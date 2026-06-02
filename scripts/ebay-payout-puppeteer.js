#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const xlsx = require('xlsx');
const { extractLegacyClientIdFromText } = require('../src/utils/ebayRefundSkuClient');
const {
    PAYOUT_IMPORT_CSV_HEADER,
    payoutRowToImportCsvLine,
    orderIdFromPayoutCsvLine,
    extractPayoutCsvDataLines,
    readOrderIdsFromPayoutCsv,
} = require('./ebay-payout-import-csv');

try {
    const dotenv = require('dotenv');
    const localEnv = path.join(__dirname, 'ebay-payout-bot.env');
    const rootEnv = path.join(__dirname, '..', '.env');
    if (fs.existsSync(localEnv)) dotenv.config({ path: localEnv });
    if (fs.existsSync(rootEnv)) dotenv.config({ path: rootEnv });
} catch {
    /* optional */
}

/** Paid & dispatched — previous calendar year (override with EBAY_ORDERS_LIST_URL or --ebay-list-url). */
const DEFAULT_EBAY_ORDERS_LIST_URL =
    'https://www.ebay.co.uk/sh/ord/?filter=status%3APAID_SHIPPED%2Ctimerange%3APREVIOUSYEAR';
const EBAY_ORDERS_URL =
    String(process.env.EBAY_ORDERS_LIST_URL || process.env.EBAY_SELLER_HUB_LIST_URL || DEFAULT_EBAY_ORDERS_LIST_URL).trim() ||
    DEFAULT_EBAY_ORDERS_LIST_URL;
const ROYAL_MAIL_URL = 'https://business.parcel.royalmail.com/reports/manifested-orders/';
/**
 * Preferred manifest filenames (merged first, then any other ManifestedOrdersReport*.xls(x) in the same search dirs).
 */
const DEFAULT_RM_MANIFEST_FILENAMES = [
    'ManifestedOrdersReport.2026-04-29-17-24-41.xls', // Mar 1 – Apr 29 2026
    'ManifestedOrdersReport.2026-04-29-17-26-03.xls', // Jan 1 – Mar 1 2026
    'ManifestedOrdersReport.2026-04-29-17-26-42.xls', // Nov–Dec
    'ManifestedOrdersReport.2026-04-29-17-27-11.xls', // Sep–Oct
    'ManifestedOrdersReport.2026-04-29-17-27-43.xls', // Jul–Aug
];
/** Legacy Google workbook; used only when RM_POSTAGE_QUEUE_SHEET_URL is a docs.google.com URL. */
const DEFAULT_RM_POSTAGE_QUEUE_SHEET_URL =
    'https://docs.google.com/spreadsheets/d/169kYDQAF6nIsVJN0DrAoOKO_JrrTviZ693hbhFRPhMY/edit?gid=0#gid=0';
/** Default missing-postage queue (local CSV). Override with RM_POSTAGE_QUEUE_CSV_PATH. */
const DEFAULT_RM_POSTAGE_QUEUE_CSV_PATH = 'c:/Users/jacob/Downloads/Postage Queue.csv';

const POSTAGE_QUEUE_CSV_HEADER_ORDER_ONLY = 'order_number';
const POSTAGE_QUEUE_CSV_HEADER_MIN = 'order_number,sold_date';
const POSTAGE_QUEUE_CSV_HEADER_FULL =
    'queued_at,order_number,sold_date,reference_number,tracking_number,item_titles,skus,quantities,earnings,reason,notes';

function urlLooksLikeEbayOrdersList(url) {
    const u = String(url || '');
    if (!/\/sh\/ord\b/i.test(u)) return false;
    return /https?:\/\/(www\.)?ebay\.(co\.uk|com)\b/i.test(u);
}

function ebayOrdersListUrlScore(url, preferredListUrl) {
    const u = String(url || '');
    const pref = String(preferredListUrl || EBAY_ORDERS_URL);
    let s = 0;
    if (/PAID_SHIPPED|paid\s*&\s*dispatched|filter=status:\s*PAID_SHIPPED/i.test(u)) s += 2000;
    else if (/filter=status:/i.test(u)) s += 100;
    try {
        if (new URL(u).search === new URL(pref).search) s += 500;
    } catch {
        /* ignore */
    }
    return s;
}

async function scoreEbayOrderListTabs(browser, preferredListUrl) {
    const scored = [];
    for (const p of await browser.pages()) {
        try {
            const u = p.url() || '';
            if (!urlLooksLikeEbayOrdersList(u)) continue;
            const linkCount = await p
                .evaluate(() => document.querySelectorAll('a[href*="/mesh/ord/details"]').length)
                .catch(() => 0);
            const score = ebayOrdersListUrlScore(u, preferredListUrl) + linkCount;
            scored.push({ p, u, linkCount, score });
        } catch {
            /* tab may be closing */
        }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
}

/** Seller Hub sometimes never fires domcontentloaded; commit + retries avoids auto-continue hangs. */
async function gotoEbayOrdersListUrl(page, label, listUrl) {
    const target = String(listUrl || EBAY_ORDERS_URL).trim() || DEFAULT_EBAY_ORDERS_LIST_URL;
    const tries = [
        { waitUntil: 'domcontentloaded', timeout: 120000 },
        { waitUntil: 'commit', timeout: 180000 },
        { waitUntil: 'commit', timeout: 240000 },
    ];
    let lastErr;
    for (let i = 0; i < tries.length; i++) {
        try {
            await page.goto(target, tries[i]);
            return;
        } catch (e) {
            lastErr = e;
            const msg = String(e.message || e);
            if (i < tries.length - 1) {
                console.warn(`${label}: goto attempt ${i + 1} failed (${msg.slice(0, 100)}) — retrying with looser wait…`);
                await sleep(1000);
                continue;
            }
        }
    }
    throw lastErr;
}

/**
 * Prefer an already-open Seller Hub orders tab (same CDP browser) so we do not reload /sh/ord
 * (reload often breaks; auto-continue reuses the tab). Otherwise opens one tab and navigates there.
 *
 * Picks the best matching tab: Paid & shipped URL first, then the tab with the most order-detail links
 * (avoids attaching to the first stale /sh/ord tab in browser.pages() order).
 */
async function attachEbayOrdersListPage(browser, listUrl) {
    const target = String(listUrl || EBAY_ORDERS_URL).trim() || DEFAULT_EBAY_ORDERS_LIST_URL;
    let scored = await scoreEbayOrderListTabs(browser, target);
    for (let scan = 0; scan < 8 && scored.length === 0; scan++) {
        await sleep(400);
        scored = await scoreEbayOrderListTabs(browser, target);
    }
    if (scored.length === 0) {
        console.log('No eBay /sh/ord tab found after rescan — opening a new tab (leave your orders list open next time to skip this).');
    }

    for (const { p, u, linkCount, score } of scored) {
        try {
            await p.bringToFront();
            if (/signin|login|auth/i.test(u)) {
                console.log('eBay sign-in on reused orders tab — complete sign-in in the browser (waiting up to 4 minutes)...');
                await p.waitForFunction(() => !/signin|login|auth/i.test(location.href), { timeout: 240000 });
                await gotoEbayOrdersListUrl(p, 'eBay list (after sign-in)', target);
            } else {
                console.log(`Reusing eBay orders tab (${linkCount} order link(s) in DOM; score=${score}). No list reload.`);
                console.log(`  Tab URL: ${u.length > 120 ? `${u.slice(0, 120)}…` : u}`);
            }
            return p;
        } catch {
            /* try next candidate */
        }
    }

    const p = await browser.newPage();
    await gotoEbayOrdersListUrl(p, 'eBay list (new tab)', target);
    if (/signin|login|auth/i.test(p.url())) {
        console.log('eBay sign-in detected. Please sign in manually in the opened Chrome window (waiting up to 4 minutes)...');
        await p.waitForFunction(() => !/signin|login|auth/i.test(location.href), { timeout: 240000 });
        await gotoEbayOrdersListUrl(p, 'eBay list (after sign-in, new tab)', target);
    }
    return p;
}
/** 2025 payout export workbook (matches PREVIOUSYEAR Seller Hub list). */
const DEFAULT_GOOGLE_SHEET_URL =
    'https://docs.google.com/spreadsheets/d/1ckpW9CB-vMl5VBpfkmN9JIvCreK0gc3g2IU2-scvAJM/edit?gid=0#gid=0';
const FIXED_PACKAGING_COST = 0.5;
/** Row 1 is user-controlled column titles only; data must never be typed here. */
const SHEET_FIRST_DATA_ROW = 2;
/** Orders (list links) processed per Node run; then a new process continues at next skip unless --no-auto-continue. */
const DEFAULT_BATCH_SIZE = 100;
const SERVICE_PRICE_BY_CODE = { TPN24: 3.84, TRN24: 2.88, TPS48: 3.12, TRS48: 2.34, SD1: 11.48 };
const DEBUG_DIR = process.env.EBAY_PAYOUT_DEBUG_DIR || path.join(__dirname, 'ebay-payout-debug');
/** Repo-root file (not process.cwd()) so npm/spawned chunks always share one checkpoint. */
const CHECKPOINT_PATH =
    process.env.EBAY_PAYOUT_CHECKPOINT_PATH || path.join(__dirname, '..', '.ebay-payout-checkpoint.json');

/** Log once per process when API append is skipped due to missing credentials. */
let warnedMissingGoogleServiceAccountJson = false;

function parseArgs(argv) {
    const out = {
        browserUrl: process.env.BROWSER_CDP_URL || 'http://127.0.0.1:9222',
        maxOrders: null,
        skipOrders: 0,
        skipOrdersProvided: false,
        batchSize: DEFAULT_BATCH_SIZE,
        autoContinue: true,
        output: null,
        sheetUrl: null,
        noSheet: false,
        startAfterOrder: '',
        replayJson: null,
        sheetBrowserOnly: false,
        refreshOrderLinks: false,
        ebayListUrl: null,
        protocolTimeoutMs: null,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--browser-url' && argv[i + 1]) out.browserUrl = argv[++i];
        else if (a === '--ebay-list-url' && argv[i + 1]) out.ebayListUrl = argv[++i];
        else if (a === '--max-orders' && argv[i + 1]) out.maxOrders = parseInt(argv[++i], 10);
        else if (a === '--refresh-order-links') out.refreshOrderLinks = true;
        else if (a === '--skip-orders' && argv[i + 1]) {
            out.skipOrders = Math.max(0, parseInt(argv[++i], 10) || 0);
            out.skipOrdersProvided = true;
        }
        else if (a === '--batch-size' && argv[i + 1]) out.batchSize = Math.max(1, parseInt(argv[++i], 10) || DEFAULT_BATCH_SIZE);
        else if (a === '--no-auto-continue') out.autoContinue = false;
        else if (a === '--output' && argv[i + 1]) out.output = argv[++i];
        else if (a === '--sheet-url' && argv[i + 1]) out.sheetUrl = argv[++i];
        else if (a === '--no-sheet') out.noSheet = true;
        else if (a === '--start-after-order' && argv[i + 1]) out.startAfterOrder = canonicalEbayOrderId(argv[++i]);
        else if (a === '--replay-json' && argv[i + 1]) out.replayJson = argv[++i];
        else if (a === '--sheet-browser-only') out.sheetBrowserOnly = true;
        else if (a === '--protocol-timeout-ms' && argv[i + 1]) {
            const n = parseInt(argv[++i], 10);
            if (Number.isFinite(n)) out.protocolTimeoutMs = n;
        }
        else if (a === '--help' || a === '-h') out.help = true;
    }
    const sb = String(process.env.EBAY_PAYOUT_SHEET_BROWSER_ONLY || '').trim().toLowerCase();
    if (sb === '1' || sb === 'true' || sb === 'yes') out.sheetBrowserOnly = true;
    const noSheetEnv = String(process.env.EBAY_PAYOUT_NO_SHEET || '').trim().toLowerCase();
    if (noSheetEnv === '1' || noSheetEnv === 'true' || noSheetEnv === 'yes') out.noSheet = true;
    const envOut = String(process.env.EBAY_PAYOUT_OUTPUT || process.env.EBAY_PAYOUT_OUTPUT_CSV || '').trim();
    if (envOut && !out.output) out.output = envOut;
    return out;
}

/** CDP default ~180s; pasting 100+ rows into Sheets often exceeds that. */
function resolveProtocolTimeoutMs(args) {
    if (args.protocolTimeoutMs != null && Number.isFinite(args.protocolTimeoutMs)) {
        return Math.max(60000, args.protocolTimeoutMs);
    }
    const raw = process.env.EBAY_PUPPETEER_PROTOCOL_TIMEOUT_MS;
    if (raw != null && String(raw).trim() !== '') {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n >= 60000) return n;
    }
    return 600000;
}

function connectOptions(browserUrl, args) {
    return {
        browserURL: browserUrl,
        defaultViewport: null,
        protocolTimeout: resolveProtocolTimeoutMs(args),
    };
}

function help() {
    console.log(`Usage: node scripts/ebay-payout-puppeteer.js [options]

Prerequisite: Start Chrome debug session first:
  npm run ebay:chrome

This launches a dedicated persistent profile in:
  .ebay-chrome-profile

Log in once there; the session is reused on next runs.

Options:
  --browser-url <url>   CDP url (default http://127.0.0.1:9222)
  --ebay-list-url <url> Seller Hub orders list (default: paid & dispatched, previous year — see EBAY_ORDERS_LIST_URL)
  --max-orders <n>      Cap list collection (default: all pages). Use a positive number to stop after N links.
  EBAY_PAYOUT_MAX_ORDER_LINKS  Optional default cap if you omit --max-orders (e.g. 1000).
  --skip-orders <n>     Skip first N collected links (resume / auto-continue)
  --batch-size <n>      How many order links to process per run (default ${DEFAULT_BATCH_SIZE}); then a fresh Node process continues
  --refresh-order-links Re-scan the eBay list (ignore saved links in checkpoint; use with skip-orders=0 to rebuild cache)
  --no-auto-continue    Stop after one chunk instead of spawning a new Node process for the next skip-orders step
  --output <path>       Write JSON + CSV (base path, or exact .csv path to append across batches)
  --no-sheet            Do not write to Google Sheets (CSV/JSON only; use with --output)
  --sheet-url <url>     Google Sheet URL override
  --start-after-order <order-id>  Resume from the first link after this order id (e.g. 06-14515-70994)
  --replay-json <path>  Skip scraping; write existing JSON rows to sheet
  --sheet-browser-only  Do not use Google Sheets API (force UI paste)
  --protocol-timeout-ms <n>  Puppeteer CDP timeout in ms (default 600000). Large Sheet pastes need this.

Env:
  GOOGLE_SHEET_URL
  GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS
    Path to service-account JSON. Share the spreadsheet with that client_email.
    When set (and not using --sheet-browser-only), rows append via API. Otherwise the script pastes in Chrome.
    If the JSON path is set, the script still uses the API to read column B (resume check, duplicate skip) even with --sheet-browser-only.
    Without credentials, those checks use only the checkpoint plus visible sheet cells (not the full column).
  EBAY_PAYOUT_SHEET_BROWSER_ONLY=1  Same as --sheet-browser-only (Puppeteer paste only).
  EBAY_PAYOUT_NO_SHEET=1            No Google Sheet (CSV only; set EBAY_PAYOUT_OUTPUT)
  EBAY_PAYOUT_OUTPUT                Payout CSV path when using --no-sheet / EBAY_PAYOUT_NO_SHEET
  GOOGLE_SHEET_TAB     Sheet tab name for API reads/writes (default Sheet1). Must match the tab where order numbers are in column B.
    Pasted/API columns A–H: order_date, order_number, item_name, custom_label_sku, quantity,
    net_earnings, client_payout, Client ID (add a “Quantity” header in E if your table is still 7 columns).
  RM_XLS_PATH (optional single Royal Mail XLS — overrides merged manifests)
  RM_MANIFEST_PATHS  Semicolon-separated list of Royal Mail XLS paths (overrides discovery below)
  RM_MANIFEST_DIRS  Extra folders to scan (semicolon or |); each folder gets the five default names plus every ManifestedOrdersReport*.xls(x)
  RM_POSTAGE_QUEUE_CSV_PATH   Local CSV for postage-missing / main-sheet fallback (default: Downloads/Postage Queue.csv)
  RM_POSTAGE_QUEUE_SHEET_URL  Optional Google Sheet instead of CSV (must be a docs.google.com URL)
  RM_POSTAGE_QUEUE_TAB        Tab name when the queue URL has no gid (default Postage queue)
  RM_POSTAGE_QUEUE_ORDER_NUMBERS_ONLY=1  CSV/Sheet: order_number (+ sold_date) only; otherwise full detail columns
  DOWNLOADS_DIR (optional, default ~/Downloads)
  EBAY_PAYOUT_CHECKPOINT_PATH  Override path for .ebay-payout-checkpoint.json (default: repo root next to package.json)
  EBAY_PAYOUT_MAX_ORDER_LINKS   When set (e.g. 1000), caps list scan if you omit --max-orders (default is no cap).
  EBAY_PAYOUT_RESET_SHEET_CHECKPOINT=1  One-shot: clear sheet append row + written-order ids only (does not delete cached order links or skip-orders). Or delete .ebay-payout-checkpoint.json for a full reset.
  EBAY_ORDERS_LIST_URL or EBAY_SELLER_HUB_LIST_URL
    Full Seller Hub list URL (e.g. ...timerange%3APREVIOUSYEAR or CURRENTYEAR). Overrides the default paid & dispatched list.
  EBAY_PUPPETEER_PROTOCOL_TIMEOUT_MS  CDP protocol timeout (default 600000). Raise if Runtime.callFunctionOn times out during Sheet paste.
  EBAY_PAYOUT_TIERED_SINCE  First calendar date (YYYY-MM-DD, UTC) for tiered client share on net after postage/packaging (default 2025-12-01).
    Rows with sold_date strictly before this use a flat legacy share (default 75% to client = 25% fee).
  EBAY_PAYOUT_LEGACY_CLIENT_SHARE  Client share for legacy rows (default 0.75). Tiered bands above remain 75%/80%/85% on net for tiered-since and later.

eBay tab: reuses a Seller Hub /sh/ord tab when possible (no full list reload). Chooses the tab that looks
  most like Paid & dispatched and has the most order links — not just the first tab in Chrome’s order.
`);
}

const money = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : 0);
const parseMoney = (v) => {
    const t = String(v || '').replace(/[^\d.,-]/g, '').replace(/,/g, '');
    const n = Number(t);
    return Number.isFinite(n) ? money(n) : 0;
};
/** Client share of adjusted net for tiered era (net = gross line − allocated postage − packaging). */
const payoutRateTiered = (n) => (n <= 50 ? 0.75 : n <= 150 ? 0.8 : 0.85);

function parseTieredSinceUtcMidnight() {
    const raw = String(process.env.EBAY_PAYOUT_TIERED_SINCE || '2025-12-01').trim();
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return new Date(Date.UTC(2025, 11, 1));
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return new Date(Date.UTC(2025, 11, 1));
    return new Date(Date.UTC(y, mo - 1, d));
}

/**
 * @param {string} s
 * @returns {Date|null} UTC midnight for calendar comparison
 */
function parseSoldDateLoose(s) {
    const raw = String(s || '').trim();
    if (!raw) return null;
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) {
        const y = parseInt(iso[1], 10);
        const mo = parseInt(iso[2], 10);
        const d = parseInt(iso[3], 10);
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return new Date(Date.UTC(y, mo - 1, d));
    }
    const uk = raw.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:\s|T|$)/);
    if (uk) {
        const d0 = parseInt(uk[1], 10);
        const mo0 = parseInt(uk[2], 10);
        const y0 = parseInt(uk[3], 10);
        if (mo0 >= 1 && mo0 <= 12 && d0 >= 1 && d0 <= 31) return new Date(Date.UTC(y0, mo0 - 1, d0));
    }
    const t = Date.parse(raw.replace(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/, '$1 $2 $3'));
    if (!Number.isNaN(t)) {
        const dt = new Date(t);
        return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
    }
    return null;
}

function usesLegacyFlatClientShare(soldDateStr) {
    const d = parseSoldDateLoose(soldDateStr);
    if (!d) return false;
    return d.getTime() < parseTieredSinceUtcMidnight().getTime();
}

function legacyClientShareFraction() {
    const x = parseFloat(String(process.env.EBAY_PAYOUT_LEGACY_CLIENT_SHARE || '0.75'));
    return Number.isFinite(x) && x > 0 && x < 1 ? x : 0.75;
}

/**
 * Client share rate applied to adjusted net (not eBay’s fee % — this is what the client keeps).
 * @param {number} adjustedNet
 * @param {string} soldDateStr
 */
function clientShareRate(adjustedNet, soldDateStr) {
    if (usesLegacyFlatClientShare(soldDateStr)) return legacyClientShareFraction();
    return payoutRateTiered(adjustedNet);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Put TSV on the OS clipboard (same clipboard Chrome uses for Ctrl+V). Avoids in-page copy(), which
 * moves focus off the grid and often breaks pastes — especially with Insert→Table / canvas layouts.
 */
function copyTextToOsClipboardSync(text) {
    const s = String(text ?? '');
    if (process.platform === 'win32') {
        const normalized = s.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
        try {
            const bom = Buffer.from([0xff, 0xfe]);
            const body = Buffer.from(normalized, 'utf16le');
            const r = spawnSync('clip', [], { input: Buffer.concat([bom, body]), maxBuffer: 10 * 1024 * 1024 });
            if (r.status === 0 && !r.error) return true;
        } catch {
            /* fall through */
        }
        try {
            const tmp = path.join(os.tmpdir(), `ebay-sheet-clip-${process.pid}-${Date.now()}.txt`);
            fs.writeFileSync(tmp, normalized, 'utf8');
            const lit = tmp.replace(/'/g, "''");
            const r = spawnSync(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-Sta',
                    '-Command',
                    `Get-Content -LiteralPath '${lit}' -Raw -Encoding UTF8 | Set-Clipboard`,
                ],
                { maxBuffer: 10 * 1024 * 1024 },
            );
            try {
                fs.unlinkSync(tmp);
            } catch {
                /* ignore */
            }
            if (r.status === 0 && !r.error) return true;
        } catch {
            /* ignore */
        }
        return false;
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

/** eBay mesh order details often throw net::ERR_ABORTED (superseded navigation / SPA). Never use about:blank — it leaves tabs stuck. */
async function gotoEbayOrderDetailsPage(orderPage, link, refererListUrl) {
    const ref = String(refererListUrl || EBAY_ORDERS_URL).trim() || DEFAULT_EBAY_ORDERS_LIST_URL;
    const max = 4;
    for (let i = 0; i < max; i++) {
        try {
            await orderPage.goto(link, {
                waitUntil: i >= 2 ? 'commit' : 'domcontentloaded',
                timeout: 120000,
                referer: ref,
            });
            return;
        } catch (e) {
            const msg = String(e.message || e);
            const retry =
                i < max - 1 &&
                /ERR_ABORTED|ERR_BLOCKED|Navigation failed|net::ERR|timeout|detached frame/i.test(msg);
            if (retry) {
                console.warn(`Order details goto attempt ${i + 1}/${max}: ${msg.slice(0, 140)} — retrying…`);
                await sleep(800 + i * 400);
                continue;
            }
            throw e;
        }
    }
}

function extractClientId(customSku) {
    return extractLegacyClientIdFromText(customSku);
}

async function clickRoyalMailAcceptCookies(page) {
    await page.evaluate(() => {
        const byId = document.querySelector('#consent_prompt_submit');
        if (byId instanceof HTMLElement) {
            byId.click();
            return;
        }
        const nodes = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const btn = nodes.find((n) => /accept all/i.test((n.textContent || '').trim()));
        if (btn instanceof HTMLElement) btn.click();
    });
}

async function clickByText(page, selectorList, regex) {
    return page.evaluate(
        ({ selectorList, pattern }) => {
            const re = new RegExp(pattern, 'i');
            const selectors = Array.isArray(selectorList) ? selectorList : ['button', 'a', '[role="button"]'];
            const nodes = selectors.flatMap((sel) => Array.from(document.querySelectorAll(sel)));
            const target = nodes.find((n) => re.test((n.textContent || n.value || '').replace(/\s+/g, ' ').trim()));
            if (target instanceof HTMLElement) {
                target.click();
                return true;
            }
            return false;
        },
        { selectorList, pattern: regex.source }
    );
}

async function ensureRoyalMailLoggedIn(page) {
    const isLoginPage = () => /login|signin|auth|business\.parcel\.royalmail\.com\/account/i.test(page.url());
    if (!isLoginPage()) return;

    const email = process.env.RM_EMAIL || 'jacobfrobinson@gmail.com';
    const password = process.env.RM_PASSWORD || 'Thebottombunk1-';
    if (email && password) {
        const emailSelectors = ['input[type="email"]', 'input[name*="email" i]', 'input[id*="email" i]'];
        const passwordSelectors = ['input[type="password"]', 'input[name*="password" i]', 'input[id*="password" i]'];
        for (const sel of emailSelectors) {
            const field = await page.$(sel);
            if (field) {
                await field.click({ clickCount: 3 });
                await field.type(email, { delay: 20 });
                break;
            }
        }
        for (const sel of passwordSelectors) {
            const field = await page.$(sel);
            if (field) {
                await field.click({ clickCount: 3 });
                await field.type(password, { delay: 20 });
                break;
            }
        }
        await page.evaluate(() => {
            const nodes = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'));
            const submit = nodes.find((n) => /log in|login|sign in|signin/i.test((n.textContent || n.value || '').trim()));
            if (submit instanceof HTMLElement) submit.click();
        });
        try {
            await page.waitForFunction(() => !/login|signin|auth|\/account/i.test(location.href), { timeout: 120000 });
        } catch {
            // If auto-login failed (captcha/2FA), fall through to manual wait.
        }
    }

    if (isLoginPage()) {
        console.log('Royal Mail sign-in detected. Please complete login manually (waiting up to 4 minutes)...');
        await page.waitForFunction(() => !/login|signin|auth|\/account/i.test(location.href), { timeout: 240000 });
    }
}

async function exportRoyalMailXls(page) {
    const selectors = ['button', 'a', '[role="button"]', '[type="submit"]'];
    const clickedOpen = await clickByText(page, selectors, /export to xls/i);
    if (!clickedOpen) {
        const clickedFallback = await clickByText(page, selectors, /\bexport\b|\bdownload\b/i);
        if (!clickedFallback) throw new Error('Could not find Royal Mail export button');
    }
    await sleep(800);

    // Some flows show a confirmation modal with another "Export to XLS" submit button.
    await page.waitForFunction(
        () => {
            const nodes = Array.from(document.querySelectorAll('button[type="submit"], [role="dialog"] button, [aria-modal="true"] button'));
            return nodes.some((n) => /export to xls/i.test((n.textContent || '').replace(/\s+/g, ' ').trim()));
        },
        { timeout: 10000 }
    ).catch(() => {});

    const clickedSubmit = await page.evaluate(() => {
        const textOf = (n) => (n.textContent || '').replace(/\s+/g, ' ').trim();
        const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
        const modalSubmit = modal
            ? Array.from(modal.querySelectorAll('button[type="submit"], button')).find((n) => /export to xls/i.test(textOf(n)))
            : null;
        if (modalSubmit instanceof HTMLElement) {
            modalSubmit.click();
            return true;
        }

        const submitBtn = Array.from(document.querySelectorAll('button[type="submit"]')).find((n) => /export to xls/i.test(textOf(n)));
        if (submitBtn instanceof HTMLElement) {
            submitBtn.click();
            return true;
        }
        return false;
    });

    if (!clickedSubmit) {
        await clickByText(page, ['button', '[type="submit"]', '[role="button"]'], /export to xls/i);
    }
}

const PAYOUT_CSV_HEADER = PAYOUT_IMPORT_CSV_HEADER;

function payoutRowToCsvLine(r) {
    return payoutRowToImportCsvLine(r);
}

function csvCellEscape(v) {
    const s = String(v ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function resolveAbsPathMaybe(p) {
    const s = String(p || '').trim();
    if (!s) return '';
    return path.isAbsolute(s) ? s : path.join(process.cwd(), s);
}

function isGoogleSheetsUrl(s) {
    return /^https?:\/\//i.test(String(s || '')) && /docs\.google\.com\/spreadsheets/i.test(String(s || ''));
}

function looksLikePostageQueueCsvPath(s) {
    const t = String(s || '').trim();
    return Boolean(t && /\.csv$/i.test(t) && !isGoogleSheetsUrl(t));
}

/** @returns {{ mode: 'csv', path: string } | { mode: 'sheet', url: string }} */
function resolvePostageQueueTarget(override) {
    const csvEnv = String(process.env.RM_POSTAGE_QUEUE_CSV_PATH || '').trim();
    if (csvEnv) return { mode: 'csv', path: resolveAbsPathMaybe(csvEnv) };

    const rawOverride = String(override || '').trim();
    if (looksLikePostageQueueCsvPath(rawOverride)) {
        return { mode: 'csv', path: resolveAbsPathMaybe(rawOverride) };
    }

    const sheetEnv = String(process.env.RM_POSTAGE_QUEUE_SHEET_URL || '').trim();
    if (looksLikePostageQueueCsvPath(sheetEnv)) {
        return { mode: 'csv', path: resolveAbsPathMaybe(sheetEnv) };
    }

    if (isGoogleSheetsUrl(rawOverride)) return { mode: 'sheet', url: rawOverride };
    if (isGoogleSheetsUrl(sheetEnv)) return { mode: 'sheet', url: sheetEnv };

    return { mode: 'csv', path: resolveAbsPathMaybe(DEFAULT_RM_POSTAGE_QUEUE_CSV_PATH) };
}

function formatPostageQueueTargetLabel(target) {
    const t = target || resolvePostageQueueTarget(null);
    return t.mode === 'csv' ? t.path : t.url;
}

function postageQueueCsvHeaderRecognized(firstLine) {
    const h = String(firstLine || '')
        .trim()
        .toLowerCase()
        .replace(/^\uFEFF/, '');
    return /^order_number(,|$)/.test(h);
}

function isJunkPostageQueueCsvLine(line) {
    const t = String(line || '').trim();
    if (!t) return true;
    const first = t.split(',')[0].replace(/^"|"$/g, '').trim();
    if (/^column\s+\d+/i.test(first)) return true;
    if (!first && /^,+$/.test(t.replace(/\s/g, ''))) return true;
    return false;
}

function extractOrderIdsFromPostageQueueCsvText(text) {
    const out = new Set();
    for (const line of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
        if (isJunkPostageQueueCsvLine(line) || postageQueueCsvHeaderRecognized(line)) continue;
        const first = line.split(',')[0].replace(/^"|"$/g, '').trim();
        const c = canonicalEbayOrderId(first);
        if (c) out.add(c);
    }
    return out;
}

/** Order ids already present in a postage-queue CSV (order_number column or first column). */
function readOrderIdsFromPostageQueueCsv(csvPath) {
    const out = new Set();
    if (!csvPath || !fs.existsSync(csvPath)) return out;
    return extractOrderIdsFromPostageQueueCsvText(fs.readFileSync(csvPath, 'utf8'));
}

/** Order ids already present in an output CSV (order_number column). */
function readOrderIdsFromOutputCsv(csvPath) {
    return readOrderIdsFromPayoutCsv(csvPath);
}

function isLocalFileBusyError(err) {
    const code = err && err.code;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return true;
    return /EBUSY|resource busy|locked/i.test(String(err && err.message));
}

function delayMs(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        /* sync wait — keeps retry logic simple without top-level await */
    }
}

function appendTextToFileWithRetry(filePath, text, label) {
    let lastErr;
    for (let i = 0; i < 12; i++) {
        try {
            fs.appendFileSync(filePath, text, 'utf8');
            if (i > 0) console.log(`${label}: append succeeded after ${i + 1} attempt(s).`);
            return;
        } catch (e) {
            lastErr = e;
            if (!isLocalFileBusyError(e) || i === 11) throw e;
            const wait = Math.min(4000, 300 + i * 350);
            console.warn(
                `${label}: file locked (${e.code || 'busy'}) — retry in ${wait}ms. Close "${path.basename(filePath)}" in Excel/LibreOffice.`,
            );
            delayMs(wait);
        }
    }
    throw lastErr;
}

function writeTextToFileWithRetry(filePath, text, label) {
    let lastErr;
    for (let i = 0; i < 12; i++) {
        try {
            fs.writeFileSync(filePath, text, 'utf8');
            if (i > 0) console.log(`${label}: write succeeded after ${i + 1} attempt(s).`);
            return;
        } catch (e) {
            lastErr = e;
            if (!isLocalFileBusyError(e) || i === 11) throw e;
            const wait = Math.min(4000, 300 + i * 350);
            console.warn(
                `${label}: file locked (${e.code || 'busy'}) — retry in ${wait}ms. Close "${path.basename(filePath)}" in Excel/LibreOffice.`,
            );
            delayMs(wait);
        }
    }
    throw lastErr;
}

function writeOutputs(rows, outputBase) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    let jsonPath;
    let csvPath;
    if (outputBase && /\.csv$/i.test(String(outputBase))) {
        csvPath = path.isAbsolute(outputBase) ? outputBase : path.join(process.cwd(), outputBase);
        jsonPath = csvPath.replace(/\.csv$/i, '.json');
    } else {
        const base = outputBase ? (path.isAbsolute(outputBase) ? outputBase : path.join(process.cwd(), outputBase)) : path.join(__dirname, `ebay-payout-${ts}`);
        jsonPath = base.endsWith('.json') ? base : `${base}.json`;
        csvPath = jsonPath.replace(/\.json$/i, '.csv');
    }

    const existingCsvIds = readOrderIdsFromOutputCsv(csvPath);
    const rowsForCsv = rows.filter((r) => !existingCsvIds.has(canonicalEbayOrderId(r.orderNumber)));
    const csvDupSkipped = rows.length - rowsForCsv.length;
    if (csvDupSkipped > 0) {
        console.log(`CSV output: skipped ${csvDupSkipped} row(s) already in ${path.basename(csvPath)} (order_number).`);
    }

    const csvLines = rowsForCsv.map((r) => payoutRowToCsvLine(r));
    if (csvLines.length) {
        fs.mkdirSync(path.dirname(csvPath), { recursive: true });
        const bom = '\uFEFF';
        const existingLines = fs.existsSync(csvPath) ? extractPayoutCsvDataLines(fs.readFileSync(csvPath, 'utf8')) : [];
        const seenLineIds = new Set();
        const mergedLines = [];
        for (const line of [...existingLines, ...csvLines]) {
            const id = orderIdFromPayoutCsvLine(line);
            if (!id || seenLineIds.has(id)) continue;
            seenLineIds.add(id);
            mergedLines.push(line);
        }
        writeTextToFileWithRetry(
            csvPath,
            bom + [PAYOUT_CSV_HEADER, ...mergedLines].join('\n') + '\n',
            'CSV output',
        );
        const totalIds = readOrderIdsFromOutputCsv(csvPath).size;
        const bytes = fs.statSync(csvPath).size;
        if (bytes < 20) {
            throw new Error(`CSV write failed — file is nearly empty after write: ${csvPath}`);
        }
        console.log(
            `CSV output saved: ${csvPath} — ${totalIds} order row(s) in file now (${bytes.toLocaleString()} bytes). Close and reopen the file in Excel if it still looks empty.`,
        );
    } else if (rows.length > 0) {
        console.warn(
            `CSV output: 0 new row(s) written to ${csvPath} — all ${rows.length} row(s) from this chunk were already in the file (order_number).`,
        );
    }

    let jsonRows = rows;
    if (fs.existsSync(jsonPath)) {
        try {
            const prev = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            const prevRows = Array.isArray(prev.rows) ? prev.rows : [];
            const seen = new Set(prevRows.map((r) => canonicalEbayOrderId(r.orderNumber)).filter(Boolean));
            const add = rows.filter((r) => !seen.has(canonicalEbayOrderId(r.orderNumber)));
            jsonRows = [...prevRows, ...add];
        } catch {
            /* overwrite below */
        }
    }
    fs.writeFileSync(
        jsonPath,
        JSON.stringify({ generatedAt: new Date().toISOString(), rows: jsonRows }, null, 2),
        'utf8',
    );

    return { jsonPath, csvPath, writtenCsvRows: rowsForCsv.length, skippedCsvDuplicates: csvDupSkipped };
}

function findNewestXls(downloadDir, afterMs) {
    if (!fs.existsSync(downloadDir)) return null;
    const files = fs
        .readdirSync(downloadDir)
        .map((f) => path.join(downloadDir, f))
        .filter((p) => /\.(xls|xlsx)$/i.test(p))
        .map((p) => ({ p, mtimeMs: fs.statSync(p).mtimeMs }))
        .filter((x) => x.mtimeMs >= afterMs)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files.length ? files[0].p : null;
}

async function waitForNewXls(downloadDir, afterMs, timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const f = findNewestXls(downloadDir, afterMs);
        if (f) return f;
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('Timed out waiting for Royal Mail XLS download');
}

async function downloadRoyalMailXlsViaPortal(rmPage, downloadDir) {
    await rmPage.goto(ROYAL_MAIL_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await sleep(1000);
    await clickRoyalMailAcceptCookies(rmPage);
    await sleep(600);
    await ensureRoyalMailLoggedIn(rmPage);
    if (!/manifested-orders/i.test(rmPage.url())) {
        await rmPage.goto(ROYAL_MAIL_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await sleep(1000);
        await clickRoyalMailAcceptCookies(rmPage);
    }
    const afterMs = Date.now();
    await exportRoyalMailXls(rmPage);
    return waitForNewXls(downloadDir, afterMs, 120000);
}

function parseRoyalMailPostageMap(xlsPath) {
    const wb = xlsx.readFile(xlsPath);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });
    const map = new Map();
    for (const row of rows) {
        const entries = Object.entries(row).map(([k, v]) => [String(k).toLowerCase(), v]);
        const pick = (...keys) => {
            for (const [k, v] of entries) if (keys.some((x) => k.includes(x))) return v;
            return '';
        };
        /** Prefer eBay-style id from Channel reference; avoid bare "order" matching internal order numbers. */
        const ref = String(
            pick('channel reference', 'channel ref') ||
                pick('sales order number', 'sales order') ||
                pick('order number', 'order no') ||
                '',
        )
            .toUpperCase()
            .trim();
        const serviceCode = String(
            pick('service code', 'service_code', 'servicecode')
        )
            .toUpperCase()
            .trim();
        const shippingService = String(pick('shipping service')).toUpperCase().trim();
        const explicit = parseMoney(pick('applicable postage', 'postage', 'cost', 'price', 'amount'));
        let derivedCode = serviceCode;
        if (!derivedCode && /TRACKED\s*24/.test(shippingService) && /LBT|LARGE LETTER/.test(shippingService)) derivedCode = 'TRN24';
        else if (!derivedCode && /TRACKED\s*24/.test(shippingService)) derivedCode = 'TPN24';
        else if (!derivedCode && /TRACKED\s*48/.test(shippingService) && /LBT|LARGE LETTER/.test(shippingService)) derivedCode = 'TRS48';
        else if (!derivedCode && /TRACKED\s*48/.test(shippingService)) derivedCode = 'TPS48';

        const cost = explicit > 0 ? explicit : SERVICE_PRICE_BY_CODE[derivedCode] || 0;
        if (cost <= 0) continue;

        // Primary key from expected columns.
        if (ref) map.set(ref, cost);

        // Aggressive fallback: index all row cell tokens so order/ref/tracking values can match.
        for (const value of Object.values(row)) {
            const token = String(value || '').toUpperCase().trim();
            if (!token) continue;
            if (token.length < 5) continue;
            if (!/[A-Z0-9]/.test(token)) continue;
            map.set(token, cost);
        }
    }
    return map;
}

/** Merge several Royal Mail manifest XLS files into one lookup map (later files overwrite same keys). */
function mergeRoyalMailPostageMaps(paths) {
    const merged = new Map();
    const list = (paths || []).filter((p) => p && fs.existsSync(p));
    for (const p of list) {
        const m = parseRoyalMailPostageMap(p);
        for (const [k, v] of m.entries()) merged.set(k, v);
    }
    return merged;
}

/**
 * All Royal Mail “manifested orders” exports in a directory (by mtime ascending so later merges win on duplicate keys).
 */
function listManifestedOrderXlsInDir(absDir) {
    if (!absDir || !fs.existsSync(absDir)) return [];
    const re = /^manifestedordersreport.*\.(xls|xlsx)$/i;
    return fs
        .readdirSync(absDir)
        .filter((f) => re.test(f))
        .map((f) => path.join(absDir, f))
        .filter((p) => fs.existsSync(p))
        .map((p) => ({ p, mtimeMs: fs.statSync(p).mtimeMs }))
        .sort((a, b) => a.mtimeMs - b.mtimeMs)
        .map((x) => x.p);
}

/**
 * Directories to scan for manifests: DOWNLOADS_DIR (or ~/Downloads), then RM_MANIFEST_DIRS (semicolon or pipe).
 */
function royalMailManifestSearchDirs(downloadDir) {
    const dirs = [];
    const primary = String(downloadDir || '').trim();
    if (primary && fs.existsSync(primary)) dirs.push(path.normalize(primary));
    const extra = String(process.env.RM_MANIFEST_DIRS || '')
        .split(/[;|]/)
        .map((s) => s.trim())
        .filter(Boolean);
    for (const d of extra) {
        const abs = path.isAbsolute(d) ? path.normalize(d) : path.normalize(path.join(process.cwd(), d));
        if (fs.existsSync(abs) && !dirs.includes(abs)) dirs.push(abs);
    }
    return dirs.length ? dirs : primary ? [path.normalize(primary)] : [];
}

function resolveRoyalMailManifestPaths(downloadDir) {
    const custom = String(process.env.RM_MANIFEST_PATHS || '').trim();
    if (custom) {
        return custom
            .split(/[;|]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .filter((p) => fs.existsSync(p));
    }
    const dirs = royalMailManifestSearchDirs(downloadDir);
    const seen = new Set();
    const out = [];
    const add = (p) => {
        const norm = path.normalize(p);
        if (!fs.existsSync(norm)) return;
        if (seen.has(norm)) return;
        seen.add(norm);
        out.push(norm);
    };
    for (const dir of dirs) {
        for (const base of DEFAULT_RM_MANIFEST_FILENAMES) {
            add(path.join(dir, base));
        }
        for (const p of listManifestedOrderXlsInDir(dir)) {
            add(p);
        }
    }
    return out;
}

function logRoyalMailDefaultFilesMissing(manifestPaths, rmXlsPath) {
    if (rmXlsPath || process.env.RM_MANIFEST_PATHS || !manifestPaths || !manifestPaths.length) return;
    const basenames = new Set(manifestPaths.map((p) => path.basename(p)));
    const missingDefaults = DEFAULT_RM_MANIFEST_FILENAMES.filter((b) => !basenames.has(b));
    if (!missingDefaults.length) return;
    console.warn(
        `Royal Mail: expected export filename(s) not in merged set: ${missingDefaults.join(', ')}. ` +
            'Copy them into Downloads or RM_MANIFEST_DIRS, or set RM_MANIFEST_PATHS. ' +
            'Other ManifestedOrdersReport*.xls(x) in those folders are merged automatically.',
    );
}

/** Newest .xls/.xlsx in DOWNLOADS_DIR + RM_MANIFEST_DIRS (fallback when no curated / glob match). */
function findNewestSpreadsheetInManifestDirs(downloadDir) {
    let best = null;
    let bestM = 0;
    for (const dir of royalMailManifestSearchDirs(downloadDir)) {
        if (!fs.existsSync(dir)) continue;
        let names;
        try {
            names = fs.readdirSync(dir);
        } catch {
            continue;
        }
        for (const name of names) {
            if (!/\.(xls|xlsx)$/i.test(name)) continue;
            const p = path.join(dir, name);
            try {
                const m = fs.statSync(p).mtimeMs;
                if (m >= bestM) {
                    bestM = m;
                    best = p;
                }
            } catch {
                /* skip */
            }
        }
    }
    return best;
}

function orderPostage(map, orderNo, extraTokens = []) {
    const tokens = [orderNo, ...extraTokens]
        .map((t) => String(t || '').toUpperCase().trim())
        .filter(Boolean);
    for (const token of tokens) {
        if (map.has(token)) return { postage: money(map.get(token)), matchedToken: token, triedTokens: tokens };
    }
    for (const token of tokens) {
        for (const [k, v] of map.entries()) {
            if (k.includes(token) || token.includes(k)) return { postage: money(v), matchedToken: k, triedTokens: tokens };
        }
    }
    return { postage: 0, matchedToken: '', triedTokens: tokens };
}

/** Last column (notes): RM default vs non-RM queue reasons (e.g. list reconcile). */
function notesFooterForPostageQueue(reason) {
    const r = String(reason || '');
    if (/list reconcile/i.test(r)) {
        return 'List reconcile only — not a Royal Mail manifest check; order was missing from the compare workbook / sheet at run time.';
    }
    if (/main sheet|main payout sheet|Could not add to main order Google Sheet/i.test(r)) {
        return 'Main sheet queue — see reason in prior column; not necessarily an RM postage miss.';
    }
    return 'No RM postage match after merged manifests + refresh — complete payout manually if needed.';
}

/** One row for the “postage missing” queue tab (same spreadsheet, gid tab). */
function cellsForPostageMissingQueue(order, reason) {
    const titles = order.rows.map((r) => String(r.itemTitle || '').trim()).filter(Boolean).join(' | ');
    const skus = order.rows.map((r) => String(r.customSku || '').trim()).filter(Boolean).join(' | ');
    const qtys = order.rows.map((r) => String(r.quantity ?? '')).filter(Boolean).join(' | ');
    const earn = order.rows.map((r) => String(r.earningsText || '').trim()).filter(Boolean).join(' | ');
    const soldFromRows = order.rows.map((r) => String(r.soldDate || '').trim()).find(Boolean) || '';
    const sold = String(order.soldDate || '').trim() || soldFromRows;
    return [
        new Date().toISOString(),
        order.orderNumber || '',
        sold,
        order.referenceNumber || '',
        order.trackingNumber || '',
        titles,
        skus,
        qtys,
        earn,
        reason,
        notesFooterForPostageQueue(reason),
    ];
}

function postageMissingQueueCsvLine(m, orderNumbersOnly, useSoldCol) {
    if (orderNumbersOnly) {
        const id =
            canonicalEbayOrderId(m.order.orderNumber) || String(m.order.orderNumber || '').trim();
        const d = String(m.order.soldDate || '').trim();
        return useSoldCol ? [id, d].map(csvCellEscape).join(',') : csvCellEscape(id);
    }
    return cellsForPostageMissingQueue(m.order, m.reason).map(csvCellEscape).join(',');
}

/**
 * Append to local postage queue CSV (RM_POSTAGE_QUEUE_CSV_PATH or default Downloads/Postage Queue.csv).
 */
function appendPostageMissingQueueCsv(csvPath, missing) {
    if (!missing.length) return { ok: true, written: 0 };

    const orderNumbersOnly = ['1', 'true', 'yes'].includes(
        String(process.env.RM_POSTAGE_QUEUE_ORDER_NUMBERS_ONLY || '').trim().toLowerCase(),
    );
    const useSoldCol = orderNumbersOnly && missing.some((m) => String(m.order.soldDate || '').trim());
    const header = orderNumbersOnly
        ? useSoldCol
            ? POSTAGE_QUEUE_CSV_HEADER_MIN
            : POSTAGE_QUEUE_CSV_HEADER_ORDER_ONLY
        : POSTAGE_QUEUE_CSV_HEADER_FULL;

    const existing = readOrderIdsFromPostageQueueCsv(csvPath);
    const beforeCount = existing.size;
    const toWrite = missing.filter((m) => {
        const id = canonicalEbayOrderId(m.order.orderNumber) || String(m.order.orderNumber || '').trim();
        const key = canonicalEbayOrderId(id) || id;
        return key && !existing.has(key);
    });
    const skippedDup = missing.length - toWrite.length;
    if (skippedDup > 0) {
        console.log(`Postage queue (CSV): skipped ${skippedDup} duplicate(s) already in ${path.basename(csvPath)}.`);
    }
    if (!toWrite.length) {
        console.log('Postage queue (CSV): nothing to append (all order id(s) already in file or empty).');
        return { ok: true, written: 0 };
    }

    for (const m of toWrite) {
        const id = canonicalEbayOrderId(m.order.orderNumber) || String(m.order.orderNumber || '').trim();
        const key = canonicalEbayOrderId(id) || id;
        if (key) existing.add(key);
    }

    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    const bom = '\uFEFF';
    let bodyLines;
    if (orderNumbersOnly && !useSoldCol) {
        bodyLines = [...existing].map((id) => csvCellEscape(id));
    } else {
        const soldById = new Map();
        if (fs.existsSync(csvPath)) {
            for (const line of fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
                if (isJunkPostageQueueCsvLine(line) || postageQueueCsvHeaderRecognized(line)) continue;
                const parts = line.split(',');
                const id = canonicalEbayOrderId((parts[0] || '').replace(/^"|"$/g, '').trim());
                const sold = (parts[1] || '').replace(/^"|"$/g, '').trim();
                if (id && sold && !soldById.has(id)) soldById.set(id, sold);
            }
        }
        for (const m of toWrite) {
            const id = canonicalEbayOrderId(m.order.orderNumber) || String(m.order.orderNumber || '').trim();
            const key = canonicalEbayOrderId(id) || id;
            const d = String(m.order.soldDate || '').trim();
            if (key && d) soldById.set(key, d);
        }
        bodyLines = [...existing].map((id) => {
            const d = soldById.get(id) || '';
            return useSoldCol ? [id, d].map(csvCellEscape).join(',') : csvCellEscape(id);
        });
    }

    writeTextToFileWithRetry(csvPath, bom + [header, ...bodyLines].join('\n') + '\n', 'Postage queue (CSV)');
    const bytes = fs.statSync(csvPath).size;
    const added = existing.size - beforeCount;

    console.log(
        `Postage queue (CSV): ${added} new order id(s); ${existing.size} total in ${csvPath} (${bytes.toLocaleString()} bytes).${
            orderNumbersOnly
                ? useSoldCol
                    ? ' Columns: order_number + sold_date.'
                    : ' Column: order_number only.'
                : ' Full detail columns.'
        } Close and reopen in Excel if the file looks blank.`,
    );
    return { ok: true, written: added };
}

/**
 * Append orders with no postage match to the postage queue (CSV by default, or Google Sheet when configured).
 * Sheet path: Google Sheets API when credentials exist, else browser paste when `browser` is passed.
 * Tab: RM_POSTAGE_QUEUE_TAB env, else gid in URL (resolved via API), else default "Postage queue" on that workbook.
 */
async function appendPostageMissingQueue(queueSheetUrl, missing, browser = null) {
    if (!missing.length) return { ok: true, written: 0 };

    const target = resolvePostageQueueTarget(queueSheetUrl);
    if (target.mode === 'csv') {
        try {
            return appendPostageMissingQueueCsv(target.path, missing);
        } catch (e) {
            console.warn(`Postage queue (CSV) append failed (${e.message || e}).`);
            for (const m of missing) console.warn(`  ${m.order.orderNumber}: ${m.reason}`);
            return { ok: false, written: 0 };
        }
    }
    queueSheetUrl = target.url;

    const rawPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
    const keyPath = rawPath ? (path.isAbsolute(rawPath) ? rawPath : path.join(process.cwd(), rawPath)) : '';
    const hasKey = Boolean(keyPath && fs.existsSync(keyPath));

    if (hasKey) {
        const spreadsheetId = spreadsheetIdFromUrl(queueSheetUrl);
        if (!spreadsheetId) {
            console.warn('Postage queue: invalid sheet URL.');
        } else {
            const gidM = String(queueSheetUrl).match(/[?&#]gid=(\d+)/i);
            const gid = gidM ? Number(gidM[1]) : NaN;
            try {
                const { google } = require('googleapis');
                const auth = new google.auth.GoogleAuth({
                    keyFile: keyPath,
                    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
                });
                const sheets = google.sheets({ version: 'v4', auth });
                let tabTitle = String(process.env.RM_POSTAGE_QUEUE_TAB || '').trim();
                if (!tabTitle && Number.isFinite(gid)) {
                    const meta = await sheets.spreadsheets.get({
                        spreadsheetId,
                        fields: 'sheets(properties(sheetId,title))',
                    });
                    const sh = (meta.data.sheets || []).find((s) => Number(s.properties.sheetId) === gid);
                    tabTitle = sh?.properties?.title || '';
                }
                if (!tabTitle) tabTitle = 'Postage queue';

                const orderNumbersOnly = ['1', 'true', 'yes'].includes(
                    String(process.env.RM_POSTAGE_QUEUE_ORDER_NUMBERS_ONLY || '').trim().toLowerCase(),
                );
                let values;
                let range;
                if (orderNumbersOnly) {
                    const useSoldCol = missing.some((m) => String(m.order.soldDate || '').trim());
                    values = missing.map((m) => {
                        const id = canonicalEbayOrderId(m.order.orderNumber) || String(m.order.orderNumber || '').trim();
                        const d = String(m.order.soldDate || '').trim();
                        return useSoldCol ? [cellForSheetPaste(id), cellForSheetPaste(d)] : [cellForSheetPaste(id)];
                    });
                    range = useSoldCol
                        ? `'${tabTitle.replace(/'/g, "''")}'!A:B`
                        : `'${tabTitle.replace(/'/g, "''")}'!A:A`;
                } else {
                    values = missing.map((m) => cellsForPostageMissingQueue(m.order, m.reason).map((c) => cellForSheetPaste(c)));
                    range = `'${tabTitle.replace(/'/g, "''")}'!A:J`;
                }
                await sheets.spreadsheets.values.append({
                    spreadsheetId,
                    range,
                    valueInputOption: 'USER_ENTERED',
                    insertDataOption: 'INSERT_ROWS',
                    requestBody: { values },
                });
                console.log(
                    `Postage queue: appended ${missing.length} row(s) to tab "${tabTitle}"${
                        orderNumbersOnly
                            ? missing.some((m) => String(m.order.soldDate || '').trim())
                                ? ' (order id column A + sold date column B)'
                                : ' (order numbers only, column A)'
                            : ''
                    }.`,
                );
                return { ok: true, written: missing.length };
            } catch (e) {
                console.warn(`Postage queue API append failed (${e.message || e}).`);
            }
        }
    }

    if (browser) {
        const fb = await appendPostageMissingQueueBrowser(browser, queueSheetUrl, missing);
        if (fb.written > 0) return { ok: true, written: fb.written };
    }

    if (!hasKey) {
        console.warn(
            'Postage queue: no GOOGLE_SERVICE_ACCOUNT_JSON (API skipped). Logged orders below — use browser session or add credentials.',
        );
    } else if (!browser) {
        console.warn('Postage queue: API failed and no browser for paste fallback.');
    }
    for (const m of missing) console.warn(`  ${m.order.orderNumber}: ${m.reason}`);
    return { ok: false, written: 0 };
}

/**
 * Any order that did not get onto the main payout sheet — same workbook as postage-missing
 * (RM_POSTAGE_QUEUE_SHEET_URL or default 169kYDQ…). Uses appendPostageMissingQueue (API + RM_POSTAGE_QUEUE_ORDER_NUMBERS_ONLY).
 *
 * @param {Array<{ orderNumber: string, reason?: string, soldDate?: string }>} entries
 * @param {import('puppeteer').Browser | null} [browser]
 */
async function appendOrdersToMainSheetFallbackQueue(entries, browser = null, queueOverride = null) {
    if (!entries || !entries.length) return { ok: true, written: 0 };
    const missing = entries
        .map((e) => ({
            order: {
                orderNumber: String(e.orderNumber || '').trim(),
                soldDate: String(e.soldDate || '').trim(),
                referenceNumber: '',
                trackingNumber: '',
                rows: [],
            },
            reason: String(e.reason || 'Could not add to main order Google Sheet').trim(),
        }))
        .filter((m) => m.order.orderNumber);
    if (!missing.length) return { ok: true, written: 0 };
    return appendPostageMissingQueue(queueOverride, missing, browser);
}

function safeFileToken(v) {
    return String(v || 'unknown').replace(/[^a-z0-9._-]+/gi, '_');
}

function withSheetRange(sheetUrl, a1Range) {
    const clean = String(sheetUrl || '').split('#')[0];
    const gidMatch = String(sheetUrl || '').match(/[?&#]gid=(\d+)/i);
    const gid = gidMatch ? gidMatch[1] : '0';
    return `${clean}#gid=${gid}&range=${encodeURIComponent(a1Range)}`;
}

function readCheckpoint() {
    if (!fs.existsSync(CHECKPOINT_PATH)) return null;
    try {
        return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
    } catch {
        return null;
    }
}

function writeCheckpoint(state) {
    const prev = readCheckpoint() || {};
    const next = { ...prev, ...state, updatedAt: new Date().toISOString() };
    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(next, null, 2), 'utf8');
}

/**
 * When the payout Google Sheet workbook changes (or you set EBAY_PAYOUT_RESET_SHEET_CHECKPOINT=1),
 * adjust checkpoint. Env reset clears **sheet** resume only (append row, written-order ids) — not orderLinkHrefs
 * or nextSkipOrders — so auto-continue (--skip-orders) still works.
 */
function reconcileCheckpointWithGoogleSheet(checkpoint, sheetUrl) {
    const sid = spreadsheetIdFromUrl(sheetUrl);
    if (!sheetUrl || !sid) return checkpoint || {};

    const resetEnv = /^(1|true|yes)$/i.test(String(process.env.EBAY_PAYOUT_RESET_SHEET_CHECKPOINT || '').trim());
    const prev = checkpoint || {};

    const clearedFull = {
        googleSheetSpreadsheetId: sid,
        nextSkipOrders: 0,
        orderLinkHrefs: [],
        lastSheetNextAppendRow: null,
        sheetNextAppendRowBySpreadsheetId: {},
        sheetWrittenOrderNumbers: [],
        lastProcessedOrderNumber: '',
    };

    const clearedSheetOnly = {
        googleSheetSpreadsheetId: sid,
        lastSheetNextAppendRow: null,
        sheetNextAppendRowBySpreadsheetId: {},
        sheetWrittenOrderNumbers: [],
        lastProcessedOrderNumber: '',
    };

    if (resetEnv) {
        writeCheckpoint({ ...prev, ...clearedSheetOnly });
        console.log(
            'EBAY_PAYOUT_RESET_SHEET_CHECKPOINT: cleared sheet append row / written-order ids only (cached order links and skip-orders unchanged). Remove the env var for the next run unless you need it again.',
        );
        return readCheckpoint();
    }

    const stored = prev.googleSheetSpreadsheetId;
    if (stored && stored !== sid) {
        writeCheckpoint({ ...prev, ...clearedFull });
        console.warn(
            `Google Sheet workbook changed (checkpoint had ${stored.slice(0, 10)}…, current URL is ${sid.slice(0, 10)}…). ` +
                `Cleared skip-orders, cached order links, sheet append row, and written-order ids so the next paste starts at row ${SHEET_FIRST_DATA_ROW} (first row below headers).`,
        );
        return readCheckpoint();
    }

    if (!stored) {
        const defaultSid = spreadsheetIdFromUrl(DEFAULT_GOOGLE_SHEET_URL);
        const hasStaleResume =
            Number(prev.nextSkipOrders) > 0 ||
            prev.lastSheetNextAppendRow != null ||
            (Array.isArray(prev.sheetWrittenOrderNumbers) && prev.sheetWrittenOrderNumbers.length > 0) ||
            !!(prev.lastProcessedOrderNumber && String(prev.lastProcessedOrderNumber).trim());
        if (defaultSid && sid === defaultSid && hasStaleResume) {
            writeCheckpoint({ ...prev, ...clearedFull });
            console.warn(
                `First run with the default 2025 payout workbook while the checkpoint had no workbook id: cleared list skip, cached links, sheet append row, and resume ids so rows start at ${SHEET_FIRST_DATA_ROW} (row 1 = headers).`,
            );
            return readCheckpoint();
        }
        writeCheckpoint({ ...prev, googleSheetSpreadsheetId: sid });
        return readCheckpoint();
    }

    return prev;
}

/** Match Seller Hub / UK listings (first segment is not always exactly 2 digits). Same idea as ebay-list-sheet-audit. */
const ORDER_NUM_RE = /^\d{2,4}-\d{4,7}-\d{4,7}$/i;

/** Normalize hyphens/spaces so Sheets cells match eBay ids (unicode dashes from paste/CSV). */
function canonicalEbayOrderId(raw) {
    const t = String(raw || '')
        .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
        .replace(/\s+/g, '')
        .trim()
        .toUpperCase();
    return ORDER_NUM_RE.test(t) ? t : '';
}

/** Order numbers already appended to the sheet (any run); keeps duplicate guard accurate when the grid is virtualized. */
function mergeSheetWrittenOrderNumbers(prevArr, newOrderNumbers) {
    const s = new Set();
    for (const x of prevArr || []) {
        const v = canonicalEbayOrderId(x);
        if (v) s.add(v);
    }
    for (const o of newOrderNumbers) {
        const v = canonicalEbayOrderId(o);
        if (v) s.add(v);
    }
    return [...s].sort();
}

/** eBay order id from Seller Hub details URL (uppercase). */
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
 * One API read of column B: next paste row (after last non-empty B cell, any text) + all eBay-style order ids.
 * Returns null if no service account / error.
 */
async function readColumnBStatsFromApi(sheetUrl) {
    const rawPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
    const keyPath = rawPath ? (path.isAbsolute(rawPath) ? rawPath : path.join(process.cwd(), rawPath)) : '';
    if (!keyPath || !fs.existsSync(keyPath)) return null;

    const spreadsheetId = spreadsheetIdFromUrl(sheetUrl);
    if (!spreadsheetId) return null;

    try {
        const { google } = require('googleapis');
        const auth = new google.auth.GoogleAuth({
            keyFile: keyPath,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const sheets = google.sheets({ version: 'v4', auth });
        const tab = await resolveGoogleSheetTabName(sheets, spreadsheetId, sheetUrl);
        const rangeB = `'${tab.replace(/'/g, "''")}'!B2:B`;
        const got = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: rangeB,
        });
        const rows = got.data.values || [];
        let lastNonEmptyIdx = -1;
        for (let i = rows.length - 1; i >= 0; i--) {
            if (String(rows[i]?.[0] ?? '').trim() !== '') {
                lastNonEmptyIdx = i;
                break;
            }
        }
        const nextAppendRow =
            lastNonEmptyIdx < 0 ? SHEET_FIRST_DATA_ROW : lastNonEmptyIdx + SHEET_FIRST_DATA_ROW + 1;

        const orderIds = new Set();
        let lastOrderId = '';
        for (const row of rows) {
            const v = canonicalEbayOrderId(row[0]);
            if (v) {
                orderIds.add(v);
                lastOrderId = v;
            }
        }
        return {
            nextAppendRow,
            orderIds,
            lastOrderId,
            lastPopulatedSheetRow: lastNonEmptyIdx < 0 ? 0 : lastNonEmptyIdx + SHEET_FIRST_DATA_ROW,
        };
    } catch (e) {
        console.warn(`Google Sheets API read column B (${e.message || e}). Using checkpoint + visible cells only for duplicate skip.`);
        return null;
    }
}

/** Full column B order ids via API (requires service account JSON). Returns null if unavailable. */
async function readSheetColumnBOrderNumbersApi(sheetUrl) {
    const stats = await readColumnBStatsFromApi(sheetUrl);
    return stats ? stats.orderIds : null;
}

/**
 * Column B visible in the grid virtualizes — scan after Home and after End and merge (no API).
 * Still misses “middle” order ids for duplicate detection if neither viewport shows them.
 */
async function readDuplicateOrdersDomMerged(sheetPage) {
    await sheetPage.click('[role="grid"], div.docs-sheet-container').catch(() => {});
    await sleep(120);
    await sheetPage.keyboard.down('Control');
    await sheetPage.keyboard.press('Home');
    await sheetPage.keyboard.up('Control');
    await sleep(450);
    const top = await readDuplicateOrdersAndAppendRow(sheetPage);
    await sheetPage.keyboard.down('Control');
    await sheetPage.keyboard.press('End');
    await sheetPage.keyboard.up('Control');
    await sleep(500);
    const end = await readDuplicateOrdersAndAppendRow(sheetPage);
    const appendRow = Math.max(top.appendRow, end.appendRow);
    const mergedNums = [...new Set([...top.existingOrderNumbers, ...end.existingOrderNumbers])];
    return { appendRow, existingOrderNumbers: mergedNums, topAppend: top.appendRow, endAppend: end.appendRow };
}

/** Visible column B order ids (virtualized — subset of sheet). */
async function readVisibleSheetColumnBOrderNumbers(browser, sheetUrl) {
    const pages = await browser.pages();
    const targetDocIdMatch = String(sheetUrl || '').match(/\/spreadsheets\/d\/([^/]+)/i);
    const targetDocId = targetDocIdMatch ? targetDocIdMatch[1] : '';
    let sheetPage =
        pages.find((p) => {
            const u = p.url() || '';
            return targetDocId ? u.includes(`/spreadsheets/d/${targetDocId}`) : u.includes('docs.google.com/spreadsheets/');
        }) || null;
    let created = false;
    if (!sheetPage) {
        sheetPage = await browser.newPage();
        created = true;
        await sheetPage.goto(withSheetRange(sheetUrl, 'A1'), { waitUntil: 'domcontentloaded', timeout: 120000 });
    } else {
        await sheetPage.bringToFront();
        await sheetPage.goto(withSheetRange(sheetUrl, 'A1'), { waitUntil: 'domcontentloaded', timeout: 120000 });
    }
    await sheetPage.waitForSelector('[role="grid"], div.docs-sheet-container', { timeout: 120000 });
    const merged = await readDuplicateOrdersDomMerged(sheetPage);
    const out = new Set(merged.existingOrderNumbers.map((x) => canonicalEbayOrderId(x)).filter(Boolean));
    if (created) await sheetPage.close().catch(() => {});
    return out;
}

/** All order numbers we treat as “already on the sheet” for skipping eBay detail loads. */
async function buildAlreadyOnSheetOrderSet(browser, sheetUrl) {
    const merged = new Set();
    const fromApi = await readSheetColumnBOrderNumbersApi(sheetUrl);
    if (fromApi) {
        for (const x of fromApi) merged.add(x);
        console.log(`Sheet: read ${fromApi.size} order number(s) from column B via API (full column).`);
    } else {
        console.log(
            'Sheet: no API — using checkpoint + browser scan (Ctrl+Home / Ctrl+End merged). Middle rows may be missed without the API.',
        );
    }
    for (const id of (readCheckpoint() || {}).sheetWrittenOrderNumbers || []) {
        const v = canonicalEbayOrderId(id);
        if (v) merged.add(v);
    }
    if (!fromApi) {
        try {
            const vis = await readVisibleSheetColumnBOrderNumbers(browser, sheetUrl);
            let added = 0;
            for (const x of vis) {
                if (!merged.has(x)) added++;
                merged.add(x);
            }
            console.log(`Sheet: merged ${added} order number(s) from visible grid (not full sheet without API).`);
        } catch (e) {
            console.warn(`Sheet: could not scan visible column B (${e.message || e}).`);
        }
    }
    return merged;
}

function spreadsheetIdFromUrl(sheetUrl) {
    const m = String(sheetUrl || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return m ? m[1] : '';
}

/**
 * sheetWrittenOrderNumbers in .ebay-payout-checkpoint.json belongs to googleSheetSpreadsheetId.
 * When writing to a different workbook (e.g. manual postage sheet), do not treat those ids as duplicates here.
 */
function checkpointWrittenOrderIdsApplyToSheet(sheetUrl) {
    const cp = readCheckpoint() || {};
    const cpSid = String(cp.googleSheetSpreadsheetId || '').trim();
    const urlSid = spreadsheetIdFromUrl(sheetUrl);
    if (!urlSid) return true;
    if (!cpSid) return true;
    return cpSid === urlSid;
}

/**
 * Sheet tab title for API ranges. Honors GOOGLE_SHEET_TAB; otherwise maps the spreadsheet URL #gid to a title
 * (avoids appending to a non-existent "Sheet1" when the first tab has another name).
 */
async function resolveGoogleSheetTabName(sheets, spreadsheetId, sheetUrl) {
    const envTab = String(process.env.GOOGLE_SHEET_TAB || '').trim();
    if (envTab) return envTab;
    const gidMatch = String(sheetUrl || '').match(/[#&?]gid=(\d+)/i);
    const gid = gidMatch ? parseInt(gidMatch[1], 10) : 0;
    if (!Number.isFinite(gid)) return 'Sheet1';
    try {
        const meta = await sheets.spreadsheets.get({
            spreadsheetId,
            fields: 'sheets.properties(sheetId,title)',
        });
        const list = meta.data.sheets || [];
        const hit = list.find((s) => s.properties && Number(s.properties.sheetId) === gid);
        if (hit?.properties?.title) return hit.properties.title;
        const first = list[0]?.properties?.title;
        if (first) return first;
    } catch {
        /* fall through */
    }
    return 'Sheet1';
}

/**
 * Navigating to A{n} in the name box fails with “Invalid range / exceeds the sheet size” when the workbook
 * tab’s grid has fewer than n rows (new sheets are often 1000 rows). Grows the tab with appendDimension
 * when a service account is configured.
 *
 * @param {string} sheetUrl
 * @param {number} minRow1Based minimum row index that must exist (e.g. 3000 to paste at A3000)
 * @returns {Promise<{ reloadBrowserTab: boolean }>} reloadBrowserTab — true if we added rows; reload the open Sheet so A{n} is valid
 */
async function ensureGoogleSheetGridRowsAtLeast(sheetUrl, minRow1Based) {
    const min = Math.floor(Number(minRow1Based));
    if (!Number.isFinite(min) || min < SHEET_FIRST_DATA_ROW) return { reloadBrowserTab: false };

    const rawPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
    const keyPath = rawPath ? (path.isAbsolute(rawPath) ? rawPath : path.join(process.cwd(), rawPath)) : '';
    if (!keyPath || !fs.existsSync(keyPath)) {
        if (min > 1000) {
            console.warn(
                `Sheet: need row ${min} for browser paste, but the default tab is only 1000 rows until expanded. ` +
                    `Set GOOGLE_SERVICE_ACCOUNT_JSON (same as other scripts) so the grid can be grown automatically, ` +
                    `or in Google Sheets: add rows to the bottom, or prefer API append (no jump to A${min}).`,
            );
        }
        return { reloadBrowserTab: false };
    }

    const spreadsheetId = spreadsheetIdFromUrl(sheetUrl);
    if (!spreadsheetId) return { reloadBrowserTab: false };

    try {
        const { google } = require('googleapis');
        const auth = new google.auth.GoogleAuth({
            keyFile: keyPath,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const sheets = google.sheets({ version: 'v4', auth });
        const gidMatch = String(sheetUrl).match(/[#&?]gid=(\d+)/i);
        const targetGid = gidMatch ? parseInt(gidMatch[1], 10) : 0;

        const meta = await sheets.spreadsheets.get({
            spreadsheetId,
            fields: 'sheets.properties(sheetId,gridProperties)',
        });
        const list = meta.data.sheets || [];
        const sheet = list.find((s) => s.properties && Number(s.properties.sheetId) === targetGid) || list[0];
        if (!sheet?.properties) return { reloadBrowserTab: false };
        const sheetId = sheet.properties.sheetId;
        const rowCount = sheet.properties.gridProperties?.rowCount ?? 1000;
        if (min <= rowCount) return { reloadBrowserTab: false };

        const addRows = min - rowCount + 25;
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: [
                    {
                        appendDimension: {
                            sheetId,
                            dimension: 'ROWS',
                            length: addRows,
                        },
                    },
                ],
            },
        });
        console.log(
            `Sheet: expanded tab by ${addRows} row(s) (grid was ${rowCount} rows; need row ${min} for A${min} browser paste).`,
        );
        return { reloadBrowserTab: true };
    } catch (e) {
        const msg = String(e.message || e);
        console.warn(`Sheet: could not expand grid before browser paste (${msg.slice(0, 200)}).`);
        return { reloadBrowserTab: false };
    }
}

/** Strip characters that break TSV paste / Sheets cells */
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

/** Single-line TSV for one row — must not contain newlines or the paste becomes many rows. */
function tsvLineForOneRow(cells) {
    const line = cells.map((c) => cellForSheetPaste(c)).join('\t');
    return line.replace(/\r?\n/g, ' ').replace(/\u2028|\u2029/g, ' ');
}

/**
 * One sheet/table row A–H: order_date, order_number, item_name, custom_label_sku, quantity,
 * net_earnings, client_payout, Client ID.
 */
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

/**
 * Append rows using googleapis (no browser UI). Requires service account JSON and sheet shared with its email.
 * Returns { writtenRows, skippedDuplicates } or null to fall back to browser.
 */
async function tryAppendViaGoogleSheetsApi(sheetUrl, rows, options = {}) {
    const rawPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
    const keyPath = rawPath ? (path.isAbsolute(rawPath) ? rawPath : path.join(process.cwd(), rawPath)) : '';
    if (!keyPath || !fs.existsSync(keyPath)) {
        if (!warnedMissingGoogleServiceAccountJson) {
            warnedMissingGoogleServiceAccountJson = true;
            console.warn(
                'Google Sheets API: GOOGLE_SERVICE_ACCOUNT_JSON (or GOOGLE_APPLICATION_CREDENTIALS) is not set or the file does not exist — rows use browser paste. Set the env var to your service account JSON path and share the spreadsheet with that account email.',
            );
        }
        return null;
    }

    const spreadsheetId = spreadsheetIdFromUrl(sheetUrl);
    if (!spreadsheetId) return null;

    const { google } = require('googleapis');

    const auth = new google.auth.GoogleAuth({
        keyFile: keyPath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const tab = await resolveGoogleSheetTabName(sheets, spreadsheetId, sheetUrl);
    if (!String(process.env.GOOGLE_SHEET_TAB || '').trim()) {
        console.log(`Google Sheets API: tab "${tab}" (from URL gid; set GOOGLE_SHEET_TAB to override).`);
    }
    const bypassDup = !!options.bypassDuplicateGuard;

    let rowsToWrite;
    let skippedDuplicates;

    if (bypassDup) {
        rowsToWrite = rows.filter((r) => canonicalEbayOrderId(r.orderNumber));
        skippedDuplicates = rows.length - rowsToWrite.length;
        console.log(
            `Google Sheets API: duplicate guard bypass — appending ${rowsToWrite.length} row(s) even if that order id already appears in the sheet or checkpoint.`,
        );
    } else {
        const rangeB = `'${tab.replace(/'/g, "''")}'!B2:B`;

        let existingValues = [];
        try {
            const got = await sheets.spreadsheets.values.get({
                spreadsheetId,
                range: rangeB,
            });
            existingValues = got.data.values || [];
        } catch (e) {
            const msg = String(e.message || e);
            console.warn(
                `Google Sheets API: could not read column B for duplicate check (${msg.slice(0, 240)}). Continuing — append will still be attempted (duplicate detection from column B only is skipped). Verify GOOGLE_SHEET_TAB="${tab}" and that the spreadsheet is shared with the service account.`,
            );
            existingValues = [];
        }

        const existingSet = new Set();
        for (const row of existingValues) {
            const v = canonicalEbayOrderId(row[0]);
            if (v) existingSet.add(v);
        }
        if (checkpointWrittenOrderIdsApplyToSheet(sheetUrl)) {
            for (const id of (readCheckpoint() || {}).sheetWrittenOrderNumbers || []) {
                const v = canonicalEbayOrderId(id);
                if (v) existingSet.add(v);
            }
        } else {
            console.log(
                'Google Sheets API: duplicate check uses this sheet’s column B only — checkpoint order ids are for a different spreadsheet.',
            );
        }

        rowsToWrite = rows.filter((r) => !existingSet.has(canonicalEbayOrderId(r.orderNumber)));
        skippedDuplicates = rows.length - rowsToWrite.length;
    }
    if (!rowsToWrite.length) {
        return { writtenRows: 0, skippedDuplicates, lastSheetNextAppendRow: null };
    }

    const values = rowsToWrite.map((r) => cellsForPayoutSheetTable(r).map((c) => cellForSheetPaste(c)));

    const appendRange = `'${tab.replace(/'/g, "''")}'!A:H`;
    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: appendRange,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
    });

    const cp = readCheckpoint() || {};
    const addedIds = rowsToWrite.map((r) => canonicalEbayOrderId(r.orderNumber)).filter(Boolean);
    const mapPrev = { ...(cp.sheetNextAppendRowBySpreadsheetId || {}) };
    let statsAfter = null;
    try {
        statsAfter = await readColumnBStatsFromApi(sheetUrl);
    } catch {
        /* ignore */
    }
    if (statsAfter && spreadsheetId) {
        mapPrev[spreadsheetId] = statsAfter.nextAppendRow;
    }
    const cpSid = String(cp.googleSheetSpreadsheetId || '').trim();
    const patch = {
        ...cp,
        sheetWrittenOrderNumbers: mergeSheetWrittenOrderNumbers(cp.sheetWrittenOrderNumbers, addedIds),
        sheetNextAppendRowBySpreadsheetId: mapPrev,
    };
    if (statsAfter && (!cpSid || cpSid === spreadsheetId)) {
        patch.lastSheetNextAppendRow = statsAfter.nextAppendRow;
    }
    writeCheckpoint(patch);

    return { writtenRows: rowsToWrite.length, skippedDuplicates, lastSheetNextAppendRow: null };
}

/** True if column B has at least one eBay-style order number on row 2+ (visible grid only — can miss rows when API is off). */
async function sheetHasAnyOrderRows(browser, sheetUrl) {
    const pages = await browser.pages();
    const targetDocIdMatch = String(sheetUrl).match(/\/spreadsheets\/d\/([^/]+)/i);
    const targetDocId = targetDocIdMatch ? targetDocIdMatch[1] : '';
    let sheetPage =
        pages.find((p) => {
            const u = p.url() || '';
            return targetDocId ? u.includes(`/spreadsheets/d/${targetDocId}`) : u.includes('docs.google.com/spreadsheets/');
        }) || null;
    let created = false;
    if (!sheetPage) {
        sheetPage = await browser.newPage();
        created = true;
        await sheetPage.goto(withSheetRange(sheetUrl, 'A1'), { waitUntil: 'domcontentloaded', timeout: 120000 });
    } else {
        await sheetPage.bringToFront();
        await sheetPage.goto(withSheetRange(sheetUrl, 'A1'), { waitUntil: 'domcontentloaded', timeout: 120000 });
    }
    await sheetPage.waitForSelector('[role="grid"], div.docs-sheet-container', { timeout: 120000 });
    await sleep(500);

    async function visibleHasOrders() {
        const state = await readDuplicateOrdersAndAppendRow(sheetPage);
        return state.existingOrderNumbers.length > 0;
    }

    if (await visibleHasOrders()) {
        if (created) await sheetPage.close().catch(() => {});
        return true;
    }

    await sheetPage.click('[role="grid"], div.docs-sheet-container').catch(() => {});
    await sleep(120);
    await sheetPage.keyboard.down('Control');
    await sheetPage.keyboard.press('Home');
    await sheetPage.keyboard.up('Control');
    await sleep(450);
    if (await visibleHasOrders()) {
        if (created) await sheetPage.close().catch(() => {});
        return true;
    }

    await sheetPage.keyboard.down('Control');
    await sheetPage.keyboard.press('End');
    await sheetPage.keyboard.up('Control');
    await sleep(450);
    const ok = await visibleHasOrders();
    if (created) await sheetPage.close().catch(() => {});
    return ok;
}

/**
 * Reliable check for resume: Sheets API (full column B) when credentials exist; else visible DOM.
 * Returns { hasOrders: boolean, source: 'api'|'dom'|'none' } for logging.
 */
async function sheetHasOrdersForResume(sheetUrl, browser) {
    const fromApi = await readSheetColumnBOrderNumbersApi(sheetUrl);
    if (fromApi !== null) {
        return { hasOrders: fromApi.size > 0, source: 'api' };
    }
    const dom = await sheetHasAnyOrderRows(browser, sheetUrl);
    return { hasOrders: dom, source: 'dom' };
}

/** Scan visible grid: duplicate order numbers in column B + first append row after last valid order (no keyboard). */
async function readDuplicateOrdersAndAppendRow(sheetPage) {
    return sheetPage.evaluate((firstDataRow) => {
        const re = /^\d{2}-\d{4,6}-\d{4,6}$/i;
        function canon(v) {
            const t = String(v || '')
                .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
                .replace(/\s+/g, '')
                .trim()
                .toUpperCase();
            return re.test(t) ? t : '';
        }
        const nums = [];
        let lastOrderRow = 0;
        for (const cell of document.querySelectorAll('[role="gridcell"][aria-colindex="2"]')) {
            const ri = Number(cell.getAttribute('aria-rowindex') || '0');
            if (ri < firstDataRow) continue;
            const v = canon(cell.textContent || '');
            if (v) {
                nums.push(v);
                lastOrderRow = Math.max(lastOrderRow, ri);
            }
        }
        const appendRow = lastOrderRow === 0 ? firstDataRow : lastOrderRow + 1;
        return { existingOrderNumbers: nums, appendRow };
    }, SHEET_FIRST_DATA_ROW);
}

/** Same as readDuplicateOrdersAndAppendRow but column A (order-id-only queue rows). */
async function readDuplicateOrdersAndAppendRowColumnA(sheetPage) {
    return sheetPage.evaluate((firstDataRow) => {
        const re = /^\d{2}-\d{4,6}-\d{4,6}$/i;
        function canon(v) {
            const t = String(v || '')
                .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
                .replace(/\s+/g, '')
                .trim()
                .toUpperCase();
            return re.test(t) ? t : '';
        }
        const nums = [];
        let lastOrderRow = 0;
        for (const cell of document.querySelectorAll('[role="gridcell"][aria-colindex="1"]')) {
            const ri = Number(cell.getAttribute('aria-rowindex') || '0');
            if (ri < firstDataRow) continue;
            const v = canon(cell.textContent || '');
            if (v) {
                nums.push(v);
                lastOrderRow = Math.max(lastOrderRow, ri);
            }
        }
        const appendRow = lastOrderRow === 0 ? firstDataRow : lastOrderRow + 1;
        return { existingOrderNumbers: nums, appendRow };
    }, SHEET_FIRST_DATA_ROW);
}

async function readQueueSheetColumnADomMerged(sheetPage) {
    await sheetPage.click('[role="grid"], div.docs-sheet-container').catch(() => {});
    await sleep(120);
    await sheetPage.keyboard.down('Control');
    await sheetPage.keyboard.press('Home');
    await sheetPage.keyboard.up('Control');
    await sleep(450);
    const top = await readDuplicateOrdersAndAppendRowColumnA(sheetPage);
    await sheetPage.keyboard.down('Control');
    await sheetPage.keyboard.press('End');
    await sheetPage.keyboard.up('Control');
    await sleep(500);
    const end = await readDuplicateOrdersAndAppendRowColumnA(sheetPage);
    const appendRow = Math.max(top.appendRow, end.appendRow);
    const mergedNums = [...new Set([...top.existingOrderNumbers, ...end.existingOrderNumbers])];
    return { appendRow, existingOrderNumbers: mergedNums };
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
    if (!ok) {
        throw new Error('Could not copy row to clipboard (execCommand copy failed).');
    }
}

/**
 * After name-box / range navigation, virtualized rows may not exist in the DOM until scrolled into view.
 * Returns true when a real gridcell for (row,col) is present with a sane bounding box.
 */
async function waitForGridCellVisibleForPaste(sheetPage, rowIndex, colIndex = 1, options = {}) {
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 12000;
    const deadline = Date.now() + timeoutMs;
    let ticks = 0;
    while (Date.now() < deadline) {
        ticks++;
        const ok = await sheetPage.evaluate(
            (row, col) => {
                let cell = document.querySelector(
                    `[role="gridcell"][aria-rowindex="${row}"][aria-colindex="${col}"]`,
                );
                if (!(cell instanceof Element)) {
                    cell = Array.from(document.querySelectorAll(`[role="gridcell"][aria-rowindex="${row}"]`)).find(
                        (el) => Number(el.getAttribute('aria-colindex') || '0') === col,
                    );
                }
                if (!(cell instanceof HTMLElement)) return false;
                cell.scrollIntoView({ block: 'center', inline: 'nearest' });
                const r = cell.getBoundingClientRect();
                return (
                    r.width >= 3 &&
                    r.height >= 3 &&
                    r.bottom > 12 &&
                    r.right > 12 &&
                    r.top < innerHeight - 8 &&
                    r.left < innerWidth - 8
                );
            },
            rowIndex,
            colIndex,
        );
        if (ok) return true;
        if (ticks <= 40) await sleep(200);
        else {
            await sheetPage.keyboard.press('PageDown').catch(() => {});
            await sleep(140);
        }
    }
    return false;
}

/**
 * Google Sheets often ignores Ctrl+V until the cell canvas has a real pointer click (not just
 * programmatic .click()). Use viewport coordinates + Puppeteer mouse.click every time.
 */
async function clickSheetCellForPaste(sheetPage, rowIndex, colIndex = 1) {
    await sheetPage.bringToFront();
    let h = await sheetPage.$(`[role="gridcell"][aria-rowindex="${rowIndex}"][aria-colindex="${colIndex}"]`);
    if (!h) {
        const cells = await sheetPage.$$(`[role="gridcell"][aria-rowindex="${rowIndex}"]`);
        for (const c of cells) {
            const ci = await c.evaluate((el) => Number(el.getAttribute('aria-colindex') || '0'));
            if (ci === colIndex) {
                h = c;
                break;
            }
        }
    }
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
            let cell = document.querySelector(`[role="gridcell"][aria-rowindex="${row}"][aria-colindex="${col}"]`);
            if (!(cell instanceof HTMLElement)) {
                cell = Array.from(document.querySelectorAll(`[role="gridcell"][aria-rowindex="${row}"]`)).find(
                    (el) => Number(el.getAttribute('aria-colindex') || '0') === col,
                );
            }
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
            let cell = document.querySelector(`[role="gridcell"][aria-rowindex="${row}"][aria-colindex="${col}"]`);
            if (!(cell instanceof HTMLElement)) {
                cell = Array.from(document.querySelectorAll(`[role="gridcell"][aria-rowindex="${row}"]`)).find(
                    (el) => Number(el.getAttribute('aria-colindex') || '0') === col,
                );
            }
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

/** Read the active cell row/col from the grid (Sheets + Insert→ Table often omit aria-selected on gridcell). */
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

/** Name box / “range” field left of the formula bar — typing A102 + Enter jumps the grid (works with virtualization). */
const SHEET_NAME_BOX_SELECTOR = '#t-name-box, input.waffle-name-box, input.jfk-textinput.waffle-name-box';

/**
 * Jump to an A1-style cell via the Sheets name box (same as a human). Falls back to #range= URL if the box is missing.
 */
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

/**
 * Browser paste fallback for postage-missing / main-sheet fallback queue (when API is unavailable or failed).
 * Respects RM_POSTAGE_QUEUE_ORDER_NUMBERS_ONLY (column A only vs full A:J row).
 */
async function appendPostageMissingQueueBrowser(browser, queueSheetUrl, missing) {
    if (!browser || !queueSheetUrl || !missing.length) return { ok: false, written: 0 };

    const orderNumbersOnly = ['1', 'true', 'yes'].includes(
        String(process.env.RM_POSTAGE_QUEUE_ORDER_NUMBERS_ONLY || '').trim().toLowerCase(),
    );

    const pages = await browser.pages();
    const targetDocIdMatch = String(queueSheetUrl).match(/\/spreadsheets\/d\/([^/]+)/i);
    const targetDocId = targetDocIdMatch ? targetDocIdMatch[1] : '';
    let sheetPage =
        pages.find((p) => {
            const u = p.url() || '';
            return targetDocId ? u.includes(`/spreadsheets/d/${targetDocId}`) : u.includes('docs.google.com/spreadsheets/');
        }) || null;
    let openedNewTab = false;
    if (!sheetPage) {
        sheetPage = await browser.newPage();
        openedNewTab = true;
        await sheetPage.goto(withSheetRange(queueSheetUrl, 'A1'), { waitUntil: 'domcontentloaded', timeout: 120000 });
    } else {
        await sheetPage.bringToFront();
        await sheetPage.goto(withSheetRange(queueSheetUrl, 'A1'), { waitUntil: 'domcontentloaded', timeout: 120000 });
    }
    await sheetPage.waitForSelector('[role="grid"], div.docs-sheet-container', { timeout: 120000 });

    let domMerged;
    if (orderNumbersOnly) {
        domMerged = await readQueueSheetColumnADomMerged(sheetPage);
    } else {
        domMerged = await readDuplicateOrdersDomMerged(sheetPage);
    }

    const existingSet = new Set(
        domMerged.existingOrderNumbers.map((x) => canonicalEbayOrderId(x)).filter(Boolean),
    );
    const toWrite = missing.filter((m) => {
        const id = canonicalEbayOrderId(m.order.orderNumber) || String(m.order.orderNumber || '').trim();
        return id && !existingSet.has(id);
    });
    const skippedDup = missing.length - toWrite.length;
    if (skippedDup > 0) {
        console.log(
            `Postage queue (browser): skipped ${skippedDup} duplicate(s) already visible on the queue sheet (Home+End scan).`,
        );
    }
    if (!toWrite.length) {
        console.log('Postage queue (browser): nothing to append (all order id(s) already on sheet or empty).');
        return { ok: true, written: 0 };
    }

    let startRow = Math.max(SHEET_FIRST_DATA_ROW, domMerged.appendRow);
    const modeLabel = orderNumbersOnly
        ? toWrite.some((m) => String(m.order.soldDate || '').trim())
            ? 'order id + sold date (columns A:B)'
            : 'order numbers only (column A)'
        : 'full row A:J';
    const jumpRef = `A${startRow}`;
    console.log(
        `Postage queue (browser): pasting ${toWrite.length} row(s) (${modeLabel}) from ${jumpRef} — keep the Sheet tab focused.`,
    );
    await goToSheetRangeForPaste(sheetPage, queueSheetUrl, jumpRef);
    let qGridReady = await waitForGridCellVisibleForPaste(sheetPage, startRow, 1, { timeoutMs: 20000 });
    if (!qGridReady) {
        console.warn(`Postage queue (browser): row ${jumpRef} not visible as gridcell — loading #range= once…`);
        await sheetPage.goto(withSheetRange(queueSheetUrl, jumpRef), { waitUntil: 'domcontentloaded', timeout: 120000 });
        await sheetPage.waitForSelector('[role="grid"], div.docs-sheet-container', { timeout: 120000 });
        await sleep(800);
        qGridReady = await waitForGridCellVisibleForPaste(sheetPage, startRow, 1, { timeoutMs: 15000 });
    }
    await clickSheetCellForPaste(sheetPage, startRow, 1);
    await sleep(200);

    const sheetPasteWarnState = { sheetCellRowUnreadable: false };
    let loggedOsClipboard = false;

    for (let r = 0; r < toWrite.length; r++) {
        const absRow = Math.max(SHEET_FIRST_DATA_ROW, startRow + r);
        if (r > 0) {
            await sheetPage.keyboard.press('Home');
            await sleep(50);
            await sheetPage.keyboard.press('ArrowDown');
            await sleep(140);
        }
        await waitForGridCellVisibleForPaste(sheetPage, absRow, 1, { timeoutMs: 8000 });
        await clickSheetCellForPaste(sheetPage, absRow, 1);
        await assertActiveCellIsDataRow(
            sheetPage,
            absRow,
            `Postage queue paste row ${r + 1}/${toWrite.length} (A${absRow})`,
            sheetPasteWarnState,
        );

        const cells = orderNumbersOnly
            ? (() => {
                  const id =
                      canonicalEbayOrderId(toWrite[r].order.orderNumber) ||
                      String(toWrite[r].order.orderNumber || '').trim();
                  const d = String(toWrite[r].order.soldDate || '').trim();
                  return d ? [id, d] : [id];
              })()
            : cellsForPostageMissingQueue(toWrite[r].order, toWrite[r].reason);
        const line = tsvLineForOneRow(cells);

        let usedOsClipboard = copyTextToOsClipboardSync(line);
        if (!usedOsClipboard) {
            console.warn('Postage queue (browser): OS clipboard failed — using in-page copy.');
            await copyTextForBrowserPaste(sheetPage, line);
            await waitForGridCellVisibleForPaste(sheetPage, absRow, 1, { timeoutMs: 5000 });
            await clickSheetCellForPaste(sheetPage, absRow, 1);
        } else if (!loggedOsClipboard) {
            loggedOsClipboard = true;
            console.log('Postage queue (browser): pasting via OS clipboard.');
        }

        await sheetPage.bringToFront();
        await sleep(usedOsClipboard ? 120 : 40);

        const pasteMod = process.platform === 'darwin' ? 'Meta' : 'Control';
        await sheetPage.keyboard.down(pasteMod);
        await sheetPage.keyboard.press('KeyV');
        await sheetPage.keyboard.up(pasteMod);
        await sleep(260);
    }

    if (openedNewTab) {
        console.log('Postage queue (browser): opened Google Sheet tab for queue; leaving it open.');
    }
    console.log(`Postage queue (browser): appended ${toWrite.length} row(s).`);
    return { ok: true, written: toWrite.length };
}

async function writeRowsToSheet(browser, sheetUrl, rows, options = {}) {
    if (!sheetUrl || !rows.length) return { writtenRows: 0, skippedDuplicates: 0, lastSheetNextAppendRow: null };

    if (!options.sheetBrowserOnly) {
        try {
            const api = await tryAppendViaGoogleSheetsApi(sheetUrl, rows, options);
            if (api !== null) {
                console.log(
                    `Google Sheets API: wrote ${api.writtenRows} row(s); skipped ${api.skippedDuplicates} duplicate(s).`,
                );
                return { ...api, lastSheetNextAppendRow: null };
            }
        } catch (e) {
            console.warn(`Google Sheets API error (${e.message || e}). Falling back to browser paste.`);
        }
    }

    const pages = await browser.pages();
    const targetDocIdMatch = String(sheetUrl).match(/\/spreadsheets\/d\/([^/]+)/i);
    const targetDocId = targetDocIdMatch ? targetDocIdMatch[1] : '';
    let sheetPage =
        pages.find((p) => {
            const u = p.url() || '';
            return targetDocId ? u.includes(`/spreadsheets/d/${targetDocId}`) : u.includes('docs.google.com/spreadsheets/');
        }) || null;
    let openedNewTab = false;
    if (!sheetPage) {
        sheetPage = await browser.newPage();
        openedNewTab = true;
        await sheetPage.goto(withSheetRange(sheetUrl, 'A1'), { waitUntil: 'domcontentloaded', timeout: 120000 });
    } else {
        await sheetPage.bringToFront();
        await sheetPage.goto(withSheetRange(sheetUrl, 'A1'), { waitUntil: 'domcontentloaded', timeout: 120000 });
    }
    await sheetPage.waitForSelector('[role="grid"], div.docs-sheet-container', { timeout: 120000 });

    const colBApi = await readColumnBStatsFromApi(sheetUrl);
    const domMerged = await readDuplicateOrdersDomMerged(sheetPage);

    let domAppendRow = Math.max(SHEET_FIRST_DATA_ROW, domMerged.appendRow);
    if (colBApi) {
        domAppendRow = Math.max(domAppendRow, colBApi.nextAppendRow);
    }

    if (colBApi) {
        console.log(
            `Sheet: column B (API) — next empty row A${colBApi.nextAppendRow} (after last value in B); ${colBApi.orderIds.size} order id(s) for duplicate check.`,
        );
        if (colBApi.nextAppendRow >= 500) {
            console.log(
                `Sheet: high row number — column B on this tab already has data through row ~${colBApi.lastPopulatedSheetRow}; new rows append after that. Use a blank tab/sheet if you expected row ${SHEET_FIRST_DATA_ROW}.`,
            );
        }
    } else {
        console.log(
            `Sheet: next paste row A${domAppendRow} (browser: Ctrl+Home + Ctrl+End + visible grid). Set GOOGLE_SERVICE_ACCOUNT_JSON for the exact next row on long sheets.`,
        );
    }

    const sheetState = {
        existingOrderNumbers: domMerged.existingOrderNumbers,
        appendRow: domAppendRow,
    };
    const cpNow = readCheckpoint() || {};
    const rawCpAppend = cpNow.lastSheetNextAppendRow;
    const checkpointSpreadsheetId = String(cpNow.googleSheetSpreadsheetId || '').trim();
    const urlSpreadsheetId = spreadsheetIdFromUrl(sheetUrl);
    const mapBySid =
        cpNow.sheetNextAppendRowBySpreadsheetId && typeof cpNow.sheetNextAppendRowBySpreadsheetId === 'object'
            ? cpNow.sheetNextAppendRowBySpreadsheetId
            : {};

    let cpAppendRow = 0;
    if (urlSpreadsheetId && mapBySid[urlSpreadsheetId] != null && Number.isFinite(Number(mapBySid[urlSpreadsheetId]))) {
        const n = Math.floor(Number(mapBySid[urlSpreadsheetId]));
        if (n >= SHEET_FIRST_DATA_ROW) {
            cpAppendRow = n;
            console.log(
                `Sheet: resume next append A${cpAppendRow} (checkpoint map for workbook ${urlSpreadsheetId.slice(0, 10)}… — safe when using a different sheet than the main payout workbook).`,
            );
        }
    }
    if (!cpAppendRow && rawCpAppend != null && Number.isFinite(Number(rawCpAppend))) {
        const n = Math.floor(Number(rawCpAppend));
        if (n >= SHEET_FIRST_DATA_ROW) {
            if (checkpointSpreadsheetId && urlSpreadsheetId && checkpointSpreadsheetId !== urlSpreadsheetId) {
                console.log(
                    `Sheet: ignoring lastSheetNextAppendRow (A${n}) — checkpoint is for spreadsheet ${checkpointSpreadsheetId.slice(0, 10)}…, but this URL is ${urlSpreadsheetId.slice(0, 10)}… (use per-workbook map, column B API, or GOOGLE_SERVICE_ACCOUNT_JSON).`,
                );
            } else {
                cpAppendRow = n;
            }
        }
    }
    /**
     * Lower bound when continuing eBay chunks: if each prior link used ~1 sheet row, the next free row
     * is at least (header row + skip). DOM is often wrong (virtualized grid); checkpoint is best.
     */
    const skipOrders = Math.max(0, Math.floor(Number(options.ebaySkipOrders) || 0));
    const linkRowFloor = skipOrders > 0 ? SHEET_FIRST_DATA_ROW + skipOrders : 0;
    /** Sheets virtualizes rows — never trust DOM alone for batch 2+. */
    let startRow = Math.max(domAppendRow, cpAppendRow, linkRowFloor);
    if (skipOrders > 0 && !cpAppendRow && startRow === linkRowFloor && linkRowFloor > domAppendRow) {
        console.warn(
            `Sheet: lastSheetNextAppendRow missing from checkpoint — using skip-orders floor A${linkRowFloor} (~1 sheet row per order link). Set lastSheetNextAppendRow after batch 1 if multi-row orders.`,
        );
    } else if (skipOrders > 0 && cpAppendRow && startRow === cpAppendRow && cpAppendRow > domAppendRow) {
        console.log(
            `Sheet: continuation (skip-orders=${skipOrders}) — appending at A${startRow} from checkpoint (DOM suggested A${domAppendRow}).`,
        );
    } else if (startRow > domAppendRow) {
        console.log(
            `Sheet: DOM suggested A${domAppendRow} but using A${startRow} so new rows go below prior batches.`,
        );
    } else {
        console.log(
            `Sheet append row: A${startRow} (DOM suggested A${domAppendRow}; row 1 is headers only; data starts row ${SHEET_FIRST_DATA_ROW}).`,
        );
    }

    const checkpointDupIdsApply = checkpointWrittenOrderIdsApplyToSheet(sheetUrl);
    const fromCheckpoint = checkpointDupIdsApply
        ? new Set(
              ((readCheckpoint() || {}).sheetWrittenOrderNumbers || []).map((x) => canonicalEbayOrderId(x)).filter(Boolean),
          )
        : new Set();
    if (!checkpointDupIdsApply && ((readCheckpoint() || {}).sheetWrittenOrderNumbers || []).length) {
        console.log(
            `Sheet: duplicate check ignores ${((readCheckpoint() || {}).sheetWrittenOrderNumbers || []).length} checkpoint order id(s) — list is for spreadsheet ${checkpointSpreadsheetId.slice(0, 10)}…, not ${urlSpreadsheetId.slice(0, 10)}…`,
        );
    }
    const bypassDup = !!options.bypassDuplicateGuard;
    const existingSet = new Set([
        ...sheetState.existingOrderNumbers.map((x) => canonicalEbayOrderId(x)).filter(Boolean),
        ...(colBApi ? [...colBApi.orderIds] : []),
        ...fromCheckpoint,
    ]);
    const rowsToWrite = bypassDup
        ? rows.filter((r) => canonicalEbayOrderId(r.orderNumber))
        : rows.filter((r) => !existingSet.has(canonicalEbayOrderId(r.orderNumber)));
    const skippedDuplicates = bypassDup ? 0 : rows.length - rowsToWrite.length;
    if (bypassDup && rowsToWrite.length) {
        console.log(
            'Sheet: duplicate guard bypassed — appending row(s) even if this order id was already recorded (checkpoint / column B).',
        );
    } else if (skippedDuplicates > 0) {
        console.log(
            checkpointDupIdsApply
                ? `Duplicate guard skipped ${skippedDuplicates} row(s) already on the sheet (column B scan + ${fromCheckpoint.size} order id(s) from checkpoint).`
                : `Duplicate guard skipped ${skippedDuplicates} row(s) (column B / visible grid only — checkpoint order ids excluded for this workbook).`,
        );
    }
    if (!rowsToWrite.length) return { writtenRows: 0, skippedDuplicates, lastSheetNextAppendRow: null };

    const tsvRows = rowsToWrite.map((r) => cellsForPayoutSheetTable(r));
    const endRowNeeded = startRow + tsvRows.length - 1;
    const { reloadBrowserTab } = await ensureGoogleSheetGridRowsAtLeast(sheetUrl, endRowNeeded);
    if (reloadBrowserTab) {
        await sheetPage.bringToFront();
        await sheetPage.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
        await sheetPage.waitForSelector('[role="grid"], div.docs-sheet-container', { timeout: 120000 });
        await sleep(500);
    }

    console.log(
        `Browser paste: ${tsvRows.length} row(s) from A${startRow} (name box → Enter, then cell click → paste; then Home ↓ per row).`,
    );

    const jumpRef = `A${startRow}`;
    console.log(`Sheet: jumping to ${jumpRef} via the name box (t-name-box / waffle-name-box), same as typing there and pressing Enter.`);
    await goToSheetRangeForPaste(sheetPage, sheetUrl, jumpRef);

    let gridReady = await waitForGridCellVisibleForPaste(sheetPage, startRow, 1, { timeoutMs: 20000 });
    if (!gridReady) {
        console.warn(
            `Sheet: row ${jumpRef} is not visible as a standard gridcell (virtualized rows or Insert→Table). Loading #range= once…`,
        );
        await sheetPage.goto(withSheetRange(sheetUrl, jumpRef), { waitUntil: 'domcontentloaded', timeout: 120000 });
        await sheetPage.waitForSelector('[role="grid"], div.docs-sheet-container', { timeout: 120000 });
        await sleep(800);
        gridReady = await waitForGridCellVisibleForPaste(sheetPage, startRow, 1, { timeoutMs: 15000 });
    }
    if (!gridReady) {
        console.warn(
            'Sheet: target cell still not found in DOM — paste may misalign. Set GOOGLE_SERVICE_ACCOUNT_JSON for API append (recommended), or use a normal grid tab (not Insert→Table).',
        );
    }

    // Real pointer click on the target row — required before Ctrl+V (do not send Escape after paste; Sheets can revert the edit).
    await clickSheetCellForPaste(sheetPage, startRow, 1);
    await sleep(200);

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
        await waitForGridCellVisibleForPaste(sheetPage, absRow, 1, { timeoutMs: 8000 });
        await clickSheetCellForPaste(sheetPage, absRow, 1);
        await assertActiveCellIsDataRow(sheetPage, absRow, `Before paste row ${r + 1}/${tsvRows.length} (A${absRow})`, sheetPasteWarnState);

        const line = tsvLineForOneRow(tsvRows[r]);
        let usedOsClipboard = copyTextToOsClipboardSync(line);
        if (!usedOsClipboard) {
            console.warn('Sheet: OS clipboard (clip/PowerShell) failed — using in-page copy to clipboard.');
            await copyTextForBrowserPaste(sheetPage, line);
            await waitForGridCellVisibleForPaste(sheetPage, absRow, 1, { timeoutMs: 5000 });
            await clickSheetCellForPaste(sheetPage, absRow, 1);
        } else if (!loggedOsClipboard) {
            loggedOsClipboard = true;
            console.log('Sheet: pasting via OS clipboard (keeps grid focus; more reliable than in-page copy).');
        }

        await sheetPage.bringToFront();
        await sleep(usedOsClipboard ? 120 : 40);

        const pasteMod = process.platform === 'darwin' ? 'Meta' : 'Control';
        await sheetPage.keyboard.down(pasteMod);
        await sheetPage.keyboard.press('KeyV');
        await sheetPage.keyboard.up(pasteMod);
        await sleep(260);
    }

    if (openedNewTab) {
        console.log('Opened Google Sheet tab for writing; leaving it open for next batch/run.');
    }
    const nextAppendRow = startRow + rowsToWrite.length;
    const cp = readCheckpoint() || {};
    const addedIds = rowsToWrite.map((r) => canonicalEbayOrderId(r.orderNumber)).filter(Boolean);
    const sheetWrittenOrderNumbers = mergeSheetWrittenOrderNumbers(cp.sheetWrittenOrderNumbers, addedIds);
    const mapPrev =
        cp.sheetNextAppendRowBySpreadsheetId && typeof cp.sheetNextAppendRowBySpreadsheetId === 'object'
            ? { ...cp.sheetNextAppendRowBySpreadsheetId }
            : {};
    if (urlSpreadsheetId) mapPrev[urlSpreadsheetId] = nextAppendRow;
    const cpSid = String(cp.googleSheetSpreadsheetId || '').trim();
    const patch = {
        ...cp,
        sheetNextAppendRowBySpreadsheetId: mapPrev,
        sheetWrittenOrderNumbers,
    };
    if (!cpSid || cpSid === urlSpreadsheetId) {
        patch.lastSheetNextAppendRow = nextAppendRow;
    }
    writeCheckpoint(patch);
    return { writtenRows: rowsToWrite.length, skippedDuplicates, lastSheetNextAppendRow: nextAppendRow };
}

/**
 * Build payout row objects for one extracted order using a single total postage £ (no Royal Mail).
 * Postage is allocated by each line’s share of order earnings; packaging and client share match the Royal Mail path.
 *
 * @param {{ orderNumber: string, rows: Array<{ itemTitle?: string, customSku?: string, quantity?: number, soldDate?: string, earningsText?: string }> }} order
 * @param {string|number} postageGbp Total postage for the order in GBP.
 * @returns {Array<{ orderNumber: string, itemTitle?: string, customSku?: string, clientId: string, quantity?: number, soldDate: string, grossEarnings: number, postageCost: number, packagingCost: number, netEarnings: number, payoutRate: number, clientPayout: number }>}
 */
function payoutRowsFromOrderWithManualPostage(order, postageGbp) {
    const p = money(parseMoney(postageGbp));
    if (p <= 0 || !order || !Array.isArray(order.rows) || !order.rows.length) return [];
    const earningRows = order.rows.map((r) => ({ ...r, earnings: money(parseMoney(r.earningsText)) }));
    const totalEarnings = money(earningRows.reduce((s, r) => s + r.earnings, 0));
    const count = earningRows.length || 1;
    const out = [];
    for (const r of earningRows) {
        const weight = totalEarnings > 0 ? r.earnings / totalEarnings : 1 / count;
        const postageCost = money(p * weight);
        const adjustedNet = money(r.earnings - postageCost - FIXED_PACKAGING_COST);
        const rate = clientShareRate(adjustedNet, r.soldDate || '');
        const clientPayout = money(adjustedNet * rate);
        out.push({
            orderNumber: order.orderNumber,
            itemTitle: r.itemTitle,
            customSku: r.customSku,
            clientId: extractClientId(r.customSku),
            quantity: r.quantity,
            soldDate: r.soldDate || '',
            grossEarnings: r.earnings,
            postageCost,
            packagingCost: FIXED_PACKAGING_COST,
            netEarnings: adjustedNet,
            payoutRate: rate,
            clientPayout,
        });
    }
    return out;
}

/**
 * Same Royal Mail manifest merge, postage split, payout rates, and postage-missing queue as main(),
 * for orders already extracted from Seller Hub (orderNumber, referenceNumber, trackingNumber, rows[].earningsText).
 *
 * @param {import('puppeteer').Browser} browser
 * @param {Array<{ orderNumber: string, referenceNumber?: string, trackingNumber?: string, rows: Array<{ itemTitle?: string, customSku?: string, quantity?: number, soldDate?: string, earningsText?: string }> }>} orders
 * @returns {Promise<{ rows: object[], missing: { order: object, reason: string }[] }>}
 */
async function payoutRowsFromOrdersWithRoyalMail(browser, orders) {
    if (!orders.length) return { rows: [], missing: [] };

    const rmPage = await browser.newPage();
    try {
        const rmXlsPath = process.env.RM_XLS_PATH;
        const downloadDir = process.env.DOWNLOADS_DIR || path.join(os.homedir(), 'Downloads');
        const forceRmRefresh =
            String(process.env.FORCE_RM_DOWNLOAD || '').toLowerCase() === '1' ||
            String(process.env.FORCE_RM_DOWNLOAD || '').toLowerCase() === 'true';

        let manifestPaths = [];
        if (rmXlsPath) {
            const single = path.isAbsolute(rmXlsPath) ? rmXlsPath : path.join(process.cwd(), rmXlsPath);
            if (!fs.existsSync(single)) throw new Error(`RM_XLS_PATH not found: ${single}`);
            manifestPaths = [single];
            console.log(`Royal Mail: single file (RM_XLS_PATH): ${single}`);
        } else {
            manifestPaths = resolveRoyalMailManifestPaths(downloadDir);
            if (manifestPaths.length) {
                console.log(
                    `Royal Mail: merging ${manifestPaths.length} manifest XLS file(s) for postage lookup:\n${manifestPaths.map((p) => `  - ${p}`).join('\n')}`,
                );
            }
            if (!manifestPaths.length && !forceRmRefresh) {
                const latestExistingXls = findNewestSpreadsheetInManifestDirs(downloadDir);
                if (latestExistingXls) {
                    manifestPaths = [latestExistingXls];
                    console.log(`Royal Mail: no ManifestedOrdersReport match — using newest spreadsheet in search dirs: ${latestExistingXls}`);
                }
            }
            if (!manifestPaths.length) {
                const downloaded = await downloadRoyalMailXlsViaPortal(rmPage, downloadDir);
                manifestPaths = [downloaded];
                console.log(`Royal Mail: downloaded manifest: ${downloaded}`);
            }
        }

        const buildRowsFromOrders = (ordersToPrice, postageMap) => {
            const out = [];
            const missing = [];
            for (const order of ordersToPrice) {
                const postageLookup = orderPostage(postageMap, order.orderNumber, [order.referenceNumber, order.trackingNumber]);
                const p = postageLookup.postage;
                if (p <= 0) {
                    const reason = `No Royal Mail postage match for order ${order.orderNumber}. Tried tokens: ${
                        postageLookup.triedTokens.join(', ') || '(none)'
                    }`;
                    missing.push({ order, reason });
                    continue;
                }
                console.log(`Postage matched for ${order.orderNumber}: £${p} (token: ${postageLookup.matchedToken})`);
                const earningRows = order.rows.map((r) => ({ ...r, earnings: money(parseMoney(r.earningsText)) }));
                const totalEarnings = money(earningRows.reduce((s, r) => s + r.earnings, 0));
                const count = earningRows.length || 1;
                for (const r of earningRows) {
                    const weight = totalEarnings > 0 ? r.earnings / totalEarnings : 1 / count;
                    const postageCost = money(p * weight);
                    const adjustedNet = money(r.earnings - postageCost - FIXED_PACKAGING_COST);
                    const rate = clientShareRate(adjustedNet, r.soldDate || '');
                    const clientPayout = money(adjustedNet * rate);
                    out.push({
                        orderNumber: order.orderNumber,
                        itemTitle: r.itemTitle,
                        customSku: r.customSku,
                        clientId: extractClientId(r.customSku),
                        quantity: r.quantity,
                        soldDate: r.soldDate || '',
                        grossEarnings: r.earnings,
                        postageCost,
                        packagingCost: FIXED_PACKAGING_COST,
                        netEarnings: adjustedNet,
                        payoutRate: rate,
                        clientPayout,
                    });
                }
            }
            return { rows: out, missing };
        };

        let postage = mergeRoyalMailPostageMaps(manifestPaths);
        console.log(`Royal Mail: merged postage lookup has ${postage.size} token(s).`);
        logRoyalMailDefaultFilesMissing(manifestPaths, rmXlsPath);

        let { rows, missing } = buildRowsFromOrders(orders, postage);
        if (missing.length) {
            console.warn(
                `Postage missing for ${missing.length} order(s). Downloading a fresh Royal Mail XLS and merging into lookup.`,
            );
            try {
                const refreshedXlsPath = await downloadRoyalMailXlsViaPortal(rmPage, downloadDir);
                if (refreshedXlsPath) {
                    console.log(`Royal Mail: XLS refreshed: ${refreshedXlsPath}`);
                    const mergedPaths = [...new Set([...manifestPaths, refreshedXlsPath])];
                    manifestPaths = mergedPaths;
                    postage = mergeRoyalMailPostageMaps(manifestPaths);
                }
                const retry = buildRowsFromOrders(
                    missing.map((m) => m.order),
                    postage,
                );
                rows = rows.concat(retry.rows);
                missing = retry.missing;
            } catch (e) {
                console.warn(
                    `Royal Mail refresh failed (${e.message || e}). Continuing — unmatched orders can be queued to the postage-missing sheet.`,
                );
            }
        }
        if (missing.length) {
            await appendPostageMissingQueue(null, missing, browser);
        }
        for (const m of missing) {
            console.warn(`Skipping order: ${m.reason}`);
        }
        return { rows, missing };
    } finally {
        await rmPage.close().catch(() => {});
    }
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help) return help();
    console.log(`Puppeteer CDP protocolTimeout=${resolveProtocolTimeoutMs(args)}ms`);
    const sheetUrl = args.noSheet
        ? String(args.sheetUrl || '').trim()
        : String(args.sheetUrl || process.env.GOOGLE_SHEET_URL || DEFAULT_GOOGLE_SHEET_URL || '').trim();
    let checkpoint = reconcileCheckpointWithGoogleSheet(readCheckpoint(), sheetUrl || null);

    if (args.replayJson) {
        const replayPath = path.isAbsolute(args.replayJson) ? args.replayJson : path.join(process.cwd(), args.replayJson);
        const raw = JSON.parse(fs.readFileSync(replayPath, 'utf8'));
        const rows = Array.isArray(raw.rows) ? raw.rows : [];
        if (!rows.length) throw new Error(`No rows found in replay JSON: ${replayPath}`);
        if (!sheetUrl) throw new Error('No Google Sheet URL configured for replay mode');

        const browser = await puppeteer.connect(connectOptions(args.browserUrl, args));
        console.log(`Replaying ${rows.length} row(s) from JSON to Google Sheets (append after last order in column B).`);
        await writeRowsToSheet(browser, sheetUrl, rows, { sheetBrowserOnly: args.sheetBrowserOnly });
        console.log(`Replay done from JSON: ${replayPath}`);
        return;
    }

    const browser = await puppeteer.connect(connectOptions(args.browserUrl, args));

    const ebayOrdersListUrl = (args.ebayListUrl && String(args.ebayListUrl).trim()) || EBAY_ORDERS_URL;
    console.log(`eBay orders list URL:\n  ${ebayOrdersListUrl}`);
    if (args.noSheet) {
        const outLabel = args.output || process.env.EBAY_PAYOUT_OUTPUT || process.env.EBAY_PAYOUT_OUTPUT_CSV || '';
        console.log(
            `Payout output: CSV only (no Google Sheet)${outLabel ? `\n  ${outLabel}` : '\n  (set EBAY_PAYOUT_OUTPUT in ebay-payout-bot.env)'}`,
        );
    }

    /** Order ids already present in the sheet — eBay list links matching these skip the order-details page. */
    let sheetOrderIdsToSkip = new Set();
    const explicitResumeAfterOrderId = canonicalEbayOrderId(args.startAfterOrder || process.env.EBAY_RESUME_AFTER_ORDER || '');
    const checkpointResumeAfterOrderId = canonicalEbayOrderId(checkpoint?.lastProcessedOrderNumber || '');
    let resumeAfterOrderId = explicitResumeAfterOrderId || checkpointResumeAfterOrderId;
    const outputCsvPath =
        args.output && /\.csv$/i.test(String(args.output))
            ? path.isAbsolute(args.output)
                ? args.output
                : path.join(process.cwd(), args.output)
            : '';
    if (outputCsvPath) {
        const fromCsv = readOrderIdsFromOutputCsv(outputCsvPath);
        for (const id of fromCsv) sheetOrderIdsToSkip.add(id);
        if (fromCsv.size) {
            console.log(
                `CSV preflight: ${fromCsv.size} order id(s) in ${path.basename(outputCsvPath)} — those links are skipped before opening order details.`,
            );
        }
    }
    if (sheetUrl) {
        console.log('Prefetch — Google Sheet: reading column B so we can skip eBay orders already exported.');
        const apiStats = await readColumnBStatsFromApi(sheetUrl);
        if (!explicitResumeAfterOrderId && apiStats && apiStats.lastOrderId) {
            resumeAfterOrderId = apiStats.lastOrderId;
            console.log(`Sheet preflight: last order id in column B is ${apiStats.lastOrderId}.`);
        }
        const fromSheet = await buildAlreadyOnSheetOrderSet(browser, sheetUrl);
        for (const id of fromSheet) sheetOrderIdsToSkip.add(id);
        console.log(
            `Sheet preflight: ${fromSheet.size} order id(s) on record — matching Seller Hub links are skipped before opening order details.`,
        );
    }

    let skip = !args.skipOrdersProvided && checkpoint && Number.isFinite(Number(checkpoint.nextSkipOrders))
        ? Number(checkpoint.nextSkipOrders)
        : (args.skipOrders || 0);

    if (!args.skipOrdersProvided && sheetUrl && skip > 0) {
        const { hasOrders, source } = await sheetHasOrdersForResume(sheetUrl, browser);
        const writtenIds = Array.isArray(checkpoint?.sheetWrittenOrderNumbers) ? checkpoint.sheetWrittenOrderNumbers : [];
        let hasSheetOrders = hasOrders;
        if (!hasSheetOrders && source === 'dom' && writtenIds.length > 0) {
            console.warn(
                `Resume check: could not see eBay order numbers in the visible sheet grid (virtualization / focus), but the checkpoint lists ${writtenIds.length} order id(s). Keeping skip-orders=${skip}. ` +
                    `Set GOOGLE_SERVICE_ACCOUNT_JSON (and GOOGLE_SHEET_TAB if not "Sheet1") so the script can read column B via API, or open the sheet in this Chrome profile before running.`,
            );
            hasSheetOrders = true;
        }
        if (!hasSheetOrders) {
            console.log(
                `Checkpoint had skip-orders=${skip}, but the spreadsheet has no eBay-style order numbers in column B (${source === 'api' ? 'API' : 'browser'}) — starting from the first orders (skip-orders=0).`,
            );
            skip = 0;
            writeCheckpoint({
                ...(checkpoint || {}),
                nextSkipOrders: 0,
                orderLinkHrefs: [],
                lastSheetNextAppendRow: null,
                sheetWrittenOrderNumbers: [],
            });
        } else if (source === 'api' && hasOrders) {
            console.log('Resume check: column B contains order number(s) (Google Sheets API).');
        }
    }

    if (!args.skipOrdersProvided && checkpoint && Number.isFinite(Number(checkpoint.nextSkipOrders)) && skip > 0) {
        console.log(`Resuming from checkpoint: skip-orders=${skip}`);
    }

    const page = await attachEbayOrdersListPage(browser, ebayOrdersListUrl);

    let maxOrders;
    if (args.maxOrders === 0) {
        maxOrders = Number.POSITIVE_INFINITY;
    } else if (Number.isFinite(args.maxOrders) && args.maxOrders > 0) {
        maxOrders = args.maxOrders;
    } else {
        const envCap = parseInt(String(process.env.EBAY_PAYOUT_MAX_ORDER_LINKS || '').trim(), 10);
        maxOrders = Number.isFinite(envCap) && envCap > 0 ? envCap : Number.POSITIVE_INFINITY;
    }
    const batchSize = Math.max(1, args.batchSize || DEFAULT_BATCH_SIZE);
    /** Paginate the list until we have this many unique order links (or run out of pages). Infinity = all pages. */
    const collectionTarget = Number.isFinite(maxOrders) ? maxOrders : Number.POSITIVE_INFINITY;
    if (Number.isFinite(maxOrders) && maxOrders > 0) {
        console.log(`List collection cap: ${maxOrders} unique order link(s) (--max-orders or EBAY_PAYOUT_MAX_ORDER_LINKS).`);
    } else {
        console.log('List collection: all pages until eBay has no more results (no link cap).');
    }

    const cpLive = readCheckpoint() || {};
    const cachedHrefs = Array.isArray(cpLive.orderLinkHrefs) ? cpLive.orderLinkHrefs : null;
    const useCachedOrderLinks =
        !args.refreshOrderLinks &&
        !process.env.EBAY_PAYOUT_REFRESH_ORDER_LINKS &&
        skip > 0 &&
        cachedHrefs &&
        cachedHrefs.length > skip;

    let collectedLinks = [];
    const seenOrderIds = new Set();
    let pageCount = 0;

    if (useCachedOrderLinks) {
        collectedLinks = cachedHrefs.slice();
        console.log(
            `Using ${collectedLinks.length} order link(s) from checkpoint (skip-orders=${skip}; no eBay list pagination).`,
        );
    } else {
        if (skip > 0 && (args.refreshOrderLinks || process.env.EBAY_PAYOUT_REFRESH_ORDER_LINKS)) {
            console.log('Refresh order links requested — scanning eBay list again.');
        }
        console.log(
            'List scan: loading the Seller Hub list from the first page (not the current tab offset) so we collect the full order link sequence.',
        );
        await gotoEbayOrdersListUrl(page, 'eBay list (full list collection)', ebayOrdersListUrl);
        await page.waitForSelector('#mainGridContainer, [role="main"], body', { timeout: 120000 }).catch(() => {});
        await sleep(800);

        while (pageCount < 100) {
            pageCount++;
            await sleep(1500);
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
                    orders.push({ orderId: candidateOrderId, href: abs.href });
                }
                const nextLink =
                    document.querySelector('a.pagination__next[href]') ||
                    document.querySelector('a[type="next"][href]') ||
                    Array.from(document.querySelectorAll('a[href]')).find((a) =>
                        /next page of results/i.test((a.getAttribute('aria-label') || '').trim()),
                    );
                const nextHref = nextLink ? new URL(nextLink.getAttribute('href') || '', location.href).href : '';
                const nextDisabled =
                    !!(
                        nextLink &&
                        (nextLink.getAttribute('aria-disabled') === 'true' ||
                            nextLink.classList.contains('disabled') ||
                            nextLink.hasAttribute('disabled'))
                    );
                return { orders, nextHref, nextDisabled };
            });

            for (const o of pageData.orders) {
                if (seenOrderIds.has(o.orderId)) continue;
                seenOrderIds.add(o.orderId);
                collectedLinks.push(o.href);
                if (Number.isFinite(collectionTarget) && collectedLinks.length >= collectionTarget) break;
            }
            console.log(`Collected ${collectedLinks.length} order link(s) after page ${pageCount}.`);

            if (Number.isFinite(collectionTarget) && collectedLinks.length >= collectionTarget) break;
            if (!pageData.nextHref || pageData.nextDisabled) break;
            await page.goto(pageData.nextHref, { waitUntil: 'domcontentloaded', timeout: 120000 });
        }
        writeCheckpoint({ orderLinkHrefs: collectedLinks.slice() });
    }

    if (resumeAfterOrderId && !args.skipOrdersProvided) {
        let markerIndex = -1;
        for (let i = collectedLinks.length - 1; i >= 0; i--) {
            const id = canonicalEbayOrderId(orderIdFromEbayDetailsLink(collectedLinks[i]));
            if (id && id === resumeAfterOrderId) {
                markerIndex = i;
                break;
            }
        }
        if (markerIndex >= 0) {
            const markerSkip = markerIndex + 1;
            const nextSkipFromAnchor = Math.max(skip, markerSkip);
            if (nextSkipFromAnchor !== skip) {
                console.log(
                    `Resume anchor: found ${resumeAfterOrderId} at list index ${markerIndex}; processing starts after it (skip-orders=${nextSkipFromAnchor}).`,
                );
                skip = nextSkipFromAnchor;
            }
        } else {
            const prevSkip = skip;
            skip = 0;
            console.warn(
                `Resume anchor: order ${resumeAfterOrderId} not found in collected links (list filter/URL changed, stale checkpoint, or order aged off the list). ` +
                    `Reset skip-orders from ${prevSkip} to 0 and walking the list from the top. ` +
                    `Orders whose ids are already in column B are still skipped before opening order details; the sheet duplicate guard still prevents re-pasting existing rows.`,
            );
        }
    }

    const orderLinks = collectedLinks.slice(skip, skip + batchSize);
    if (skip > 0) {
        console.log(`Skipping first ${skip} collected order(s).`);
    }
    console.log(
        `List scan: ${collectedLinks.length} order link(s) collected; this run processes ${orderLinks.length} (orders-per-run=${batchSize}${Number.isFinite(collectionTarget) ? `, max-orders=${collectionTarget}` : ', all pages'}).`,
    );
    if (!orderLinks.length) {
        console.log('No eBay order detail links found for this block. Stopping.');
        return;
    }

    const orders = [];
    const extractionMisses = [];
    const shouldDumpOrderDebug =
        String(process.env.EBAY_ORDER_DEBUG_DUMP || '').toLowerCase() === '1' ||
        String(process.env.EBAY_ORDER_DEBUG_DUMP || '').toLowerCase() === 'true' ||
        args.maxOrders === 1;
    let dumpedOrderDebug = false;

    const orderPage = await browser.newPage();
    for (let oi = 0; oi < orderLinks.length; oi++) {
        const link = orderLinks[oi];
        const oid = orderIdFromEbayDetailsLink(link);
        if (oid && sheetOrderIdsToSkip.has(oid)) {
            console.log(
                `Order ${oi + 1}/${orderLinks.length}: ${oid} — skipped (already exported to sheet or CSV)`,
            );
            continue;
        }
        const idHint = oid || (link.match(/orderid=([^&]+)/i) || [])[1] || `link-${oi + 1}`;
        console.log(`Order ${oi + 1}/${orderLinks.length}: ${idHint}`);
        try {
            await gotoEbayOrderDetailsPage(orderPage, link, ebayOrdersListUrl);
            await orderPage
                .waitForFunction(
                    () => {
                        const t = (document.body && document.body.innerText) || '';
                        return /order earnings|custom sku|quantity|sold/i.test(t);
                    },
                    { timeout: 15000 }
                )
                .catch(() => {});
            await sleep(1000);
            if (shouldDumpOrderDebug && !dumpedOrderDebug) {
                fs.mkdirSync(DEBUG_DIR, { recursive: true });
                const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                const base = path.join(DEBUG_DIR, `ebay-order-debug-${stamp}-${safeFileToken(link)}`);
                const html = await orderPage.content();
                const text = await orderPage.evaluate(() => (document.body ? document.body.innerText : ''));
                fs.writeFileSync(`${base}.html`, html, 'utf8');
                fs.writeFileSync(`${base}.txt`, text, 'utf8');
                console.log(`Saved order debug files: ${base}.html and ${base}.txt`);
                dumpedOrderDebug = true;
            }

            const order = await orderPage.evaluate(() => {
            const txt = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
            const isDateLike = (s) => /^(?:[0-3]?\d)\s+[A-Za-z]{3,9}(?:\s+\d{2,4})?$/.test(String(s || '').trim());
            const body = document.body ? document.body.innerText : '';
            const normalized = body.replace(/\r/g, '\n').replace(/[ \t]+/g, ' ');
            const m = body.match(/Order (number|no\.?|ID)\s*[:#]?\s*([A-Za-z0-9-]+)/i) || body.match(/\b(\d{2,4}-\d{4,6}-\d{4,6})\b/);
            const orderNumber = m ? (m[2] || m[1]) : '';
            const refMatch = body.match(/Ref\s*#\s*([A-Za-z0-9]+)/i);
            const trackingMatch = body.match(/\b([A-Z]{2}\d{9,}[A-Z]{2})\b/i);
            const referenceNumber = refMatch ? refMatch[1] : '';
            const trackingNumber = trackingMatch ? trackingMatch[1] : '';
            const rows = [];
            const labelLike = /order earnings|custom sku|custom label|quantity|qty|sold|sale date/i;
            const valueFromLines = (lines, labelRe, valueRe) => {
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (!labelRe.test(line)) continue;
                    const sameLine = line.match(valueRe);
                    if (sameLine) return sameLine[1] || sameLine[0];
                    for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
                        if (labelLike.test(lines[j])) continue;
                        const nextLine = lines[j].match(valueRe);
                        if (nextLine) return nextLine[1] || nextLine[0];
                    }
                }
                return '';
            };

            const labelNodes = Array.from(document.querySelectorAll('span, p, div, dt, th')).filter((n) => /order earnings/i.test(txt(n)));
            const candidateRows = [];
            const seenRowText = new Set();
            for (const n of labelNodes) {
                let row = n;
                for (let i = 0; i < 6 && row; i++) {
                    const t = txt(row);
                    if (/order earnings/i.test(t) && /(custom sku|custom label|quantity|sold)/i.test(t)) break;
                    row = row.parentElement;
                }
                if (!row) continue;
                const t = txt(row);
                if (!t || t.length < 20) continue;
                if (seenRowText.has(t)) continue;
                seenRowText.add(t);
                candidateRows.push(row);
            }

            for (const row of candidateRows) {
                const rowText = txt(row);
                const lines = rowText
                    .split(/\n+/)
                    .map((x) => x.trim())
                    .filter(Boolean);

                const titleEl = row.querySelector('a[href*="/itm/"], [data-test-id*="title"], [class*="title"]');
                const titleText = txt(titleEl);
                const itemTitle =
                    titleText && !/skip to main content/i.test(titleText)
                        ? titleText
                        : lines.find((l) => !labelLike.test(l) && !/^£\s*[0-9,.]+$/.test(l) && !/skip to main content/i.test(l)) || '';

                const skuRaw = valueFromLines(lines, /\b(custom sku|custom label|sku)\b/i, /\b(custom sku|custom label|sku)\b\s*[:#-]?\s*(.+)$/i)
                    || valueFromLines(lines, /\b(custom sku|custom label|sku)\b/i, /^([A-Za-z0-9._-]+(?:\s+[A-Za-z0-9._ -]+)?)$/);
                const qtyRaw = valueFromLines(lines, /\b(quantity|qty)\b/i, /\b(?:quantity|qty)\b\s*[:x]?\s*(\d+)/i)
                    || valueFromLines(lines, /\b(quantity|qty)\b/i, /^(\d{1,3})$/);
                const soldRaw = valueFromLines(lines, /\b(sold|sale date)\b/i, /\b(?:sold|sale date)\b\s*[:\-]?\s*([0-3]?\d\s+[A-Za-z]{3,9}(?:\s+\d{2,4})?)/i)
                    || lines.find((l) => isDateLike(l))
                    || '';
                const earnRaw = valueFromLines(lines, /\border earnings\b/i, /\border earnings\b[^£\d]*£?\s*([0-9,.]+)/i)
                    || valueFromLines(lines, /\border earnings\b/i, /£\s*([0-9,.]+)/i);

                const customSku = String(skuRaw || '').replace(/\b(custom sku|custom label|sku)\b\s*[:#-]?\s*/i, '').trim();
                const quantity = Number(qtyRaw) > 0 ? Number(qtyRaw) : 1;
                const soldDate = String(soldRaw || '').trim();
                const earningsText = String(earnRaw || '').trim();

                if (!earningsText || !customSku) continue;
                rows.push({
                    itemTitle,
                    customSku,
                    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
                    soldDate,
                    earningsText,
                });
            }
            if (!rows.length) {
                // Fallback tuned to eBay "Order details" text structure.
                const lines = normalized
                    .split('\n')
                    .map((x) => x.trim())
                    .filter(Boolean);
                const moneyRe = /^£\s*([0-9,.]+)$/i;
                const readNextMoney = (start, maxJump = 8) => {
                    for (let j = start; j < Math.min(lines.length, start + maxJump); j++) {
                        const m = lines[j].match(moneyRe);
                        if (m) return m[1];
                    }
                    return '';
                };
                const readNextNumber = (start, maxJump = 8) => {
                    for (let j = start; j < Math.min(lines.length, start + maxJump); j++) {
                        const m = lines[j].match(/^(\d{1,4})$/);
                        if (m) return m[1];
                    }
                    return '';
                };
                const nearestItemTitleBefore = (start, maxBack = 8) => {
                    for (let j = start - 1; j >= Math.max(0, start - maxBack); j--) {
                        const v = lines[j];
                        if (!v) continue;
                        if (/^(items?|tracking|quantity|custom label|vat rate|item id|sold via)/i.test(v)) continue;
                        if (/^skip to main content$/i.test(v)) continue;
                        if (moneyRe.test(v)) continue;
                        return v;
                    }
                    return '';
                };

                const soldIdx = lines.findIndex((l) => /^sold$/i.test(l) || /^sold\s+\d/.test(l));
                const soldDatePage =
                    soldIdx >= 0
                        ? (lines[soldIdx].match(/^sold\s+(.+)$/i)?.[1] || lines[soldIdx + 1] || '')
                        : '';
                const orderEarnIdx = lines.findIndex((l) => /^order earnings$/i.test(l));
                const orderEarningsPage = orderEarnIdx >= 0 ? readNextMoney(orderEarnIdx + 1) : '';

                for (let i = 0; i < lines.length; i++) {
                    const skuMatch = lines[i].match(/^custom label\s*\(sku\)\s*:\s*(.+)$/i);
                    if (!skuMatch) continue;
                    const customSku = String(skuMatch[1] || '').trim();
                    const itemTitle = nearestItemTitleBefore(i);

                    let quantity = 1;
                    const qtyLabelIdx = lines.findIndex((l, idx) => idx >= i && idx <= i + 20 && /^quantity$/i.test(l));
                    if (qtyLabelIdx >= 0) {
                        const q = readNextNumber(qtyLabelIdx + 1, 6);
                        if (q) quantity = Number(q);
                    }

                    let soldDate = soldDatePage;
                    const soldNearIdx = lines.findIndex((l, idx) => idx >= i && idx <= i + 40 && /^sold$/i.test(l));
                    if (soldNearIdx >= 0) soldDate = lines[soldNearIdx + 1] || soldDate;

                    let earningsText = '';
                    // Prefer eBay "Order earnings" for payout calculation basis.
                    earningsText = orderEarningsPage;
                    if (!earningsText) {
                        const itemTotalIdx = lines.findIndex((l, idx) => idx >= i && idx <= i + 30 && /^item total$/i.test(l));
                        if (itemTotalIdx >= 0) earningsText = readNextMoney(itemTotalIdx + 1, 6);
                    }

                    if (!customSku) continue;
                    rows.push({
                        itemTitle: itemTitle || '',
                        customSku,
                        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
                        soldDate: String(soldDate || '').trim(),
                        earningsText: String(earningsText || '').trim(),
                    });
                }
            }
            if (!rows.length) {
                // Fallback: parse repeated label/value groups from flattened page text.
                const pattern =
                    /(?:item\s+title\s*[:\-]?\s*([^\n]+)\n)?[\s\S]{0,120}?custom\s*(?:sku|label)\s*[:\-]?\s*([^\n£]+?)\s*(?:\n|$)[\s\S]{0,120}?quantity\s*[:x]?\s*(\d+)[\s\S]{0,120}?sold(?:\s+date)?\s*[:\-]?\s*([0-3]?\d\s+[A-Za-z]{3,9}(?:\s+\d{2,4})?)[\s\S]{0,120}?order\s+earnings\s*[:\-]?\s*£?\s*([0-9,.]+)/gi;
                let match;
                while ((match = pattern.exec(normalized)) !== null) {
                    rows.push({
                        itemTitle: String(match[1] || '').trim(),
                        customSku: String(match[2] || '').trim(),
                        quantity: Number(match[3]) > 0 ? Number(match[3]) : 1,
                        soldDate: String(match[4] || '').trim(),
                        earningsText: String(match[5] || '').trim(),
                    });
                }
            }
            if (!rows.length) {
                // Fallback: line-by-line label parsing for pages where labels and values are separated.
                const lines = normalized
                    .split('\n')
                    .map((x) => x.trim())
                    .filter(Boolean);
                const takeNextValue = (idx, re, maxJump = 6) => {
                    for (let j = idx; j < Math.min(lines.length, idx + maxJump); j++) {
                        const m = lines[j].match(re);
                        if (m) return m[1] || m[0];
                    }
                    return '';
                };
                const itemTitleGuess = lines.find((l) => /item title/i.test(l)) || '';
                const sku = takeNextValue(0, /\b(?:custom sku|custom label)\b\s*[:\-]?\s*(.+)$/i) || takeNextValue(0, /^([A-Za-z0-9._-]+\s+[A-Za-z0-9._ -]+)$/);
                const qtyRaw = takeNextValue(0, /\b(?:quantity|qty)\b\s*[:x]?\s*(\d+)/i) || takeNextValue(0, /^(\d{1,3})$/);
                const sold = takeNextValue(0, /\b(?:sold|sale date)\b\s*[:\-]?\s*([0-3]?\d\s+[A-Za-z]{3,9}(?:\s+\d{2,4})?)/i) || lines.find((l) => isDateLike(l)) || '';
                const earn =
                    takeNextValue(0, /\border earnings\b[^£\d]*£?\s*([0-9,.]+)/i) ||
                    takeNextValue(0, /£\s*([0-9,.]+)/i);
                if (sku || qtyRaw || sold || earn) {
                    rows.push({
                        itemTitle: itemTitleGuess.replace(/^item title\s*[:\-]?\s*/i, ''),
                        customSku: String(sku || '').trim(),
                        quantity: Number(qtyRaw) > 0 ? Number(qtyRaw) : 1,
                        soldDate: String(sold || '').trim(),
                        earningsText: String(earn || '').trim(),
                    });
                }
            }
            return {
                orderNumber,
                referenceNumber,
                trackingNumber,
                rows: rows.filter((r) => r.itemTitle || r.customSku || r.earningsText),
            };
        });
            if (order.rows.length) {
                orders.push(order);
            } else {
                const html = await orderPage.content();
                const text = await orderPage.evaluate(() => (document.body ? document.body.innerText : ''));
                extractionMisses.push({ link, html, text });
            }
        } catch (e) {
            console.warn(`Order ${idHint} failed: ${String(e.message || e)}`);
            extractionMisses.push({ link, html: '', text: `Error: ${String(e.message || e)}` });
        }
    }
    await orderPage.close().catch(() => {});

    if (extractionMisses.length) {
        const fb = extractionMisses
            .map((m) => ({
                orderNumber: orderIdFromEbayDetailsLink(m.link),
                reason: 'No line items extracted from order page',
            }))
            .filter((x) => x.orderNumber);
        if (fb.length) {
            await appendOrdersToMainSheetFallbackQueue(fb, browser);
            console.log(
                `Main sheet fallback queue: queued ${fb.length} order(s) with no extracted line items → ${formatPostageQueueTargetLabel(resolvePostageQueueTarget(null))}`,
            );
        }
    }

    const priced = await payoutRowsFromOrdersWithRoyalMail(browser, orders);
    const rows = priced.rows;
    const missing = priced.missing;
    const skippedOrders = missing.map((m) => ({ orderNumber: m.order.orderNumber, reason: m.reason }));

    let sheetWrite = { writtenRows: 0, skippedDuplicates: 0, lastSheetNextAppendRow: null };
    if (sheetUrl && rows.length) {
        try {
            sheetWrite = await writeRowsToSheet(browser, sheetUrl, rows, {
                sheetBrowserOnly: args.sheetBrowserOnly,
                ebaySkipOrders: skip,
            });
        } catch (e) {
            const ids = [...new Set(rows.map((r) => canonicalEbayOrderId(r.orderNumber)).filter(Boolean))];
            if (ids.length) {
                await appendOrdersToMainSheetFallbackQueue(
                    ids.map((id) => ({ orderNumber: id, reason: `Main sheet write failed: ${String(e.message || e)}` })),
                    browser,
                );
                console.warn(`Main sheet fallback queue: queued ${ids.length} order id(s) after write error.`);
            }
            throw e;
        }
    }
    if (rows.length) {
        if (sheetUrl) {
            console.log(
                `Sheet: ${rows.length} payout row(s) from this run; wrote ${sheetWrite.writtenRows}, skipped ${sheetWrite.skippedDuplicates} duplicate(s).`,
            );
        } else if (args.output) {
            console.log(`Payout: ${rows.length} row(s) computed this chunk — writing to CSV/JSON next.`);
        }
    }

    if (!rows.length) {
        if (extractionMisses.length) {
            fs.mkdirSync(DEBUG_DIR, { recursive: true });
            const miss = extractionMisses[0];
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const base = path.join(DEBUG_DIR, `ebay-order-extract-miss-${stamp}-${safeFileToken(miss.link)}`);
            fs.writeFileSync(`${base}.html`, miss.html, 'utf8');
            fs.writeFileSync(`${base}.txt`, miss.text, 'utf8');
            console.error(`Saved extraction debug files: ${base}.html and ${base}.txt`);
            throw new Error('No item rows were extracted from eBay order pages (nothing to paste).');
        }
        if (skippedOrders.length) {
            console.log(
                `No payout rows to write in this chunk; ${skippedOrders.length} order(s) were unmatched for postage and queued/skipped.`,
            );
        } else {
            console.log('No payout rows to write in this chunk (all links already on sheet or no eligible rows).');
        }
    }
    if (skippedOrders.length) {
        console.log(`Skipped ${skippedOrders.length} order(s) due to missing Royal Mail postage match.`);
    }

    if (!args.output && !sheetUrl) {
        throw new Error('No output destination: use --output PATH.csv (or EBAY_PAYOUT_OUTPUT) and/or --sheet-url / GOOGLE_SHEET_URL.');
    }
    const output = args.output
        ? writeOutputs(rows, args.output)
        : { jsonPath: '', csvPath: '', writtenCsvRows: 0, skippedCsvDuplicates: 0 };
    const nextSkipOrders = skip + orderLinks.length;
    const processedOrderIds = rows.map((r) => canonicalEbayOrderId(r.orderNumber)).filter(Boolean);
    const lastProcessedOrderNumber = processedOrderIds.length ? processedOrderIds[processedOrderIds.length - 1] : '';
    const sheetCp =
        sheetUrl &&
        rows.length &&
        Number.isFinite(Number(sheetWrite.lastSheetNextAppendRow)) &&
        Number(sheetWrite.lastSheetNextAppendRow) >= SHEET_FIRST_DATA_ROW
            ? { lastSheetNextAppendRow: Math.floor(Number(sheetWrite.lastSheetNextAppendRow)) }
            : {};
    writeCheckpoint({
        nextSkipOrders,
        batchIndex: Math.floor(skip / batchSize) + 1,
        ...(output.jsonPath ? { lastOutputJson: output.jsonPath } : {}),
        ...(output.csvPath ? { lastOutputCsv: output.csvPath } : {}),
        ...(lastProcessedOrderNumber ? { lastProcessedOrderNumber } : {}),
        ...sheetCp,
        ...(sheetUrl ? { googleSheetSpreadsheetId: spreadsheetIdFromUrl(sheetUrl) } : {}),
    });

    if (output.jsonPath) console.log(`Done. JSON: ${output.jsonPath}`);
    if (output.csvPath) {
        const totalInCsv = fs.existsSync(output.csvPath) ? readOrderIdsFromOutputCsv(output.csvPath).size : 0;
        console.log(
            `Done. CSV: ${output.csvPath}` +
                (output.writtenCsvRows != null ? ` (+${output.writtenCsvRows} row(s) this chunk` : '') +
                (output.skippedCsvDuplicates ? `, ${output.skippedCsvDuplicates} duplicate(s) skipped in chunk` : '') +
                `; ${totalInCsv} order row(s) in file total)`,
        );
    }
    const shouldRestartChunk =
        !!args.autoContinue && orderLinks.length === batchSize && skip + batchSize < collectedLinks.length;
    const nextSkip = nextSkipOrders;
    if (shouldRestartChunk) {
        console.log(
            `Starting a new Node process for the next ${batchSize} order link(s) (skip-orders=${nextSkip}). Disconnecting Puppeteer first so the next run can attach cleanly.`,
        );
        await browser.disconnect().catch(() => {});
        const scriptPath = path.join(__dirname, 'ebay-payout-puppeteer.js');
        const nextArgs = [scriptPath, '--browser-url', args.browserUrl, '--batch-size', String(batchSize), '--skip-orders', String(nextSkip)];
        if (maxOrders === Number.POSITIVE_INFINITY) {
            nextArgs.push('--max-orders', '0');
        } else if (Number.isFinite(maxOrders) && maxOrders > 0) {
            nextArgs.push('--max-orders', String(Math.floor(maxOrders)));
        }
        if (args.ebayListUrl) nextArgs.push('--ebay-list-url', args.ebayListUrl);
        if (args.sheetUrl) nextArgs.push('--sheet-url', args.sheetUrl);
        if (args.noSheet) nextArgs.push('--no-sheet');
        if (args.output) nextArgs.push('--output', args.output);
        if (args.sheetBrowserOnly) nextArgs.push('--sheet-browser-only');
        const chained = spawnSync(process.execPath, nextArgs, {
            cwd: process.cwd(),
            stdio: 'inherit',
        });
        if (chained.status !== 0) {
            throw new Error(`Follow-up chunk failed with exit code ${chained.status}`);
        }
    }
}

/**
 * Paginate the Seller Hub orders list and collect unique mesh order-detail URLs (same DOM scan as payout main()).
 * Does not read or write the payout checkpoint unless options.persistCheckpoint is true.
 *
 * @param {import('puppeteer').Browser} browser
 * @param {string} ebayOrdersListUrl
 * @param {{ maxLinks?: number, maxPages?: number, persistCheckpoint?: boolean }} [options]
 * @returns {Promise<string[]>}
 */
async function collectSellerHubOrderDetailHrefs(browser, ebayOrdersListUrl, options = {}) {
    const maxPages = Math.min(100, Number(options.maxPages) > 0 ? Math.floor(Number(options.maxPages)) : 100);
    const collectionTarget =
        Number.isFinite(Number(options.maxLinks)) && Number(options.maxLinks) > 0
            ? Math.floor(Number(options.maxLinks))
            : Number.POSITIVE_INFINITY;
    const persistCheckpoint = !!options.persistCheckpoint;

    const page = await attachEbayOrdersListPage(browser, ebayOrdersListUrl);
    console.log('List scan: loading Seller Hub from the first page to collect order detail links…');
    await gotoEbayOrdersListUrl(page, 'eBay list (full list collection)', ebayOrdersListUrl);
    await page.waitForSelector('#mainGridContainer, [role="main"], body', { timeout: 120000 }).catch(() => {});
    await sleep(800);

    const collectedLinks = [];
    const seenOrderIds = new Set();
    let pageCount = 0;

    while (pageCount < maxPages) {
        pageCount++;
        await sleep(1500);
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
                orders.push({ orderId: candidateOrderId, href: abs.href });
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
            const cid = canonicalEbayOrderId(o.orderId) || canonicalEbayOrderId(orderIdFromEbayDetailsLink(o.href));
            if (!cid || seenOrderIds.has(cid)) continue;
            seenOrderIds.add(cid);
            collectedLinks.push(o.href);
            if (Number.isFinite(collectionTarget) && collectedLinks.length >= collectionTarget) break;
        }
        console.log(`Collected ${collectedLinks.length} order link(s) after list page ${pageCount}.`);

        if (Number.isFinite(collectionTarget) && collectedLinks.length >= collectionTarget) break;
        if (!pageData.nextHref || pageData.nextDisabled) break;
        await page.goto(pageData.nextHref, { waitUntil: 'domcontentloaded', timeout: 120000 });
    }

    if (persistCheckpoint) writeCheckpoint({ orderLinkHrefs: collectedLinks.slice() });
    return collectedLinks;
}

module.exports = {
    writeRowsToSheet,
    payoutRowsFromOrdersWithRoyalMail,
    payoutRowsFromOrderWithManualPostage,
    cellsForPayoutSheetTable,
    appendOrdersToMainSheetFallbackQueue,
    readSheetColumnBOrderNumbersApi,
    readColumnBStatsFromApi,
    canonicalEbayOrderId,
    orderIdFromEbayDetailsLink,
    buildAlreadyOnSheetOrderSet,
    collectSellerHubOrderDetailHrefs,
    readCheckpoint,
    reconcileCheckpointWithGoogleSheet,
    connectOptions,
    resolveProtocolTimeoutMs,
};

if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
