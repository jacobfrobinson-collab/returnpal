#!/usr/bin/env node
/**
 * John Pye PALLET browse → LLM RRP/resale estimates → ranked CSV/JSON with on-disk cache.
 * Use --lot-url for a single lot (prints items + selling price in the console, no category browse).
 * Lots already in the cache file are skipped (no re-scrape, no re-LLM) unless --force.
 *
 * Env: OPENAI_API_KEY. Optional: OPENAI_JOHN_PYE_MODEL (default gpt-4o), OPENAI_MODEL, .env from
 * scripts/auction-valuation/.env or repo root. Estimates only — verify before bidding.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
    DEFAULT_BROWSE_URL,
    sleep,
    normalizeBrowseBaseUrl,
    collectLotUrlsAllBrowsePages,
    extractLotPhotos,
    chunkLotsForBatches,
    sortImageUrlsOcrFirst,
    preferJohnPyeFullSizeUrl,
} = require('./john-pye-lib');
const { valueLotWithLlm, imagePartsFromBuffers } = require('./auction-valuation/llm.js');
const {
    fetchEbayUkSoldPricesGbpWithFallbacks,
    defaultDelayMs: EBAY_COMP_DELAY,
} = require('./ebay-uk-sold-comps.js');
const { buildPalletCompResale, setCompMapFromFetch } = require('./pallet-comp-pricing.js');
const { getActualForLot } = require('./john-pye-actuals.js');
const {
    extractLotHammerGbp,
    computeBuyerCostsGbp,
    profitAfterCostsGbp,
} = require('./john-pye-lot-pricing.js');

try {
    const dotenv = require('dotenv');
    const localEnv = path.join(__dirname, 'auction-valuation', '.env');
    const rootEnv = path.join(__dirname, '..', '.env');
    if (fs.existsSync(localEnv)) dotenv.config({ path: localEnv });
    if (fs.existsSync(rootEnv)) dotenv.config({ path: rootEnv });
} catch {
    /* optional */
}

const CACHE_VERSION = 1;
const MAX_IMAGE_BYTES = 1_500_000;
/** How many lot images to send to the vision model (pallet lots need many angles to read every box). */
const LLM_IMAGES_MAX = (() => {
    const n = parseInt(process.env.JOHN_PYE_LLM_IMAGES || '10', 10);
    return Number.isFinite(n) && n >= 1 && n <= 20 ? n : 10;
})();

const JOHN_PYE_LLM_MODEL = process.env.OPENAI_JOHN_PYE_MODEL || process.env.OPENAI_MODEL || 'gpt-4o';

/**
 * eBay comp haircut (0–1): that fraction of “sum of sold medians + impute” is treated as *lost* to pallet/unknowns.
 */
function resolveCompHaircut(n) {
    if (n != null && Number.isFinite(Number(n))) {
        return Math.min(0.9, Math.max(0, Number(n)));
    }
    const f = parseFloat(String(process.env.JOHN_PYE_COMP_HAIRCUT || '0.35').trim().replace(/,/g, ''), 10);
    return Number.isFinite(f) && f >= 0 && f < 1 ? f : 0.35;
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {object} valuation
 * @param {object} args
 * @param {string} lotUrl
 * @returns {Promise<object | null>}
 */
async function runEbayCompsForLot(context, valuation, args, lotUrl) {
    if (!args.compPricing || !valuation) {
        return null;
    }
    const li = Array.isArray(valuation.lineItems) ? valuation.lineItems : [];
    if (!li.length) {
        return { skipped: 'no_line_items' };
    }
    const maxU = args.compMaxQueries;
    const seenQ = new Set();
    const uniqueQ = [];
    for (const l of li) {
        const k = (l && l.searchQuery) || '';
        if (!k || seenQ.has(k)) {
            continue;
        }
        seenQ.add(k);
        uniqueQ.push(k);
    }
    const toFetch = uniqueQ.slice(0, maxU);
    const delay = EBAY_COMP_DELAY();
    const h = resolveCompHaircut(args.compHaircut);
    const llmL = valuation.resaleGbpLow != null ? Number(valuation.resaleGbpLow) : null;
    const llmH = valuation.resaleGbpHigh != null ? Number(valuation.resaleGbpHigh) : null;
    const llmM = numMid(llmL, llmH);
    const compBy = new Map();
    const page = await context.newPage();
    const started = new Date().toISOString();
    const fetchLog = [];
    try {
        for (let i = 0; i < toFetch.length; i++) {
            if (i > 0) {
                // eslint-disable-next-line no-await-in-loop
                await page.waitForTimeout(delay);
            }
            const q = toFetch[i];
            console.log(`[ebay comps] ${i + 1}/${toFetch.length} primary "${q}"`);
            // eslint-disable-next-line no-await-in-loop
            const withFb = await fetchEbayUkSoldPricesGbpWithFallbacks(page, q, { maxListings: 30 });
            if (withFb.fromFallback && withFb.usedQuery && withFb.usedQuery.toLowerCase() !== q.toLowerCase()) {
                console.log(
                    `   → using broader eBay query: "${withFb.usedQuery}"` +
                        (withFb.exhausted && (!withFb.result || !withFb.result.medianGbp) ? ' (still no sold median)' : '')
                );
            }
            setCompMapFromFetch(compBy, withFb.result, q);
            fetchLog.push({
                query: q,
                usedQuery: withFb.usedQuery,
                fromFallback: withFb.fromFallback,
                attemptCount: withFb.attempts ? withFb.attempts.length : 0,
                median: withFb.result.medianGbp,
                count: withFb.result.count,
                err: withFb.result.error,
            });
        }
    } finally {
        await page.close().catch(() => {});
    }
    const impute = !args.compNoImpute;
    const ag = buildPalletCompResale({
        compByQuery: compBy,
        lineItems: li,
        resaleHaircut: h,
        llmResaleLow: llmL,
        llmResaleHigh: llmH,
        llmResaleMid: llmM,
        imputeUnpricedFromLlm: impute,
    });
    return {
        at: started,
        lotUrl,
        skipped: null,
        eBayFetches: fetchLog,
        maxUniqueQueries: maxU,
        uniqueQueries: uniqueQ,
        toFetch: toFetch,
        notFetched: uniqueQ.length - toFetch.length,
        aggregate: ag,
    };
}

function applyCompsToRowData(row, comp) {
    if (!comp) {
        return;
    }
    if (comp.skipped) {
        row.ebayComps = comp;
        row.compCoverage = String(comp.skipped);
        if (comp.error) {
            row.compEbayError = comp.error;
        }
        return;
    }
    const a = comp.aggregate;
    if (a) {
        row.resaleGbpCompsLow = a.rangeLowGbp;
        row.resaleGbpCompsHigh = a.rangeHighGbp;
        row.resaleMidComps = a.midGbp;
        row.compSumGbp = a.compSumGbp;
        row.compImputedGbp = a.imputedGbp;
        row.compCoverage = a.coverage;
        row.compPalletHaircut = a.haircut;
    }
    row.ebayComps = comp;
}

/**
 * @param {object} row
 * @param {string} lotUrl
 * @param {string | null} actualsFile
 */
function applyActualsToRow(row, lotUrl, actualsFile) {
    const a = getActualForLot(lotUrl, actualsFile || null);
    if (a == null) {
        return;
    }
    const ar = a.actualResaleGbp;
    if (ar == null || !Number.isFinite(ar)) {
        return;
    }
    row.actualResaleGbp = ar;
    if (row.resaleMidComps != null) {
        row.compsMidVsActualGbp = round4(row.resaleMidComps - ar);
    }
    if (row.resaleMid != null) {
        row.llmMidVsActualGbp = round4(row.resaleMid - ar);
    }
}

function round4(n) {
    if (n == null || !Number.isFinite(n)) {
        return null;
    }
    return Math.round(n * 100) / 100;
}

/**
 * @param {object} args
 * @param {object} row
 */
function feeOptsForComps(args, row) {
    if (args.profitFromLlm) {
        return { profitResaleMid: row.resaleMid, profitResaleSource: 'llm_vision' };
    }
    if (row.resaleMidComps != null && Number.isFinite(row.resaleMidComps)) {
        return { profitResaleMid: row.resaleMidComps, profitResaleSource: 'ebay_comps' };
    }
    return {};
}

function parseArgs(argv) {
    const out = {
        url: DEFAULT_BROWSE_URL,
        cache: path.join(__dirname, 'john-pye-valuation-cache.json'),
        outBase: null,
        headed: false,
        slowMo: 0,
        storage: null,
        force: false,
        singlePage: false,
        browsePage: null,
        scrollRounds: 50,
        pauseMs: 500,
        lotDelayMs: 1200,
        browseDelayMs: 1500,
        maxBrowsePages: 2000,
        maxValueCalls: 0,
        topFlags: 10,
        premiumPercent: 0,
        vatPercent: 20,
        deliveryGbp: 0,
        batchSize: 100,
        batchPauseMs: 0,
        debugHrefs: false,
        csvExcel: false,
        allBrowsePages: false,
        lotUrl: null,
        maxLots: 0,
        help: false,
        compPricing: process.env.JOHN_PYE_EBAY_COMPS === '1',
        compMaxQueries: (() => {
            const n = parseInt(process.env.JOHN_PYE_COMP_MAX_QUERIES || '8', 10);
            return Number.isFinite(n) && n >= 1 && n <= 25 ? n : 8;
        })(),
        compHaircut: null,
        compNoImpute: false,
        /** When true, margin + profit columns use the LLM resale mid even if eBay comps exist. */
        profitFromLlm: false,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--headed') out.headed = true;
        if (a === '--force') out.force = true;
        if (a === '--single-page') out.singlePage = true;
        if (a === '--all-browse-pages') out.allBrowsePages = true;
        if (a === '--debug-hrefs') out.debugHrefs = true;
        if (a === '--csv-excel') out.csvExcel = true;
        else if (a === '--lot-url' && argv[i + 1]) out.lotUrl = String(argv[++i] || '').trim() || null;
        else if (a === '--url' && argv[i + 1]) out.url = argv[++i];
        else if (a === '--cache' && argv[i + 1]) out.cache = argv[++i];
        else if (a === '--out-base' && argv[i + 1]) out.outBase = argv[++i];
        else if (a === '--storage' && argv[i + 1]) out.storage = argv[++i];
        else if (a === '--slowmo' && argv[i + 1]) out.slowMo = parseInt(argv[++i], 10);
        else if (a === '--scroll-rounds' && argv[i + 1]) out.scrollRounds = parseInt(argv[++i], 10);
        else if (a === '--lot-delay' && argv[i + 1]) out.lotDelayMs = parseInt(argv[++i], 10);
        else if (a === '--browse-delay' && argv[i + 1]) out.browseDelayMs = parseInt(argv[++i], 10);
        else if (a === '--max-browse-pages' && argv[i + 1]) out.maxBrowsePages = parseInt(argv[++i], 10);
        else if (a === '--max-value-calls' && argv[i + 1]) out.maxValueCalls = parseInt(argv[++i], 10);
        else if (a === '--top-flags' && argv[i + 1]) out.topFlags = parseInt(argv[++i], 10);
        else if (a === '--premium-percent' && argv[i + 1]) out.premiumPercent = parseFloat(argv[++i]);
        else if (a === '--vat-percent' && argv[i + 1]) out.vatPercent = parseFloat(argv[++i]);
        else if (a === '--delivery-gbp' && argv[i + 1]) out.deliveryGbp = parseFloat(argv[++i]);
        else if (a === '--batch-size' && argv[i + 1]) out.batchSize = parseInt(argv[++i], 10);
        else if (a === '--batch-pause-ms' && argv[i + 1]) out.batchPauseMs = parseInt(argv[++i], 10);
        else if (a === '--browse-page' && argv[i + 1]) {
            const bp = parseInt(argv[++i], 10);
            out.browsePage = Number.isFinite(bp) ? bp : null;
        } else if (a === '--max-lots' && argv[i + 1]) {
            const m = parseInt(argv[++i], 10);
            out.maxLots = Number.isFinite(m) && m > 0 ? m : 0;
        } else if (a === '--comp-pricing' || a === '--ebay-comps') {
            out.compPricing = true;
        } else if (a === '--no-ebay-comps' || a === '--no-comp-pricing') {
            out.compPricing = false;
        } else if (a === '--comp-max-queries' && argv[i + 1]) {
            const c = parseInt(argv[++i], 10);
            if (Number.isFinite(c) && c >= 1 && c <= 25) {
                out.compMaxQueries = c;
            }
        } else if (a === '--comp-haircut' && argv[i + 1]) {
            const c = parseFloat(String(argv[++i] || ''), 10);
            if (Number.isFinite(c) && c >= 0 && c < 1) {
                out.compHaircut = c;
            }
        } else if (a === '--comp-no-impute') {
            out.compNoImpute = true;
        } else if (a === '--profit-llm') {
            out.profitFromLlm = true;
        } else if (a === '--help' || a === '-h') out.help = true;
    }
    return out;
}

function printHelp() {
    console.log(`Usage: node scripts/john-pye-ranked-valuation.js [options]

Discovers lots (paginated browse), skips lots already in --cache, values new lots with OpenAI vision,
writes ranked JSON + CSV (RRP and margin vs current bid).

Options:
  --url <url>              Browse URL (default PALLET)
  --cache <path>           JSON cache of valued lots (default: scripts/john-pye-valuation-cache.json)
  --out-base <path>        Write <path>.json and <path>.csv (default: scripts/john-pye-ranked-<timestamp>)
  --csv-excel              Prepend sep=, for Excel on Windows; default CSV is header-first for scripts/pandas
  --force                  Ignore cache and re-value every lot (still updates cache)
  --single-page            Only first browse page (same as --browse-page 1)
  --browse-page <n>        Only browse page n (1 = first, 2 = second, …). Run again with 2, 3, … for the rest.
  --all-browse-pages       Page 0, value, page 1, … until a page has no listings. One JSON/CSV, refreshed after each page.
                            Pair with e.g. --max-browse-pages 40; default 2000 can mean a very long discovery pass.
  --lot-url <url>         Value one lot only (no category browse). Use the full https URL from the address bar (no "..." in the path).
                            Prints items + selling price; still writes JSON/CSV. Ignores browse flags above.
  --max-lots <n>            After normal browse discover, only value the first n lot links in order (1 = first link on the first page loaded — use with --single-page to match “page 0, first item”).
  --max-value-calls <n>    Cap OpenAI calls this run (0 = no cap); cached lots do not count
  --top-flags <n>          Mark top N as top_pick_high_rrp / top_pick_high_margin (default 10)
  --headed / --storage     Same as john-pye-browse-lots.js
  --max-browse-pages / --browse-delay / --lot-delay / --scroll-rounds

Comp-based resale (eBay UK sold, after vision; uses lineItems from the model):
  --comp-pricing           Fetch sold-comp medians per line item, aggregate with a pallet “haircut”, fill CSVs.
  --no-ebay-comps          Turn off (overrides JOHN_PYE_EBAY_COMPS=1).
  --comp-max-queries <n>  Max *distinct* eBay searches (default 8, max 25). Env: JOHN_PYE_COMP_MAX_QUERIES
  --comp-haircut <0–1>    Friction lost to unknowns/condition (default 0.35). Env: JOHN_PYE_COMP_HAIRCUT
  --comp-no-impute        Do not pro-rate the LLM resale to lines that got no eBay comp (partial only).
  --profit-llm            Use the LLM resale mid for profit / margin (ignore comp mid if present).

Fees (optional — applied to extracted hammer/current bid for cost + net profit columns):
  --premium-percent <n>   Buyer's premium %% on hammer (e.g. 22.5). Default 0
  --vat-percent <n>       VAT %% on (hammer + premium). Default 20; use 0 to disable
  --delivery-gbp <n>      Fixed delivery/collection estimate in GBP. Default 0

  Profit columns default to the comp mid when eBay data exists (unless --profit-llm).

Hammer/bid is parsed from tables, __NEXT_DATA__, then page text (see john-pye-lot-pricing.js).

Batching (browser reset):
  --batch-size <n>        Close and reopen Chromium after each n consecutive lot URLs (default 100).
                          Cached-only batches skip opening a browser. Use 0 for one browser session for all lots.
  --batch-pause-ms <n>    Pause between batches (default 0)

Env: OPENAI_API_KEY (required). eBay: JOHN_PYE_EBAY_COMPS=1, JOHN_PYE_EBAY_DELAY_MS (between lines),
  JOHN_PYE_EBAY_FALLBACK_DELAY_MS (between *fallback* queries for the same line), JOHN_PYE_EBAY_MIN_SOLD (min sold
  listings to accept; default 1. Use 3 if you only want a median with more data — then brand fallbacks are likelier).
Calibration: set JOHN_PYE_ACTUALS=path to JSON, or add rows with: node scripts/john-pye-log-actual.js <url> <gbp>
`);
}

function feeOptionsFromArgs(args) {
    return {
        premiumPercent: Number.isFinite(args.premiumPercent) ? args.premiumPercent : 0,
        vatPercent: Number.isFinite(args.vatPercent) ? args.vatPercent : 0,
        deliveryGbp: Number.isFinite(args.deliveryGbp) ? args.deliveryGbp : 0,
    };
}

/**
 * @param {object} row
 * @param {object} fees
 * @param {{ profitResaleMid?: number | null, profitResaleSource?: string } | void} [opts]
 */
function applyFeesToRow(row, fees, opts) {
    const o = opts || {};
    const mid =
        o.profitResaleMid != null && Number.isFinite(o.profitResaleMid) ? o.profitResaleMid : row.resaleMid;
    const costs = computeBuyerCostsGbp(row.currentBidGbp, fees);
    row.buyersPremiumGbp = costs.buyersPremiumGbp;
    row.vatGbp = costs.vatGbp;
    row.deliveryGbp = costs.deliveryGbp;
    row.totalCostGbp = costs.totalCostGbp;
    if (o.profitResaleMid != null && Number.isFinite(o.profitResaleMid)) {
        row.profitResaleSource = o.profitResaleSource || 'ebay_comps';
    } else {
        row.profitResaleSource = 'llm_vision';
    }
    row.profitResaleMid = mid;
    row.profitAfterCostsGbp = profitAfterCostsGbp(mid, costs.totalCostGbp);
    row.marginResaleVsBidGbp = marginResaleVsBid(mid, row.currentBidGbp);
}

function cacheKey(lotUrl) {
    const u = new URL(lotUrl);
    u.hash = '';
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    return u.href;
}

function countLotsNeedingLlm(lotUrls, cache, force) {
    if (force) return lotUrls.length;
    let n = 0;
    for (const u of lotUrls) {
        if (!cache.entries[cacheKey(u)]) n++;
    }
    return n;
}

/**
 * Catches “example” URLs with literal … or ... in the path (not a real John Pye lot link).
 */
function isPlaceholderOrExampleLotUrl(urlStr) {
    if (!urlStr) return true;
    const t = String(urlStr).trim();
    if (t.includes('\u2026')) {
        return true;
    }
    let u;
    try {
        u = new URL(t);
    } catch {
        return true;
    }
    if (u.pathname.includes('...')) {
        return true;
    }
    if (/LotDetails\/\.\.|\.\.\/LotDetails/i.test(u.pathname + u.search)) {
        return true;
    }
    return false;
}

function isLikelyJohnPyeNotFoundTitle(pageTitle) {
    const s = (pageTitle || '').trim();
    if (!s) return false;
    if (/^sorry,?\s*page not found\.?$/i.test(s)) {
        return true;
    }
    if (/^not found\.?$|^page not found\.?$/i.test(s)) {
        return true;
    }
    if (/\b404\b/.test(s) && /\bnot found\b/i.test(s)) {
        return true;
    }
    if (/^oops\b|^error\b|access denied|lot (is )?(unavailable|ended|closed|removed)/i.test(s)) {
        return true;
    }
    if (s.length < 50 && /not found|unavailable|no longer (accept|be)/i.test(s) && !/lot\s*#|£|bid/i.test(s)) {
        return true;
    }
    return false;
}

function logKeyForCacheConsole(key) {
    try {
        const u = new URL(key);
        const t = (u.pathname + u.search).replace(/^\/+/, '');
        if (t.length <= 72) return t;
        return t.slice(0, 40) + '…' + t.slice(-30);
    } catch {
        return (key && key.length > 64) ? key.slice(0, 35) + '…' : key || '';
    }
}

/**
 * @param {object} row
 * @param {{ compPricing?: boolean } | void} [opts] — pass from main when not on row
 */
function printSingleLotResult(row, opts) {
    const o = opts || {};
    const v = row.valuation || {};
    const title = (row.title || '').trim() || '(no title)';
    console.log('\n┌─ This listing ─────────────────────────────────────');
    console.log('│ ' + title);
    console.log('│ ' + (row.lotUrl || ''));
    const pack = (v.packagingText || '').trim();
    if (pack) {
        console.log('├─ Read from packaging (OCR-style) ─');
        for (const line of pack.split(/\n+/)) {
            const t = line.trim();
            if (t) console.log('│  ' + t);
        }
    }
    console.log('├─ What the photos show (visual ID — brand / model when legible) ─');
    const guess = (v.productGuess || '').trim() || '—';
    for (const line of guess.split(/\n+/)) {
        const t = line.trim();
        if (t) console.log('│  ' + t);
    }
    if ((v.assumptions || '').trim()) {
        console.log('├─ Assumptions ─');
        for (const line of v.assumptions.split(/\n+/)) {
            if (line.trim()) console.log('│  ' + line.trim());
        }
    }
    if ((v.risks || '').trim()) {
        console.log('├─ Risks ─');
        for (const line of v.risks.split(/\n+/)) {
            if (line.trim()) console.log('│  ' + line.trim());
        }
    }
    const lo = v.resaleGbpLow;
    const hi = v.resaleGbpHigh;
    const midRes = row.resaleMid;
    console.log('├─ Suggested selling price (UK private / marketplace resale) ─');
    if (lo != null && hi != null) {
        const mid = midRes != null ? `  (midpoint ~ £${Number(midRes).toFixed(0)})` : '';
        console.log('│  £' + lo + ' – £' + hi + mid);
    } else {
        console.log('│  (insufficient to estimate — check images / errors above)');
    }
    const rlo = v.rrpGbpLow;
    const rhi = v.rrpGbpHigh;
    console.log('├─ RRP band (retail) ─');
    if (rlo != null && rhi != null) {
        console.log('│  £' + rlo + ' – £' + rhi);
    } else {
        console.log('│  (not available)');
    }
    if (v.confidence0to100 != null) {
        console.log('│  Model confidence: ' + v.confidence0to100 + '/100');
    }
    if (v.lineItems && v.lineItems.length) {
        console.log('├─ Line items (for eBay / comps) ─');
        for (const it of v.lineItems) {
            if (!it || !it.searchQuery) {
                continue;
            }
            const q = it.searchQuery;
            const n = it.quantity != null ? ' ×' + it.quantity : '';
            const s = (it.source || 'inferred') + (n ? n : '');
            console.log('│  • ' + q + '  (' + s + ')');
        }
    }
    {
        const want = v.lineItems && v.lineItems.length;
        const hasCompBand = row.resaleGbpCompsLow != null && row.resaleGbpCompsHigh != null;
        const req = o.compPricing === true || row.compRequested;
        if (want && !hasCompBand) {
            console.log('├─ eBay UK *sold* comps (median / pallet haircut) —');
            if (!req) {
                console.log(
                    '│  Not run. Re-run with --comp-pricing (or: npm run john-pye:rank:first:comps). Add --force if this lot is cached from an earlier run without comps.',
                );
            } else if (row.compEbayError) {
                console.log('│  ' + String(row.compEbayError).slice(0, 200));
            } else if (row.ebayComps && row.ebayComps.skipped) {
                const sk = row.ebayComps.skipped;
                const err = row.ebayComps.error;
                if (err) {
                    console.log('│  ' + String(err).slice(0, 200));
                } else {
                    console.log('│  Skipped: ' + String(sk) + (sk === 'no_line_items' ? ' (add line items from vision)' : ''));
                }
            } else {
                const cov = row.ebayComps && row.ebayComps.aggregate && row.ebayComps.aggregate.coverage;
                if (cov) {
                    console.log(
                        '│  No usable comp band: coverage "' +
                            String(cov) +
                            '". eBay may have no sold data for the queries tried, or the page was blocked. See [ebay comps] log lines and JSON eBayFetches.',
                    );
                } else {
                    console.log('│  No comp band; check [ebay comps] / JSON for details (blocked, captcha, or 0 results).');
                }
            }
        }
    }
    if (row.resaleGbpCompsLow != null && row.resaleGbpCompsHigh != null) {
        console.log('├─ Resale (eBay UK *sold* comps + pallet haircut) —');
        const midc = row.resaleMidComps;
        const midS = midc != null ? `  (mid ~ £${Number(midc).toFixed(0)})` : '';
        const cov = row.compCoverage ? '  [' + row.compCoverage + ']' : '';
        const src = row.profitResaleSource || '';
        console.log(
            '│  £' +
                row.resaleGbpCompsLow +
                ' – £' +
                row.resaleGbpCompsHigh +
                midS +
                cov,
        );
        if (row.compImputedGbp > 0) {
            console.log('│  (includes pro-rated LLM share for unpriced lines: ~£' + row.compImputedGbp + ')');
        }
        if (src) {
            console.log('│  Profit / margin use: ' + (src === 'ebay_comps' ? 'this comp band' : 'LLM (see --profit-llm)'));
        }
    }
    if (row.actualResaleGbp != null) {
        console.log('├─ Your logged actual resale (JOHN_PYE_ACTUALS) ─');
        let line = '│  £' + row.actualResaleGbp;
        if (row.compsMidVsActualGbp != null) {
            line += '  (comp mid − actual: ' + (row.compsMidVsActualGbp >= 0 ? '+' : '') + row.compsMidVsActualGbp + ')';
        } else if (row.llmMidVsActualGbp != null) {
            line += '  (LLM mid − actual: ' + (row.llmMidVsActualGbp >= 0 ? '+' : '') + row.llmMidVsActualGbp + ')';
        }
        console.log(line);
    }
    if (row.currentBidGbp != null) {
        console.log('├─ Current bid (hammer) parsed from page: £' + row.currentBidGbp);
    }
    if (row.totalCostGbp != null && row.profitAfterCostsGbp != null) {
        console.log('├─ With your fee settings: total cost ~ £' + Number(row.totalCostGbp).toFixed(2) + ' → est. net £' + Number(row.profitAfterCostsGbp).toFixed(2) + (row.profitResaleSource ? '  [resale: ' + row.profitResaleSource + ']' : ''));
    } else if (row.marginResaleVsBidGbp != null) {
        console.log('├─ Resale mid minus hammer: £' + row.marginResaleVsBidGbp);
    }
    if (row.fromCache) {
        console.log('│  (served from cache — add --force to re-run OpenAI on this lot)');
    }
    if (row.skippedCap) {
        console.log('│  Skipped: ' + (row.llmError || 'cap'));
    } else if (row.llmError) {
        console.log('├─ Issue: ' + row.llmError);
    }
    console.log('└──────────────────────────────────────────────────────\n');
}

function loadCache(cachePath) {
    if (!fs.existsSync(cachePath)) {
        return { version: CACHE_VERSION, entries: {} };
    }
    try {
        const j = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (!j.entries || typeof j.entries !== 'object') j.entries = {};
        j.version = CACHE_VERSION;
        return j;
    } catch {
        return { version: CACHE_VERSION, entries: {} };
    }
}

function saveCache(cachePath, data) {
    const dir = path.dirname(cachePath);
    if (dir) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, cachePath);
}

async function fetchImageBase64(request, imageUrl, referer) {
    try {
        const res = await request.get(imageUrl, {
            headers: { Referer: referer },
            timeout: 20000,
        });
        if (!res.ok()) return null;
        const buf = Buffer.from(await res.body());
        if (buf.length > MAX_IMAGE_BYTES) return null;
        const ct = res.headers()['content-type'] || 'image/jpeg';
        if (!/^image\//i.test(ct)) return null;
        return { base64: buf.toString('base64'), mimeType: ct.split(';')[0].trim() };
    } catch {
        return null;
    }
}

async function buildImageBuffersForLlm(context, lotUrl, imageUrls) {
    const request = context.request;
    const ordered = sortImageUrlsOcrFirst(imageUrls || []);
    const out = [];
    for (const imgUrl of ordered.slice(0, LLM_IMAGES_MAX)) {
        const prefer = preferJohnPyeFullSizeUrl(imgUrl);
        let fetched = await fetchImageBase64(request, prefer, lotUrl);
        if (!fetched && prefer !== imgUrl) {
            fetched = await fetchImageBase64(request, imgUrl, lotUrl);
        }
        if (fetched) {
            out.push({ mimeType: fetched.mimeType, base64: fetched.base64 });
        }
    }
    return out;
}

function numMid(a, b) {
    if (a != null && b != null) return (Number(a) + Number(b)) / 2;
    if (a != null) return Number(a);
    if (b != null) return Number(b);
    return null;
}

function marginResaleVsBid(resaleMid, bid) {
    if (resaleMid == null || bid == null || Number.isNaN(Number(bid))) return null;
    return Math.round((Number(resaleMid) - Number(bid)) * 100) / 100;
}

function csvEscape(s) {
    let t = s == null ? '' : String(s);
    t = t.replace(/\r\n|\r|\n|\t/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (/[",]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
}

function assignRanksAndFlags(rows, topN) {
    const byRrp = [...rows].sort((a, b) => {
        const ar = a.rrpMid,
            br = b.rrpMid;
        if (ar == null && br == null) return 0;
        if (ar == null) return 1;
        if (br == null) return -1;
        return br - ar;
    });
    const rrpRank = new Map();
    let r = 1;
    for (const row of byRrp) {
        if (row.rrpMid != null) rrpRank.set(row.lotUrl, r++);
    }

    const byMargin = [...rows].sort((a, b) => {
        const am = a.marginResaleVsBidGbp,
            bm = b.marginResaleVsBidGbp;
        if (am == null && bm == null) return 0;
        if (am == null) return 1;
        if (bm == null) return -1;
        return bm - am;
    });
    const marginRank = new Map();
    let m = 1;
    for (const row of byMargin) {
        if (row.marginResaleVsBidGbp != null) marginRank.set(row.lotUrl, m++);
    }

    const byNet = [...rows].sort((a, b) => {
        const an = a.profitAfterCostsGbp,
            bn = b.profitAfterCostsGbp;
        if (an == null && bn == null) return 0;
        if (an == null) return 1;
        if (bn == null) return -1;
        return bn - an;
    });
    const netRank = new Map();
    let n = 1;
    for (const row of byNet) {
        if (row.profitAfterCostsGbp != null) netRank.set(row.lotUrl, n++);
    }

    for (const row of rows) {
        row.rankByRrp = rrpRank.get(row.lotUrl) ?? '';
        row.rankByMargin = marginRank.get(row.lotUrl) ?? '';
        row.rankByNetProfit = netRank.get(row.lotUrl) ?? '';
        const rr = row.rankByRrp;
        const mr = row.rankByMargin;
        const nr = row.rankByNetProfit;
        row.topPickHighRrp = rr !== '' && rr <= topN ? 'Y' : 'N';
        row.topPickHighMargin = mr !== '' && mr <= topN ? 'Y' : 'N';
        row.topPickHighNet = nr !== '' && nr <= topN ? 'Y' : 'N';
    }
}

function writeCsv(csvPath, rows, opts = {}) {
    const excelSepHint = Boolean(opts.excelSepHint);
    const headers = [
        'lot_url',
        'from_cache',
        'scanned_at',
        'title',
        'packaging_text',
        'hammer_gbp',
        'pricing_sources',
        'buyers_premium_gbp',
        'vat_gbp',
        'delivery_gbp',
        'total_cost_gbp',
        'profit_after_costs_gbp',
        'rrp_low_gbp',
        'rrp_high_gbp',
        'rrp_mid_gbp',
        'resale_low_gbp',
        'resale_high_gbp',
        'resale_mid_gbp',
        'resale_comps_low_gbp',
        'resale_comps_high_gbp',
        'resale_comps_mid_gbp',
        'comp_coverage',
        'comp_pallet_haircut',
        'comp_imputed_gbp',
        'profit_resale_source',
        'profit_resale_mid_gbp',
        'actual_resale_gbp',
        'comps_mid_vs_actual_gbp',
        'llm_mid_vs_actual_gbp',
        'line_items_json',
        'margin_resale_vs_hammer_gbp',
        'confidence',
        'rank_by_rrp',
        'rank_by_margin',
        'rank_by_net_profit',
        'top_pick_high_rrp',
        'top_pick_high_margin',
        'top_pick_high_net',
        'product_guess',
        'assumptions',
        'risks',
        'llm_error',
    ];
    const lines = excelSepHint ? ['sep=,', headers.join(',')] : [headers.join(',')];
    for (const row of rows) {
        const v = row.valuation || {};
        const src = Array.isArray(row.pricingSources) ? row.pricingSources.join(' | ') : '';
        lines.push(
            [
                csvEscape(row.lotUrl),
                csvEscape(row.fromCache ? 'Y' : 'N'),
                csvEscape(row.scannedAt || ''),
                csvEscape(row.title),
                csvEscape((v && v.packagingText) || ''),
                csvEscape(row.currentBidGbp != null ? row.currentBidGbp : ''),
                csvEscape(src),
                csvEscape(row.buyersPremiumGbp != null ? row.buyersPremiumGbp : ''),
                csvEscape(row.vatGbp != null ? row.vatGbp : ''),
                csvEscape(row.deliveryGbp != null ? row.deliveryGbp : ''),
                csvEscape(row.totalCostGbp != null ? row.totalCostGbp : ''),
                csvEscape(row.profitAfterCostsGbp != null ? row.profitAfterCostsGbp : ''),
                csvEscape(v.rrpGbpLow),
                csvEscape(v.rrpGbpHigh),
                csvEscape(row.rrpMid != null ? row.rrpMid : ''),
                csvEscape(v.resaleGbpLow),
                csvEscape(v.resaleGbpHigh),
                csvEscape(row.resaleMid != null ? row.resaleMid : ''),
                csvEscape(row.resaleGbpCompsLow != null ? row.resaleGbpCompsLow : ''),
                csvEscape(row.resaleGbpCompsHigh != null ? row.resaleGbpCompsHigh : ''),
                csvEscape(row.resaleMidComps != null ? row.resaleMidComps : ''),
                csvEscape(row.compCoverage != null ? row.compCoverage : ''),
                csvEscape(row.compPalletHaircut != null ? row.compPalletHaircut : ''),
                csvEscape(row.compImputedGbp != null ? row.compImputedGbp : ''),
                csvEscape(row.profitResaleSource || ''),
                csvEscape(row.profitResaleMid != null ? row.profitResaleMid : ''),
                csvEscape(row.actualResaleGbp != null ? row.actualResaleGbp : ''),
                csvEscape(row.compsMidVsActualGbp != null ? row.compsMidVsActualGbp : ''),
                csvEscape(row.llmMidVsActualGbp != null ? row.llmMidVsActualGbp : ''),
                csvEscape(
                    (() => {
                        try {
                            return v.lineItems && v.lineItems.length
                                ? JSON.stringify(v.lineItems)
                                : '';
                        } catch {
                            return '';
                        }
                    })()
                ),
                csvEscape(row.marginResaleVsBidGbp != null ? row.marginResaleVsBidGbp : ''),
                csvEscape(v.confidence0to100),
                csvEscape(row.rankByRrp),
                csvEscape(row.rankByMargin),
                csvEscape(row.rankByNetProfit),
                csvEscape(row.topPickHighRrp),
                csvEscape(row.topPickHighMargin),
                csvEscape(row.topPickHighNet),
                csvEscape(v.productGuess),
                csvEscape(v.assumptions),
                csvEscape(v.risks),
                csvEscape(row.llmError || ''),
            ].join(',')
        );
    }
    // UTF-8 BOM + CRLF helps Excel on Windows open/import the file reliably.
    fs.writeFileSync(csvPath, `\uFEFF${lines.join('\r\n')}`, 'utf8');
}

function buildSummaryBlocks(report, args, browseLotCount) {
    const browseForSummary = typeof browseLotCount === 'number' ? browseLotCount : undefined;
    const valuedRows = report.rows.filter((r) => !r.skippedCap);
    const byRrp = [...valuedRows]
        .filter((r) => r.rrpMid != null)
        .sort((a, b) => b.rrpMid - a.rrpMid)
        .slice(0, 5)
        .map((r) => ({
            lotUrl: r.lotUrl,
            rrpMidGbp: r.rrpMid,
            marginGbp: r.marginResaleVsBidGbp,
            title: (r.title || '').slice(0, 80),
        }));
    const byMargin = [...valuedRows]
        .filter((r) => r.marginResaleVsBidGbp != null)
        .sort((a, b) => b.marginResaleVsBidGbp - a.marginResaleVsBidGbp)
        .slice(0, 5)
        .map((r) => ({
            lotUrl: r.lotUrl,
            marginGbp: r.marginResaleVsBidGbp,
            rrpMidGbp: r.rrpMid,
            title: (r.title || '').slice(0, 80),
        }));
    const byNet = [...valuedRows]
        .filter((r) => r.profitAfterCostsGbp != null)
        .sort((a, b) => b.profitAfterCostsGbp - a.profitAfterCostsGbp)
        .slice(0, 5)
        .map((r) => ({
            lotUrl: r.lotUrl,
            netProfitGbp: r.profitAfterCostsGbp,
            totalCostGbp: r.totalCostGbp,
            title: (r.title || '').slice(0, 80),
        }));
    report.summary = {
        browseLotCount: browseForSummary != null ? browseForSummary : report.rows.length,
        rowsWritten: report.rows.length,
        fromCache: valuedRows.filter((r) => r.fromCache).length,
        newlyValuedOk: valuedRows.filter((r) => !r.fromCache && r.valuation).length,
        newlyValuedFailed: valuedRows.filter((r) => !r.fromCache && r.llmError && !r.skippedCap).length,
        skippedCap: report.rows.filter((r) => r.skippedCap).length,
        topByRrpMidGbp: byRrp,
        topByMarginGbp: byMargin,
        topByNetProfitGbp: byNet,
    };
}

function writeRankedOutputs(jsonPath, csvPath, report, args, { browseLotCount, batchCount, progressiveNote }) {
    if (typeof batchCount === 'number') report.batchCount = batchCount;
    assignRanksAndFlags(report.rows, args.topFlags);
    buildSummaryBlocks(report, args, browseLotCount);
    report.finishedAt = new Date().toISOString();
    if (progressiveNote) {
        if (!report.progress) report.progress = [];
        report.progress.push({ at: report.finishedAt, note: progressiveNote });
    }
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    const hint = args.csvExcel ? ' + Excel sep hint' : '';
    console.log(`Writing CSV with ${report.rows.length} data rows (+ header${hint})${progressiveNote ? ` [${progressiveNote}]` : ''}…`);
    writeCsv(csvPath, report.rows, { excelSepHint: args.csvExcel });
    console.log('Wrote', jsonPath);
    console.log('Wrote', csvPath);
}

function collectOptsFromArgs(args, overrides = {}) {
    return {
        scrollRounds: args.scrollRounds,
        pauseMs: args.pauseMs,
        browseDelayMs: args.browseDelayMs,
        maxBrowsePages: args.maxBrowsePages,
        debugHrefs: args.debugHrefs,
        ...overrides,
    };
}

async function valueChunkedLots(p) {
    const {
        orderedLotUrls,
        report,
        cache,
        cachePath,
        fees,
        args,
        launchOpts,
        ctxFactory,
        lotState,
        valueState,
        isFinalRunSegment,
        lotPositionStart,
        runLabel,
    } = p;

    if (!orderedLotUrls || orderedLotUrls.length === 0) return;

    const chunks = chunkLotsForBatches(orderedLotUrls, args.batchSize);
    const totalInSegment = orderedLotUrls.length;
    let lotPositionOffset = lotPositionStart;

    async function ensureLotBrowser() {
        if (lotState.browser) return;
        lotState.browser = await chromium.launch(launchOpts);
        lotState.context = await lotState.browser.newContext(ctxFactory());
        lotState.page = await lotState.context.newPage();
    }

    async function closeLotBrowserIfAny(isLastBatch) {
        if (!lotState.browser) return;
        if (args.saveStorage && isLastBatch && isFinalRunSegment) {
            try {
                await lotState.context.storageState({ path: args.saveStorage });
                console.log('Saved storage state to', args.saveStorage);
            } catch (e) {
                console.error('Failed to save storage:', e.message || e);
            }
        }
        await lotState.browser.close();
        lotState.browser = null;
        lotState.context = null;
        lotState.page = null;
    }

    for (let bi = 0; bi < chunks.length; bi++) {
        const chunk = chunks[bi];
        const rangeFrom = lotPositionOffset + 1;
        const rangeTo = lotPositionOffset + chunk.length;
        lotPositionOffset += chunk.length;
        console.log(
            `[${runLabel} batch ${bi + 1}/${chunks.length}] ${chunk.length} lot URLs (global ${rangeFrom}–${rangeTo} of ${lotPositionStart + totalInSegment}), fresh browser when any lot is opened`
        );

        for (const lotUrl of chunk) {
            const key = cacheKey(lotUrl);
            const cached = cache.entries[key];
            const useCache = cached && !args.force;

            if (useCache) {
                const v = cached.valuation || {};
                const rrpMid = numMid(v.rrpGbpLow, v.rrpGbpHigh);
                const resaleMid = numMid(v.resaleGbpLow, v.resaleGbpHigh);
                const row = {
                    lotUrl,
                    fromCache: true,
                    scannedAt: cached.scannedAt || '',
                    title: cached.title || '',
                    currentBidGbp: cached.currentBidGbp != null ? cached.currentBidGbp : null,
                    pricingSources: cached.pricingSources || [],
                    valuation: cached.valuation || null,
                    rrpMid,
                    resaleMid,
                    llmError: cached.llmError || null,
                    compRequested: Boolean(args.compPricing),
                };
                if (args.compPricing) {
                    let compR = cached.compPricing || null;
                    if (!compR && v.lineItems && v.lineItems.length) {
                        try {
                            await ensureLotBrowser();
                            compR = await runEbayCompsForLot(lotState.context, v, args, lotUrl);
                            if (compR && !compR.skipped) {
                                cache.entries[key] = { ...cache.entries[key], compPricing: compR };
                                saveCache(cachePath, cache);
                            }
                        } catch (e) {
                            report.errors.push({ lotUrl, error: 'eBay comps: ' + (e.message || String(e)) });
                            row.compEbayError = e.message || String(e);
                        }
                    }
                    if (compR) {
                        applyCompsToRowData(row, compR);
                    }
                }
                applyActualsToRow(row, lotUrl, process.env.JOHN_PYE_ACTUALS);
                applyFeesToRow(row, fees, feeOptsForComps(args, row));
                report.rows.push(row);
                console.log(`[cache] ${logKeyForCacheConsole(key)}`);
                continue;
            }

            if (args.maxValueCalls > 0 && valueState.valueCalls >= args.maxValueCalls) {
                const capRow = {
                    lotUrl,
                    fromCache: false,
                    skippedCap: true,
                    scannedAt: '',
                    title: '',
                    currentBidGbp: null,
                    pricingSources: [],
                    valuation: null,
                    rrpMid: null,
                    resaleMid: null,
                    llmError: 'skipped: --max-value-calls reached',
                };
                applyFeesToRow(capRow, fees);
                report.rows.push(capRow);
                console.log(`[skip cap] ${lotUrl}`);
                continue;
            }

            try {
                await ensureLotBrowser();
                const navRes = await lotState.page.goto(lotUrl, { waitUntil: 'load', timeout: 90_000 });
                await sleep(300);
                const pageTitleSnap = (await lotState.page.title().catch(() => '')) || '';
                if (navRes && (navRes.status() === 404 || navRes.status() === 410)) {
                    throw new Error(
                        'HTTP ' +
                            navRes.status() +
                            ': that URL is not a page on the site. Check you pasted the full lot address (the path must not contain "…" or "..." as a placeholder).',
                    );
                }
                if (isLikelyJohnPyeNotFoundTitle(pageTitleSnap)) {
                    throw new Error(
                        'The server returned a “not found” page, not a lot. Title: ' +
                            JSON.stringify(pageTitleSnap.slice(0, 100)) +
                            ' — open the real lot in a browser, copy the full https URL from the address bar, and try again.',
                    );
                }
                const { title, imageUrls } = await extractLotPhotos(lotState.page);
                const { hammerGbp, pricingSources } = await extractLotHammerGbp(lotState.page);
                const currentBidGbp = hammerGbp;
                const buffers = await buildImageBuffersForLlm(lotState.context, lotUrl, imageUrls);
                if (imageUrls.length) {
                    console.log(
                        `[vision] lot photos on page: ${imageUrls.length}; sending up to ${LLM_IMAGES_MAX} to the model (set JOHN_PYE_LLM_IMAGES=12 to try more)`,
                    );
                }
                const imageParts = imagePartsFromBuffers(buffers, {
                    imageDetail: 'high',
                    maxImages: LLM_IMAGES_MAX,
                });

                let valuation = null;
                let llmError = null;
                if (imageParts.length === 0) {
                    llmError = 'no images for vision';
                    console.error(
                        '[warn] No photos could be fetched for vision (0 images). Try re-running with --headed, or check the lot in a normal browser. Cloudflare or lazy loading can block headless.'
                    );
                } else {
                    valueState.valueCalls++;
                    try {
                        const lotExtra = args.lotUrl
                            ? {
                                  extraUserLines: [
                                      'Single lot page: in productGuess, list what you can read in the images (per unit), then the GBP numbers.',
                                  ],
                              }
                            : {};
                        const res = await valueLotWithLlm(
                            {
                                title,
                                metaDescription: '',
                                imageParts,
                            },
                            { model: JOHN_PYE_LLM_MODEL, ...lotExtra }
                        );
                        valuation = res.valuation;
                    } catch (e) {
                        llmError = e.message || String(e);
                    }
                }

                const v = valuation || {};
                const rrpMid = numMid(v.rrpGbpLow, v.rrpGbpHigh);
                const resaleMid = numMid(v.resaleGbpLow, v.resaleGbpHigh);

                let compReport = null;
                if (valuation && args.compPricing) {
                    try {
                        compReport = await runEbayCompsForLot(lotState.context, valuation, args, lotUrl);
                    } catch (e) {
                        const msg = e.message || String(e);
                        report.errors.push({ lotUrl, error: 'eBay comps: ' + msg });
                        compReport = { skipped: 'error', error: msg };
                    }
                }

                const scannedAt = new Date().toISOString();
                if (valuation) {
                    const entry = {
                        scannedAt,
                        lotUrl,
                        title,
                        currentBidGbp,
                        pricingSources,
                        photoCount: imageUrls.length,
                        valuation,
                        llmError: null,
                    };
                    if (compReport && !compReport.skipped) {
                        entry.compPricing = compReport;
                    }
                    cache.entries[key] = entry;
                    saveCache(cachePath, cache);
                }

                const row = {
                    lotUrl,
                    fromCache: false,
                    scannedAt: valuation ? scannedAt : '',
                    title,
                    currentBidGbp,
                    pricingSources,
                    valuation,
                    rrpMid,
                    resaleMid,
                    llmError,
                    compRequested: Boolean(args.compPricing),
                };
                if (compReport) {
                    applyCompsToRowData(row, compReport);
                }
                applyActualsToRow(row, lotUrl, process.env.JOHN_PYE_ACTUALS);
                applyFeesToRow(row, fees, feeOptsForComps(args, row));
                report.rows.push(row);
                console.log(
                    `[valued ${valueState.valueCalls}] ${(title || '').slice(0, 56)}… rrpMid=${rrpMid ?? '?'} net=${row.profitAfterCostsGbp ?? '?'} hammer=${currentBidGbp ?? '?'} comp=${row.resaleMidComps != null ? '~£' + row.resaleMidComps : 'n/a'}`
                );
            } catch (e) {
                const msg = e.message || String(e);
                report.errors.push({ lotUrl, error: msg });
                const errRow = {
                    lotUrl,
                    fromCache: false,
                    scannedAt: new Date().toISOString(),
                    title: '',
                    currentBidGbp: null,
                    pricingSources: [],
                    valuation: null,
                    rrpMid: null,
                    resaleMid: null,
                    llmError: msg,
                };
                applyFeesToRow(errRow, fees);
                report.rows.push(errRow);
                console.error(`[error] ${lotUrl}: ${msg}`);
            }

            await sleep(args.lotDelayMs);
        }

        const lastBatch = bi === chunks.length - 1;
        if (lastBatch) await closeLotBrowserIfAny(true);
        if (args.batchPauseMs > 0 && !lastBatch) await sleep(args.batchPauseMs);
    }
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help) {
        printHelp();
        process.exit(0);
    }

    if (!process.env.OPENAI_API_KEY) {
        console.error('OPENAI_API_KEY is required.');
        process.exit(1);
    }

    if (args.allBrowsePages && !args.lotUrl && args.maxBrowsePages > 200) {
        console.warn(
            `[warn] --all-browse-pages will try up to ${args.maxBrowsePages} listing pages (0…${args.maxBrowsePages - 1}). ` +
                `For a quicker test use e.g. --max-browse-pages 40.`
        );
    }

    const runStartedAt = Date.now();
    const cachePath = path.isAbsolute(args.cache) ? args.cache : path.join(process.cwd(), args.cache);
    const cache = loadCache(cachePath);

    let oneLotU = null;
    if (args.lotUrl) {
        if (args.allBrowsePages) {
            console.warn('[warn] --lot-url is set: ignoring --all-browse-pages');
        }
        if (args.singlePage) {
            console.warn('[warn] --lot-url is set: ignoring --single-page');
        }
        if (args.browsePage) {
            console.warn('[warn] --lot-url is set: ignoring --browse-page');
        }
        try {
            oneLotU = new URL(String(args.lotUrl).trim());
            if (oneLotU.protocol !== 'http:' && oneLotU.protocol !== 'https:') {
                throw new Error('bad protocol');
            }
        } catch {
            console.error('Invalid --lot-url: pass a full https://… link to a John Pye lot detail page.');
            process.exit(1);
        }
        if (isPlaceholderOrExampleLotUrl(String(args.lotUrl))) {
            console.error(
                'The --lot-url must be copied from your browser address bar, not a shortened example.\n' +
                    'Yours still looks like a placeholder (it contains "..." in the path). ' +
                    'On johnpyeauctions.co.uk, open the real lot, then copy the full https://… URL.',
            );
            process.exit(1);
        }
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outBase = args.outBase
        ? path.isAbsolute(args.outBase)
            ? args.outBase
            : path.join(process.cwd(), args.outBase)
        : path.join(__dirname, `john-pye-ranked-${ts}`);

    const jsonPath = `${outBase}.json`;
    const csvPath = `${outBase}.csv`;

    const launchOpts = {
        headless: !args.headed,
        slowMo: args.slowMo || undefined,
    };
    const contextOpts = {};
    if (args.storage && fs.existsSync(args.storage)) {
        contextOpts.storageState = args.storage;
    }

    const baseNormalized = oneLotU ? `${oneLotU.origin}/` : normalizeBrowseBaseUrl(args.url);
    const fees = feeOptionsFromArgs(args);

    const report = {
        lotMode: Boolean(oneLotU),
        browseUrlInput: oneLotU ? oneLotU.href : args.url,
        browseBaseUrl: baseNormalized,
        cachePath,
        feeSettings: fees,
        batchSize: args.batchSize,
        compSettings: {
            compPricing: args.compPricing,
            compMaxQueries: args.compMaxQueries,
            compHaircut: resolveCompHaircut(args.compHaircut),
            compNoImpute: args.compNoImpute,
            profitFromLlm: args.profitFromLlm,
            ebayDelayMs: EBAY_COMP_DELAY(),
            actualsFile: process.env.JOHN_PYE_ACTUALS || 'scripts/john-pye-actuals.json',
        },
        startedAt: new Date().toISOString(),
        browsePagination: [],
        rows: [],
        errors: [],
    };

    const valueState = { valueCalls: 0 };

    const ctxFactory = () => ({
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1365, height: 900 },
        ...contextOpts,
    });

    let orderedLotUrls = [];
    const segments = [];

    if (oneLotU) {
        orderedLotUrls = [oneLotU.href];
    } else if (args.allBrowsePages) {
        if (args.browsePage != null || args.singlePage) {
            console.warn('Ignoring --browse-page / --single-page with --all-browse-pages');
        }
        const maxP = Math.max(0, args.maxBrowsePages - 1);
        const discoverBrowser = await chromium.launch(launchOpts);
        const discoverContext = await discoverBrowser.newContext(ctxFactory());
        const discoverPage = await discoverContext.newPage();
        try {
            for (let p = 0; p <= maxP; p++) {
                const r = await collectLotUrlsAllBrowsePages(
                    discoverPage,
                    baseNormalized,
                    collectOptsFromArgs(args, { onlyPageIndex: p, singlePage: false })
                );
                const pl0 = r.pageLog[0];
                if (!r.orderedLotUrls.length || (pl0 && pl0.lotsOnPage === 0)) {
                    console.log(
                        `[browse] stopping: no lot links on page index ${p} (0 = first listing page, 1 = ?page=1, …).`
                    );
                    break;
                }
                report.browsePagination = report.browsePagination.concat(r.pageLog);
                segments.push({ pageIndex: p, orderedLotUrls: r.orderedLotUrls });
            }
        } finally {
            await discoverBrowser.close();
        }
    } else {
        const discoverBrowser = await chromium.launch(launchOpts);
        const discoverContext = await discoverBrowser.newContext(ctxFactory());
        const discoverPage = await discoverContext.newPage();
        try {
            const onlyPageIndex =
                args.browsePage != null && Number.isFinite(args.browsePage) && args.browsePage >= 1
                    ? args.browsePage - 1
                    : undefined;
            const r = await collectLotUrlsAllBrowsePages(discoverPage, baseNormalized, {
                ...(onlyPageIndex !== undefined ? { onlyPageIndex } : {}),
                singlePage: args.singlePage,
                scrollRounds: args.scrollRounds,
                pauseMs: args.pauseMs,
                browseDelayMs: args.browseDelayMs,
                maxBrowsePages: args.maxBrowsePages,
                debugHrefs: args.debugHrefs,
            });
            orderedLotUrls = r.orderedLotUrls;
            report.browsePagination = r.pageLog;
        } finally {
            await discoverBrowser.close();
        }
    }

    if (!oneLotU && !args.lotUrl && args.maxLots > 0) {
        if (args.allBrowsePages) {
            const flat = [];
            for (const seg of segments) {
                for (const u of seg.orderedLotUrls) {
                    flat.push(u);
                    if (flat.length >= args.maxLots) {
                        break;
                    }
                }
                if (flat.length >= args.maxLots) {
                    break;
                }
            }
            segments.length = 0;
            if (flat.length) {
                const pIdx = report.browsePagination.length ? report.browsePagination[0].pageIndex : 0;
                segments.push({ pageIndex: pIdx, orderedLotUrls: flat });
            }
        } else {
            orderedLotUrls = orderedLotUrls.slice(0, args.maxLots);
        }
        report.maxLotsApplied = args.maxLots;
        const nQ = args.allBrowsePages
            ? (segments[0] ? segments[0].orderedLotUrls.length : 0)
            : orderedLotUrls.length;
        console.log(
            `[limit] --max-lots ${args.maxLots}: valuing ${nQ} lot URL(s) in browse order (discovery unchanged; rest are skipped this run).`
        );
    } else if (oneLotU && args.maxLots > 0) {
        console.warn('[warn] --max-lots is ignored with --lot-url (single-URL mode).');
    }

    if (args.allBrowsePages && !oneLotU) {
        report.allBrowsePages = true;
        report.browseAllPageSegments = segments.map((s) => ({
            pageIndex: s.pageIndex,
            lotCount: s.orderedLotUrls.length,
        }));
    }

    report.pageTitleAfterBrowse = report.browsePagination[0]?.titleAfterNav ?? null;
    if (report.pageTitleAfterBrowse && /just a moment/i.test(report.pageTitleAfterBrowse)) {
        report.errors.push(
            'Page title looks like Cloudflare challenge. Re-run with --headed, complete the challenge, then use --save-storage and --storage on later runs.'
        );
        console.error(report.errors[report.errors.length - 1]);
    }

    const allDiscoveryUrls = args.allBrowsePages
        ? segments.flatMap((s) => s.orderedLotUrls)
        : orderedLotUrls;
    const uniqueUrls = [...new Set(allDiscoveryUrls)];
    const estLlm = countLotsNeedingLlm(uniqueUrls, cache, args.force);
    const discMode = oneLotU
        ? 'single_lot'
        : args.allBrowsePages
          ? 'all_browse_pages'
          : 'single_range';
    report.discovery = {
        mode: discMode,
        listingPageCount: report.browsePagination.length,
        totalLotLinks: uniqueUrls.length,
        estimatedOpenAiVisionCalls: estLlm,
    };
    if (oneLotU) {
        report.discovery.lotUrl = oneLotU.href;
    }
    if (args.allBrowsePages && !oneLotU) {
        report.discovery.browsePageSegmentCount = segments.length;
    }
    if (args.maxValueCalls > 0) {
        report.discovery.maxValueCallsCap = args.maxValueCalls;
    }
    const capNote =
        args.maxValueCalls > 0
            ? ` (capped at ${args.maxValueCalls} new valuations this run; cached lots do not count)`
            : '';
    if (oneLotU) {
        console.log(
            `[discovery] Single lot mode. ~${estLlm} OpenAI vision call(s) if this URL is not in cache${args.force ? ' (--force: re-check)' : ''}${capNote}.`
        );
    } else {
        console.log(
            `[discovery] ${uniqueUrls.length} lot link(s) in ${report.browsePagination.length} listing page load(s). ` +
                `~${estLlm} OpenAI vision call(s) for lots not in cache${args.force ? ' (--force: all lots)' : ''}${capNote}.`
        );
    }

    let sigintOnce = false;
    process.on('SIGINT', () => {
        if (sigintOnce) process.exit(130);
        sigintOnce = true;
        console.error('\n[interrupt] saving report (Ctrl+C)…');
        try {
            report.interruptedAt = new Date().toISOString();
            report.errors.push('Run interrupted (Ctrl+C); output may be partial.');
            const totalLinks = uniqueUrls.length;
            writeRankedOutputs(jsonPath, csvPath, report, args, {
                browseLotCount: totalLinks,
                batchCount: report.batchCount || 0,
            });
            console.error(`[interrupt] wrote ${report.rows.length} row(s) -> ${path.basename(csvPath)}`);
        } catch (e) {
            console.error(e);
        }
        process.exit(130);
    });

    if (args.allBrowsePages && !oneLotU) {
        const lotState = { browser: null, context: null, page: null };
        const totalDiscovered = segments.reduce((a, s) => a + s.orderedLotUrls.length, 0);
        let lotGlobal = 0;
        let totalBatchChunks = 0;
        for (let si = 0; si < segments.length; si++) {
            const { pageIndex, orderedLotUrls: pageLots } = segments[si];
            const segChunks = chunkLotsForBatches(pageLots, args.batchSize).length;
            totalBatchChunks += segChunks;
            const lastSeg = si === segments.length - 1;
            console.log(
                `\n--- [all-browse] page index ${pageIndex} (${pageLots.length} lot URLs) — segment ${si + 1}/${
                    segments.length
                } ---\n`
            );
            await valueChunkedLots({
                orderedLotUrls: pageLots,
                report,
                cache,
                cachePath,
                fees,
                args,
                launchOpts,
                ctxFactory,
                lotState,
                valueState,
                isFinalRunSegment: lastSeg,
                lotPositionStart: lotGlobal,
                runLabel: `page${pageIndex}`,
            });
            lotGlobal += pageLots.length;
            const cumulativeBrowse = segments.slice(0, si + 1).reduce((a, s) => a + s.orderedLotUrls.length, 0);
            const note = `after browse page index ${pageIndex} (${cumulativeBrowse}/${totalDiscovered} lot URLs in run)`;
            writeRankedOutputs(jsonPath, csvPath, report, args, {
                browseLotCount: cumulativeBrowse,
                batchCount: totalBatchChunks,
                progressiveNote: lastSeg ? undefined : note,
            });
            if (!lastSeg) console.log('Updated', csvPath, '(intermediate snapshot)\n');
        }
        if (segments.length === 0) {
            writeRankedOutputs(jsonPath, csvPath, report, args, { browseLotCount: 0, batchCount: 0 });
        }
    } else {
        const chunks = chunkLotsForBatches(orderedLotUrls, args.batchSize);
        const lotState = { browser: null, context: null, page: null };
        await valueChunkedLots({
            orderedLotUrls,
            report,
            cache,
            cachePath,
            fees,
            args,
            launchOpts,
            ctxFactory,
            lotState,
            valueState,
            isFinalRunSegment: true,
            lotPositionStart: 0,
            runLabel: 'batch',
        });
        writeRankedOutputs(jsonPath, csvPath, report, args, {
            browseLotCount: orderedLotUrls.length,
            batchCount: chunks.length,
        });
    }

    if (report.rows[0] && (oneLotU || args.maxLots === 1)) {
        printSingleLotResult(report.rows[0], { compPricing: args.compPricing });
    }
    const sec = (Date.now() - runStartedAt) / 1000;
    const timeStr = sec < 90 ? `${Math.round(sec)}s` : `${(sec / 60).toFixed(1)} min`;
    console.log(`Run finished in ${timeStr} (wall clock).`);
    console.log('Updated cache', cachePath);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
