#!/usr/bin/env node
'use strict';

/**
 * Paginate Seller Hub order list → order id from each link → compare to a known order list.
 * Compare source (first match): --compare-file / EBAY_RECONCILE_COMPARE_FILE (.xlsx, .xls, .csv);
 * else Google Sheets API; else --sheet-csv; else CSV download via Chrome (full tab).
 * Orders not in the compare set are appended to the RM postage-missing queue.
 * No order-detail scraping, no Royal Mail, no main-sheet writes.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const xlsx = require('xlsx');
const puppeteer = require('puppeteer-core');
const {
    readSheetColumnBOrderNumbersApi,
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
const DEFAULT_EBAY_ORDERS_LIST_URL =
    'https://www.ebay.co.uk/sh/ord/?filter=status%3APAID_SHIPPED%2Ctimerange%3APREVIOUSYEAR';

const REASON = 'Not on main payout sheet (list reconcile)';
/** Saved full-sheet CSV used for column B (API fallback). */
const DEFAULT_RECONCILE_SHEET_CSV = '.ebay-reconcile-main-sheet.csv';
const RECONCILE_DOWNLOAD_DIR = '.ebay-reconcile-downloads';

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

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
                        `  Run: npm run ebay:chrome\n` +
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

function spreadsheetIdFromUrl(sheetUrl) {
    const m = String(sheetUrl || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return m ? m[1] : '';
}

function gidFromSheetUrl(sheetUrl) {
    const m = String(sheetUrl || '').match(/[?&#]gid=(\d+)/i);
    return m ? m[1] : '0';
}

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

/** Same shape as Seller Hub URLs: orderid=26-14018-78959 (also tolerates spaces / unicode dashes / extra text). */
const ORDER_ID_TOKEN_RE = /\d{2,4}-\d{4,7}-\d{4,7}/i;

function normalizeOrderIdToken(raw) {
    const t = String(raw ?? '')
        .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
        .replace(/\s+/g, '')
        .trim()
        .toUpperCase();
    if (!t) return '';
    if (/^\d{2,4}-\d{4,7}-\d{4,7}$/.test(t)) return t;
    const m = t.match(ORDER_ID_TOKEN_RE);
    return m ? m[0].toUpperCase() : '';
}

/**
 * Read order id from Seller Hub details href: query param orderid (case variants), never from anchor text.
 */
function orderIdFromSellerHubHref(href) {
    const s = String(href || '').trim();
    if (!s) return '';
    try {
        const base = /^https?:\/\//i.test(s) ? undefined : 'https://www.ebay.co.uk';
        const u = new URL(s, base);
        const raw =
            u.searchParams.get('orderid') ||
            u.searchParams.get('orderId') ||
            u.searchParams.get('ORDERID');
        if (raw) {
            try {
                return normalizeOrderIdToken(decodeURIComponent(String(raw).replace(/\+/g, ' ')));
            } catch {
                return normalizeOrderIdToken(String(raw).replace(/\+/g, ' '));
            }
        }
    } catch {
        /* relative or odd URL */
    }
    const m = s.match(/[?&#](?:orderid|orderId)=([^&#]+)/i);
    if (!m) return '';
    try {
        return normalizeOrderIdToken(decodeURIComponent(String(m[1]).replace(/\+/g, ' ')));
    } catch {
        return normalizeOrderIdToken(String(m[1]).replace(/\+/g, ' '));
    }
}

/** One cell / CSV field → order id (for workbook rows). */
function extractOrderIdFromCsvField(raw) {
    return normalizeOrderIdToken(raw);
}

/** A1-style letters → 1-based column index (A=1, B=2, …). */
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

/**
 * @param {string} csvPath
 * @param {number} columnOneBased 1 = A — used only when scanAllColumns is false
 * @param {number} startRowOneBased first row to scan (1 = top line of file)
 * @param {boolean} scanAllColumns if true, every field in the row can contribute an order id (finds column automatically)
 */
function readOrderIdSetFromCsvFile(csvPath, columnOneBased, startRowOneBased, scanAllColumns = false) {
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
        if (scanAllColumns) {
            for (const part of parts) {
                const oid = extractOrderIdFromCsvField(part);
                if (oid) set.add(oid);
            }
        } else {
            if (parts.length <= colIdx) continue;
            const oid = extractOrderIdFromCsvField(parts[colIdx]);
            if (oid) set.add(oid);
        }
    }
    return set;
}

/**
 * @param {string} filePath absolute or cwd-relative
 * @param {{ sheetName?: string | null, columnOneBased: number, startRowOneBased: number, scanAllColumns?: boolean }} opts
 */
function readOrderIdSetFromExcelFile(filePath, opts) {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    if (!fs.existsSync(abs)) {
        throw new Error(`Workbook not found: ${abs}`);
    }
    const workbook = xlsx.readFile(abs);
    const sheetName = opts.sheetName && String(opts.sheetName).trim()
        ? String(opts.sheetName).trim()
        : workbook.SheetNames[0];
    if (!sheetName) {
        throw new Error(`No worksheets in: ${abs}`);
    }
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
        throw new Error(`Worksheet not found "${sheetName}" in ${abs}. Available: ${workbook.SheetNames.join(', ')}`);
    }
    // raw: false = use formatted display text (matches what you see in Excel; avoids number-only loss of hyphens)
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    const colIdx = Math.max(0, opts.columnOneBased - 1);
    const startIdx = Math.max(0, opts.startRowOneBased - 1);
    const scanAll = opts.scanAllColumns === true;
    const set = new Set();
    for (let i = startIdx; i < rows.length; i++) {
        const row = rows[i];
        if (!row || !row.length) continue;
        if (scanAll) {
            for (const cell of row) {
                const oid = extractOrderIdFromCsvField(cell != null && cell !== undefined ? String(cell) : '');
                if (oid) set.add(oid);
            }
        } else {
            const cell = row[colIdx];
            const oid = extractOrderIdFromCsvField(cell != null && cell !== undefined ? String(cell) : '');
            if (oid) set.add(oid);
        }
    }
    return set;
}

function readOrderIdSetFromCompareFile(filePath, columnOneBased, startRowOneBased, workbookTab, scanAllColumns = false) {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    if (!fs.existsSync(abs)) {
        throw new Error(`Compare file not found: ${abs}`);
    }
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.csv') {
        return readOrderIdSetFromCsvFile(abs, columnOneBased, startRowOneBased, scanAllColumns);
    }
    if (ext === '.xlsx' || ext === '.xls') {
        return readOrderIdSetFromExcelFile(abs, {
            sheetName: workbookTab || null,
            columnOneBased,
            startRowOneBased,
            scanAllColumns,
        });
    }
    throw new Error(`Unsupported compare file type "${ext}" (use .csv, .xlsx, or .xls): ${abs}`);
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

/** Full current tab as CSV using logged-in Chrome (same approach as ebay-list-sheet-audit). */
async function downloadSheetCsvViaBrowser(browser, sheetUrl, destPath) {
    const spreadsheetId = spreadsheetIdFromUrl(sheetUrl);
    if (!spreadsheetId) throw new Error('Invalid GOOGLE_SHEET_URL / --sheet-url');
    const gid = gidFromSheetUrl(sheetUrl);
    const exportUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${encodeURIComponent(String(gid))}`;

    const downloadDirAbs = path.resolve(process.cwd(), RECONCILE_DOWNLOAD_DIR);
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
        console.warn(`Reconcile: Chrome download folder hint failed (${String(e.message || e)}); continuing.`);
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
                console.log(`Reconcile: read downloaded CSV (${path.basename(saved)}).`);
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
                `Could not read CSV from export or ${RECONCILE_DOWNLOAD_DIR}. In ebay:chrome, open the main sheet (signed into Google), then rerun. Or set GOOGLE_SERVICE_ACCOUNT_JSON for API column B read.`,
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

/** Same list pagination as ebay-list-sheet-audit collectOrderLinksFromListPage. */
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
            const ORDER_ID_RE = /^\d{2,4}-\d{4,7}-\d{4,7}$/;
            function listSoldDateNearLink(anchor) {
                let rowText = '';
                const tr = anchor.closest && anchor.closest('tr');
                if (tr) rowText = tr.innerText || '';
                else {
                    const rw = anchor.closest && anchor.closest('[role="row"]');
                    if (rw) rowText = rw.innerText || '';
                    else {
                        let p = anchor;
                        for (let depth = 0; depth < 8 && p; depth++) {
                            if (p.getAttribute && p.getAttribute('role') === 'row') {
                                rowText = p.innerText || '';
                                break;
                            }
                            p = p.parentElement;
                        }
                    }
                }
                rowText = (rowText || '').replace(/\s+/g, ' ').trim();
                const dateRe =
                    /\b(\d{1,2}[/.]\s*\d{1,2}[/.]\s*\d{2,4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*,?\s*\d{2,4}|\d{4}-\d{2}-\d{2})\b/i;
                const m = rowText.match(dateRe);
                return m ? m[1].replace(/\s+/g, ' ').trim() : '';
            }
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
                orders.push({
                    orderId: candidateOrderId.toUpperCase(),
                    href: abs.href,
                    listSoldDate: listSoldDateNearLink(a),
                });
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
            collected.push({ href: o.href, listSoldDate: o.listSoldDate || '' });
        }
        console.log(`Reconcile: collected ${collected.length} unique order link(s) after list page ${pageCount}.`);

        if (!pageData.nextHref || pageData.nextDisabled) break;
        await page.goto(pageData.nextHref, { waitUntil: 'domcontentloaded', timeout: 120000 });
    }
    return collected;
}

function parseArgs(argv) {
    const out = {
        browserUrl: process.env.BROWSER_CDP_URL || 'http://127.0.0.1:9222',
        sheetUrl: null,
        ebayListUrl: null,
        maxPages: 100,
        /** Local .xlsx / .xls / .csv — full compare set (preferred) */
        compareFile: null,
        /** 1-based column for order numbers (default 2 = B). Accepts B or 2 */
        orderColumn: 2,
        /** 1 = first row in file. Use 2 if row 1 is headers only (no order numbers). */
        dataStartRow: 1,
        /** Excel worksheet name (default first sheet); not used for CSV */
        workbookTab: null,
        /** Existing CSV only (no local xlsx); skips API + download */
        sheetCsv: null,
        /** Where to save downloaded CSV when API is unavailable */
        sheetCsvOutput: null,
        /** Override RM_POSTAGE_QUEUE_SHEET_URL for this run only (missing-postage workbook) */
        postageQueueUrl: null,
        /** Log every list link: order id, in-file or miss (very chatty) */
        verbose: false,
        /**
         * false (default) = only column B (--order-column 2): order id always in column 2.
         * true = scan every cell per row (optional).
         */
        compareScanAllColumns: ['1', 'true', 'yes'].includes(
            String(process.env.EBAY_RECONCILE_SCAN_ALL_COLUMNS || '').trim().toLowerCase(),
        ),
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--verbose' || a === '-v') out.verbose = true;
        else if (a === '--scan-all-columns') out.compareScanAllColumns = true;
        else if (a === '--single-column') out.compareScanAllColumns = false;
        else if (a === '--browser-url' && argv[i + 1]) out.browserUrl = argv[++i];
        else if (a === '--sheet-url' && argv[i + 1]) out.sheetUrl = argv[++i];
        else if (a === '--ebay-list-url' && argv[i + 1]) out.ebayListUrl = argv[++i];
        else if (a === '--max-pages' && argv[i + 1]) out.maxPages = Math.max(1, parseInt(argv[++i], 10) || 100);
        else if (a === '--compare-file' && argv[i + 1]) out.compareFile = argv[++i];
        else if (a === '--order-column' && argv[i + 1]) {
            const v = argv[++i];
            if (/^[A-Za-z]+$/.test(String(v).trim())) out.orderColumn = columnLettersToOneBased(v);
            else out.orderColumn = Math.max(1, parseInt(v, 10) || 2);
        } else if (a === '--data-start-row' && argv[i + 1]) {
            out.dataStartRow = Math.max(1, parseInt(argv[++i], 10) || 1);
        } else if (a === '--workbook-tab' && argv[i + 1]) out.workbookTab = argv[++i];
        else if (a === '--sheet-csv' && argv[i + 1]) out.sheetCsv = argv[++i];
        else if (a === '--sheet-csv-output' && argv[i + 1]) out.sheetCsvOutput = argv[++i];
        else if (a === '--postage-queue-url' && argv[i + 1]) out.postageQueueUrl = String(argv[++i] || '').trim();
        else if (a === '--help' || a === '-h') out.help = true;
    }
    return out;
}

function help() {
    console.log(`Usage: node scripts/ebay-reconcile-list-vs-main-sheet.js [options]

Compares every Seller Hub order link to order numbers in a workbook/CSV, then queues missing ids to the postage-missing
queue (CSV by default: RM_POSTAGE_QUEUE_CSV_PATH / Downloads/Postage Queue.csv, or Google Sheet via RM_POSTAGE_QUEUE_SHEET_URL).

Compare source (first that applies):
  (1) --compare-file or EBAY_RECONCILE_COMPARE_FILE — local .xlsx, .xls, or .csv (all rows).
  (2) Google Sheets API if credentials are set.
  (3) --sheet-csv — CSV path only.
  (4) Else full Google Sheet CSV download via Chrome (needs Google sign-in in ebay:chrome).

Order ids in the workbook are read from **column B (column 2)** only, unless you pass **--scan-all-columns**.
First scanned row defaults to **1**. If row 1 is headers only, use **--data-start-row 2**.
Override column with **--order-column** if needed (default 2).

For .xlsx, use --workbook-tab "Sheet1" if the data is not on the first sheet.

Each Seller Hub link uses the **orderid=** query value. A **sold date** is guessed from the same list row (UK-style date in the row text) and sent to the postage queue with the order number (column C in full A:J rows, or column B when using order-numbers-only A:B mode).

Prerequisite: npm run ebay:chrome (eBay; Google only if downloading sheet CSV)

Options:
  --browser-url <url>       CDP (default http://127.0.0.1:9222)
  --compare-file <path>     Local .xlsx / .xls / .csv (e.g. Downloads export)
  --order-column <n|B>      Workbook column for order numbers (default 2 = B)
  --scan-all-columns        Also search other columns in each row (not needed if ids are always in column B)
  --single-column           Same as default (column B only); kept for compatibility
  --data-start-row <n>      First row to read (default 1). Use 2 if row 1 is header-only.
  --workbook-tab <name>     Excel worksheet name (default first sheet)
  --ebay-list-url <url>     Seller Hub list URL (e.g. …timerange%3ACURRENTYEAR for current year)
  --postage-queue-url <path|url> Postage queue CSV or Google Sheet for this run (overrides RM_POSTAGE_QUEUE_*)
  --sheet-url <url>         Google Sheet (API / download; default GOOGLE_SHEET_URL)
  --max-pages <n>           Max list pagination steps (default 100)
  --sheet-csv <path>        CSV compare file (when not using --compare-file)
  --sheet-csv-output <path> Save path when downloading from Google (default ${DEFAULT_RECONCILE_SHEET_CSV})
  --verbose, -v            Log every list link: index, order id, in compare file or not (and sample URL)

Env:
  EBAY_RECONCILE_COMPARE_FILE   Same as --compare-file
  EBAY_RECONCILE_SCAN_ALL_COLUMNS=1  Same as --scan-all-columns
  GOOGLE_SHEET_URL, GOOGLE_SHEET_TAB
  GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS
  EBAY_ORDERS_LIST_URL, EBAY_SELLER_HUB_LIST_URL, EBAY_LIST_AUDIT_URL
  RM_POSTAGE_QUEUE_CSV_PATH, RM_POSTAGE_QUEUE_SHEET_URL, RM_POSTAGE_QUEUE_ORDER_NUMBERS_ONLY
  EBAY_RECONCILE_POSTAGE_QUEUE_URL  Same as --postage-queue-url (CSV path or Sheet URL)
`);
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help) return help();

    const sheetUrl = args.sheetUrl || process.env.GOOGLE_SHEET_URL || DEFAULT_GOOGLE_SHEET_URL;
    const ebayListUrl =
        args.ebayListUrl ||
        String(process.env.EBAY_ORDERS_LIST_URL || process.env.EBAY_SELLER_HUB_LIST_URL || '').trim() ||
        String(process.env.EBAY_LIST_AUDIT_URL || '').trim() ||
        DEFAULT_EBAY_ORDERS_LIST_URL;

    const comparePathRaw = String(args.compareFile || process.env.EBAY_RECONCILE_COMPARE_FILE || '').trim();

    console.log(`Reconcile: eBay list URL:\n  ${ebayListUrl}`);
    if (comparePathRaw) {
        console.log(`Reconcile: compare file:\n  ${comparePathRaw}`);
    } else {
        console.log(`Reconcile: Google Sheet (API / download fallback):\n  ${sheetUrl}`);
    }

    console.log(`Reconcile: checking Chrome DevTools at ${args.browserUrl} …`);
    await assertChromeDevToolsReachable(args.browserUrl);
    const browser = await puppeteer.connect({
        browserURL: args.browserUrl,
        defaultViewport: null,
        protocolTimeout: 180000,
    });
    console.log('Reconcile: connected to Chrome.');

    let onSheet;
    let sheetSource;

    if (comparePathRaw) {
        onSheet = readOrderIdSetFromCompareFile(
            comparePathRaw,
            args.orderColumn,
            args.dataStartRow,
            args.workbookTab,
            args.compareScanAllColumns,
        );
        sheetSource = `local file (${path.basename(comparePathRaw)}${args.compareScanAllColumns ? ', all columns/row' : `, column ${args.orderColumn} only`})`;
    } else {
        onSheet = await readSheetColumnBOrderNumbersApi(sheetUrl);
        sheetSource = 'API';
        if (!onSheet) {
            const csvManual = String(args.sheetCsv || '').trim();
            if (csvManual) {
                onSheet = readOrderIdSetFromCompareFile(
                    csvManual,
                    args.orderColumn,
                    args.dataStartRow,
                    null,
                    args.compareScanAllColumns,
                );
                sheetSource = 'CSV file (--sheet-csv)';
            } else {
                const outPath = path.resolve(process.cwd(), args.sheetCsvOutput || DEFAULT_RECONCILE_SHEET_CSV);
                console.log('Reconcile: downloading Google Sheet as CSV via Chrome (full tab)…');
                await downloadSheetCsvViaBrowser(browser, sheetUrl, outPath);
                onSheet = readOrderIdSetFromCsvFile(
                    outPath,
                    args.orderColumn,
                    args.dataStartRow,
                    args.compareScanAllColumns,
                );
                sheetSource = `downloaded CSV → ${path.basename(outPath)}`;
            }
        }
    }
    console.log(
        `Reconcile: ${onSheet.size} order id(s) in compare set (from row ${args.dataStartRow}${args.compareScanAllColumns ? ', all columns/row' : `, column ${args.orderColumn} only`}; ${sheetSource}).`,
    );

    const page = await browser.newPage();
    try {
        await page.goto(ebayListUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    } catch {
        await page.goto(ebayListUrl, { waitUntil: 'domcontentloaded', timeout: 180000 });
    }
    if (/signin|login|auth/i.test(page.url())) {
        console.log('Reconcile: eBay sign-in required — complete it in Chrome (waiting up to 4 minutes)...');
        await page.waitForFunction(() => !/signin|login|auth/i.test(location.href), { timeout: 240000 });
        await page.goto(ebayListUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    }

    const bodyPeek = await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 6000));
    if (/please verify yourself|verify yourself to continue/i.test(bodyPeek)) {
        console.log('Reconcile: eBay verification — complete it in Chrome (waiting up to 5 minutes)…');
        await page.waitForFunction(
            () =>
                !/please verify yourself|verify yourself to continue/i.test(
                    document.body ? document.body.innerText.slice(0, 6000) : '',
                ),
            { timeout: 300000 },
        );
        await page.goto(ebayListUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    }

    const listRows = await collectOrderLinksFromListPage(page, args.maxPages);
    await page.close().catch(() => {});

    console.log(
        `Reconcile: checking ${listRows.length} Seller Hub link(s) one-by-one against ${onSheet.size} order id(s) in compare set…`,
    );

    let already = 0;
    let nonCanonical = 0;
    /** @type {Map<string, { href: string, listSoldDate: string }>} */
    const missingById = new Map();
    const progressEvery = args.verbose ? 1 : 250;

    for (let i = 0; i < listRows.length; i++) {
        const row = listRows[i];
        const href = typeof row === 'string' ? row : row.href;
        const listSoldDate = typeof row === 'string' ? '' : String(row.listSoldDate || '').trim();
        const idx = i + 1;
        const oid = orderIdFromSellerHubHref(href);
        if (!oid) {
            nonCanonical++;
            console.warn(`Reconcile: [${idx}/${listRows.length}] could not parse order id from link — skipped`);
            if (args.verbose) console.warn(`  ${href.slice(0, 140)}${href.length > 140 ? '…' : ''}`);
            continue;
        }
        const inFile = onSheet.has(oid);
        if (args.verbose) {
            const urlShort = href.length > 110 ? `${href.slice(0, 110)}…` : href;
            console.log(
                `Reconcile: [${idx}/${listRows.length}] ${oid}${listSoldDate ? ` (${listSoldDate})` : ''}  ${inFile ? 'in compare file' : 'NOT in compare file'}  ${urlShort}`,
            );
        } else if (progressEvery > 1 && (idx % progressEvery === 0 || idx === listRows.length)) {
            console.log(`Reconcile: progress ${idx}/${listRows.length} links checked…`);
        }
        if (inFile) {
            already++;
            continue;
        }
        if (!missingById.has(oid)) {
            missingById.set(oid, { href, listSoldDate });
        }
    }

    const missingEntries = [...missingById.entries()].map(([orderNumber, info]) => ({
        orderNumber,
        soldDate: info.listSoldDate || '',
        reason: REASON,
    }));

    console.log(
        `Reconcile: ${listRows.length} list link(s); ${already} in compare file; ${missingEntries.length} not in compare file; ${nonCanonical} link(s) with non-canonical id.`,
    );

    if (!missingEntries.length) {
        console.log('Reconcile: nothing to queue.');
        await browser.disconnect().catch(() => {});
        return;
    }

    const queueOverride = String(args.postageQueueUrl || process.env.EBAY_RECONCILE_POSTAGE_QUEUE_URL || '').trim();
    const prevRmQueue = process.env.RM_POSTAGE_QUEUE_SHEET_URL;
    const prevRmCsv = process.env.RM_POSTAGE_QUEUE_CSV_PATH;
    const queueIsCsv = /\.csv$/i.test(queueOverride) && !/^https?:\/\//i.test(queueOverride);
    if (queueOverride) {
        if (queueIsCsv) {
            process.env.RM_POSTAGE_QUEUE_CSV_PATH = queueOverride;
            delete process.env.RM_POSTAGE_QUEUE_SHEET_URL;
        } else {
            process.env.RM_POSTAGE_QUEUE_SHEET_URL = queueOverride;
            delete process.env.RM_POSTAGE_QUEUE_CSV_PATH;
        }
        console.log(`Reconcile: posting missing orders to queue:\n  ${queueOverride}`);
    }
    let result;
    try {
        result = await appendOrdersToMainSheetFallbackQueue(missingEntries, browser, queueOverride || null);
    } finally {
        if (queueOverride) {
            if (prevRmQueue === undefined) delete process.env.RM_POSTAGE_QUEUE_SHEET_URL;
            else process.env.RM_POSTAGE_QUEUE_SHEET_URL = prevRmQueue;
            if (prevRmCsv === undefined) delete process.env.RM_POSTAGE_QUEUE_CSV_PATH;
            else process.env.RM_POSTAGE_QUEUE_CSV_PATH = prevRmCsv;
        }
    }
    const queueLabel =
        queueOverride ||
        process.env.RM_POSTAGE_QUEUE_CSV_PATH ||
        process.env.RM_POSTAGE_QUEUE_SHEET_URL ||
        'RM_POSTAGE_QUEUE_CSV_PATH (default Downloads/Postage Queue.csv)';
    console.log(`Reconcile: postage queue append — ok=${result.ok}, written=${result.written} (${queueLabel}).`);

    await browser.disconnect().catch(() => {});
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
