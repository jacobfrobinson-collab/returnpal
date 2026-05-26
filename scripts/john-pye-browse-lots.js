#!/usr/bin/env node
/**
 * John Pye Auctions — open a Browse category URL, scroll to load listings, visit each lot
 * detail page, and collect image URLs (and counts).
 *
 * Respect johnpyeauctions.co.uk Terms of Use; personal research only; polite rate limits.
 * Cloudflare may block headless Chromium — use --headed (and optionally --storage) if you see
 * "Just a moment..." or zero lots found.
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
} = require('./john-pye-lib');

function parseArgs(argv) {
    const out = {
        url: DEFAULT_BROWSE_URL,
        limit: 0,
        headed: false,
        slowMo: 0,
        output: null,
        storage: null,
        saveStorage: null,
        scrollRounds: 50,
        pauseMs: 500,
        lotDelayMs: 1200,
        browseDelayMs: 1500,
        maxBrowsePages: 2000,
        batchSize: 100,
        batchPauseMs: 0,
        singlePage: false,
        browsePage: null,
        debugHrefs: false,
        help: false,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--headed') out.headed = true;
        else if (a === '--single-page') out.singlePage = true;
        else if (a === '--debug-hrefs') out.debugHrefs = true;
        else if (a === '--url' && argv[i + 1]) out.url = argv[++i];
        else if (a === '--limit' && argv[i + 1]) out.limit = parseInt(argv[++i], 10);
        else if (a === '--out' && argv[i + 1]) out.output = argv[++i];
        else if (a === '--storage' && argv[i + 1]) out.storage = argv[++i];
        else if (a === '--save-storage' && argv[i + 1]) out.saveStorage = argv[++i];
        else if (a === '--slowmo' && argv[i + 1]) out.slowMo = parseInt(argv[++i], 10);
        else if (a === '--scroll-rounds' && argv[i + 1]) out.scrollRounds = parseInt(argv[++i], 10);
        else if (a === '--lot-delay' && argv[i + 1]) out.lotDelayMs = parseInt(argv[++i], 10);
        else if (a === '--browse-delay' && argv[i + 1]) out.browseDelayMs = parseInt(argv[++i], 10);
        else if (a === '--max-browse-pages' && argv[i + 1]) out.maxBrowsePages = parseInt(argv[++i], 10);
        else if (a === '--batch-size' && argv[i + 1]) out.batchSize = parseInt(argv[++i], 10);
        else if (a === '--batch-pause-ms' && argv[i + 1]) out.batchPauseMs = parseInt(argv[++i], 10);
        else if (a === '--browse-page' && argv[i + 1]) {
            const bp = parseInt(argv[++i], 10);
            out.browsePage = Number.isFinite(bp) ? bp : null;
        } else if (a === '--help' || a === '-h') out.help = true;
    }
    return out;
}

function printHelp() {
    console.log(`Usage: node scripts/john-pye-browse-lots.js [options]

Opens the Browse page (default: PALLET category), scrolls to load lazy content, collects
lot detail links across ?page=1, ?page=2, … until no new lots appear, then visits each lot.

Options:
  --url <url>           Browse URL (default: ${DEFAULT_BROWSE_URL}; ?page= stripped for pagination base)
  --limit <n>           After discovery, visit at most n lots for photos (0 = all)
  --single-page         Only first browse page (no ?page=1,2,…)
  --browse-page <n>     Only page n (1 = first, 2 = second, …). Use for one page per run.
  --out <path>          JSON report (default: scripts/john-pye-lot-photos-<timestamp>.json)
  --headed              Visible browser (often required for Cloudflare)
  --slowmo <ms>         Playwright slowMo
  --storage <path>      Load Playwright storage state JSON (cookies/session)
  --save-storage <path> After run, save storage state (reuse with --storage)
  --scroll-rounds <n>   Max scroll iterations per browse page (default 50)
  --browse-delay <ms>   Pause between browse pages (default 1500)
  --max-browse-pages <n> Safety cap on browse pages (default 2000)
  --batch-size <n>      Restart browser after every n lot URLs (default 100; 0 = one session for all lots)
  --batch-pause-ms <n>  Pause between batches (default 0)
  --lot-delay <ms>      Pause between lot pages (default 1200)
  --debug-hrefs         Print sample internal hrefs when no lots match heuristics
`);
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help) {
        printHelp();
        process.exit(0);
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const defaultOut = path.join(__dirname, `john-pye-lot-photos-${ts}.json`);
    const outPath = args.output
        ? path.isAbsolute(args.output)
            ? args.output
            : path.join(process.cwd(), args.output)
        : defaultOut;

    const launchOpts = {
        headless: !args.headed,
        slowMo: args.slowMo || undefined,
    };

    const contextOpts = {};
    if (args.storage && fs.existsSync(args.storage)) {
        contextOpts.storageState = args.storage;
    }

    const baseNormalized = normalizeBrowseBaseUrl(args.url);

    const report = {
        browseUrlInput: args.url,
        browseBaseUrl: baseNormalized,
        batchSize: args.batchSize,
        startedAt: new Date().toISOString(),
        browsePagination: [],
        pageTitleAfterBrowse: null,
        lotUrls: [],
        lots: [],
        errors: [],
    };

    const ctxFactory = () => ({
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1365, height: 900 },
        ...contextOpts,
    });

    let orderedLotUrls = [];
    let pageLog = [];

    {
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
            pageLog = r.pageLog;
        } finally {
            await discoverBrowser.close();
        }
    }

    report.browsePagination = pageLog;
    report.pageTitleAfterBrowse = pageLog[0]?.titleAfterNav ?? null;

    if (report.pageTitleAfterBrowse && /just a moment/i.test(report.pageTitleAfterBrowse)) {
        report.errors.push(
            'Page title looks like Cloudflare challenge. Re-run with --headed, complete the challenge, then use --save-storage and --storage on later runs.'
        );
        console.error(report.errors[report.errors.length - 1]);
    }

    report.allLotUrls = orderedLotUrls;
    const lotUrls = args.limit > 0 ? orderedLotUrls.slice(0, args.limit) : orderedLotUrls;
    report.lotUrls = lotUrls;

    if (lotUrls.length === 0) {
        report.errors.push(
            'No lot URLs matched heuristics. Try --headed, --debug-hrefs to inspect paths, or update looksLikeLotDetailUrl() for this site layout.'
        );
        console.error(report.errors[report.errors.length - 1]);
    }

    const chunks = chunkLotsForBatches(lotUrls, args.batchSize);
    let globalIndex = 0;

    for (let bi = 0; bi < chunks.length; bi++) {
        const chunk = chunks[bi];
        console.log(
            `[batch ${bi + 1}/${chunks.length}] ${chunk.length} lot URLs (global ${globalIndex + 1}–${globalIndex + chunk.length} of ${lotUrls.length}), fresh browser`
        );

        const browser = await chromium.launch(launchOpts);
        const context = await browser.newContext(ctxFactory());
        const page = await context.newPage();

        try {
            for (const lotUrl of chunk) {
                const i = globalIndex;
                globalIndex++;
                try {
                    await page.goto(lotUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    await sleep(800);
                    const { title, imageUrls } = await extractLotPhotos(page);
                    report.lots.push({
                        index: i + 1,
                        url: lotUrl,
                        title,
                        photoCount: imageUrls.length,
                        photoUrls: imageUrls.slice(0, 40),
                    });
                    console.log(`[${i + 1}/${lotUrls.length}] ${photoUrlsShort(title)} — ${imageUrls.length} images`);
                } catch (e) {
                    const msg = e.message || String(e);
                    report.lots.push({ index: i + 1, url: lotUrl, error: msg, photoCount: 0, photoUrls: [] });
                    console.error(`[${i + 1}/${lotUrls.length}] ERROR ${lotUrl}: ${msg}`);
                }
                await sleep(args.lotDelayMs);
            }

            if (args.saveStorage && bi === chunks.length - 1) {
                try {
                    await context.storageState({ path: args.saveStorage });
                    console.log('Saved storage state to', args.saveStorage);
                } catch (e) {
                    console.error('Failed to save storage:', e.message || e);
                }
            }
        } finally {
            await browser.close();
        }

        if (args.batchPauseMs > 0 && bi < chunks.length - 1) await sleep(args.batchPauseMs);
    }

    report.finishedAt = new Date().toISOString();

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
    console.log('Wrote', outPath);
}

function photoUrlsShort(title) {
    const t = (title || '').replace(/\s+/g, ' ').trim();
    return t.length > 72 ? t.slice(0, 69) + '...' : t || '(no title)';
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
