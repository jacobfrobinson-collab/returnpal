#!/usr/bin/env node
'use strict';

/**
 * Manual postage → payout sheet rows (same math as Royal Mail path).
 *
 * Modes:
 *   A) --orders-xlsx PATH — read order ids from the workbook, scan Seller Hub list (all pages), only process
 *      orders whose links appear on that list (real mesh hrefs). Then item name / sold price in terminal,
 *      prompt for postage £, append to Google Sheet or a local .ods/.xlsx (see --output-ods).
 *   B) --orders-file PATH or trailing order ids — open mesh details per id (no list scan).
 *
 * Prereq: `npm run ebay:chrome` (Chrome with CDP on --browser-url). Complete any eBay verification in the browser.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const puppeteer = require('puppeteer-core');
const xlsx = require('xlsx');

try {
    const dotenv = require('dotenv');
    const localEnv = path.join(__dirname, 'ebay-payout-bot.env');
    const rootEnv = path.join(__dirname, '..', '.env');
    if (fs.existsSync(localEnv)) dotenv.config({ path: localEnv });
    if (fs.existsSync(rootEnv)) dotenv.config({ path: rootEnv });
} catch {
    /* optional */
}

const { sleep, gotoEbayOrderDetailsPage, extractOrderDetailsFromPage } = require('./ebay-order-details-read.js');
const {
    writeRowsToSheet,
    payoutRowsFromOrderWithManualPostage,
    cellsForPayoutSheetTable,
    canonicalEbayOrderId,
    orderIdFromEbayDetailsLink,
    collectSellerHubOrderDetailHrefs,
    readCheckpoint,
    reconcileCheckpointWithGoogleSheet,
    connectOptions,
    resolveProtocolTimeoutMs,
    readColumnBStatsFromApi,
} = require('./ebay-payout-puppeteer.js');

const DEFAULT_EBAY_LIST_URL =
    'https://www.ebay.co.uk/sh/ord/?filter=status%3APAID_SHIPPED%2Ctimerange%3APREVIOUSYEAR';
/** Default payout tab for “missing postage” manual runs (override with --sheet-url / GOOGLE_SHEET_URL). */
const DEFAULT_GOOGLE_SHEET_URL =
    'https://docs.google.com/spreadsheets/d/1GFeoSLXKexR7-YIbTcglozzVhtHOa2zeQNT9I8RqdJs/edit?gid=0#gid=0';

function ebayOriginFromListUrl(listUrl) {
    const u = String(listUrl || '').trim();
    try {
        const parsed = new URL(u);
        if (/ebay\.(co\.uk|com)/i.test(parsed.hostname)) return `${parsed.protocol}//${parsed.host}`;
    } catch {
        /* ignore */
    }
    return 'https://www.ebay.co.uk';
}

function meshOrderDetailsUrl(origin, orderId) {
    const base = String(origin || 'https://www.ebay.co.uk').replace(/\/$/, '');
    return `${base}/mesh/ord/details?orderid=${encodeURIComponent(String(orderId).trim())}&source=Orders`;
}

function parseArgs(argv) {
    const out = {
        browserUrl: process.env.BROWSER_CDP_URL || 'http://127.0.0.1:9222',
        sheetUrl: String(process.env.GOOGLE_SHEET_URL || '').trim() || null,
        ebayListUrl: String(process.env.EBAY_ORDERS_LIST_URL || process.env.EBAY_SELLER_HUB_LIST_URL || '').trim() || DEFAULT_EBAY_LIST_URL,
        ordersFile: null,
        ordersXlsx: null,
        ordersXlsxSheet: null,
        /** Inclusive max column index to scan (0=A). Default 25 = A..Z; use --orders-xlsx-column-a-only for A only. */
        ordersXlsxMaxCol: 25,
        /** Same as ebay-payout-puppeteer: API append first unless true (env or --sheet-browser-only). */
        sheetBrowserOnly: false,
        dryRun: false,
        /** Append even when order id is in column B / payout checkpoint (failed paste left a false "written" record). */
        forceSheetAppend:
            /^(1|true|yes)$/i.test(String(process.env.EBAY_MANUAL_POSTAGE_FORCE_APPEND || '').trim()),
        /** Same CDP protocol timeout as ebay-payout-puppeteer (`--protocol-timeout-ms` / env). */
        protocolTimeoutMs: null,
        /** Append A–H rows here instead of Google Sheets (same columns as payout tab). .ods or .xlsx. */
        outputOdsPath: null,
        /** Worksheet tab name inside the output file (default: first sheet, or "Sheet1" when creating file). */
        outputOdsSheet: null,
        extraOrderIds: [],
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--browser-url') out.browserUrl = argv[++i] || out.browserUrl;
        else if (a === '--sheet-url') out.sheetUrl = (argv[++i] || '').trim() || out.sheetUrl;
        else if (a === '--ebay-list-url') out.ebayListUrl = (argv[++i] || '').trim() || out.ebayListUrl;
        else if (a === '--orders-file') out.ordersFile = argv[++i] || null;
        else if (a === '--orders-xlsx') out.ordersXlsx = argv[++i] || null;
        else if (a === '--orders-xlsx-sheet') out.ordersXlsxSheet = argv[++i] || null;
        else if (a === '--orders-xlsx-scan-ab') out.ordersXlsxMaxCol = 1;
        else if (a === '--orders-xlsx-column-a-only') out.ordersXlsxMaxCol = 0;
        else if (a === '--orders-xlsx-max-col-index') {
            const n = parseInt(argv[++i], 10);
            if (Number.isFinite(n) && n >= 0 && n <= 50) out.ordersXlsxMaxCol = n;
        }
        else if (a === '--sheet-browser-only') out.sheetBrowserOnly = true;
        else if (a === '--protocol-timeout-ms' && argv[i + 1]) {
            const n = parseInt(argv[++i], 10);
            if (Number.isFinite(n)) out.protocolTimeoutMs = n;
        }
        else if (a === '--dry-run') out.dryRun = true;
        else if (a === '--output-ods') out.outputOdsPath = (argv[++i] || '').trim() || out.outputOdsPath;
        else if (a === '--output-ods-sheet') out.outputOdsSheet = (argv[++i] || '').trim() || null;
        else if (a === '--help' || a === '-h') out.help = true;
        else if (!a.startsWith('-')) out.extraOrderIds.push(a);
    }
    const sbPayout = String(process.env.EBAY_PAYOUT_SHEET_BROWSER_ONLY || '').trim().toLowerCase();
    const sbLegacy = String(process.env.EBAY_SHEET_BROWSER_ONLY || '').trim().toLowerCase();
    if (sbPayout === '1' || sbPayout === 'true' || sbPayout === 'yes') out.sheetBrowserOnly = true;
    else if (sbLegacy === '1' || sbLegacy === 'true' || sbLegacy === 'yes') out.sheetBrowserOnly = true;

    const envOut = String(process.env.EBAY_MANUAL_POSTAGE_OUTPUT_ODS || '').trim();
    if (envOut && !out.outputOdsPath) out.outputOdsPath = envOut;
    const envOutSheet = String(process.env.EBAY_MANUAL_POSTAGE_OUTPUT_ODS_SHEET || '').trim();
    if (envOutSheet && !out.outputOdsSheet) out.outputOdsSheet = envOutSheet;

    if (out.outputOdsPath) {
        out.outputOdsPath = path.isAbsolute(out.outputOdsPath)
            ? path.normalize(out.outputOdsPath)
            : path.normalize(path.join(process.cwd(), out.outputOdsPath));
        out.sheetUrl = null;
    } else if (!out.sheetUrl) {
        out.sheetUrl = DEFAULT_GOOGLE_SHEET_URL;
    }
    return out;
}

function readOrderIdsFromFile(filePath) {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    if (!fs.existsSync(abs)) throw new Error(`Orders file not found: ${abs}`);
    const raw = fs.readFileSync(abs, 'utf8');
    const ids = [];
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const firstCell = trimmed.split(/[,\t]/)[0].trim();
        const c = canonicalEbayOrderId(firstCell);
        if (c) ids.push(c);
        else if (firstCell) console.warn(`Skipping non–order-id line: ${firstCell.slice(0, 80)}`);
    }
    return ids;
}

function cellDisplay(cell) {
    if (!cell || typeof cell !== 'object') return '';
    if (cell.w != null && String(cell.w).trim() !== '') return String(cell.w).trim();
    if (cell.v === undefined || cell.v === null) return '';
    if (typeof cell.v === 'number' && Number.isFinite(cell.v)) return String(cell.v);
    return String(cell.v).trim();
}

/** Row 1 = optional headers; payout data from row 2 (A–H), same as Google Sheet. */
const LOCAL_PAYOUT_FIRST_DATA_ROW_0BASED = 1;

function safeLocalSheetTabName(name) {
    const s = String(name || 'Sheet1')
        .replace(/[:\\/?*\[\]]/g, '_')
        .trim()
        .slice(0, 31);
    return s || 'Sheet1';
}

function localOutputBookType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.ods') return 'ods';
    if (ext === '.xlsx' || ext === '.xlsm') return 'xlsx';
    throw new Error(`Unsupported local output extension "${ext}" (use .ods or .xlsx): ${filePath}`);
}

function collectOrderIdsColumnB(ws) {
    const ref = ws['!ref'];
    if (!ref) return new Set();
    const range = xlsx.utils.decode_range(ref);
    const out = new Set();
    for (let R = LOCAL_PAYOUT_FIRST_DATA_ROW_0BASED; R <= range.e.r; R++) {
        const addr = xlsx.utils.encode_cell({ r: R, c: 1 });
        const id = canonicalEbayOrderId(cellDisplay(ws[addr]));
        if (id) out.add(id);
    }
    return out;
}

function findNextAppendRow0(ws) {
    const ref = ws['!ref'];
    if (!ref) return LOCAL_PAYOUT_FIRST_DATA_ROW_0BASED;
    const range = xlsx.utils.decode_range(ref);
    let lastFilled = LOCAL_PAYOUT_FIRST_DATA_ROW_0BASED - 1;
    for (let R = LOCAL_PAYOUT_FIRST_DATA_ROW_0BASED; R <= range.e.r; R++) {
        for (let C = 0; C <= 7; C++) {
            const addr = xlsx.utils.encode_cell({ r: R, c: C });
            if (String(cellDisplay(ws[addr])).trim() !== '') {
                lastFilled = Math.max(lastFilled, R);
                break;
            }
        }
    }
    if (lastFilled < LOCAL_PAYOUT_FIRST_DATA_ROW_0BASED) return LOCAL_PAYOUT_FIRST_DATA_ROW_0BASED;
    return lastFilled + 1;
}

function isFileBusyError(err) {
    const code = err && err.code;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return true;
    return /EBUSY|resource busy|locked/i.test(String(err && err.message));
}

const LOCAL_WRITE_RETRY_ATTEMPTS = 16;
const LOCAL_WRITE_RETRY_BASE_MS = 350;

async function writeLocalSpreadsheetWithRetry(filePath, wb, bookType) {
    let lastErr;
    for (let i = 0; i < LOCAL_WRITE_RETRY_ATTEMPTS; i++) {
        try {
            xlsx.writeFile(wb, filePath, { bookType });
            if (i > 0) console.log(`Local spreadsheet: save succeeded after ${i + 1} attempt(s).`);
            return;
        } catch (e) {
            lastErr = e;
            if (!isFileBusyError(e) || i === LOCAL_WRITE_RETRY_ATTEMPTS - 1) throw e;
            const wait = Math.min(5000, Math.floor(LOCAL_WRITE_RETRY_BASE_MS * 1.35 ** i));
            console.warn(
                `Local spreadsheet: file in use (${e.code || 'busy'}) — retry in ${wait}ms (${i + 1}/${LOCAL_WRITE_RETRY_ATTEMPTS}). Close "${path.basename(filePath)}" in LibreOffice/Excel (or save elsewhere) so ReturnPal can write.`,
            );
            await sleep(wait);
        }
    }
    throw lastErr;
}

/**
 * Append payout rows (A–H) to a local .ods or .xlsx (same columns as Google writeRowsToSheet).
 * @returns {Promise<{ writtenRows: number, skippedDuplicates: number }>}
 */
async function appendRowsToLocalSpreadsheet(filePath, payoutRows, opts = {}) {
    const forceAppend = !!opts.forceAppend;
    const wantedSheet = opts.sheetName ? safeLocalSheetTabName(opts.sheetName) : null;
    const bookType = localOutputBookType(filePath);

    let wb;
    if (fs.existsSync(filePath)) {
        let lastRead;
        for (let r = 0; r < 6; r++) {
            try {
                wb = xlsx.readFile(filePath, { cellDates: true });
                break;
            } catch (e) {
                lastRead = e;
                if (!isFileBusyError(e) || r === 5) throw e;
                await sleep(Math.min(3000, 250 * 1.4 ** r));
            }
        }
        if (!wb) throw lastRead;
    } else {
        wb = xlsx.utils.book_new();
        const header = [['order_date', 'order_number', 'item_name', 'custom_label_sku', 'quantity', 'net_earnings', 'client_payout', 'Client ID']];
        const wsNew = xlsx.utils.aoa_to_sheet(header);
        const tab = wantedSheet || 'Sheet1';
        xlsx.utils.book_append_sheet(wb, wsNew, tab);
    }

    let sheetName = wb.SheetNames[0];
    if (wantedSheet && wb.SheetNames.includes(wantedSheet)) sheetName = wantedSheet;
    else if (wantedSheet && !wb.SheetNames.includes(wantedSheet)) {
        console.warn(`Local output: sheet "${wantedSheet}" not found — using first sheet "${wb.SheetNames[0]}".`);
    }

    const ws = wb.Sheets[sheetName];
    if (!ws) throw new Error(`No worksheet in ${filePath}`);

    const existingSet = collectOrderIdsColumnB(ws);
    const rowsToWrite = forceAppend
        ? payoutRows.filter((r) => canonicalEbayOrderId(r.orderNumber))
        : payoutRows.filter((r) => !existingSet.has(canonicalEbayOrderId(r.orderNumber)));
    const skippedDuplicates = payoutRows.length - rowsToWrite.length;

    if (!rowsToWrite.length) {
        return { writtenRows: 0, skippedDuplicates };
    }

    const start0 = findNextAppendRow0(ws);
    const aoa = rowsToWrite.map((r) => cellsForPayoutSheetTable(r));
    xlsx.utils.sheet_add_aoa(ws, aoa, { origin: { r: start0, c: 0 } });

    await writeLocalSpreadsheetWithRetry(filePath, wb, bookType);
    console.log(
        `Local spreadsheet (${bookType.toUpperCase()}): appended ${rowsToWrite.length} row(s) on "${sheetName}" at row ${start0 + 1} → ${filePath}`,
    );
    return { writtenRows: rowsToWrite.length, skippedDuplicates };
}

/** Pull eBay order ids from a cell: plain id, id embedded in text, or orderid= in a URL. */
function extractEbayOrderIdsLoose(raw) {
    const found = [];
    if (raw == null || raw === '') return found;
    const s0 = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : String(raw);
    const normalized = s0.replace(/^\uFEFF/, '').replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-').trim();
    if (!normalized) return found;
    const fromUrl = normalized.match(/orderid=([^&\s#"']+)/i);
    if (fromUrl) {
        try {
            const dec = decodeURIComponent(fromUrl[1].replace(/\+/g, ' '));
            const c = canonicalEbayOrderId(dec) || canonicalEbayOrderId(dec.replace(/\s+/g, ''));
            if (c) found.push(c);
        } catch {
            /* ignore */
        }
    }
    const compact = normalized.replace(/\s+/g, '');
    const hay = compact.length >= 10 ? compact : normalized;
    const matches = hay.match(/\d{2,4}-\d{4,7}-\d{4,7}/gi) || [];
    for (const m of matches) {
        const c = canonicalEbayOrderId(m);
        if (c) found.push(c);
    }
    const alone = canonicalEbayOrderId(compact) || canonicalEbayOrderId(normalized.replace(/\s+/g, ''));
    if (alone) found.push(alone);
    return found;
}

/**
 * @param {string} filePath
 * @param {{ sheetName?: string|null, maxColIndex?: number }} options maxColIndex inclusive (0=A, 25=A..Z)
 */
function readOrderIdsFromXlsx(filePath, options = {}) {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    if (!fs.existsSync(abs)) throw new Error(`XLSX not found: ${abs}`);
    const wb = xlsx.readFile(abs, { cellDates: true });
    const sheetName = options.sheetName || wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    if (!ws) throw new Error(`Sheet "${sheetName}" not found in ${abs} (available: ${wb.SheetNames.join(', ')})`);
    const maxCol = Math.max(0, Math.min(50, Number(options.maxColIndex)));
    if (!Number.isFinite(maxCol)) throw new Error(`Invalid maxColIndex for XLSX read: ${options.maxColIndex}`);

    const ids = new Set();
    const ref = ws['!ref'];
    if (ref) {
        const range = xlsx.utils.decode_range(ref);
        for (let r = range.s.r; r <= range.e.r; r++) {
            for (let c = range.s.c; c <= Math.min(range.e.c, maxCol); c++) {
                const addr = xlsx.utils.encode_cell({ r, c });
                const disp = cellDisplay(ws[addr]);
                for (const id of extractEbayOrderIdsLoose(disp)) ids.add(id);
            }
        }
    }

    const arr = [...ids];
    if (!arr.length) {
        const colLetter = xlsx.utils.encode_col(maxCol);
        console.warn(
            `No eBay order ids found in "${path.basename(abs)}" (sheet "${sheetName}", scanned columns A–${colLetter}). ` +
                `Ids must look like 12-34567-89012, or paste a Seller Hub URL containing orderid=.`,
        );
        if (ref) {
            const range = xlsx.utils.decode_range(ref);
            const sample = [];
            for (let r = range.s.r; r <= Math.min(range.s.r + 4, range.e.r); r++) {
                const cells = [];
                for (let c = range.s.c; c <= Math.min(range.s.c + 7, range.e.c, maxCol); c++) {
                    cells.push(cellDisplay(ws[xlsx.utils.encode_cell({ r, c })]));
                }
                sample.push(cells);
            }
            console.warn('First rows (formatted cell text as read):', JSON.stringify(sample));
        }
    }
    return arr;
}

function parseMoneyLoose(s) {
    const t = String(s || '').replace(/[^\d.,-]/g, '').replace(/,/g, '');
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
}

function createPrompter() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return {
        question: (q) => new Promise((resolve) => rl.question(q, resolve)),
        close: () => rl.close(),
    };
}

function printUsage() {
    console.log(`
ebay-manual-postage-to-sheet.js

  Postage split by line earnings; £0.50 packaging per line; tiered client share (same as payout bot).

  Mode A — XLSX + Seller Hub list (recommended for "missing postage" workbooks):
    --orders-xlsx PATH       Excel: finds ids like 12-34567-89012 in any cell text, or orderid= in URLs
    --orders-xlsx-sheet NAME First sheet by default (use if order numbers are not on the first tab)
    --orders-xlsx-column-a-only   Only scan column A (default scans A–Z)
    --orders-xlsx-scan-ab         Only columns A–B
    --orders-xlsx-max-col-index N Last column index to scan (0=A, 25=Z; default 25)
    --ebay-list-url URL      List to scan (default: Paid & shipped PREVIOUSYEAR UK)
    Script paginates the list, keeps only orders that appear both in the XLSX and on the list, then
    opens each real list link.

  Mode B — plain ids (no list scan):
    --orders-file PATH       One order id per line, or trailing ids on the command line

  Common:
    --browser-url URL        Chrome CDP (default BROWSER_CDP_URL or http://127.0.0.1:9222)
    --protocol-timeout-ms N Same CDP timeout as ebay-payout-puppeteer (optional; see EBAY_PUPPETEER_PROTOCOL_TIMEOUT_MS)
    --output-ods PATH        Append A–H rows to this local .ods or .xlsx instead of Google Sheets (no API key needed).
                             Or set EBAY_MANUAL_POSTAGE_OUTPUT_ODS. Optional tab: --output-ods-sheet NAME or EBAY_MANUAL_POSTAGE_OUTPUT_ODS_SHEET.
                             Close the file in LibreOffice/Excel while this script runs (otherwise Windows may lock it — EBUSY); the script retries saves briefly.
    --sheet-url URL          Google Sheet URL (default if --output-ods not set; override with GOOGLE_SHEET_URL)
    --sheet-browser-only     When using Google Sheets: skip API and paste in the browser only
    When using Google Sheets (no --output-ods), same writeRowsToSheet as ebay-payout-puppeteer.js: set
    GOOGLE_SERVICE_ACCOUNT_JSON (shared spreadsheet + tab) for API append; otherwise browser paste.
    Env EBAY_PAYOUT_SHEET_BROWSER_ONLY=1 forces browser-only (same as payout script); EBAY_SHEET_BROWSER_ONLY is legacy alias.
    --dry-run                No sheet writes
    --force-sheet-append     Write every row even if that order id is already on the sheet or in the payout
                             checkpoint (use after a failed paste still recorded the order as "written").
                             Or set EBAY_MANUAL_POSTAGE_FORCE_APPEND=1

  If eBay shows "Please verify yourself", finish verification in Chrome, then re-run.
`);
}

/**
 * @param {import('puppeteer').Page} orderPage
 * @param {string} href mesh details URL (from list or synthetic)
 * @param {string} referer
 * @param {{ question: (s: string) => Promise<string> }} prompter
 * @param {{ sheetUrl: string, sheetBrowserOnly: boolean, dryRun: boolean }} args
 * @param {{ index: number, total: number, idLabel: string }} meta
 * @returns {Promise<number>} rows written
 */
async function processOneOrder(orderPage, href, referer, prompter, args, meta) {
    const { index, total, idLabel } = meta;
    console.log(`\n--- Order ${index + 1}/${total}: ${idLabel} ---`);

    await gotoEbayOrderDetailsPage(orderPage, href, referer);
    await orderPage
        .waitForFunction(
            () => {
                const t = (document.body && document.body.innerText) || '';
                return /order earnings|custom sku|quantity|sold/i.test(t);
            },
            { timeout: 20000 },
        )
        .catch(() => {});
    await sleep(900);

    const order = await extractOrderDetailsFromPage(orderPage);
    const onPage = canonicalEbayOrderId(order.orderNumber);
    const orderNumber = onPage || canonicalEbayOrderId(orderIdFromEbayDetailsLink(href)) || idLabel;
    const merged = { ...order, orderNumber };

    if (!merged.rows || !merged.rows.length) {
        console.warn('No line items parsed (empty rows). Skipping — sign-in, captcha, or page layout.');
        return 0;
    }

    console.log('Item / sold price (per line):');
    for (let li = 0; li < merged.rows.length; li++) {
        const r = merged.rows[li];
        const title = String(r.itemTitle || '(no title)').slice(0, 140);
        console.log(`  ${li + 1}. ${title}`);
        console.log(`     Sold (order earnings): ${r.earningsText || '?'}    SKU: ${r.customSku || ''}    Qty: ${r.quantity ?? 1}`);
    }

    const ans = await prompter.question(
        `Total postage £ for this whole order (blank = skip; allocated across lines by earnings share): `,
    );
    const postage = parseMoneyLoose(ans);
    if (!Number.isFinite(postage) || postage <= 0) {
        console.log('Skipped (no postage).');
        return 0;
    }

    const rows = payoutRowsFromOrderWithManualPostage(merged, postage);
    if (!rows.length) {
        console.warn('No payout rows generated.');
        return 0;
    }

    console.log(
        `Computed ${rows.length} sheet row(s). Net → client: ${rows.map((r) => `£${r.netEarnings} → £${r.clientPayout}`).join(' | ')}`,
    );

    if (args.dryRun) return 0;

    if (args.outputOdsPath) {
        const { writtenRows, skippedDuplicates } = await appendRowsToLocalSpreadsheet(args.outputOdsPath, rows, {
            sheetName: args.outputOdsSheet,
            forceAppend: args.forceSheetAppend,
        });
        if (skippedDuplicates) console.log(`Local: skipped ${skippedDuplicates} duplicate row(s) (column B).`);
        console.log(`Local: wrote ${writtenRows} row(s) this order.`);
        return writtenRows;
    }

    const { writtenRows, skippedDuplicates } = await writeRowsToSheet(args.browser, args.sheetUrl, rows, {
        sheetBrowserOnly: args.sheetBrowserOnly,
        ebaySkipOrders: 0,
        bypassDuplicateGuard: args.forceSheetAppend,
    });
    if (skippedDuplicates) console.log(`Sheet: skipped ${skippedDuplicates} duplicate row(s).`);
    console.log(`Sheet: wrote ${writtenRows} row(s) this order.`);
    return writtenRows;
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help) {
        printUsage();
        process.exit(0);
    }

    if (args.ordersFile && args.ordersXlsx) {
        console.error('Use either --orders-file or --orders-xlsx, not both.');
        process.exit(1);
    }

    let orderIdsFromInputs = [];
    if (args.ordersFile) orderIdsFromInputs = readOrderIdsFromFile(args.ordersFile);
    if (args.ordersXlsx) {
        orderIdsFromInputs = readOrderIdsFromXlsx(args.ordersXlsx, {
            sheetName: args.ordersXlsxSheet,
            maxColIndex: args.ordersXlsxMaxCol,
        });
    }
    for (const x of args.extraOrderIds) {
        const c = canonicalEbayOrderId(x);
        if (c) orderIdsFromInputs.push(c);
        else console.warn(`Skipping invalid trailing id: ${x}`);
    }
    orderIdsFromInputs = [...new Set(orderIdsFromInputs)];

    if (!orderIdsFromInputs.length) {
        console.error('No order ids. Use --orders-xlsx PATH and/or --orders-file / trailing ids.');
        printUsage();
        process.exit(1);
    }

    const origin = ebayOriginFromListUrl(args.ebayListUrl);
    const referer = args.ebayListUrl;

    if (args.outputOdsPath) {
        console.log(`Local output file: ${args.outputOdsPath}`);
        if (args.outputOdsSheet) console.log(`Local output sheet tab: ${args.outputOdsSheet}`);
    } else {
        console.log(`Target sheet: ${args.sheetUrl}`);
    }
    console.log(`eBay list (scan / referer): ${args.ebayListUrl}`);
    console.log(`eBay origin: ${origin}`);
    console.log(`Puppeteer CDP protocolTimeout=${resolveProtocolTimeoutMs(args)}ms`);

    if (args.sheetUrl) {
        reconcileCheckpointWithGoogleSheet(readCheckpoint(), args.sheetUrl);
    }

    if (!args.dryRun && args.sheetUrl) {
        console.log(
            'Prefetch — Google Sheet: same column B API check as payout bot (GOOGLE_SERVICE_ACCOUNT_JSON + sheet shared with service account).',
        );
        const apiStats = await readColumnBStatsFromApi(args.sheetUrl);
        if (apiStats) {
            console.log(
                `Sheet preflight: column B API OK — next empty row ~A${apiStats.nextAppendRow}; ${apiStats.orderIds.size} order id(s) for duplicate guard.`,
            );
        } else {
            console.warn(
                'Sheet preflight: API unavailable — writes use browser paste fallback (set GOOGLE_SERVICE_ACCOUNT_JSON and share this spreadsheet; optional GOOGLE_SHEET_TAB).',
            );
        }
    }

    if (args.dryRun) console.log('Dry run: sheet writes disabled.');
    if (args.forceSheetAppend) {
        console.log(
            'Force append: duplicate guard off — rows append even if order id is in column B or .ebay-payout-checkpoint (for retries after bad paste).',
        );
    }

    const browser = await puppeteer.connect(connectOptions(args.browserUrl, args));

    const orderPage = await browser.newPage();
    const prompter = createPrompter();
    let writtenTotal = 0;

    const runArgs = { ...args, browser };

    try {
        if (args.ordersXlsx) {
            const missingSet = new Set(orderIdsFromInputs);
            console.log(
                `\nXLSX: ${missingSet.size} unique order id(s) in "${path.basename(args.ordersXlsx)}" (scanned A–${xlsx.utils.encode_col(args.ordersXlsxMaxCol)}).`,
            );
            console.log('Scanning Seller Hub list (all pages) for mesh order links…');
            const allHrefs = await collectSellerHubOrderDetailHrefs(browser, args.ebayListUrl, {
                persistCheckpoint: false,
            });
            console.log(`List scan done: ${allHrefs.length} unique order link(s) on the list.`);

            const matchedHrefs = [];
            const seen = new Set();
            for (const href of allHrefs) {
                const id = canonicalEbayOrderId(orderIdFromEbayDetailsLink(href));
                if (!id || !missingSet.has(id) || seen.has(id)) continue;
                seen.add(id);
                matchedHrefs.push({ href, id });
            }

            const notOnList = [...missingSet].filter((id) => !seen.has(id)).sort();
            console.log(`Matched ${matchedHrefs.length} order(s) from the XLSX to links on the current list.`);
            if (notOnList.length) {
                console.log(
                    `${notOnList.length} XLSX id(s) not found on this list (wrong year filter, pagination, or not paid/shipped):`,
                );
                for (const id of notOnList.slice(0, 40)) console.log(`  - ${id}`);
                if (notOnList.length > 40) console.log(`  … and ${notOnList.length - 40} more`);
            }

            if (!matchedHrefs.length) {
                console.log('Nothing to process. Adjust the list URL or XLSX ids, complete eBay verification, then retry.');
                return;
            }

            for (let i = 0; i < matchedHrefs.length; i++) {
                const { href, id } = matchedHrefs[i];
                try {
                    writtenTotal += await processOneOrder(orderPage, href, referer, prompter, runArgs, {
                        index: i,
                        total: matchedHrefs.length,
                        idLabel: id,
                    });
                } catch (e) {
                    console.error(`Error on order ${id}: ${e.message || e}`);
                }
            }
        } else {
            console.log(`\nDirect mesh URLs for ${orderIdsFromInputs.length} order id(s) (no list scan).`);
            for (let i = 0; i < orderIdsFromInputs.length; i++) {
                const id = orderIdsFromInputs[i];
                const href = meshOrderDetailsUrl(origin, id);
                try {
                    writtenTotal += await processOneOrder(orderPage, href, referer, prompter, runArgs, {
                        index: i,
                        total: orderIdsFromInputs.length,
                        idLabel: id,
                    });
                } catch (e) {
                    console.error(`Error on order ${id}: ${e.message || e}`);
                }
            }
        }
    } finally {
        prompter.close();
    }

    console.log(
        `\nDone. Total rows written this run: ${writtenTotal}${args.dryRun ? ' (dry run — 0 written)' : ''}${args.outputOdsPath ? ` → ${args.outputOdsPath}` : ''}.`,
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
