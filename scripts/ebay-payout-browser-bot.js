#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
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

const DEFAULT_EBAY_ORDERS_LIST_URL =
    'https://www.ebay.co.uk/sh/ord/?filter=status%3APAID_SHIPPED%2Ctimerange%3APREVIOUSYEAR';
const EBAY_ORDERS_URL =
    String(process.env.EBAY_ORDERS_LIST_URL || process.env.EBAY_SELLER_HUB_LIST_URL || DEFAULT_EBAY_ORDERS_LIST_URL).trim() ||
    DEFAULT_EBAY_ORDERS_LIST_URL;
const ROYAL_MAIL_URL = 'https://business.parcel.royalmail.com/reports/manifested-orders/';
const FIXED_PACKAGING_COST = 0.5;
const PROMOTED_RATE = 0.1;

const SERVICE_PRICE_BY_CODE = {
    TPN24: 3.84,
    TRN24: 2.88,
    TPS48: 3.12,
    TRS48: 2.34,
    SD1: 11.48,
};

const ORDER_REF_KEYS = [
    'order',
    'order number',
    'order no',
    'order id',
    'reference',
    'shipment reference',
    'item reference',
    'customer reference',
    'ecommerce',
];
const SERVICE_KEYS = ['service', 'service code', 'shipping service', 'product code'];
const POSTAGE_KEYS = ['postage', 'cost', 'price', 'amount', 'postage cost', 'shipping cost', 'net amount'];

function parseArgs(argv) {
    const out = {
        headed: false,
        help: false,
        maxOrders: null,
        output: null,
        useChromeProfile: false,
        chromeProfileName: process.env.CHROME_PROFILE_NAME || 'JR ebay',
        chromeUserDataDir: process.env.CHROME_USER_DATA_DIR || '',
        chromeProfileDir: process.env.CHROME_PROFILE_DIR || '',
        cloneChromeProfile: String(process.env.CLONE_CHROME_PROFILE || '1') !== '0',
        debugDir: process.env.EBAY_PAYOUT_DEBUG_DIR || '',
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--headed') out.headed = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else if (a === '--max-orders' && argv[i + 1]) out.maxOrders = parseInt(argv[++i], 10);
        else if (a === '--output' && argv[i + 1]) out.output = argv[++i];
        else if (a === '--use-chrome-profile') out.useChromeProfile = true;
        else if (a === '--chrome-profile-name' && argv[i + 1]) out.chromeProfileName = argv[++i];
        else if (a === '--chrome-profile-dir' && argv[i + 1]) out.chromeProfileDir = argv[++i];
        else if (a === '--chrome-user-data-dir' && argv[i + 1]) out.chromeUserDataDir = argv[++i];
        else if (a === '--no-clone-chrome-profile') out.cloneChromeProfile = false;
        else if (a === '--debug-dir' && argv[i + 1]) out.debugDir = argv[++i];
    }
    return out;
}

function printHelp() {
    console.log(`Usage: node scripts/ebay-payout-browser-bot.js [options]

Options:
  --headed                      Run with visible browser
  --max-orders <n>              Cap number of orders to process
  --output <path>               JSON + CSV output base path
  --use-chrome-profile          Use your local Chrome profile (for JR ebay test flow)
  --chrome-profile-name <name>  Chrome profile folder name (default: "JR ebay")
  --chrome-profile-dir <dir>    Actual profile dir (e.g. "Default", "Profile 3")
  --chrome-user-data-dir <dir>  Chrome user data dir override
  --no-clone-chrome-profile     Launch directly from live profile (less stable)
  --debug-dir <path>            Save failed page screenshots/html/json

Required env vars (only if login is needed):
  EBAY_EMAIL, EBAY_PASSWORD
  RM_EMAIL, RM_PASSWORD
  GOOGLE_EMAIL, GOOGLE_PASSWORD
  GOOGLE_SHEET_URL

Optional env vars:
  RM_XLS_PATH
  PLAYWRIGHT_SLOW_MO_MS
  CHROME_PROFILE_NAME
  CHROME_PROFILE_DIR
  CHROME_USER_DATA_DIR
  CLONE_CHROME_PROFILE
  EBAY_PAYOUT_DEBUG_DIR
`);
}

function money(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return 0;
    return Math.round(x * 100) / 100;
}

function parseMoney(value) {
    if (value == null) return null;
    const t = String(value).replace(/[^\d.,-]/g, '').replace(/,/g, '');
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? money(n) : null;
}

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function pickCell(row, keyHints) {
    for (const [rawKey, value] of Object.entries(row)) {
        const k = normalizeText(rawKey);
        if (keyHints.some((hint) => k.includes(hint))) return value;
    }
    return '';
}

function extractOrderToken(value) {
    const s = String(value || '').trim();
    if (!s) return '';
    const m = s.match(/(?:\d{2,4}-\d{4,6}-\d{4,6}|[A-Z0-9-]{8,})/i);
    return (m ? m[0] : s).toUpperCase();
}

function findPostageForOrder(orderNumber, postageByOrder) {
    const token = extractOrderToken(orderNumber);
    if (!token) return 0;
    if (postageByOrder.has(token)) return money(postageByOrder.get(token));
    for (const [k, v] of postageByOrder.entries()) {
        if (k.includes(token) || token.includes(k)) return money(v);
    }
    return 0;
}

function payoutRateTiered(netEarnings) {
    if (netEarnings <= 50) return 0.75;
    if (netEarnings <= 150) return 0.8;
    return 0.85;
}

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

function clientShareRate(adjustedNet, soldDateStr) {
    if (usesLegacyFlatClientShare(soldDateStr)) return legacyClientShareFraction();
    return payoutRateTiered(adjustedNet);
}

function resolveChromeUserDataDir(overrideDir) {
    if (overrideDir) return path.resolve(overrideDir);
    const local = process.env.LOCALAPPDATA || '';
    return path.join(local, 'Google', 'Chrome', 'User Data');
}

function resolveChromeProfileDirectoryName(userDataDir, args) {
    if (args.chromeProfileDir && String(args.chromeProfileDir).trim()) {
        return String(args.chromeProfileDir).trim();
    }
    const wantedName = String(args.chromeProfileName || '').trim();
    if (!wantedName) return 'Default';
    try {
        const localStatePath = path.join(userDataDir, 'Local State');
        if (fs.existsSync(localStatePath)) {
            const raw = fs.readFileSync(localStatePath, 'utf8');
            const parsed = JSON.parse(raw);
            const infoCache = parsed && parsed.profile && parsed.profile.info_cache ? parsed.profile.info_cache : {};
            for (const [dirKey, meta] of Object.entries(infoCache)) {
                const visibleName = String(meta && meta.name ? meta.name : '').trim();
                if (visibleName.toLowerCase() === wantedName.toLowerCase()) {
                    return dirKey;
                }
            }
        }
    } catch {
        /* fallback below */
    }
    return wantedName;
}

function sanitizeFilePart(input) {
    return String(input || 'unknown')
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 120);
}

function copyDirectorySafe(srcRoot, destRoot) {
    const skipDirNames = new Set([
        'Network',
        'Cache',
        'Code Cache',
        'GPUCache',
        'GrShaderCache',
        'DawnCache',
        'Crashpad',
        'Service Worker',
        'Session Storage',
        'SharedStorage',
        'Safe Browsing',
        'ShaderCache',
    ]);
    const skipFileNames = new Set(['LOCK', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'Current Tabs', 'Current Session']);

    function walk(srcDir, destDir) {
        fs.mkdirSync(destDir, { recursive: true });
        let entries = [];
        try {
            entries = fs.readdirSync(srcDir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const srcPath = path.join(srcDir, entry.name);
            const destPath = path.join(destDir, entry.name);
            if (entry.isDirectory()) {
                if (skipDirNames.has(entry.name)) continue;
                walk(srcPath, destPath);
                continue;
            }
            if (entry.isFile()) {
                if (skipFileNames.has(entry.name)) continue;
                try {
                    fs.copyFileSync(srcPath, destPath);
                } catch {
                    /* skip locked files */
                }
            }
        }
    }

    walk(srcRoot, destRoot);
}

async function captureDebug(page, debugDir, tag, payload) {
    if (!debugDir) return;
    const dir = path.isAbsolute(debugDir) ? debugDir : path.join(process.cwd(), debugDir);
    fs.mkdirSync(dir, { recursive: true });
    const base = `${new Date().toISOString().replace(/[:.]/g, '-')}-${sanitizeFilePart(tag)}`;
    const png = path.join(dir, `${base}.png`);
    const html = path.join(dir, `${base}.html`);
    const json = path.join(dir, `${base}.json`);
    await page.screenshot({ path: png, fullPage: true }).catch(() => {});
    const content = await page.content().catch(() => '');
    fs.writeFileSync(html, content || '', 'utf8');
    fs.writeFileSync(json, JSON.stringify(payload || {}, null, 2), 'utf8');
}

async function ensureEbayLoggedIn(page) {
    await page.goto(EBAY_ORDERS_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    if (!/signin|login|auth/i.test(page.url())) return;
    const email = process.env.EBAY_EMAIL || '';
    const password = process.env.EBAY_PASSWORD || '';
    if (!email || !password) {
        console.log('eBay sign-in page detected. Complete login manually in the opened browser window.');
        await page.waitForURL((u) => !/signin|login|auth/i.test(String(u)), { timeout: 180000 });
        return;
    }
    await page.fill('input[type="email"], input[name="userid"]', email).catch(() => {});
    const continueBtn = page.locator('button:has-text("Continue"), #signin-continue-btn');
    if (await continueBtn.count()) await continueBtn.first().click().catch(() => {});
    await page.fill('input[type="password"], input[name="pass"]', password);
    await page.click('button:has-text("Sign in"), #sgnBt');
    await page.waitForLoadState('domcontentloaded', { timeout: 120000 });
}

async function collectOrderDetailLinks(page, maxOrders) {
    await page.goto(EBAY_ORDERS_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(1500);
    const links = await page.evaluate(() => {
        const out = [];
        for (const a of document.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href') || '';
            const text = (a.textContent || '').trim();
            if (/order details|view order|order number|ord\/details|\/sh\/ord\/|purchase history|\/v1\/orders\//i.test(href + ' ' + text)) {
                out.push(new URL(href, location.href).href);
            }
        }
        return Array.from(new Set(out));
    });
    if (!links.length) throw new Error('No order links found; layout changed or not logged in');
    return typeof maxOrders === 'number' && maxOrders > 0 ? links.slice(0, maxOrders) : links;
}

async function scrapeOneOrder(orderPage, orderUrl) {
    await orderPage.goto(orderUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await orderPage.waitForTimeout(1200);
    return orderPage.evaluate(() => {
        const txt = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
        const bodyText = (document.body && document.body.innerText) || '';
        const orderNoMatch =
            bodyText.match(/Order (number|no\.?|ID)\s*[:#]?\s*([A-Za-z0-9-]+)/i) ||
            bodyText.match(/\b(\d{2,4}-\d{4,6}-\d{4,6})\b/);
        const orderNumber = orderNoMatch ? (orderNoMatch[2] || orderNoMatch[1]) : '';
        const rows = [];
        const rowEls = document.querySelectorAll(
            '[data-test-id*="line-item"], [data-test-id*="order-line-item"], [class*="line-item"], [class*="item-row"], [class*="order-item"], tr',
        );
        for (const row of rowEls) {
            const titleEl =
                row.querySelector('[data-test-id*="title"], [class*="title"], a[href*="/itm/"]') ||
                row.querySelector('a');
            const rowText = txt(row);
            const quantityMatch =
                rowText.match(/\bQty(?:uantity)?\s*[:x]?\s*(\d+)\b/i) ||
                rowText.match(/\bQuantity\s*[:x]?\s*(\d+)\b/i) ||
                rowText.match(/\bx\s*(\d+)\b/);
            const skuMatch =
                rowText.match(/\b(?:SKU|Custom SKU)\s*[:#]?\s*([A-Za-z0-9._-]+)\b/i) ||
                rowText.match(/\b([A-Z0-9._-]{5,})\b/i);
            const earningsMatch =
                rowText.match(/(?:earnings|you earned|item total|line total|amount)\s*[:£\s]*([0-9,.]+)/i) ||
                rowText.match(/£\s*[0-9,.]+/i);
            if (!titleEl && !skuMatch && !earningsMatch) continue;
            rows.push({
                itemTitle: txt(titleEl),
                customSku: skuMatch ? skuMatch[1] : '',
                quantity: quantityMatch ? Number(quantityMatch[1]) : 1,
                earningsText: earningsMatch ? (earningsMatch[1] || earningsMatch[0]) : '',
            });
        }
        return { orderNumber, rows: rows.filter((r) => r.itemTitle || r.customSku || r.earningsText) };
    });
}

async function downloadRoyalMailReport(page) {
    const existing = process.env.RM_XLS_PATH;
    if (existing && fs.existsSync(existing)) return existing;
    await page.goto(ROYAL_MAIL_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    if (/login|sign in/i.test(await page.title())) {
        const email = process.env.RM_EMAIL || '';
        const password = process.env.RM_PASSWORD || '';
        if (!email || !password) throw new Error('Missing RM_EMAIL/RM_PASSWORD');
        await page.fill('input[type="email"], input[name="email"]', email);
        await page.fill('input[type="password"], input[name="password"]', password);
        await page.click('button:has-text("Sign in"), input[type="submit"]');
        await page.waitForLoadState('domcontentloaded', { timeout: 120000 });
    }

    const exportBtn = page.locator(
        'button:has-text("Export"), a:has-text("Export"), button:has-text("Export to XLS"), a:has-text("Export to XLS"), button:has-text("XLS"), a:has-text("XLS")',
    );
    if (!(await exportBtn.count())) throw new Error('Royal Mail export button not found');
    const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
    await exportBtn.first().click();
    const xlsBtn = page.locator('button:has-text("XLS"), a:has-text("XLS"), [role="menuitem"]:has-text("XLS")');
    if (await xlsBtn.count()) await xlsBtn.first().click().catch(() => {});
    const download = await downloadPromise;
    const savePath = path.join(os.tmpdir(), `royalmail-${Date.now()}-${download.suggestedFilename()}`);
    await download.saveAs(savePath);
    return savePath;
}

function parseRoyalMailPostageMap(xlsPath) {
    const wb = xlsx.readFile(xlsPath);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });
    const map = new Map();
    for (const row of rows) {
        const orderRef = extractOrderToken(pickCell(row, ORDER_REF_KEYS));
        const serviceCodeRaw = String(pickCell(row, SERVICE_KEYS)).trim().toUpperCase();
        const explicitCost = parseMoney(pickCell(row, POSTAGE_KEYS));
        if (!orderRef) continue;
        const mapped = explicitCost != null ? explicitCost : SERVICE_PRICE_BY_CODE[serviceCodeRaw] || 0;
        if (mapped > 0) map.set(orderRef, money(mapped));
    }
    return map;
}

function expandOrderRows(order, postageByOrder) {
    const out = [];
    const orderNo = order.orderNumber || '';
    const orderPostage = findPostageForOrder(orderNo, postageByOrder);
    const rows = (order.rows || []).map((r) => ({ ...r, gross: money(parseMoney(r.earningsText) || 0) }));
    const totalGross = money(rows.reduce((sum, r) => sum + r.gross, 0));
    const count = rows.length || 1;
    for (const row of rows) {
        const gross = row.gross;
        const weight = totalGross > 0 ? gross / totalGross : 1 / count;
        const rowPostage = money(orderPostage * weight);
        const rowPackaging = FIXED_PACKAGING_COST;
        const promoted = money(gross * PROMOTED_RATE);
        const net = money(gross - rowPostage - rowPackaging - promoted);
        const soldDateStr = row.soldDate || order.soldDate || '';
        const rate = clientShareRate(net, soldDateStr);
        out.push({
            orderNumber: orderNo,
            itemTitle: row.itemTitle || '',
            customSku: row.customSku || '',
            quantity: row.quantity || 1,
            grossEarnings: gross,
            postageCost: rowPostage,
            packagingCost: rowPackaging,
            promotedCost: promoted,
            netEarnings: net,
            payoutRate: rate,
            clientPayout: money(net * rate),
        });
    }
    return out;
}

function toTsv(rows) {
    const headers = [
        'order_number',
        'item_title',
        'custom_sku',
        'quantity',
        'gross_earnings',
        'postage_cost',
        'packaging_cost',
        'promoted_cost',
        'net_earnings',
        'payout_rate',
        'client_payout',
    ];
    return [headers.join('\t')]
        .concat(
            rows.map((r) =>
                [
                    r.orderNumber,
                    r.itemTitle,
                    r.customSku,
                    r.quantity,
                    r.grossEarnings,
                    r.postageCost,
                    r.packagingCost,
                    r.promotedCost,
                    r.netEarnings,
                    r.payoutRate,
                    r.clientPayout,
                ].join('\t'),
            ),
        )
        .join('\n');
}

async function appendRowsToGoogleSheet(page, rows) {
    const url = process.env.GOOGLE_SHEET_URL || '';
    if (!url) throw new Error('Missing GOOGLE_SHEET_URL');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    if (/accounts\.google\.com/i.test(page.url())) {
        const email = process.env.GOOGLE_EMAIL || '';
        const password = process.env.GOOGLE_PASSWORD || '';
        if (!email || !password) throw new Error('Missing GOOGLE_EMAIL/GOOGLE_PASSWORD');
        await page.fill('input[type="email"]', email);
        await page.click('#identifierNext button, button:has-text("Next")');
        await page.waitForTimeout(1000);
        await page.fill('input[type="password"]', password);
        await page.click('#passwordNext button, button:has-text("Next")');
        await page.waitForLoadState('domcontentloaded', { timeout: 120000 });
    }
    await page.waitForSelector('[role="grid"], div.docs-sheet-container', { timeout: 120000 });
    await page.keyboard.press('Control+g').catch(() => {});
    await page.keyboard.type('A1').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(300);
    await page.keyboard.insertText(toTsv(rows));
}

function writeOutputs(rows, outputBase) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const base = outputBase
        ? (path.isAbsolute(outputBase) ? outputBase : path.join(process.cwd(), outputBase))
        : path.join(__dirname, `ebay-payout-${ts}`);
    const jsonPath = base.toLowerCase().endsWith('.json') ? base : `${base}.json`;
    const csvPath = jsonPath.replace(/\.json$/i, '.csv');
    fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2), 'utf8');
    const csvHeader =
        'order_number,item_title,custom_sku,quantity,gross_earnings,postage_cost,packaging_cost,promoted_cost,net_earnings,payout_rate,client_payout';
    const csvRows = rows.map((r) =>
        [
            r.orderNumber,
            `"${String(r.itemTitle || '').replace(/"/g, '""')}"`,
            r.customSku,
            r.quantity,
            r.grossEarnings,
            r.postageCost,
            r.packagingCost,
            r.promotedCost,
            r.netEarnings,
            r.payoutRate,
            r.clientPayout,
        ].join(','),
    );
    fs.writeFileSync(csvPath, [csvHeader].concat(csvRows).join('\n'), 'utf8');
    return { jsonPath, csvPath };
}

async function createBrowserContext(args) {
    const slowMoMs = Number(process.env.PLAYWRIGHT_SLOW_MO_MS || 0);
    const launchOptions = { headless: !args.headed, slowMo: Number.isFinite(slowMoMs) ? slowMoMs : 0 };
    if (!args.useChromeProfile) {
        const browser = await chromium.launch(launchOptions);
        const context = await browser.newContext({ acceptDownloads: true });
        return { browser, context };
    }

    const userDataDir = resolveChromeUserDataDir(args.chromeUserDataDir);
    const profileDir = resolveChromeProfileDirectoryName(userDataDir, args);

    let launchUserDataDir = userDataDir;
    if (args.cloneChromeProfile) {
        const tempUserDataDir = path.join(os.tmpdir(), `rp-chrome-profile-${Date.now()}`);
        fs.mkdirSync(tempUserDataDir, { recursive: true });
        const srcProfilePath = path.join(userDataDir, profileDir);
        if (!fs.existsSync(srcProfilePath)) {
            throw new Error(
                `Chrome profile directory not found: ${srcProfilePath}. Try --chrome-profile-dir "Default" or "Profile 1".`,
            );
        }
        copyDirectorySafe(srcProfilePath, path.join(tempUserDataDir, profileDir));
        const localStatePath = path.join(userDataDir, 'Local State');
        if (fs.existsSync(localStatePath)) {
            try {
                fs.copyFileSync(localStatePath, path.join(tempUserDataDir, 'Local State'));
            } catch {
                /* optional */
            }
        }
        launchUserDataDir = tempUserDataDir;
    }

    const context = await chromium.launchPersistentContext(launchUserDataDir, {
        channel: 'chrome',
        headless: !args.headed,
        slowMo: launchOptions.slowMo,
        acceptDownloads: true,
        args: [`--profile-directory=${profileDir}`],
    });
    return { browser: null, context };
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help) return printHelp();

    const { browser, context } = await createBrowserContext(args);
    const page = context.pages()[0] || (await context.newPage());
    const orderPage = await context.newPage();
    const sheetsPage = await context.newPage();

    try {
        await ensureEbayLoggedIn(page).catch(async (err) => {
            await captureDebug(page, args.debugDir, 'ebay-login-failed', { error: String(err && err.message ? err.message : err) });
            throw err;
        });

        const detailLinks = await collectOrderDetailLinks(page, args.maxOrders).catch(async (err) => {
            await captureDebug(page, args.debugDir, 'ebay-orders-list-failed', { error: String(err && err.message ? err.message : err) });
            throw err;
        });
        console.log(`Found ${detailLinks.length} order detail links`);

        const orders = [];
        for (const link of detailLinks) {
            try {
                const order = await scrapeOneOrder(orderPage, link);
                if ((order.rows || []).length) orders.push(order);
            } catch (err) {
                await captureDebug(orderPage, args.debugDir, `ebay-order-failed-${extractOrderToken(link)}`, {
                    error: String(err && err.message ? err.message : err),
                    orderUrl: link,
                });
            }
        }
        console.log(`Scraped ${orders.length} orders with line rows`);

        const rmPath = await downloadRoyalMailReport(page).catch(async (err) => {
            await captureDebug(page, args.debugDir, 'royalmail-export-failed', { error: String(err && err.message ? err.message : err) });
            throw err;
        });
        const postageMap = parseRoyalMailPostageMap(rmPath);
        console.log(`Loaded ${postageMap.size} Royal Mail postage references`);

        const payoutRows = orders.flatMap((o) => expandOrderRows(o, postageMap));
        const output = writeOutputs(payoutRows, args.output);

        await appendRowsToGoogleSheet(sheetsPage, payoutRows).catch(async (err) => {
            await captureDebug(sheetsPage, args.debugDir, 'google-sheet-write-failed', {
                error: String(err && err.message ? err.message : err),
                rowCount: payoutRows.length,
            });
            throw err;
        });

        console.log(`Done. JSON: ${output.jsonPath}`);
        console.log(`Done. CSV: ${output.csvPath}`);
        if (args.debugDir) console.log(`Debug output: ${path.resolve(args.debugDir)}`);
    } finally {
        await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
