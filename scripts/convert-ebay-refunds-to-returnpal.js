#!/usr/bin/env node
'use strict';

/**
 * Map eBay Payments Transaction report (CSV/XLSX) → ReturnPal multi-client return_adjustment import.
 *
 * Usage:
 *   node scripts/convert-ebay-refunds-to-returnpal.js <ebay-transactions.csv|xlsx> <out.csv> [--orders-map orders.xlsx] [--state-file path.json]
 *
 * Env:
 *   EBAY_REFUND_TYPE_HINTS — pipe-separated substrings (default: refund|return|cancellation|chargeback|credit)
 *   RETURNPAL_ORDER_CLIENT_MAP — JSON object { "ORDER-123": "ac", ... } merged with --orders-map
 *
 * Requires sold rows in ReturnPal with matching order_number for auto-link on import.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { normalizeSoldDateForDb } = require('../src/utils/adminBulkImport');
const {
    extractLegacyClientIdFromText,
    canonicalizeClientIdCandidate,
} = require('../src/utils/ebayRefundSkuClient');

const DEFAULT_REFUND_HINTS = [
    'refund',
    'return',
    'claim',
    'cancellation',
    'cancelled',
    'chargeback',
    'credit',
    'reversal',
    'dispute',
];
const OUTPUT_HEADER = [
    'Client ID',
    'order_number',
    'product',
    'amount',
    'refund_date',
    'reference',
    'linked_sold_item_id',
    'notes',
    'status',
];

const TXN_FIELD_ALIASES = {
    order_number: [
        'order_number',
        'order_id',
        'order_no',
        'orderid',
        'order',
        'sales_record_number',
    ],
    product: [
        'item_title',
        'item_name',
        'product',
        'title',
        'description',
        'memo',
        'transaction_memo',
        'item',
    ],
    amount: [
        'net_amount',
        'amount',
        'total_amount',
        'transaction_amount',
        'gross_transaction_amount',
        'refund_amount',
        'total',
    ],
    txn_type: [
        'type',
        'transaction_type',
        'transaction_type_description',
        'subtype',
        'category',
    ],
    txn_id: [
        'transaction_id',
        'reference_id',
        'reference_number',
        'payout_id',
        'id',
    ],
    txn_date: [
        'transaction_creation_date',
        'transaction_date',
        'date',
        'creation_date',
        'posted_date',
    ],
    client_id: ['client_id', 'legacy_client_id', 'seller_client_id'],
    custom_label: ['custom_label', 'customlabel', 'sku', 'seller_sku'],
};

function normalizeHeaderKey(s) {
    return String(s || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_]/g, '');
}

function parseMoney(v) {
    if (v == null || v === '') return NaN;
    let s = String(v).trim().replace(/,/g, '');
    const negParen = /^\((.*)\)$/.exec(s);
    if (negParen) s = '-' + negParen[1];
    s = s.replace(/[£$€]/g, '').trim();
    const n = parseFloat(s);
    return Number.isFinite(n) ? Math.abs(n) : NaN;
}

function sanitizeCell(v) {
    if (v == null) return '';
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return String(v).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').trim();
}

function rowToCsvLine(cells) {
    return cells
        .map((c) => {
            const s = String(c == null ? '' : c);
            if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
            return s;
        })
        .join(',');
}

function headerIndexMap(headers) {
    const m = Object.create(null);
    for (let i = 0; i < headers.length; i++) {
        const k = normalizeHeaderKey(headers[i]);
        if (k && m[k] === undefined) m[k] = i;
    }
    return m;
}

function resolveColumnIndex(field, headerMap, headersRow, explicitMap) {
    if (explicitMap && explicitMap[field]) {
        const want = normalizeHeaderKey(explicitMap[field]);
        if (headerMap[want] !== undefined) return headerMap[want];
        for (let i = 0; i < headersRow.length; i++) {
            if (normalizeHeaderKey(headersRow[i]) === want) return i;
        }
        return -1;
    }
    const aliases = TXN_FIELD_ALIASES[field];
    if (!aliases) return -1;
    for (const a of aliases) {
        if (headerMap[a] !== undefined) return headerMap[a];
    }
    for (const key of Object.keys(headerMap)) {
        for (const a of aliases) {
            if (key.includes(a) || a.includes(key)) return headerMap[key];
        }
    }
    return -1;
}

function cell(row, idx) {
    if (idx < 0 || idx >= row.length) return '';
    const v = row[idx];
    if (v == null) return '';
    if (typeof v === 'number' && Number.isFinite(v) && v > 20000 && v < 120000) {
        const epochMs = Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000;
        const d = new Date(epochMs);
        if (!isNaN(d.getTime())) {
            const p = (n) => (n < 10 ? '0' + n : String(n));
            return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
        }
    }
    return String(v).trim();
}

function refundTypeHints() {
    const raw = process.env.EBAY_REFUND_TYPE_HINTS;
    if (!raw || !String(raw).trim()) return DEFAULT_REFUND_HINTS;
    return String(raw)
        .split('|')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

function isRefundLikeText(text, hints) {
    const t = String(text || '').toLowerCase();
    if (!t) return false;
    return hints.some((h) => t.includes(h));
}

/**
 * @param {Record<string, string>} rowObj normalized header -> value
 * @param {string[]} hints
 */
function isRefundTransactionRow(rowObj, hints) {
    const parts = [
        rowObj.type,
        rowObj.transaction_type,
        rowObj.transaction_type_description,
        rowObj.subtype,
        rowObj.category,
        rowObj.description,
        rowObj.memo,
    ]
        .filter(Boolean)
        .join(' ');
    if (isRefundLikeText(parts, hints)) return true;
    const amt = parseMoney(rowObj.amount || rowObj.net_amount || rowObj.total);
    if (Number.isFinite(amt) && amt > 0) {
        const saleHints = ['order', 'sale', 'sold', 'payment', 'payout'];
        const looksSale = saleHints.some((h) => isRefundLikeText(parts, [h]) && !isRefundLikeText(parts, hints));
        if (!looksSale && String(rowObj.amount || rowObj.net_amount || '').trim().startsWith('-')) return true;
    }
    return false;
}

/**
 * eBay Refunds report CSV has ~12 lines of notes before the real header row.
 * @param {unknown[][]} aoa
 * @returns {number}
 */
function findTransactionHeaderRowIndex(aoa) {
    if (!aoa || !aoa.length) return 0;
    for (let i = 0; i < Math.min(aoa.length, 40); i++) {
        const row = aoa[i];
        if (!row || !row.length) continue;
        const keys = row.map((c) => normalizeHeaderKey(c));
        const hasOrder = keys.some((k) => k === 'order_number' || (k.includes('order') && k.includes('number')));
        const hasType = keys.includes('type');
        const hasNet = keys.some((k) => k === 'net_amount' || k.includes('net_amount'));
        if (hasOrder && hasType && hasNet) return i;
    }
    return 0;
}

/**
 * Pull client code from eBay Custom label when orders-map has no hit (PPF040, SM, JR, etc.).
 * @param {string} label
 */
/** @param {string} label */
function extractClientHintFromCustomLabel(label) {
    return extractLegacyClientIdFromText(label) || canonicalizeClientIdCandidate(label) || '';
}

function canonicalOrderNumber(raw) {
    const s = String(raw || '')
        .trim()
        .replace(/\s+/g, '');
    if (!s) return '';
    const m = s.match(/\d{2}-\d{5}-\d{5}|\d{3}-\d{7}-\d{7}/);
    return m ? m[0] : s;
}

/**
 * EVERY EBAY ORDER SHEET: B=order id, H=client id (0-based indices 1 and 7).
 * @param {unknown[][]} aoa
 */
function buildOrderClientMapFromOrdersAoa(aoa) {
    const map = Object.create(null);
    if (!aoa || !aoa.length) return map;
    let start = 0;
    const row0 = aoa[0] || [];
    const h0 = normalizeHeaderKey(row0[1]);
    const h7 = normalizeHeaderKey(row0[7]);
    if (
        (h0.includes('order') || h0 === 'order_id') &&
        (h7.includes('client') || h7 === 'client_id' || h7 === '')
    ) {
        start = 1;
    }
    for (let i = start; i < aoa.length; i++) {
        const row = aoa[i];
        if (!row) continue;
        const onum = canonicalOrderNumber(row[1]);
        const clientId = sanitizeCell(row[7]).replace(/^\uFEFF/, '');
        if (onum && clientId) map[onum] = clientId;
    }
    return map;
}

function loadOrdersMapFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return Object.create(null);
    const wb = XLSX.readFile(filePath, { cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
    return buildOrderClientMapFromOrdersAoa(aoa);
}

function loadExtraOrderClientMapFromEnv() {
    const raw = process.env.RETURNPAL_ORDER_CLIENT_MAP;
    if (!raw || !String(raw).trim()) return Object.create(null);
    try {
        const o = JSON.parse(raw);
        if (!o || typeof o !== 'object') return Object.create(null);
        const out = Object.create(null);
        for (const [k, v] of Object.entries(o)) {
            const on = canonicalOrderNumber(k);
            if (on && v != null && String(v).trim()) out[on] = String(v).trim();
        }
        return out;
    } catch (e) {
        throw new Error(`RETURNPAL_ORDER_CLIENT_MAP must be valid JSON: ${e.message}`);
    }
}

function mergeOrderClientMaps(...maps) {
    return Object.assign(Object.create(null), ...maps);
}

function readSheetAoa(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.csv') {
        const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
        const wb = XLSX.read(text, { type: 'string', raw: true });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
    }
    const wb = XLSX.readFile(filePath, { cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
}

function dedupeKey(clientId, orderNumber, amount, txnId) {
    return [
        normalizeHeaderKey(clientId),
        normalizeHeaderKey(orderNumber),
        String(Math.round(amount * 100) / 100),
        normalizeHeaderKey(txnId),
    ].join('|');
}

function loadDedupeState(statePath) {
    try {
        const j = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (!j || typeof j !== 'object') return { keys: {} };
        if (!j.keys || typeof j.keys !== 'object') return { keys: {} };
        return j;
    } catch {
        return { keys: {} };
    }
}

function saveDedupeState(statePath, state) {
    const dir = path.dirname(statePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * @param {unknown[][]} aoa
 * @param {{ orderClientMap?: Record<string,string>, hints?: string[], explicitColumnMap?: Record<string,string>|null }} opts
 */
function parseRefundRowsFromTransactionSheet(aoa, opts = {}) {
    const hints = opts.hints || refundTypeHints();
    const orderClientMap = opts.orderClientMap || Object.create(null);
    if (!aoa || aoa.length < 2) return { rows: [], skipped: { empty: 0, notRefund: 0, noAmount: 0, noProduct: 0 } };

    const headerRowIndex = findTransactionHeaderRowIndex(aoa);
    const dataAoa = aoa.slice(headerRowIndex);
    if (dataAoa.length < 2) return { rows: [], skipped: { empty: 0, notRefund: 0, noAmount: 0, noProduct: 0 } };

    const headers = (dataAoa[0] || []).map((h) => String(h ?? ''));
    const headerMap = headerIndexMap(headers);
    const explicit = opts.explicitColumnMap || null;

    const idxOrder = resolveColumnIndex('order_number', headerMap, headers, explicit);
    const idxProduct = resolveColumnIndex('product', headerMap, headers, explicit);
    const idxAmount = resolveColumnIndex('amount', headerMap, headers, explicit);
    const idxType = resolveColumnIndex('txn_type', headerMap, headers, explicit);
    const idxTxnId = resolveColumnIndex('txn_id', headerMap, headers, explicit);
    const idxDate = resolveColumnIndex('txn_date', headerMap, headers, explicit);
    const idxClient = resolveColumnIndex('client_id', headerMap, headers, explicit);
    const idxCustomLabel = resolveColumnIndex('custom_label', headerMap, headers, explicit);

    const rows = [];
    const skipped = { empty: 0, notRefund: 0, noAmount: 0, noProduct: 0 };

    for (let i = 1; i < dataAoa.length; i++) {
        const row = dataAoa[i];
        if (!row || !row.some((c) => c !== '' && c != null && String(c).trim() !== '')) {
            skipped.empty++;
            continue;
        }

        const rowObj = Object.create(null);
        for (let c = 0; c < headers.length; c++) {
            const k = normalizeHeaderKey(headers[c]);
            if (k) rowObj[k] = cell(row, c);
        }

        if (idxType >= 0) rowObj.type = cell(row, idxType);
        if (idxAmount >= 0) rowObj.amount = cell(row, idxAmount);

        if (!isRefundTransactionRow(rowObj, hints)) {
            skipped.notRefund++;
            continue;
        }

        const orderNumber = canonicalOrderNumber(idxOrder >= 0 ? cell(row, idxOrder) : rowObj.order_number || '');
        let product = idxProduct >= 0 ? cell(row, idxProduct) : '';
        if (!product) {
            product =
                rowObj.item_title ||
                rowObj.description ||
                rowObj.memo ||
                (orderNumber ? `Refund order ${orderNumber}` : 'eBay refund');
        }
        product = sanitizeCell(product).slice(0, 500);

        let amount = parseMoney(idxAmount >= 0 ? cell(row, idxAmount) : rowObj.amount || rowObj.net_amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            skipped.noAmount++;
            continue;
        }

        if (!product) {
            skipped.noProduct++;
            continue;
        }

        const txnId = idxTxnId >= 0 ? cell(row, idxTxnId) : rowObj.transaction_id || '';
        const txnDateRaw = idxDate >= 0 ? cell(row, idxDate) : rowObj.transaction_date || '';
        const txnDate = normalizeSoldDateForDb(txnDateRaw) || txnDateRaw;

        const customLabel = idxCustomLabel >= 0 ? cell(row, idxCustomLabel) : '';
        let clientId = '';
        let clientSource = 'none';
        const fromCol = idxClient >= 0 ? cell(row, idxClient) : '';
        if (fromCol) {
            clientId = fromCol;
            clientSource = 'column';
        } else if (orderNumber && orderClientMap[orderNumber]) {
            clientId = orderClientMap[orderNumber];
            clientSource = 'orders_map';
        } else {
            const fromLabel = extractClientHintFromCustomLabel(customLabel);
            if (fromLabel) {
                clientId = fromLabel;
                clientSource = 'custom_label';
            }
        }

        rows.push({
            clientId: sanitizeCell(clientId),
            clientSource,
            orderNumber,
            product,
            customLabel: sanitizeCell(customLabel).slice(0, 500),
            amount,
            refundDate: txnDate || '',
            reference: txnId ? String(txnId).slice(0, 64) : '',
            notes: ['eBay txn', txnId].filter(Boolean).join(' ').slice(0, 500),
            status: 'applied',
            txnId,
            type: rowObj.type || '',
        });
    }

    return { rows, skipped };
}

/**
 * @param {ReturnType<typeof parseRefundRowsFromTransactionSheet>['rows']} parsedRows
 * @param {{ state?: { keys: Record<string,boolean> }, recordState?: boolean }} opts
 */
function applyDedupeAndSplit(parsedRows, opts = {}) {
    const state = opts.state || { keys: {} };
    const recordState = opts.recordState !== false;
    const out = [];
    const unmatched = [];
    let duplicates = 0;

    for (const r of parsedRows) {
        if (!r.clientId) {
            unmatched.push(r);
            continue;
        }
        const key = dedupeKey(r.clientId, r.orderNumber, r.amount, r.txnId);
        if (state.keys[key]) {
            duplicates++;
            continue;
        }
        if (recordState) state.keys[key] = true;
        out.push(r);
    }

    return { out, unmatched, duplicates, state };
}

function rowsToImportAoa(rows) {
    const aoa = [OUTPUT_HEADER];
    for (const r of rows) {
        aoa.push([
            r.clientId,
            r.orderNumber,
            r.product,
            r.amount,
            r.refundDate || '',
            r.reference || '',
            '',
            r.notes || '',
            r.status || 'applied',
        ]);
    }
    return aoa;
}

function readBufferToAoa(buffer, originalName) {
    const ext = path.extname(String(originalName || '')).toLowerCase();
    if (ext === '.csv' || ext === '.txt') {
        const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
        const wb = XLSX.read(text, { type: 'string', raw: true });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
    }
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
}

/**
 * Convert eBay Refunds report buffers → ReturnPal bulk-import CSV buffer.
 * @param {{ refundsBuffer: Buffer, ordersMapBuffer?: Buffer|null, ordersMapName?: string }} opts
 */
/**
 * All refund rows for admin review (before dedupe). Client ID may be auto-filled or empty.
 * @param {{ refundsBuffer: Buffer, ordersMapBuffer?: Buffer|null, ordersMapName?: string }} opts
 */
function convertEbayRefundsForReview(opts) {
    const refundsBuffer = opts.refundsBuffer;
    if (!refundsBuffer || !refundsBuffer.length) {
        throw new Error('refunds file is empty');
    }
    const orderClientMap = mergeOrderClientMaps(
        opts.ordersMapBuffer && opts.ordersMapBuffer.length
            ? buildOrderClientMapFromOrdersAoa(readBufferToAoa(opts.ordersMapBuffer, opts.ordersMapName || ''))
            : Object.create(null),
        loadExtraOrderClientMapFromEnv()
    );
    const aoa = readBufferToAoa(refundsBuffer, 'refunds.csv');
    const { rows: parsed, skipped } = parseRefundRowsFromTransactionSheet(aoa, { orderClientMap });
    const withClient = parsed.filter((r) => r.clientId).length;
    return {
        rows: parsed,
        stats: {
            parsed: parsed.length,
            skipped,
            with_client: withClient,
            needs_client: parsed.length - withClient,
        },
        orderClientMapSize: Object.keys(orderClientMap).length,
    };
}

/** @param {Array<Record<string, unknown>>} rows */
function reviewedRowsToCsvBuffer(rows) {
    const importRows = (rows || []).map((r) => ({
        clientId: String(r.clientId != null ? r.clientId : r.client_id || '').trim(),
        orderNumber: r.orderNumber != null ? r.orderNumber : r.order_number,
        product: r.product,
        amount: r.amount,
        refundDate: r.refundDate != null ? r.refundDate : r.refund_date,
        reference: r.reference || '',
        notes: r.notes || '',
        status: r.status || 'applied',
    }));
    const importAoa = rowsToImportAoa(importRows);
    const csvBody = importAoa.map((row) => rowToCsvLine(row)).join('\r\n');
    return Buffer.from('\uFEFF' + csvBody, 'utf8');
}

function convertEbayRefundsBuffers(opts) {
    const refundsBuffer = opts.refundsBuffer;
    if (!refundsBuffer || !refundsBuffer.length) {
        throw new Error('refunds file is empty');
    }
    const orderClientMap = mergeOrderClientMaps(
        opts.ordersMapBuffer && opts.ordersMapBuffer.length
            ? buildOrderClientMapFromOrdersAoa(readBufferToAoa(opts.ordersMapBuffer, opts.ordersMapName || ''))
            : Object.create(null),
        loadExtraOrderClientMapFromEnv()
    );
    const aoa = readBufferToAoa(refundsBuffer, 'refunds.csv');
    const { rows: parsed, skipped } = parseRefundRowsFromTransactionSheet(aoa, { orderClientMap });
    const { out, unmatched, duplicates } = applyDedupeAndSplit(parsed, {
        state: { keys: {} },
        recordState: false,
    });
    const importAoa = rowsToImportAoa(out);
    const csvBody = importAoa.map((row) => rowToCsvLine(row)).join('\r\n');
    const csvBuffer = Buffer.from('\uFEFF' + csvBody, 'utf8');
    return {
        csvBuffer,
        stats: {
            parsed: parsed.length,
            skipped,
            import_rows: out.length,
            file_duplicates_skipped: duplicates,
            unmatched_client: unmatched.length,
        },
        unmatched,
    };
}

function parseArgs(argv) {
    const out = {
        inPath: null,
        outPath: null,
        ordersMap: null,
        stateFile: path.join(__dirname, '.ebay-refunds-sync-state.json'),
        dryRun: false,
        help: false,
    };
    const positional = [];
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') out.help = true;
        else if (a === '--dry-run') out.dryRun = true;
        else if (a === '--orders-map' && argv[i + 1]) out.ordersMap = argv[++i];
        else if (a === '--state-file' && argv[i + 1]) out.stateFile = argv[++i];
        else positional.push(a);
    }
    out.inPath = positional[0] || null;
    out.outPath = positional[1] || null;
    return out;
}

function printHelp() {
    console.log(`Usage: node scripts/convert-ebay-refunds-to-returnpal.js <ebay-transactions.csv|xlsx> <out.csv> [options]

Options:
  --orders-map <path>   EVERY EBAY ORDER SHEET (order col B → client col H)
  --state-file <path>   Dedupe state JSON (default: scripts/.ebay-refunds-sync-state.json)
  --dry-run             Parse only; do not write files or update state

Then: Admin → Bulk import → Multi-client → Return / refund adjustments → upload out.csv`);
}

function main() {
    const args = parseArgs(process.argv);
    if (args.help || !args.inPath || !args.outPath) {
        printHelp();
        process.exit(args.help ? 0 : 1);
    }
    if (!fs.existsSync(args.inPath)) {
        console.error('Input not found:', args.inPath);
        process.exit(1);
    }

    const orderClientMap = mergeOrderClientMaps(
        args.ordersMap ? loadOrdersMapFile(args.ordersMap) : Object.create(null),
        loadExtraOrderClientMapFromEnv()
    );

    const aoa = readSheetAoa(args.inPath);
    const { rows: parsed, skipped } = parseRefundRowsFromTransactionSheet(aoa, { orderClientMap });
    const state = loadDedupeState(args.stateFile);
    const { out, unmatched, duplicates, state: nextState } = applyDedupeAndSplit(parsed, {
        state,
        recordState: !args.dryRun,
    });

    const importAoa = rowsToImportAoa(out);
    const unmatchedAoa = rowsToImportAoa(
        unmatched.map((r) => ({
            ...r,
            clientId: '',
            notes: (r.notes ? r.notes + ' ' : '') + '(no Client ID — set via orders map)',
        }))
    );

    const outDir = path.dirname(path.resolve(args.outPath));
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    if (!args.dryRun) {
        const csvBody = importAoa.map((row) => rowToCsvLine(row)).join('\r\n');
        fs.writeFileSync(args.outPath, '\uFEFF' + csvBody, 'utf8');

        if (unmatched.length) {
            const umPath = args.outPath.replace(/\.csv$/i, '-unmatched.csv');
            const umBody = unmatchedAoa.map((row) => rowToCsvLine(row)).join('\r\n');
            fs.writeFileSync(umPath, '\uFEFF' + umBody, 'utf8');
            console.log('Wrote', umPath, `(${unmatched.length} rows without Client ID)`);
        }

        saveDedupeState(args.stateFile, nextState);
    }

    console.log('Parsed refund-like rows:', parsed.length);
    console.log('Skipped:', skipped);
    console.log('Output import rows:', out.length);
    console.log('Duplicates skipped (state):', duplicates);
    console.log('Unmatched client (no orders-map):', unmatched.length);
    if (!args.dryRun) console.log('Wrote', args.outPath);
    else console.log('Dry run — no files written');
}

if (require.main === module) {
    main();
}

module.exports = {
    normalizeHeaderKey,
    findTransactionHeaderRowIndex,
    extractClientHintFromCustomLabel,
    buildOrderClientMapFromOrdersAoa,
    canonicalOrderNumber,
    isRefundTransactionRow,
    parseRefundRowsFromTransactionSheet,
    applyDedupeAndSplit,
    dedupeKey,
    rowsToImportAoa,
    refundTypeHints,
    OUTPUT_HEADER,
    convertEbayRefundsBuffers,
    convertEbayRefundsForReview,
    reviewedRowsToCsvBuffer,
    readBufferToAoa,
};
