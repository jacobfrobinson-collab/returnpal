#!/usr/bin/env node
'use strict';

/**
 * Poll a Google Sheet "orders" tab, map rows to ReturnPal multi-client sold import format
 * (client_id in last column), dedupe via state file, POST /api/admin/bulk-import-multi.
 *
 * Env (required unless noted):
 *   ORDERS_SYNC_SPREADSHEET_ID — Google spreadsheet id
 *   ORDERS_SYNC_RANGE — A1 range, e.g. Orders!A:ZZ or 'My Tab'!A:ZZ
 *   GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS — path to SA key JSON
 *   RETURNPAL_BASE_URL — default http://127.0.0.1:3000
 *   RETURNPAL_ADMIN_EMAIL, RETURNPAL_ADMIN_PASSWORD — admin JWT login
 *
 * Optional:
 *   ORDERS_SYNC_COLUMN_MAP — JSON object: import field -> source column header (substring match after normalize)
 *     Default maps order_date, order_number, item_title, quantity, net_earnings (and common aliases).
 *   Prefer the sold_date column as plain text ISO **YYYY-MM-DD** (e.g. 2026-01-04) so values match the dashboard
 *   and are never confused with UK/US slash dates. Native sheet date cells also work (read as serials).
 *   ORDERS_SYNC_STATE_FILE — default scripts/.orders-sync-state.json (keyed by spreadsheetId+range)
 *   ORDERS_SYNC_HEADER_ROW — 1-based first header row (default 1)
 *   ORDERS_SYNC_UPLOAD_FORMAT — csv (default) or xlsx for the multipart upload
 *
 * CLI: --once | --cron CRON_EXPR (e.g. every 15 min) | --dry-run | --write-out path.csv
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');

try {
    const dotenv = require('dotenv');
    const rootEnv = path.join(__dirname, '..', '.env');
    if (fs.existsSync(rootEnv)) dotenv.config({ path: rootEnv });
} catch {
    /* optional */
}

const { google } = require('googleapis');
const XLSX = require('xlsx');

const ROOT = path.join(__dirname, '..');
const DEFAULT_STATE = path.join(__dirname, '.orders-sync-state.json');

function normalizeHeaderKey(s) {
    return String(s || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_]/g, '');
}

/** @type {Record<string, string[]>} importField -> list of normalized source header keys to try */
const DEFAULT_SOURCE_ALIASES = {
    sold_date: ['order_date', 'sold_date', 'date', 'sale_date'],
    order_number: ['order_number', 'order_id', 'order_no', 'orderid'],
    item_name: ['item_title', 'item_name', 'product', 'title'],
    quantity: ['quantity', 'qty'],
    earnings: ['net_earnings', 'earnings', 'client_payout', 'gross_earnings', 'total'],
};

function parseArgs(argv) {
    const out = { once: true, cron: null, dryRun: false, writeOut: null };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--once') out.once = true;
        else if (a === '--cron' && argv[i + 1]) {
            out.cron = argv[++i];
            out.once = false;
        } else if (a === '--dry-run') out.dryRun = true;
        else if (a === '--write-out' && argv[i + 1]) out.writeOut = argv[++i];
        else if (a === '--help' || a === '-h') out.help = true;
    }
    return out;
}

function usage() {
    console.log(`Usage: node scripts/google-orders-sheet-sync-sold.js [--once] [--cron CRON] [--dry-run] [--write-out out.csv]

Reads ORDERS_SYNC_SPREADSHEET_ID + ORDERS_SYNC_RANGE via a Google service account,
maps columns using ORDERS_SYNC_COLUMN_MAP or built-in aliases, uses the last non-empty
header column as client_id, skips rows already recorded in ORDERS_SYNC_STATE_FILE,
then uploads new rows as kind=sold multi bulk import.`);
}

function loadColumnMapFromEnv() {
    const raw = process.env.ORDERS_SYNC_COLUMN_MAP;
    if (!raw || !String(raw).trim()) return null;
    try {
        const o = JSON.parse(raw);
        if (!o || typeof o !== 'object') return null;
        /** @type {Record<string, string>} importField -> exact or logical source header */
        return o;
    } catch (e) {
        throw new Error(`ORDERS_SYNC_COLUMN_MAP must be valid JSON: ${e.message}`);
    }
}

/**
 * Build normalized header -> first column index
 * @param {string[]} headers
 */
function headerIndexMap(headers) {
    const m = Object.create(null);
    for (let i = 0; i < headers.length; i++) {
        const k = normalizeHeaderKey(headers[i]);
        if (k && m[k] === undefined) m[k] = i;
    }
    return m;
}

/**
 * Resolve column index for an import field
 * @param {Record<string, string>|null} explicit importField -> source header label from env
 */
function resolveColumnIndex(importField, headerMap, headersRow, explicit) {
    if (explicit && explicit[importField]) {
        const want = normalizeHeaderKey(explicit[importField]);
        const idx = headerMap[want];
        if (idx !== undefined) return idx;
        for (let i = 0; i < headersRow.length; i++) {
            if (normalizeHeaderKey(headersRow[i]) === want) return i;
        }
        return -1;
    }
    const aliases = DEFAULT_SOURCE_ALIASES[importField];
    if (!aliases) return -1;
    for (const a of aliases) {
        if (headerMap[a] !== undefined) return headerMap[a];
    }
    return -1;
}

function lastNonEmptyHeaderIndex(headers) {
    for (let i = headers.length - 1; i >= 0; i--) {
        if (String(headers[i] ?? '').trim() !== '') return i;
    }
    return -1;
}

function cell(row, idx) {
    if (idx < 0 || idx >= row.length) return '';
    const v = row[idx];
    if (v == null) return '';
    if (typeof v === 'number' && Number.isFinite(v)) {
        if (v > 20000 && v < 120000) {
            const epochMs = Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000;
            const d = new Date(epochMs);
            if (!isNaN(d.getTime())) {
                const p = (n) => (n < 10 ? '0' + n : String(n));
                return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
            }
        }
    }
    return String(v).trim();
}

function dedupeKey(clientId, soldDate, orderNumber, itemName, qty, earnings) {
    const parts = [
        normalizeHeaderKey(clientId),
        normalizeHeaderKey(soldDate),
        normalizeHeaderKey(orderNumber),
        normalizeHeaderKey(itemName),
        String(qty),
        normalizeHeaderKey(String(earnings)),
    ];
    return parts.join('|');
}

function sheetStateKey(spreadsheetId, range) {
    return `${spreadsheetId}::${range}`;
}

function loadState(statePath) {
    try {
        const t = fs.readFileSync(statePath, 'utf8');
        const j = JSON.parse(t);
        if (!j || typeof j !== 'object') return { sheets: {} };
        if (!j.sheets) j.sheets = {};
        return j;
    } catch {
        return { sheets: {} };
    }
}

function saveState(statePath, state) {
    const dir = path.dirname(statePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function hashSheetRows(rows2d) {
    const h = crypto.createHash('sha256');
    for (const row of rows2d) {
        h.update('\n');
        for (const c of row) h.update(String(c ?? ''));
        h.update('\t');
    }
    return h.digest('hex');
}

async function getSheetsClient() {
    const keyFile =
        process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        '';
    if (!keyFile || !fs.existsSync(keyFile)) {
        throw new Error(
            'Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS to a readable service account JSON path'
        );
    }
    const auth = new google.auth.GoogleAuth({
        keyFile: path.resolve(keyFile),
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const authClient = await auth.getClient();
    return google.sheets({ version: 'v4', auth: authClient });
}

async function fetchRange(sheets, spreadsheetId, range) {
    // UNFORMATTED_VALUE yields numeric serials for date cells (same epoch as Excel),
    // avoiding locale strings like "04/12/2026" that are ambiguous between US MM/DD and UK DD/MM.
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
        valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const values = res.data.values;
    if (!values || !values.length) return [];
    return values;
}

function padRowsToRect(values) {
    let max = 0;
    for (const r of values) max = Math.max(max, r.length);
    return values.map((r) => {
        const o = r.slice();
        while (o.length < max) o.push('');
        return o;
    });
}

function buildImportRows(values, explicitMap) {
    const headerRow1Based = Math.max(1, parseInt(process.env.ORDERS_SYNC_HEADER_ROW || '1', 10) || 1);
    const start = headerRow1Based - 1;
    if (values.length <= start) return { importRows: [], headers: [], errors: ['No data below header row'] };

    const rawHeaders = values[start].map((h) => String(h ?? ''));
    const headers = padRowsToRect(values)[start];
    const headerMap = headerIndexMap(headers.map((h) => String(h ?? '')));

    const idxSold = resolveColumnIndex('sold_date', headerMap, headers, explicitMap);
    const idxOrder = resolveColumnIndex('order_number', headerMap, headers, explicitMap);
    const idxItem = resolveColumnIndex('item_name', headerMap, headers, explicitMap);
    const idxQty = resolveColumnIndex('quantity', headerMap, headers, explicitMap);
    const idxEarn = resolveColumnIndex('earnings', headerMap, headers, explicitMap);
    const lastIdx = lastNonEmptyHeaderIndex(headers);

    const errors = [];
    if (idxSold < 0) errors.push('Could not resolve sold_date column (set ORDERS_SYNC_COLUMN_MAP, e.g. {"sold_date":"Order Date"})');
    if (idxItem < 0) errors.push('Could not resolve item_name column');
    if (idxQty < 0) errors.push('Could not resolve quantity column');
    if (idxEarn < 0) errors.push('Could not resolve earnings column');
    if (lastIdx < 0) errors.push('No headers in sheet');
    if (errors.length) return { importRows: [], headers, errors };

    const mapped = [idxSold, idxItem, idxQty, idxEarn].concat(idxOrder >= 0 ? [idxOrder] : []);
    for (const i of mapped) {
        if (i === lastIdx) {
            errors.push(
                'A mapped data column uses the same index as the last column; keep Client ID as the rightmost non-empty header only.'
            );
            break;
        }
    }
    if (errors.length) return { importRows: [], headers, errors };

    const importRows = [];
    for (let r = start + 1; r < values.length; r++) {
        const row = padRowsToRect(values)[r];
        const clientId = cell(row, lastIdx);
        if (!clientId) continue;
        const soldDate = cell(row, idxSold);
        const orderNumber = idxOrder >= 0 ? cell(row, idxOrder) : '';
        const itemName = cell(row, idxItem);
        const qtyStr = cell(row, idxQty);
        const earningsStr = cell(row, idxEarn);
        if (!soldDate && !itemName && !qtyStr && !earningsStr) continue;
        if (!itemName) continue;
        const qty = Math.max(1, parseInt(qtyStr, 10) || 1);
        if (earningsStr === '' || earningsStr == null) continue;
        importRows.push({
            client_id: clientId,
            sold_date: soldDate,
            order_number: orderNumber,
            item_name: itemName,
            quantity: qty,
            earnings: earningsStr,
            _key: dedupeKey(clientId, soldDate, orderNumber, itemName, qty, earningsStr),
        });
    }
    return { importRows, headers, errors: [] };
}

function importRowsToCsvBuffer(rows) {
    const header = 'client_id,sold_date,order_number,item_name,quantity,earnings\n';
    const lines = rows.map((row) => {
        const esc = (s) => {
            const t = String(s ?? '');
            if (/[",\n\r]/.test(t)) return '"' + t.replace(/"/g, '""') + '"';
            return t;
        };
        return [
            esc(row.client_id),
            esc(row.sold_date),
            esc(row.order_number),
            esc(row.item_name),
            esc(row.quantity),
            esc(row.earnings),
        ].join(',');
    });
    return Buffer.from(header + lines.join('\n'), 'utf8');
}

function importRowsToXlsxBuffer(rows) {
    const aoa = [
        ['client_id', 'sold_date', 'order_number', 'item_name', 'quantity', 'earnings'],
        ...rows.map((r) => [r.client_id, r.sold_date, r.order_number, r.item_name, r.quantity, r.earnings]),
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, 'import');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function loginAdmin(baseUrl, email, password) {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) {
        throw new Error(`Admin login failed: ${res.status} ${JSON.stringify(data)}`);
    }
    return data.token;
}

async function uploadBulkMulti(baseUrl, token, buffer, filename) {
    const form = new FormData();
    form.append('kind', 'sold');
    const blob = new Blob([buffer], { type: filename.endsWith('.csv') ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    form.append('file', blob, filename);
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/admin/bulk-import-multi`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(`bulk-import-multi failed: ${res.status} ${JSON.stringify(data)}`);
    }
    return data;
}

async function runSyncOnce(cli) {
    const spreadsheetId = String(process.env.ORDERS_SYNC_SPREADSHEET_ID || '').trim();
    const range = String(process.env.ORDERS_SYNC_RANGE || '').trim();
    if (!spreadsheetId) throw new Error('ORDERS_SYNC_SPREADSHEET_ID is required');
    if (!range) throw new Error('ORDERS_SYNC_RANGE is required (e.g. Orders!A:ZZ)');

    const baseUrl = String(process.env.RETURNPAL_BASE_URL || 'http://127.0.0.1:3000').trim();
    const email = String(process.env.RETURNPAL_ADMIN_EMAIL || '').trim();
    const password = String(process.env.RETURNPAL_ADMIN_PASSWORD || '').trim();

    const statePath = path.resolve(process.env.ORDERS_SYNC_STATE_FILE || DEFAULT_STATE);
    const explicitMap = loadColumnMapFromEnv();

    const sheets = await getSheetsClient();
    const values = await fetchRange(sheets, spreadsheetId, range);
    const rect = padRowsToRect(values);
    const sheetHash = hashSheetRows(rect);

    const { importRows, headers, errors } = buildImportRows(rect, explicitMap);
    if (errors.length) {
        throw new Error(errors.join('; '));
    }

    const state = loadState(statePath);
    const sk = sheetStateKey(spreadsheetId, range);
    if (!state.sheets[sk]) state.sheets[sk] = { processedKeys: [], lastSheetHash: '' };

    const processed = new Set(state.sheets[sk].processedKeys);
    const newRows = importRows.filter((r) => !processed.has(r._key));

    console.log(
        JSON.stringify(
            {
                spreadsheetId,
                range,
                headerSample: headers.slice(0, 8),
                totalDataRows: importRows.length,
                newRows: newRows.length,
                sheetHash: sheetHash.slice(0, 16) + '…',
            },
            null,
            0
        )
    );

    if (cli.writeOut) {
        const buf = importRowsToCsvBuffer(newRows.length ? newRows : importRows);
        fs.writeFileSync(path.resolve(cli.writeOut), buf);
        console.log(`Wrote ${cli.writeOut} (${newRows.length || importRows.length} rows)`);
    }

    if (newRows.length === 0) {
        state.sheets[sk].lastSheetHash = sheetHash;
        saveState(statePath, state);
        console.log('No new rows to import (all keys already processed).');
        return { imported: 0, skipped: true };
    }

    if (cli.dryRun) {
        console.log('Dry run — would import:', newRows.slice(0, 5));
        if (newRows.length > 5) console.log(`… and ${newRows.length - 5} more`);
        return { imported: 0, dryRun: true, newRows: newRows.length };
    }

    const useXlsx = String(process.env.ORDERS_SYNC_UPLOAD_FORMAT || 'csv').toLowerCase() === 'xlsx';
    const buffer = useXlsx ? importRowsToXlsxBuffer(newRows) : importRowsToCsvBuffer(newRows);
    const filename = useXlsx ? 'orders-sync-import.xlsx' : 'orders-sync-import.csv';

    if (!email || !password) {
        throw new Error('RETURNPAL_ADMIN_EMAIL and RETURNPAL_ADMIN_PASSWORD are required for upload (use --dry-run to skip)');
    }

    const token = await loginAdmin(baseUrl, email, password);
    const result = await uploadBulkMulti(baseUrl, token, buffer, filename);
    console.log('Import result:', JSON.stringify({ imported: result.imported, errors: result.errors, by_user: result.by_user }, null, 2));

    for (const r of newRows) {
        processed.add(r._key);
    }
    state.sheets[sk].processedKeys = Array.from(processed).slice(-20000);
    state.sheets[sk].lastSheetHash = sheetHash;
    saveState(statePath, state);

    return { imported: result.imported, errors: result.errors };
}

async function main() {
    const cli = parseArgs(process.argv);
    if (cli.help) {
        usage();
        process.exit(0);
    }

    const run = async () => {
        try {
            await runSyncOnce(cli);
        } catch (e) {
            console.error(e.message || e);
            process.exitCode = 1;
        }
    };

    if (cli.cron) {
        if (!cron.validate(cli.cron)) {
            console.error('Invalid cron expression:', cli.cron);
            process.exit(1);
        }
        console.log('Cron mode:', cli.cron);
        await run();
        cron.schedule(cli.cron, run);
        return;
    }

    await run();
}

main();
