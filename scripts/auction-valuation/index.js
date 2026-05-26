#!/usr/bin/env node
/**
 * Auction lot valuation: Playwright scrape + OpenAI vision JSON.
 *
 * Env: OPENAI_API_KEY (required). Optional: OPENAI_MODEL (default gpt-4o-mini).
 * Loads, in order: `scripts/auction-valuation/.env`, then repo-root `.env` (later only fills vars not already set).
 * Copy `.env.example` to `.env` here and set your key — do not commit `.env`.
 *
 * Legal: Only use on pages you are permitted to access; many sites forbid automation.
 * Output is approximate — verify before bidding.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

try {
    const dotenv = require('dotenv');
    const localEnv = path.join(__dirname, '.env');
    const rootEnv = path.join(__dirname, '..', '..', '.env');
    if (fs.existsSync(localEnv)) dotenv.config({ path: localEnv });
    if (fs.existsSync(rootEnv)) dotenv.config({ path: rootEnv });
} catch {
    /* dotenv optional */
}

const { scrapeLotPage } = require('./scrape');
const { valueLotWithLlm, imagePartsFromBuffers } = require('./llm');

function parseArgs(argv) {
    const out = {
        input: null,
        out: null,
        limit: null,
        headed: false,
        slowMo: 0,
        retries: 2,
        concurrency: 1,
        csv: false,
        dryRun: false,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--headed') out.headed = true;
        else if (a === '--csv') out.csv = true;
        else if (a === '--dry-run') out.dryRun = true;
        else if (a === '--input' && argv[i + 1]) out.input = argv[++i];
        else if (a === '--out' && argv[i + 1]) out.out = argv[++i];
        else if (a === '--limit' && argv[i + 1]) out.limit = parseInt(argv[++i], 10);
        else if (a === '--slowmo' && argv[i + 1]) out.slowMo = parseInt(argv[++i], 10);
        else if (a === '--retries' && argv[i + 1]) out.retries = parseInt(argv[++i], 10);
        else if (a === '--concurrency' && argv[i + 1]) out.concurrency = Math.max(1, parseInt(argv[++i], 10));
        else if (a === '--help' || a === '-h') out.help = true;
    }
    return out;
}

function printHelp() {
    console.log(`Usage: node scripts/auction-valuation/index.js --input <file> [options]

Input file:
  - JSON: { "lots": [ { "url": "https://...", "currentBidGbp": 12 } ] }
  - Or plain text: one URL per line

Options:
  --out <path>       JSON report path (default: scripts/auction-valuation/report-<timestamp>.json)
  --csv              Also write <out-base>.csv next to JSON (or report-<ts>.csv if --out omitted)
  --limit <n>        Process at most n lots
  --headed           Show browser (CAPTCHA / bot challenges)
  --slowmo <ms>      Slow down Playwright operations
  --retries <n>      Navigation retries per lot (0-5, default 2)
  --concurrency <n>  Parallel lots (default 1; higher may trigger rate limits)
  --dry-run          Scrape only, skip OpenAI

Env: OPENAI_API_KEY, optional OPENAI_MODEL (set in scripts/auction-valuation/.env or repo-root .env)
`);
}

function loadLots(inputPath) {
    const raw = fs.readFileSync(inputPath, 'utf8').trim();
    if (!raw) return [];
    if (raw.startsWith('{') || raw.startsWith('[')) {
        const j = JSON.parse(raw);
        if (Array.isArray(j)) return j.map((u) => (typeof u === 'string' ? { url: u } : u));
        if (j.lots && Array.isArray(j.lots)) return j.lots;
        if (j.urls && Array.isArray(j.urls)) return j.urls.map((u) => (typeof u === 'string' ? { url: u } : u));
        throw new Error('JSON input must be { "lots": [...] } or an array of urls/objects');
    }
    return raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((url) => ({ url }));
}

function csvEscape(s) {
    const t = s == null ? '' : String(s);
    if (/[",\r\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
}

function marginVsBid(currentBidGbp, resaleLow, resaleHigh) {
    if (currentBidGbp == null || Number.isNaN(Number(currentBidGbp))) return null;
    const bid = Number(currentBidGbp);
    if (resaleLow == null && resaleHigh == null) return null;
    const lo = resaleLow != null ? Number(resaleLow) : Number(resaleHigh);
    const hi = resaleHigh != null ? Number(resaleHigh) : lo;
    const mid = (lo + hi) / 2;
    return Math.round((mid - bid) * 100) / 100;
}

function writeCsv(reportPath, rows) {
    const headers = [
        'url',
        'title',
        'currentBidGbp',
        'productGuess',
        'rrpGbpLow',
        'rrpGbpHigh',
        'resaleGbpLow',
        'resaleGbpHigh',
        'estimatedMarginVsMidResaleGbp',
        'confidence0to100',
        'assumptions',
        'risks',
        'scrapeError',
        'llmError',
    ];
    const lines = [headers.join(',')];
    for (const r of rows) {
        const v = r.valuation || {};
        const margin = marginVsBid(r.currentBidGbp, v.resaleGbpLow, v.resaleGbpHigh);
        lines.push(
            [
                csvEscape(r.url),
                csvEscape(r.title),
                csvEscape(r.currentBidGbp != null ? r.currentBidGbp : ''),
                csvEscape(v.productGuess),
                csvEscape(v.rrpGbpLow),
                csvEscape(v.rrpGbpHigh),
                csvEscape(v.resaleGbpLow),
                csvEscape(v.resaleGbpHigh),
                csvEscape(margin != null ? margin : ''),
                csvEscape(v.confidence0to100),
                csvEscape(v.assumptions),
                csvEscape(v.risks),
                csvEscape(r.scrapeError),
                csvEscape(r.llmError),
            ].join(',')
        );
    }
    fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
}

async function runPool(items, concurrency, worker) {
    const results = new Array(items.length);
    let idx = 0;
    async function runOne() {
        for (;;) {
            const i = idx++;
            if (i >= items.length) return;
            results[i] = await worker(items[i], i);
        }
    }
    const n = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: n }, () => runOne()));
    return results;
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help || !args.input) {
        printHelp();
        process.exit(args.help ? 0 : 1);
    }

    const inputPath = path.isAbsolute(args.input) ? args.input : path.join(process.cwd(), args.input);
    if (!fs.existsSync(inputPath)) {
        console.error('Input file not found:', inputPath);
        process.exit(1);
    }

    let lots = loadLots(inputPath);
    if (args.limit != null && !Number.isNaN(args.limit)) {
        lots = lots.slice(0, Math.max(0, args.limit));
    }
    if (lots.length === 0) {
        console.error('No lots to process (empty or invalid input).');
        process.exit(1);
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const defaultOut = path.join(__dirname, `report-${ts}.json`);
    const outJson = args.out
        ? path.isAbsolute(args.out)
            ? args.out
            : path.join(process.cwd(), args.out)
        : defaultOut;

    if (!args.dryRun && !process.env.OPENAI_API_KEY) {
        console.error('OPENAI_API_KEY is required unless --dry-run');
        process.exit(1);
    }

    const browser = await chromium.launch({
        headless: !args.headed,
        slowMo: args.slowMo || undefined,
    });

    const startedAt = new Date().toISOString();
    const rows = [];

    try {
        const work = lots.map((lot, index) => ({ lot, index }));
        const chunkResults = await runPool(work, args.concurrency, async ({ lot }) => {
            const url = lot.url || lot.href;
            if (!url || typeof url !== 'string') {
                return {
                    url: '',
                    currentBidGbp: lot.currentBidGbp,
                    title: '',
                    imageUrls: [],
                    scrapeError: 'missing url',
                    llmError: null,
                    valuation: null,
                };
            }
            const currentBidGbp =
                lot.currentBidGbp != null
                    ? Number(lot.currentBidGbp)
                    : lot.current_bid_gbp != null
                      ? Number(lot.current_bid_gbp)
                      : null;

            let scrape;
            try {
                scrape = await scrapeLotPage(browser, url, { retries: args.retries });
            } catch (e) {
                return {
                    url,
                    currentBidGbp,
                    title: '',
                    imageUrls: [],
                    scrapeError: e.message || String(e),
                    llmError: null,
                    valuation: null,
                };
            }

            if (args.dryRun) {
                return {
                    url,
                    currentBidGbp,
                    title: scrape.title,
                    metaDescription: scrape.metaDescription,
                    imageUrls: scrape.imageUrls,
                    scrapeError: null,
                    llmError: null,
                    valuation: null,
                };
            }

            const imageParts = imagePartsFromBuffers(scrape.imagesForLlm || []);
            if (imageParts.length === 0) {
                return {
                    url,
                    currentBidGbp,
                    title: scrape.title,
                    metaDescription: scrape.metaDescription,
                    imageUrls: scrape.imageUrls,
                    scrapeError: null,
                    llmError: 'no images could be fetched for vision',
                    valuation: null,
                };
            }

            try {
                const { valuation } = await valueLotWithLlm(
                    {
                        title: scrape.title,
                        metaDescription: scrape.metaDescription,
                        imageParts,
                    },
                    {}
                );
                return {
                    url,
                    currentBidGbp,
                    title: scrape.title,
                    metaDescription: scrape.metaDescription,
                    imageUrls: scrape.imageUrls,
                    scrapeError: null,
                    llmError: null,
                    valuation,
                };
            } catch (e) {
                return {
                    url,
                    currentBidGbp,
                    title: scrape.title,
                    metaDescription: scrape.metaDescription,
                    imageUrls: scrape.imageUrls,
                    scrapeError: null,
                    llmError: e.message || String(e),
                    valuation: null,
                };
            }
        });

        for (const r of chunkResults) rows.push(r);
    } finally {
        await browser.close();
    }

    const report = {
        startedAt,
        finishedAt: new Date().toISOString(),
        inputPath,
        dryRun: !!args.dryRun,
        rows,
    };

    fs.mkdirSync(path.dirname(outJson), { recursive: true });
    fs.writeFileSync(outJson, JSON.stringify(report, null, 2), 'utf8');
    console.log('Wrote', outJson);

    if (args.csv) {
        const csvPath = outJson.toLowerCase().endsWith('.json')
            ? outJson.slice(0, -5) + '.csv'
            : `${outJson}.csv`;
        writeCsv(csvPath, rows);
        console.log('Wrote', csvPath);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
