#!/usr/bin/env node
'use strict';

/**
 * Same Seller Hub list → order details → Royal Mail postage → payout row math → Google Sheets as
 * ebay-payout-puppeteer (payoutRowsFromOrdersWithRoyalMail + writeRowsToSheet), but the eBay list is filtered
 * to orders not already in a sheet snapshot (CSV download or --sheet-csv).
 *
 * Writes a separate "new orders only" CSV for this run (not merged into the full sheet export).
 * Sheet writes may update lastSheetNextAppendRow / sheetWrittenOrderNumbers in .ebay-payout-checkpoint.json.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const orderDetailsRead = require('./ebay-order-details-read.js');
const {
    writeRowsToSheet,
    payoutRowsFromOrdersWithRoyalMail,
    appendOrdersToMainSheetFallbackQueue,
} = require('./ebay-payout-puppeteer.js');

try {
    const dotenv = require('dotenv');
    const localEnv = path.join(__dirname, 'ebay-payout-bot.env');
    const rootEnv = path.join(__dirname, '..', '.env');
    if (fs.existsSync(localEnv)) dotenv.config({ path: localEnv });
    if (fs.existsSync(rootEnv)) dotenv.config({ path: rootEnv });
} catch {
    /* optional */
}

const DEFAULT_GOOGLE_SHEET_URL =
    'https://docs.google.com/spreadsheets/d/1ckpW9CB-vMl5VBpfkmN9JIvCreK0gc3g2IU2-scvAJM/edit?gid=0#gid=0';
/** Paid & dispatched, previous calendar year (override: --ebay-list-url or EBAY_LIST_AUDIT_URL). */
const DEFAULT_EBAY_LIST_URL =
    'https://www.ebay.co.uk/sh/ord/?filter=status%3APAID_SHIPPED%2Ctimerange%3APREVIOUSYEAR';

const SHEET_FIRST_DATA_ROW = 2;
/** Match Seller Hub / Sheets: first segment is often 2–4 digits (not always exactly 2). */
const ORDER_NUM_RE = /^\d{2,4}-\d{4,7}-\d{4,7}$/i;
const SHEET_NAME_BOX_SELECTOR = '#t-name-box, input.waffle-name-box, input.jfk-textinput.waffle-name-box';

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/** Fail fast if debug Chrome is not listening (otherwise puppeteer.connect can look “stuck”). */
function assertChromeDevToolsReachable(browserUrl, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
        let versionUrl;
        try {
            const base = String(browserUrl || '').trim().replace(/\/$/, '');
            versionUrl = new URL('/json/version', `${base}/`);
        } catch {
            reject(new Error(`Invalid --browser-url: ${browserUrl}`));
            return;
        }
        const lib = versionUrl.protocol === 'https:' ? https : http;
        const req = lib.get(versionUrl, { timeout: timeoutMs }, (res) => {
            res.resume();
            if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve();
                return;
            }
            reject(
                new Error(
                    `Chrome DevTools at ${browserUrl} returned HTTP ${res.statusCode}. Is this the ebay:chrome window?`,
                ),
            );
        });
        req.on('error', (err) => {
            const code = err && err.code ? String(err.code) : '';
            reject(
                new Error(
                    `Cannot reach Chrome DevTools at ${browserUrl} (${code || err.message}).\n` +
                        `  In another terminal run:  cd ${process.cwd()}  &&  npm run ebay:chrome\n` +
                        '  Leave that Chrome window open; this script attaches to remote debugging port 9222.',
                ),
            );
        });
        req.on('timeout', () => {
            req.destroy();
            reject(
                new Error(
                    `Timeout waiting for ${browserUrl}/json/version. Start debug Chrome (npm run ebay:chrome) and retry.`,
                ),
            );
        });
    });
}

function canonicalEbayOrderId(raw) {
    const t = String(raw || '')
        .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
        .replace(/\s+/g, '')
        .trim()
        .toUpperCase();
    return ORDER_NUM_RE.test(t) ? t : '';
}

/** A1-style letters → 1-based column index (A=1, B=2, …, Z=26, AA=27). */
function columnLettersToOneBased(letters) {
    const L = String(letters || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '');
    if (!/^[A-Z]+$/.test(L) || !L.length) return 2;
    let n = 0;
    for (let i = 0; i < L.length; i++) n = n * 26 + (L.charCodeAt(i) - 64);
    return Math.max(1, Math.min(n, 4096));
}

/** Google Sheets CSV export: quoted fields, commas. */
function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            inQuotes = !inQuotes;
            continue;
        }
        if (!inQuotes && c === ',') {
            out.push(cur);
            cur = '';
            continue;
        }
        cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
}

function csvEscapeField(val) {
    const s = String(val ?? '');
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function csvLineFromValues(vals) {
    return vals.map(csvEscapeField).join(',');
}

function snapshotMissingLinksPath(snapshotCsvPath) {
    const abs = path.isAbsolute(snapshotCsvPath) ? snapshotCsvPath : path.join(process.cwd(), snapshotCsvPath);
    const dir = path.dirname(abs);
    const base = path.basename(abs, path.extname(abs));
    return path.join(dir, `${base}-missing-order-links.csv`);
}

/** One row per missing order: order id + Seller Hub details URL (for retries / manual). */
function writeMissingOrderLinksFile(outPath, missingEntries) {
    if (!missingEntries.length) return null;
    const lines = ['order_number,details_url'];
    for (const { href, orderNumber } of missingEntries) {
        lines.push(csvLineFromValues([orderNumber || '', href || '']));
    }
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
    return outPath;
}

/** Payout table A–H; only rows added in this audit run (not the full sheet export). */
const NEW_ORDERS_ONLY_CSV_HEADER =
    'sold_date,order_number,item_title,custom_sku,quantity,net_earnings,client_payout,client_id';

function initNewOrdersOnlyCsv(outPath) {
    fs.writeFileSync(outPath, `${NEW_ORDERS_ONLY_CSV_HEADER}\n`, 'utf8');
}

function appendNewOrdersOnlyCsvRows(outPath, enrichedRows) {
    if (!enrichedRows.length) return;
    const lines = enrichedRows.map((r) => csvLineFromValues(cellsForPayoutSheetTable(r)));
    fs.appendFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
}

function extractOrderIdFromCsvField(raw) {
    const t = String(raw ?? '').trim();
    let o = canonicalEbayOrderId(t);
    if (o) return o;
    const m = t.match(/\d{2,4}-\d{4,7}-\d{4,7}/i);
    return m ? canonicalEbayOrderId(m[0]) : '';
}

/**
 * @param {string} csvPath
 * @param {number} columnOneBased 1 = A, 2 = B
 * @param {number} startRowOneBased  first data row (default 2 = skip one header row)
 */
function readOrderIdSetFromCsvFile(csvPath, columnOneBased, startRowOneBased) {
    const abs = path.isAbsolute(csvPath) ? csvPath : path.join(process.cwd(), csvPath);
    if (!fs.existsSync(abs)) {
        throw new Error(`CSV not found: ${abs}`);
    }
    const raw = fs.readFileSync(abs, 'utf8');
    const lines = raw.split(/\r?\n/);
    const set = new Set();
    const colIdx = Math.max(0, columnOneBased - 1);
    const start = Math.max(1, startRowOneBased);
    for (let i = 0; i < lines.length; i++) {
        const rowNum = i + 1;
        if (rowNum < start) continue;
        const line = lines[i];
        if (!line || !String(line).trim()) continue;
        const parts = parseCsvLine(line);
        if (parts.length <= colIdx) continue;
        const oid = extractOrderIdFromCsvField(parts[colIdx]);
        if (oid) set.add(oid);
    }
    return set;
}

/**
 * Next free row on the sheet if data matches the CSV snapshot: first data row is `startRowOneBased`,
 * each subsequent non-empty CSV line (from that row down) occupies one sheet row. Trail blanks ignored.
 */
function nextAppendRowFromCsvFile(csvPath, startRowOneBased) {
    const abs = path.isAbsolute(csvPath) ? csvPath : path.join(process.cwd(), csvPath);
    if (!fs.existsSync(abs)) {
        throw new Error(`CSV not found: ${abs}`);
    }
    const raw = fs.readFileSync(abs, 'utf8');
    const lines = raw.split(/\r?\n/);
    const start = Math.max(1, startRowOneBased);
    let dataLines = 0;
    for (let i = start - 1; i < lines.length; i++) {
        if (String(lines[i]).trim()) dataLines++;
    }
    if (dataLines === 0) return SHEET_FIRST_DATA_ROW;
    return start + dataLines;
}

function spreadsheetIdFromUrl(sheetUrl) {
    const m = String(sheetUrl || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return m ? m[1] : '';
}

function gidFromSheetUrl(sheetUrl) {
    const m = String(sheetUrl || '').match(/[?&#]gid=(\d+)/i);
    return m ? m[1] : '0';
}

function clearCsvFilesInDir(dir) {
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch {
        return;
    }
    for (const name of names) {
        if (!String(name).toLowerCase().endsWith('.csv')) continue;
        try {
            fs.unlinkSync(path.join(dir, name));
        } catch {
            /* in use */
        }
    }
}

/**
 * Wait for a new .csv in `dir` (Chrome export). Names like "EVERY EBAY ORDER SHEET - Sheet1.csv" are fine (spaces).
 * If several new files appear, picks the newest by mtime.
 */
async function waitForNewCsvFile(dir, beforeNames, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        let entries = [];
        try {
            entries = fs.readdirSync(dir);
        } catch {
            await sleep(300);
            continue;
        }
        const stablePaths = [];
        for (const name of entries) {
            if (beforeNames.has(name)) continue;
            if (!String(name).toLowerCase().endsWith('.csv')) continue;
            const p = path.join(dir, name);
            try {
                const st = fs.statSync(p);
                if (st.size < 4) continue;
                await sleep(250);
                const st2 = fs.statSync(p);
                if (st2.size === st.size) stablePaths.push(p);
            } catch {
                /* still writing */
            }
        }
        if (stablePaths.length === 1) return stablePaths[0];
        if (stablePaths.length > 1) {
            stablePaths.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
            return stablePaths[0];
        }
        await sleep(300);
    }
    return null;
}

async function downloadSheetCsvViaBrowser(browser, sheetUrl, destPath) {
    const spreadsheetId = spreadsheetIdFromUrl(sheetUrl);
    if (!spreadsheetId) throw new Error('Invalid GOOGLE_SHEET_URL / --sheet-url');
    const gid = gidFromSheetUrl(sheetUrl);
    const exportUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${encodeURIComponent(String(gid))}`;

    const downloadDirAbs = path.resolve(process.cwd(), '.ebay-list-audit-downloads');
    fs.mkdirSync(downloadDirAbs, { recursive: true });
    clearCsvFilesInDir(downloadDirAbs);
    let beforeNames;
    try {
        beforeNames = new Set(fs.readdirSync(downloadDirAbs));
    } catch {
        beforeNames = new Set();
    }

    try {
        await browser.defaultBrowserContext().setDownloadBehavior({
            policy: 'allow',
            downloadPath: downloadDirAbs,
        });
    } catch (e) {
        console.warn(`Audit: Chrome download folder hint failed (${String(e.message || e)}); continuing.`);
    }

    const page = await browser.newPage();
    try {
        await page.goto(exportUrl, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch((err) => {
            const msg = String(err && err.message ? err.message : err);
            if (/ERR_ABORTED|net::ERR/i.test(msg)) return;
            throw err;
        });

        let body = await page.evaluate(() => (document.body ? document.body.innerText : '') || '');

        if (!String(body).trim()) {
            const saved = await waitForNewCsvFile(downloadDirAbs, beforeNames, 90000);
            if (saved) {
                console.log(`Audit: read downloaded CSV (${path.basename(saved)}).`);
                body = fs.readFileSync(saved, 'utf8');
                try {
                    fs.unlinkSync(saved);
                } catch {
                    /* ignore */
                }
            }
        }

        if (!String(body).trim()) {
            throw new Error(
                'Could not read CSV from the export page or from .ebay-list-audit-downloads. In ebay:chrome, open the sheet once (signed in), try File → Download → Comma-separated values, then rerun. Or skip download: npm run ebay:list:sheet-audit -- --sheet-csv ".\\your-export.csv" --ebay-list-url "..."',
            );
        }
        const head = body.slice(0, 512).toLowerCase();
        if (head.includes('<!doctype') || head.includes('<html')) {
            throw new Error(
                'Google returned a sign-in or error page instead of CSV. Open the sheet in ebay:chrome, complete Google sign-in, then retry.',
            );
        }
        const abs = path.resolve(destPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body.replace(/^\uFEFF/, ''), 'utf8');
    } finally {
        await page.close().catch(() => {});
    }

    try {
        await browser.defaultBrowserContext().setDownloadBehavior({ policy: 'default' });
    } catch {
        /* ignore */
    }
}

function withSheetRange(sheetUrl, a1Range) {
    const clean = String(sheetUrl || '').split('#')[0];
    const gidMatch = String(sheetUrl || '').match(/[?&#]gid=(\d+)/i);
    const gid = gidMatch ? gidMatch[1] : '0';
    return `${clean}#gid=${gid}&range=${encodeURIComponent(a1Range)}`;
}

function cellForSheetPaste(v) {
    return String(v ?? '')
        .replace(/^\uFEFF+/, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n/g, ' ')
        .replace(/\u2028|\u2029/g, ' ')
        .replace(/\t/g, ' ')
        .trim();
}

function tsvLineForOneRow(cells) {
    const line = cells.map((c) => cellForSheetPaste(c)).join('\t');
    return line.replace(/\r?\n/g, ' ').replace(/\u2028|\u2029/g, ' ');
}

function cellsForPayoutSheetTable(r) {
    const qty = Number(r.quantity);
    const quantity = Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 1;
    return [
        r.soldDate || '',
        r.orderNumber || '',
        r.itemTitle || '',
        r.customSku || '',
        String(quantity),
        String(r.netEarnings),
        String(r.clientPayout),
        r.clientId || '',
    ];
}

function orderIdFromEbayDetailsLink(link) {
    try {
        const m = String(link || '').match(/orderid=([^&]+)/i);
        if (!m) return '';
        return decodeURIComponent(String(m[1]).replace(/\+/g, ' ')).trim().toUpperCase();
    } catch {
        return '';
    }
}

/**
 * Open each Seller Hub order details link and return orders in the same shape as ebay-payout-puppeteer
 * extraction (for payoutRowsFromOrdersWithRoyalMail: rows[].earningsText, ref/tracking on order).
 */
async function extractPayoutOrdersForAuditBatch(browser, entries, refererUrl) {
    const { gotoEbayOrderDetailsPage, extractOrderDetailsFromPage, sleep: sleepOrd } = orderDetailsRead;
    const orderPage = await browser.newPage();
    const orders = [];
    const fallbackSkipped = [];
    try {
        for (let i = 0; i < entries.length; i++) {
            const { href, orderNumber } = entries[i];
            const idHint = orderNumber || `idx-${i}`;
            try {
                await gotoEbayOrderDetailsPage(orderPage, href, refererUrl);
                await orderPage
                    .waitForFunction(
                        () => {
                            const t = (document.body && document.body.innerText) || '';
                            return /order earnings|custom sku|quantity|sold/i.test(t);
                        },
                        { timeout: 15000 },
                    )
                    .catch(() => {});
                await sleepOrd(800);
                const data = await extractOrderDetailsFromPage(orderPage);
                const oid = canonicalEbayOrderId(data.orderNumber) || canonicalEbayOrderId(orderNumber);
                if (!data.rows || !data.rows.length) {
                    console.warn(`Audit: order ${idHint}: no line items parsed — skipped (no payout rows).`);
                    fallbackSkipped.push({
                        orderNumber: oid || String(orderNumber || '').trim() || idHint,
                        reason: 'No line items extracted from order page',
                    });
                    continue;
                }
                orders.push({
                    orderNumber: oid || orderNumber,
                    referenceNumber: data.referenceNumber || '',
                    trackingNumber: data.trackingNumber || '',
                    rows: data.rows,
                });
            } catch (e) {
                const msg = String(e.message || e);
                console.warn(`Audit: order ${idHint}: ${msg}`);
                fallbackSkipped.push({
                    orderNumber: canonicalEbayOrderId(orderNumber) || String(orderNumber || '').trim() || idHint,
                    reason: msg,
                });
            }
        }
    } finally {
        await orderPage.close().catch(() => {});
    }
    return { orders, fallbackSkipped };
}

/** Paste TSV rows into an already-open sheet tab (no DOM duplicate scan). */
async function pasteTsvRowsStartingAt(sheetPage, sheetUrl, tsvRows, startRow) {
    if (!tsvRows.length) return;
    const jumpRef = `A${startRow}`;
    await goToSheetRangeForPaste(sheetPage, sheetUrl, jumpRef);
    await sheetPage.evaluate(() => {
        const app = document.querySelector('[role="application"]');
        if (app instanceof HTMLElement) app.focus();
    });
    await sleep(120);
    await sheetPage.keyboard.press('Escape');
    await sleep(80);
    await sheetPage.keyboard.press('Escape');
    await sleep(80);

    const sheetPasteWarnState = { sheetCellRowUnreadable: false };
    let loggedOsClipboard = false;
    for (let r = 0; r < tsvRows.length; r++) {
        const absRow = Math.max(SHEET_FIRST_DATA_ROW, startRow + r);
        if (r > 0) {
            await sheetPage.keyboard.press('Home');
            await sleep(50);
            await sheetPage.keyboard.press('ArrowDown');
            await sleep(140);
        }
        await clickSheetCellForPaste(sheetPage, absRow, 1);
        await assertActiveCellIsDataRow(sheetPage, absRow, `Audit paste row ${r + 1}/${tsvRows.length} (A${absRow})`, sheetPasteWarnState);

        const line = tsvLineForOneRow(tsvRows[r]);
        let usedOsClipboard = copyTextToOsClipboardSync(line);
        if (!usedOsClipboard) {
            await copyTextForBrowserPaste(sheetPage, line);
            await clickSheetCellForPaste(sheetPage, absRow, 1);
        } else if (!loggedOsClipboard) {
            loggedOsClipboard = true;
            console.log('Sheet: pasting via OS clipboard (Windows clip).');
        }

        await sheetPage.bringToFront();
        await sleep(usedOsClipboard ? 120 : 40);
        const pasteMod = process.platform === 'darwin' ? 'Meta' : 'Control';
        await sheetPage.keyboard.down(pasteMod);
        await sheetPage.keyboard.press('KeyV');
        await sheetPage.keyboard.up(pasteMod);
        await sleep(260);
        await sheetPage.keyboard.press('Escape');
        await sleep(80);
    }
}

function copyTextToOsClipboardSync(text) {
    const s = String(text ?? '');
    if (process.platform === 'win32') {
        try {
            const normalized = s.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
            const bom = Buffer.from([0xff, 0xfe]);
            const body = Buffer.from(normalized, 'utf16le');
            const r = spawnSync('clip', [], { input: Buffer.concat([bom, body]), maxBuffer: 10 * 1024 * 1024 });
            return r.status === 0 && !r.error;
        } catch {
            return false;
        }
    }
    if (process.platform === 'darwin') {
        try {
            const r = spawnSync('pbcopy', [], { input: Buffer.from(s, 'utf8'), maxBuffer: 10 * 1024 * 1024 });
            return r.status === 0 && !r.error;
        } catch {
            return false;
        }
    }
    if (process.platform === 'linux') {
        try {
            const wl = spawnSync('wl-copy', [], { input: Buffer.from(s, 'utf8'), maxBuffer: 10 * 1024 * 1024 });
            if (wl.status === 0 && !wl.error) return true;
        } catch {
            /* ignore */
        }
        try {
            const x = spawnSync('xclip', ['-selection', 'clipboard'], {
                input: Buffer.from(s, 'utf8'),
                maxBuffer: 10 * 1024 * 1024,
            });
            return x.status === 0 && !x.error;
        } catch {
            return false;
        }
    }
    return false;
}

/**
 * Row 1 header: find the column that looks like "order number" (not always aria-colindex 2 — frozen panes / extra cols).
 */
async function detectOrderNumberColumnIndex(sheetPage) {
    const idx = await sheetPage.evaluate(() => {
        let best = 2;
        for (const cell of document.querySelectorAll('[role="gridcell"]')) {
            if (Number(cell.getAttribute('aria-rowindex')) !== 1) continue;
            const t = (cell.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!t) continue;
            if (/order\s*(number|no\.?|id|#)?/i.test(t) || /^order$/i.test(t)) {
                const ci = Number(cell.getAttribute('aria-colindex') || '0');
                if (Number.isFinite(ci) && ci >= 1) best = ci;
            }
        }
        return best;
    });
    return idx;
}

/** Scan one viewport: all cells in column `colIndex` (by aria-colindex) with eBay-style order ids. */
async function scanOrderColumnViewport(sheetPage, colIndex) {
    return sheetPage.evaluate(
        ({ firstDataRow, colIndex: ci }) => {
            const STRICT = /^\d{2,4}-\d{4,7}-\d{4,7}$/i;
            const SUB = /\d{2,4}-\d{4,7}-\d{4,7}/i;
            function canon(raw) {
                let s = String(raw || '')
                    .replace(/^['\u2018\u2019]+/, '')
                    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
                    .replace(/\s+/g, '')
                    .trim();
                if (STRICT.test(s)) return s.toUpperCase();
                const m = s.match(SUB);
                return m ? m[0].toUpperCase() : '';
            }
            const nums = [];
            let lastOrderRow = 0;
            for (const cell of document.querySelectorAll('[role="gridcell"]')) {
                const col = Number(cell.getAttribute('aria-colindex') || '0');
                const ri = Number(cell.getAttribute('aria-rowindex') || '0');
                if (col !== ci || ri < firstDataRow) continue;
                const raw = (cell.innerText != null ? cell.innerText : '') || cell.textContent || '';
                const v = canon(raw);
                if (v) {
                    nums.push(v);
                    lastOrderRow = Math.max(lastOrderRow, ri);
                }
            }
            const appendRow = lastOrderRow === 0 ? firstDataRow : lastOrderRow + 1;
            return { existingOrderNumbers: nums, appendRow };
        },
        { firstDataRow: SHEET_FIRST_DATA_ROW, colIndex },
    );
}

/**
 * If column-specific scan finds nothing, sweep visible grid for eBay order-shaped tokens (embedded text OK).
 */
async function sweepVisibleGridForOrderIds(sheetPage) {
    return sheetPage.evaluate((firstDataRow) => {
        const STRICT = /^\d{2,4}-\d{4,7}-\d{4,7}$/i;
        const SUB = /\d{2,4}-\d{4,7}-\d{4,7}/i;
        const MAX_COL = 30;
        function canon(raw) {
            let s = String(raw || '')
                .replace(/^['\u2018\u2019]+/, '')
                .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
                .replace(/\s+/g, '')
                .trim();
            if (STRICT.test(s)) return s.toUpperCase();
            const m = s.match(SUB);
            return m ? m[0].toUpperCase() : '';
        }
        const nums = [];
        let lastOrderRow = 0;
        for (const cell of document.querySelectorAll('[role="gridcell"]')) {
            const col = Number(cell.getAttribute('aria-colindex') || '0');
            const ri = Number(cell.getAttribute('aria-rowindex') || '0');
            if (ri < firstDataRow || col < 1 || col > MAX_COL) continue;
            const raw = (cell.innerText != null ? cell.innerText : '') || cell.textContent || '';
            const v = canon(raw);
            if (v) {
                nums.push(v);
                lastOrderRow = Math.max(lastOrderRow, ri);
            }
        }
        const appendRow = lastOrderRow === 0 ? firstDataRow : lastOrderRow + 1;
        return { existingOrderNumbers: nums, appendRow };
    }, SHEET_FIRST_DATA_ROW);
}

/** When no IDs match, log a few raw grid cells so we can see format / empty DOM. */
async function warnSheetGridDebugSamples(sheetPage) {
    const d = await sheetPage.evaluate((firstDataRow) => {
        const cells = [...document.querySelectorAll('[role="gridcell"]')];
        const interesting = cells
            .filter((c) => {
                const ri = Number(c.getAttribute('aria-rowindex') || '0');
                return ri >= firstDataRow && ri <= firstDataRow + 30;
            })
            .slice(0, 24);
        return {
            gridCellCount: cells.length,
            samples: interesting.map((c) => ({
                r: c.getAttribute('aria-rowindex'),
                col: c.getAttribute('aria-colindex'),
                inner: String((c.innerText || '').replace(/\s+/g, ' ').trim()).slice(0, 80),
                text: String((c.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 80),
            })),
        };
    }, SHEET_FIRST_DATA_ROW);
    console.warn(
        `Audit: no order IDs matched in the visible grid (${d.gridCellCount} gridcell(s) in DOM). Sample data rows (for debugging):`,
    );
    for (const s of d.samples.slice(0, 8)) {
        console.warn(`  row ${s.r} col ${s.col}: innerText=${JSON.stringify(s.inner)} textContent=${JSON.stringify(s.text)}`);
    }
    console.warn(
        '  Tip: Live sheet scan only sees rendered rows (~top and bottom). For a full column use --sheet-csv or --fetch-sheet-csv.',
    );
}

async function readDuplicateOrdersDomMerged(sheetPage) {
    await sheetPage.click('[role="grid"], div.docs-sheet-container').catch(() => {});
    await sleep(200);
    const colIdx = await detectOrderNumberColumnIndex(sheetPage);
    console.log(`Audit: detected “order number” column aria-colindex=${colIdx} (header row).`);

    await sheetPage.keyboard.down('Control');
    await sheetPage.keyboard.press('Home');
    await sheetPage.keyboard.up('Control');
    await sleep(650);
    let top = await scanOrderColumnViewport(sheetPage, colIdx);
    if (!top.existingOrderNumbers.length) {
        const sweep = await sweepVisibleGridForOrderIds(sheetPage);
        if (sweep.existingOrderNumbers.length) {
            console.log(
                'Audit: no ids in detected column — using visible-grid sweep for eBay order pattern (cols 1–12).',
            );
            top = sweep;
        }
    }

    await sheetPage.keyboard.down('Control');
    await sheetPage.keyboard.press('End');
    await sheetPage.keyboard.up('Control');
    await sleep(700);
    let end = await scanOrderColumnViewport(sheetPage, colIdx);
    if (!end.existingOrderNumbers.length) {
        const sweepEnd = await sweepVisibleGridForOrderIds(sheetPage);
        if (sweepEnd.existingOrderNumbers.length) {
            console.log('Audit: bottom viewport — using grid sweep for order ids.');
            end = sweepEnd;
        }
    }

    const appendRow = Math.max(top.appendRow, end.appendRow);
    const mergedNums = [...new Set([...top.existingOrderNumbers, ...end.existingOrderNumbers])];
    if (!mergedNums.length) {
        await warnSheetGridDebugSamples(sheetPage);
    }
    return { appendRow, existingOrderNumbers: mergedNums, topAppend: top.appendRow, endAppend: end.appendRow, orderColIndex: colIdx };
}

async function copyTextForBrowserPaste(sheetPage, text) {
    const viaApi = await sheetPage.evaluate(async (t) => {
        try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(t);
                return true;
            }
        } catch {
            /* fall through */
        }
        return false;
    }, text);
    if (viaApi) return;

    const ok = await sheetPage.evaluate((t) => {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(ta);
        return copied;
    }, text);
    if (!ok) throw new Error('Could not copy row to clipboard (execCommand copy failed).');
}

async function clickSheetCellForPaste(sheetPage, rowIndex, colIndex = 1) {
    await sheetPage.bringToFront();
    const sel = `[role="gridcell"][aria-rowindex="${rowIndex}"][aria-colindex="${colIndex}"]`;
    const h = await sheetPage.$(sel);
    if (h) {
        try {
            const box = await h.boundingBox();
            if (box && box.width > 2 && box.height > 2) {
                const cx = box.x + box.width * 0.5;
                const cy = box.y + box.height * 0.5;
                await sheetPage.mouse.move(cx, cy);
                await sleep(35);
                await sheetPage.mouse.click(cx, cy, { delay: 30, clickCount: 1 });
            } else {
                await h.click({ delay: 40 });
            }
        } finally {
            await h.dispose().catch(() => {});
        }
        await sleep(280);
        return;
    }

    const pt = await sheetPage.evaluate(
        (row, col) => {
            const cell = document.querySelector(`[role="gridcell"][aria-rowindex="${row}"][aria-colindex="${col}"]`);
            if (!(cell instanceof HTMLElement)) return null;
            cell.scrollIntoView({ block: 'center', inline: 'nearest' });
            const r = cell.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) return null;
            return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 };
        },
        rowIndex,
        colIndex,
    );
    if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
        await sheetPage.mouse.move(pt.x, pt.y);
        await sleep(35);
        await sheetPage.mouse.click(pt.x, pt.y, { delay: 30, clickCount: 1 });
        await sleep(280);
        return;
    }

    await sheetPage.evaluate(
        (row, col) => {
            const cell = document.querySelector(`[role="gridcell"][aria-rowindex="${row}"][aria-colindex="${col}"]`);
            if (cell instanceof HTMLElement) {
                cell.scrollIntoView({ block: 'center', inline: 'nearest' });
                cell.click();
                return;
            }
            const app = document.querySelector('[role="application"]');
            if (app instanceof HTMLElement) app.focus();
            const grid = document.querySelector('.docs-sheet-grid-container') || document.querySelector('[role="grid"]');
            if (grid instanceof HTMLElement) {
                grid.scrollIntoView({ block: 'center', inline: 'nearest' });
                grid.click();
            }
        },
        rowIndex,
        colIndex,
    );
    await sleep(280);
}

async function readActiveSheetGridIndices(sheetPage) {
    return sheetPage.evaluate(() => {
        const tryCell = (el) => {
            if (!el || !el.getAttribute) return null;
            const ri = Number(el.getAttribute('aria-rowindex') || '0');
            const ci = Number(el.getAttribute('aria-colindex') || '0');
            if (!Number.isFinite(ri) || !Number.isFinite(ci) || ri < 1 || ci < 1) return null;
            return { ri, ci };
        };
        const ordered = [
            () => document.querySelector('[role="gridcell"][aria-selected="true"]'),
            () => document.querySelector('[role="gridcell"][aria-current="true"]'),
            () => document.querySelector('[role="gridcell"][aria-current="cell"]'),
            () => {
                const ed = document.querySelector('[contenteditable="true"]');
                return ed && ed.closest ? ed.closest('[role="gridcell"]') : null;
            },
            () => {
                const root = document.querySelector('#waffle-rich-text-editor, .cell-input, textarea.cell-input');
                return root && root.closest ? root.closest('[role="gridcell"]') : null;
            },
            () => {
                for (const c of document.querySelectorAll('[role="gridcell"]')) {
                    if (c.matches(':focus-within')) return c;
                }
                return null;
            },
            () => {
                const a = document.activeElement;
                return a && a.closest ? a.closest('[role="gridcell"]') : null;
            },
        ];
        for (const pick of ordered) {
            const cell = pick();
            const out = tryCell(cell);
            if (out) return out;
        }
        return { ri: 0, ci: 0 };
    });
}

async function goToSheetRangeForPaste(sheetPage, sheetUrl, a1Ref) {
    const ref = String(a1Ref || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '');
    if (!/^[A-Z]{1,3}\d{1,9}$/.test(ref)) {
        console.warn(`Sheet: invalid range "${a1Ref}" — using URL hash only.`);
        await sheetPage.goto(withSheetRange(sheetUrl, String(a1Ref)), { waitUntil: 'domcontentloaded', timeout: 120000 });
        await sheetPage.waitForSelector('[role="grid"], div.docs-sheet-container', { timeout: 120000 });
        await sleep(600);
        return;
    }

    await sheetPage.bringToFront();
    await sleep(120);
    await sheetPage.keyboard.press('Escape');
    await sleep(100);

    const nameHandle = await sheetPage.$(SHEET_NAME_BOX_SELECTOR);
    if (!nameHandle) {
        console.warn('Sheet: name box not found — falling back to URL #range= navigation.');
        await sheetPage.goto(withSheetRange(sheetUrl, ref), { waitUntil: 'domcontentloaded', timeout: 120000 });
        await sheetPage.waitForSelector('[role="grid"], div.docs-sheet-container', { timeout: 120000 });
        await sleep(600);
        return;
    }

    try {
        await nameHandle.click({ clickCount: 2, delay: 40 });
        await sleep(80);
        const selMod = process.platform === 'darwin' ? 'Meta' : 'Control';
        await sheetPage.keyboard.down(selMod);
        await sheetPage.keyboard.press('KeyA');
        await sheetPage.keyboard.up(selMod);
        await sleep(50);
        await sheetPage.keyboard.type(ref, { delay: 12 });
        await sleep(100);
        await sheetPage.keyboard.press('Enter');
    } finally {
        await nameHandle.dispose().catch(() => {});
    }
    await sheetPage.waitForSelector('[role="grid"], div.docs-sheet-container', { timeout: 120000 });
    await sleep(550);
}

async function assertActiveCellIsDataRow(sheetPage, expectedRow, label, warnState) {
    const { ri, ci } = await readActiveSheetGridIndices(sheetPage);
    if (ri === 1) {
        throw new Error(
            `${label}: selection is on row 1 (table headers). Click cell A${expectedRow} in the sheet, close Find if it is open, then retry.`,
        );
    }
    if (ri >= SHEET_FIRST_DATA_ROW) {
        if (Number.isFinite(expectedRow) && ri !== expectedRow) {
            console.warn(`${label}: expected row ${expectedRow}, grid reports row ${ri} — continuing.`);
        }
        if (ci !== 1) {
            await sheetPage.keyboard.press('Home');
            await sleep(80);
        }
        return;
    }
    if (warnState && !warnState.sheetCellRowUnreadable) {
        warnState.sheetCellRowUnreadable = true;
        console.warn(
            'Sheet: could not read active cell row (Insert→Table / canvas). Continuing — keep the Chrome window visible; paste uses the OS clipboard + Ctrl+V.',
        );
    }
}

async function getOrOpenSheetPage(browser, sheetUrl, options = {}) {
    const jumpRange = options.jumpRange || 'A1';
    console.log(
        options.openingMessage ||
            'Audit: loading Google Sheet — if you see a Google sign-in, complete it in the Chrome window…',
    );
    const targetDocIdMatch = String(sheetUrl).match(/\/spreadsheets\/d\/([^/]+)/i);
    const targetDocId = targetDocIdMatch ? targetDocIdMatch[1] : '';
    const pages = await browser.pages();
    let sheetPage =
        pages.find((p) => {
            const u = p.url() || '';
            return targetDocId ? u.includes(`/spreadsheets/d/${targetDocId}`) : u.includes('docs.google.com/spreadsheets/');
        }) || null;
    let openedNew = false;
    if (!sheetPage) {
        sheetPage = await browser.newPage();
        openedNew = true;
        await sheetPage.goto(withSheetRange(sheetUrl, jumpRange), { waitUntil: 'domcontentloaded', timeout: 120000 });
    } else {
        await sheetPage.bringToFront();
        await sheetPage.goto(withSheetRange(sheetUrl, jumpRange), { waitUntil: 'domcontentloaded', timeout: 120000 });
    }
    await sheetPage.waitForSelector('[role="grid"], div.docs-sheet-container', { timeout: 120000 });
    await sheetPage.waitForSelector('[role="gridcell"]', { timeout: 120000 }).catch(() => {});
    await sleep(900);
    return { sheetPage, openedNew };
}

async function readColumnBOrderIdSetBrowser(browser, sheetUrl) {
    const { sheetPage, openedNew } = await getOrOpenSheetPage(browser, sheetUrl, { jumpRange: 'B2' });
    await sleep(400);
    console.log('Audit: scanning for order IDs (Ctrl+Home / Ctrl+End) — often 15–90s on large sheets…');
    const merged = await readDuplicateOrdersDomMerged(sheetPage);
    const set = new Set(merged.existingOrderNumbers.map((x) => canonicalEbayOrderId(x)).filter(Boolean));
    if (openedNew) await sheetPage.close().catch(() => {});
    return { set, appendHint: merged.appendRow };
}

/**
 * @param {{ csvSnapshot?: { orderIdSet: Set<string>, nextAppendRow: number, csvPath?: string } }} options
 *        When set (after --fetch-sheet-csv / --sheet-csv), skip DOM scan for row index and use CSV-derived next row.
 */
async function appendRowsBrowser(browser, sheetUrl, rows, options = {}) {
    if (!rows.length) return 0;
    const snap = options.csvSnapshot;
    const { sheetPage, openedNew } = await getOrOpenSheetPage(browser, sheetUrl, {
        jumpRange: 'B2',
        openingMessage: snap
            ? 'Audit: opening Google Sheet to paste rows (CSV snapshot already compared — no column re-scan)…'
            : undefined,
    });
    await sleep(400);

    let startRow = SHEET_FIRST_DATA_ROW;
    let existingSet = new Set();
    if (snap && snap.orderIdSet instanceof Set && Number.isFinite(snap.nextAppendRow)) {
        startRow = Math.max(SHEET_FIRST_DATA_ROW, snap.nextAppendRow);
        existingSet = snap.orderIdSet;
        console.log(
            `Audit (browser): append using CSV snapshot — next empty row A${startRow} (${existingSet.size} order id(s) from CSV).`,
        );
    } else {
        const domMerged = await readDuplicateOrdersDomMerged(sheetPage);
        startRow = Math.max(SHEET_FIRST_DATA_ROW, domMerged.appendRow);
        existingSet = new Set(domMerged.existingOrderNumbers.map((x) => canonicalEbayOrderId(x)).filter(Boolean));
    }

    const rowsToWrite = rows.filter((r) => !existingSet.has(canonicalEbayOrderId(r.orderNumber)));
    if (!rowsToWrite.length) {
        if (openedNew) await sheetPage.close().catch(() => {});
        return 0;
    }

    const tsvRows = rowsToWrite.map((r) => cellsForPayoutSheetTable(r));
    console.log(`Audit (browser): pasting ${tsvRows.length} row(s) from A${startRow}.`);

    const jumpRef = `A${startRow}`;
    await goToSheetRangeForPaste(sheetPage, sheetUrl, jumpRef);
    await sheetPage.evaluate(() => {
        const app = document.querySelector('[role="application"]');
        if (app instanceof HTMLElement) app.focus();
    });
    await sleep(120);
    await sheetPage.keyboard.press('Escape');
    await sleep(80);
    await sheetPage.keyboard.press('Escape');
    await sleep(80);

    const sheetPasteWarnState = { sheetCellRowUnreadable: false };
    let loggedOsClipboard = false;
    for (let r = 0; r < tsvRows.length; r++) {
        const absRow = Math.max(SHEET_FIRST_DATA_ROW, startRow + r);
        if (r > 0) {
            await sheetPage.keyboard.press('Home');
            await sleep(50);
            await sheetPage.keyboard.press('ArrowDown');
            await sleep(140);
        }
        await clickSheetCellForPaste(sheetPage, absRow, 1);
        await assertActiveCellIsDataRow(sheetPage, absRow, `Audit paste row ${r + 1}/${tsvRows.length} (A${absRow})`, sheetPasteWarnState);

        const line = tsvLineForOneRow(tsvRows[r]);
        let usedOsClipboard = copyTextToOsClipboardSync(line);
        if (!usedOsClipboard) {
            await copyTextForBrowserPaste(sheetPage, line);
            await clickSheetCellForPaste(sheetPage, absRow, 1);
        } else if (!loggedOsClipboard) {
            loggedOsClipboard = true;
            console.log('Sheet: pasting via OS clipboard (Windows clip).');
        }

        await sheetPage.bringToFront();
        await sleep(usedOsClipboard ? 120 : 40);
        const pasteMod = process.platform === 'darwin' ? 'Meta' : 'Control';
        await sheetPage.keyboard.down(pasteMod);
        await sheetPage.keyboard.press('KeyV');
        await sheetPage.keyboard.up(pasteMod);
        await sleep(260);
        await sheetPage.keyboard.press('Escape');
        await sleep(80);
    }

    if (openedNew) {
        console.log('Audit: opened Google Sheet tab for paste; leaving it open.');
    }
    return rowsToWrite.length;
}

function parseArgs(argv) {
    const out = {
        browserUrl: process.env.BROWSER_CDP_URL || 'http://127.0.0.1:9222',
        sheetUrl: null,
        ebayListUrl: null,
        maxPages: 100,
        sheetCsv: null,
        /** 1-based column: 2 = B */
        sheetCsvColumn: 2,
        /** 1-based first row to treat as data (default 2 = skip one header row) */
        sheetCsvFromRow: 2,
        fetchSheetCsv: false,
        sheetCsvOutput: null,
        /** How many order-detail pages to load before pasting a block (default 100). */
        detailBatch: 100,
        /** Do not write .ebay-list-audit-new-orders-only.csv (legacy: --skip-local-csv-append). */
        skipNewRowsCsv: false,
        newRowsCsvOutput: null,
        sheetBrowserOnly: false,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--browser-url' && argv[i + 1]) out.browserUrl = argv[++i];
        else if (a === '--sheet-url' && argv[i + 1]) out.sheetUrl = argv[++i];
        else if (a === '--ebay-list-url' && argv[i + 1]) out.ebayListUrl = argv[++i];
        else if (a === '--max-pages' && argv[i + 1]) out.maxPages = Math.max(1, parseInt(argv[++i], 10) || 100);
        else if (a === '--fetch-sheet-csv') out.fetchSheetCsv = true;
        else if (a === '--sheet-csv-output' && argv[i + 1]) out.sheetCsvOutput = argv[++i];
        else if (a === '--detail-batch' && argv[i + 1]) out.detailBatch = Math.max(1, parseInt(argv[++i], 10) || 100);
        else if (a === '--skip-local-csv-append' || a === '--no-new-rows-csv') out.skipNewRowsCsv = true;
        else if (a === '--new-rows-csv-output' && argv[i + 1]) out.newRowsCsvOutput = argv[++i];
        else if (a === '--sheet-browser-only') out.sheetBrowserOnly = true;
        else if (a === '--sheet-csv' && argv[i + 1]) out.sheetCsv = argv[++i];
        else if (a === '--sheet-csv-column' && argv[i + 1]) {
            const v = argv[++i];
            if (/^[A-Za-z]+$/.test(String(v).trim())) {
                out.sheetCsvColumn = columnLettersToOneBased(v);
            } else {
                out.sheetCsvColumn = Math.max(1, parseInt(v, 10) || 2);
            }
        } else if (a === '--sheet-csv-from-row' && argv[i + 1]) {
            out.sheetCsvFromRow = Math.max(1, parseInt(argv[++i], 10) || 2);
        } else if (a === '--help' || a === '-h') out.help = true;
    }
    return out;
}

function help() {
    console.log(`Usage: node scripts/ebay-list-sheet-audit.js [options]

Compares Seller Hub order links to a sheet snapshot (CSV or DOM), opens only missing orders, then runs the same
Royal Mail postage merge + per-line payout math + writeRowsToSheet path as ebay-payout-puppeteer.

Also writes a small CSV of only this run’s new rows (default .ebay-list-audit-new-orders-only.csv), not merged into the downloaded sheet export.

Royal Mail: same as npm run ebay:payout:browser — merges the five default filenames plus every ManifestedOrdersReport*.xls(x)
  in Downloads (DOWNLOADS_DIR) and in RM_MANIFEST_DIRS (semicolon-separated extra folders). RM_MANIFEST_PATHS / RM_XLS_PATH override. GOOGLE_SERVICE_ACCOUNT_JSON for postage-missing queue API.

Prerequisite: npm run ebay:chrome  (logged into eBay + Google in that Chrome)

Options:
  --browser-url <url>     CDP (default http://127.0.0.1:9222)
  --ebay-list-url <url>   Seller Hub list URL
  --sheet-url <url>       Google Sheet URL
  --sheet-csv <path>      Use a CSV file you already have (full column, no DOM limits)
  --fetch-sheet-csv       Download the sheet as CSV in Chrome (logged-in Google), then compare
  --sheet-csv-output <path>  Where to save that download (default: .ebay-list-audit-sheet.csv in cwd).
                             Missing order links: <basename>-missing-order-links.csv
  --new-rows-csv-output <path>  Only this run’s missing-order rows (default .ebay-list-audit-new-orders-only.csv)
  --no-new-rows-csv       Do not write the new-rows-only CSV (--skip-local-csv-append is an alias)
  --sheet-browser-only    Force browser paste (same as ebay-payout-puppeteer)
  --sheet-csv-column <n|letters>  CSV column for order ids (default 2 = B). Example: B or 2
  --sheet-csv-from-row <n>        First data row, 1-based (default 2 = skip one header row)
  --detail-batch <n>      Seller Hub detail pages per batch; after each batch, writeRowsToSheet that batch (default 100)
  --max-pages <n>         Max list pagination (default 100)

Env:
  GOOGLE_SHEET_URL
  SHEET_CSV_PATH            Same as --sheet-csv if set
  EBAY_PAYOUT_SHEET_BROWSER_ONLY=1   Same as --sheet-browser-only
  DOWNLOADS_DIR, RM_MANIFEST_DIRS, RM_MANIFEST_PATHS, RM_XLS_PATH   Royal Mail manifest discovery (see ebay-payout-puppeteer help)
  RM_POSTAGE_QUEUE_SHEET_URL, RM_POSTAGE_QUEUE_ORDER_NUMBERS_ONLY   Postage-missing queue (default doc: order numbers only with =1)
`);
}

async function collectOrderLinksFromListPage(page, maxPages) {
    const collected = [];
    const seen = new Set();
    let pageCount = 0;
    while (pageCount < maxPages) {
        pageCount++;
        await sleep(1200);
        const bodyText = await page.evaluate(() => (document.body ? document.body.innerText : ''));
        if (/verify yourself|security measure|Please verify yourself/i.test(bodyText)) {
            throw new Error(
                'eBay showed a verification / security page. Complete it in Chrome, then rerun this script.',
            );
        }

        const pageData = await page.evaluate(() => {
            const ORDER_ID_RE = /^\d{2,4}-\d{4,6}-\d{4,6}$/;
            const root = document.querySelector('#mainGridContainer') || document;
            const orders = [];
            for (const a of root.querySelectorAll('a[href*="/mesh/ord/details"]')) {
                const href = a.getAttribute('href') || '';
                const text = (a.textContent || '').trim();
                let abs;
                try {
                    abs = new URL(href, location.href);
                } catch {
                    continue;
                }
                const pathLooksRight = /\/mesh\/ord\/details/i.test(abs.pathname);
                const orderIdParam = (abs.searchParams.get('orderid') || '').trim();
                const candidateOrderId = ORDER_ID_RE.test(orderIdParam) ? orderIdParam : text;
                const textLooksLikeOrder = ORDER_ID_RE.test(text);
                if (!pathLooksRight) continue;
                if (!ORDER_ID_RE.test(candidateOrderId)) continue;
                if (!textLooksLikeOrder && !ORDER_ID_RE.test(orderIdParam)) continue;
                orders.push({ orderId: candidateOrderId.toUpperCase(), href: abs.href });
            }
            const nextLink =
                document.querySelector('a.pagination__next[href]') ||
                document.querySelector('a[type="next"][href]') ||
                Array.from(document.querySelectorAll('a[href]')).find((a) =>
                    /next page of results/i.test((a.getAttribute('aria-label') || '').trim()),
                );
            const nextHref = nextLink ? new URL(nextLink.getAttribute('href') || '', location.href).href : '';
            const nextDisabled = !!(
                nextLink &&
                (nextLink.getAttribute('aria-disabled') === 'true' ||
                    nextLink.classList.contains('disabled') ||
                    nextLink.hasAttribute('disabled'))
            );
            return { orders, nextHref, nextDisabled };
        });

        for (const o of pageData.orders) {
            if (seen.has(o.orderId)) continue;
            seen.add(o.orderId);
            collected.push(o.href);
        }
        console.log(`Audit: collected ${collected.length} unique order link(s) after list page ${pageCount}.`);

        if (!pageData.nextHref || pageData.nextDisabled) break;
        await page.goto(pageData.nextHref, { waitUntil: 'domcontentloaded', timeout: 120000 });
    }
    return collected;
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help) return help();

    const sheetUrl = args.sheetUrl || process.env.GOOGLE_SHEET_URL || DEFAULT_GOOGLE_SHEET_URL;
    const ebayListUrl = args.ebayListUrl || process.env.EBAY_LIST_AUDIT_URL || DEFAULT_EBAY_LIST_URL;
    const sheetCsvPath = (args.sheetCsv || process.env.SHEET_CSV_PATH || '').trim();
    const useCsvManual = Boolean(sheetCsvPath) && !args.fetchSheetCsv;
    const fetchDest = path.resolve(process.cwd(), args.sheetCsvOutput || '.ebay-list-audit-sheet.csv');

    let browser = null;
    async function ensureBrowser() {
        if (browser) return browser;
        console.log(`Audit: checking Chrome DevTools at ${args.browserUrl} …`);
        await assertChromeDevToolsReachable(args.browserUrl);
        console.log('Audit: DevTools OK — connecting Puppeteer to your Chrome…');
        browser = await puppeteer.connect({
            browserURL: args.browserUrl,
            defaultViewport: null,
            protocolTimeout: 180000,
        });
        console.log('Audit: connected.');
        return browser;
    }

    console.log(`Audit: eBay list URL:\n  ${ebayListUrl}`);
    if (args.fetchSheetCsv) {
        if (sheetCsvPath) {
            console.warn('Audit: --sheet-csv is ignored when --fetch-sheet-csv is set.');
        }
        console.log(`Audit: Google Sheet:\n  ${sheetUrl}`);
        console.log(`Audit: sheet mode: download CSV →\n  ${fetchDest}`);
    } else if (useCsvManual) {
        const resolved = path.isAbsolute(sheetCsvPath) ? sheetCsvPath : path.join(process.cwd(), sheetCsvPath);
        console.log(`Audit: sheet snapshot (CSV):\n  ${resolved}`);
        console.log(
            `Audit: CSV column ${args.sheetCsvColumn} (1-based), data from row ${args.sheetCsvFromRow} onward`,
        );
    } else {
        console.log(`Audit: Google Sheet:\n  ${sheetUrl}`);
    }
    if (!args.fetchSheetCsv) {
        console.log(`Audit: sheet mode: ${useCsvManual ? 'CSV file' : 'live sheet in Chrome'}`);
    }

    let onSheet = new Set();
    /** When order ids came from CSV/fetch, paste below last CSV row (DOM scan is unreliable for row count). */
    let appendCsvSnapshot = null;

    if (args.fetchSheetCsv) {
        const br = await ensureBrowser();
        console.log('Audit: downloading sheet via Chrome (logged-in Google session)…');
        await downloadSheetCsvViaBrowser(br, sheetUrl, fetchDest);
        console.log(`Audit: CSV saved (${fetchDest}).`);
        onSheet = readOrderIdSetFromCsvFile(fetchDest, args.sheetCsvColumn, args.sheetCsvFromRow);
        console.log(`Audit: ${onSheet.size} order id(s) from downloaded CSV.`);
        appendCsvSnapshot = {
            orderIdSet: new Set(onSheet),
            nextAppendRow: nextAppendRowFromCsvFile(fetchDest, args.sheetCsvFromRow),
            csvPath: fetchDest,
        };
    } else if (useCsvManual) {
        const resolvedCsv = path.isAbsolute(sheetCsvPath) ? sheetCsvPath : path.join(process.cwd(), sheetCsvPath);
        onSheet = readOrderIdSetFromCsvFile(sheetCsvPath, args.sheetCsvColumn, args.sheetCsvFromRow);
        console.log(`Audit: ${onSheet.size} order id(s) from CSV (full file).`);
        appendCsvSnapshot = {
            orderIdSet: new Set(onSheet),
            nextAppendRow: nextAppendRowFromCsvFile(resolvedCsv, args.sheetCsvFromRow),
            csvPath: resolvedCsv,
        };
    } else {
        const br = await ensureBrowser();
        const { set } = await readColumnBOrderIdSetBrowser(br, sheetUrl);
        onSheet = set;
        console.log(
            `Audit: ${onSheet.size} order id(s) seen in column B (browser Home+End scan — not the full sheet if very long).`,
        );
    }

    const br = await ensureBrowser();
    console.log('Audit: opening Seller Hub order list — comparing to sheet snapshot, then appending any missing orders at the bottom…');
    const page = await br.newPage();
    try {
        await page.goto(ebayListUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    } catch {
        await page.goto(ebayListUrl, { waitUntil: 'domcontentloaded', timeout: 180000 });
    }
    if (/signin|login|auth/i.test(page.url())) {
        console.log('eBay sign-in required — complete it in Chrome (waiting up to 4 minutes)...');
        await page.waitForFunction(() => !/signin|login|auth/i.test(location.href), { timeout: 240000 });
        await page.goto(ebayListUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    }

    const bodyPeek = await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 6000));
    if (/please verify yourself|verify yourself to continue/i.test(bodyPeek)) {
        console.log(
            'eBay showed a verification step — complete it in the Chrome window (waiting up to 5 minutes)…',
        );
        await page.waitForFunction(
            () =>
                !/please verify yourself|verify yourself to continue/i.test(
                    document.body ? document.body.innerText.slice(0, 6000) : '',
                ),
            { timeout: 300000 },
        );
        await page.goto(ebayListUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    }

    const hrefs = await collectOrderLinksFromListPage(page, args.maxPages);
    await page.close().catch(() => {});

    const missingEntries = [];
    let already = 0;
    for (const href of hrefs) {
        const oid = canonicalEbayOrderId(orderIdFromEbayDetailsLink(href));
        if (!oid) continue;
        if (onSheet.has(oid)) {
            already++;
            continue;
        }
        onSheet.add(oid);
        missingEntries.push({ href, orderNumber: oid });
    }

    console.log(`Audit: ${already} order(s) already in snapshot; ${missingEntries.length} missing from sheet.`);

    if (!missingEntries.length) {
        console.log('Audit: nothing to append.');
        if (browser) await browser.disconnect().catch(() => {});
        return;
    }

    const missingLinksPath = appendCsvSnapshot?.csvPath
        ? snapshotMissingLinksPath(appendCsvSnapshot.csvPath)
        : path.join(process.cwd(), '.ebay-list-audit-missing-order-links.csv');
    writeMissingOrderLinksFile(missingLinksPath, missingEntries);
    console.log(`Audit: saved ${missingEntries.length} missing order link(s) → ${missingLinksPath}`);

    const detailBatch = Math.max(1, args.detailBatch || 100);
    const sbEnv = String(process.env.EBAY_PAYOUT_SHEET_BROWSER_ONLY || '').trim().toLowerCase();
    const sheetBrowserOnly =
        args.sheetBrowserOnly || sbEnv === '1' || sbEnv === 'true' || sbEnv === 'yes';

    const newRowsCsvPath = args.skipNewRowsCsv
        ? null
        : path.resolve(process.cwd(), args.newRowsCsvOutput || '.ebay-list-audit-new-orders-only.csv');
    if (newRowsCsvPath) {
        initNewOrdersOnlyCsv(newRowsCsvPath);
        console.log(`Audit: new-orders-only CSV (this run, not the full sheet export) → ${newRowsCsvPath}`);
    }

    let totalWritten = 0;
    let totalSkippedDup = 0;
    for (let i = 0; i < missingEntries.length; i += detailBatch) {
        const slice = missingEntries.slice(i, i + detailBatch);
        const hi = Math.min(i + detailBatch, missingEntries.length);
        console.log(`Audit: loading Seller Hub order details for orders ${i + 1}–${hi} of ${missingEntries.length}…`);
        const { orders: ordersPart, fallbackSkipped } = await extractPayoutOrdersForAuditBatch(br, slice, ebayListUrl);
        if (fallbackSkipped.length) {
            await appendOrdersToMainSheetFallbackQueue(fallbackSkipped, br);
            console.log(
                `Audit: queued ${fallbackSkipped.length} order(s) to fallback sheet (could not build payout rows from order page).`,
            );
        }
        if (!ordersPart.length) {
            console.log('Audit: no orders extracted in this batch — skipping Royal Mail / sheet write.');
            continue;
        }
        const { rows: payoutRows, missing: postageMissing } = await payoutRowsFromOrdersWithRoyalMail(br, ordersPart);
        console.log(
            `Audit: ${payoutRows.length} payout row(s) after Royal Mail + rates (${postageMissing.length} order(s) still without postage in this batch).`,
        );
        if (!payoutRows.length) {
            console.log('Audit: nothing to paste for this batch (all orders missing postage or empty).');
            continue;
        }
        console.log('Audit: writing to Google Sheet (ebay-payout-puppeteer writeRowsToSheet)…');
        if (newRowsCsvPath) appendNewOrdersOnlyCsvRows(newRowsCsvPath, payoutRows);
        let sw;
        try {
            sw = await writeRowsToSheet(br, sheetUrl, payoutRows, {
                sheetBrowserOnly,
                ebaySkipOrders: 0,
            });
        } catch (e) {
            const ids = [...new Set(payoutRows.map((r) => canonicalEbayOrderId(r.orderNumber)).filter(Boolean))];
            if (ids.length) {
                await appendOrdersToMainSheetFallbackQueue(
                    ids.map((id) => ({ orderNumber: id, reason: `Main sheet write failed: ${String(e.message || e)}` })),
                    br,
                );
                console.warn(`Audit: queued ${ids.length} order id(s) to fallback sheet after main sheet error.`);
            }
            throw e;
        }
        if (
            payoutRows.length &&
            (sw.writtenRows || 0) === 0 &&
            (sw.skippedDuplicates || 0) > 0
        ) {
            const dupIds = [...new Set(payoutRows.map((r) => canonicalEbayOrderId(r.orderNumber)).filter(Boolean))];
            if (dupIds.length) {
                await appendOrdersToMainSheetFallbackQueue(
                    dupIds.map((id) => ({
                        orderNumber: id,
                        reason:
                            'Duplicate on main sheet (checkpoint + column B scan — no new row appended this batch)',
                    })),
                    br,
                );
                console.log(
                    `Audit: queued ${dupIds.length} order id(s) to fallback queue — payout rows were skipped as duplicate on main sheet.`,
                );
            }
        }
        totalWritten += sw.writtenRows || 0;
        totalSkippedDup += sw.skippedDuplicates || 0;
        console.log(
            `Audit: batch sheet result — wrote ${sw.writtenRows}, skipped ${sw.skippedDuplicates} duplicate(s) (checkpoint + sheet scan).`,
        );
    }
    console.log(
        `Audit: finished — ${totalWritten} row(s) written to Google Sheet total; ${totalSkippedDup} duplicate skip(s) across batches.`,
    );

    if (browser) await browser.disconnect().catch(() => {});
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
