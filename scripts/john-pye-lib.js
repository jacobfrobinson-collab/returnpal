/**
 * Shared helpers for John Pye Playwright scripts (browse pagination, lot link harvest).
 */
'use strict';

const DEFAULT_BROWSE_URL = 'https://www.johnpyeauctions.co.uk/Browse/C302579983/PALLET';

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function normalizeBrowseBaseUrl(input) {
    const u = new URL(input);
    u.hash = '';
    u.searchParams.delete('page');
    return u.toString();
}

function buildBrowsePageUrl(baseNormalized, pageIndex) {
    const u = new URL(baseNormalized);
    if (pageIndex <= 0) {
        u.searchParams.delete('page');
        return u.toString();
    }
    u.searchParams.set('page', String(pageIndex));
    return u.toString();
}

function looksLikeLotDetailUrl(href, browseUrlObj) {
    let u;
    try {
        u = new URL(href, browseUrlObj.href);
    } catch {
        return false;
    }
    if (!/johnpyeauctions\.co\.uk$/i.test(u.hostname)) return false;

    const p = u.pathname.replace(/\/+$/, '') || '/';
    const browsePath = browseUrlObj.pathname.replace(/\/+$/, '') || '/';

    if (p.toLowerCase() === browsePath.toLowerCase()) return false;

    const lower = p.toLowerCase();
    if (lower.startsWith('/browse/c')) {
        const parts = lower.split('/').filter(Boolean);
        if (parts.length <= 3) return false;
    }

    if (lower === '/listing') return false;

    if (lower.includes('/event/lotdetails/')) return true;

    if (/(^|\/)lot(\/|$|_)/i.test(p)) return true;
    if (/(^|\/)item(\/|$)/i.test(p) && lower !== '/item') return true;
    if (/lotdetail|itemdetail|listingdetail/i.test(p)) return true;
    if (/\/[0-9]{7,}(\/|$)/.test(p) && !lower.startsWith('/browse/')) return true;

    return false;
}

async function scrollToLoadListings(page, rounds, pauseMs) {
    let stable = 0;
    let lastHeight = 0;
    for (let i = 0; i < rounds; i++) {
        const { scrollHeight, clientHeight } = await page.evaluate(() => ({
            scrollHeight: document.documentElement.scrollHeight,
            clientHeight: document.documentElement.clientHeight,
        }));
        await page.evaluate(() => window.scrollBy(0, Math.max(200, window.innerHeight * 0.85)));
        await sleep(pauseMs);
        const newHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        if (newHeight === lastHeight && scrollHeight <= clientHeight + 50) stable++;
        else stable = 0;
        lastHeight = newHeight;
        if (stable >= 4) break;
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
}

async function collectLotUrls(page, browseUrl, debugHrefs) {
    const browseUrlObj = new URL(browseUrl);
    const hrefs = await page.evaluate(() =>
        [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') || '')
    );
    const lotLineHrefs = await page.evaluate(() => {
        const out = [];
        const re = /#\s*Lot\s+\d+/i;
        for (const a of document.querySelectorAll('a[href]')) {
            const t = (a.textContent || '').replace(/\s+/g, ' ').trim();
            if (re.test(t)) out.push(a.getAttribute('href') || '');
        }
        return out;
    });
    const seen = new Set();
    const lots = [];
    const internalSample = new Set();

    for (const h of [...hrefs, ...lotLineHrefs]) {
        const abs = (() => {
            try {
                return new URL(h, browseUrlObj.href).href;
            } catch {
                return null;
            }
        })();
        if (!abs) continue;
        try {
            const u = new URL(abs);
            if (u.hostname.replace(/^www\./i, '') === 'johnpyeauctions.co.uk'.replace(/^www\./i, '')) {
                if (internalSample.size < 80) internalSample.add(u.pathname + u.search);
            }
        } catch {
            /* ignore */
        }
        if (!looksLikeLotDetailUrl(abs, browseUrlObj)) continue;
        if (seen.has(abs)) continue;
        seen.add(abs);
        lots.push(abs);
    }

    if (lots.length === 0 && debugHrefs) {
        console.error('[debug-hrefs] sample internal paths (first 60 unique):');
        console.error([...internalSample].slice(0, 60).join('\n'));
    }

    return lots;
}

/**
 * Prefer fullsize over thumbfit / thumb for the same lot image (John Pye uses lotimages.co.uk/.../N_M_suffix.jpg).
 * @param {string[]} urls
 */
function dedupeImageUrlsPreferFullsize(urls) {
    const rank = (u) => {
        const s = u.toLowerCase();
        if (s.includes('_fullsize')) return 100;
        if (s.includes('_large')) return 90;
        if (s.includes('thumbfit')) return 55;
        if (s.includes('_thumb')) return 45;
        return 60;
    };
    const keyFor = (u) =>
        u.replace(/_(fullsize|thumbfit|thumb|large|small)\.(jpe?g|webp|png)(\?.*)?$/i, '.$2$3');
    const best = new Map();
    const order = [];
    for (const url of urls) {
        const k = keyFor(url);
        if (!best.has(k)) order.push(k);
        const prev = best.get(k);
        if (!prev || rank(url) > rank(prev)) best.set(k, url);
    }
    return order.map((k) => best.get(k));
}

async function prepareLotPageForImageHarvest(page) {
    try {
        await page.waitForLoadState('load', { timeout: 45_000 });
    } catch {
        /* domcontentloaded-only navigations, etc. */
    }
    await sleep(500);
    try {
        await page.evaluate(() => {
            try {
                window.scrollTo(0, 400);
            } catch {
                /* */
            }
        });
    } catch {
        /* */
    }
    await sleep(600);
    try {
        await page.evaluate(() => {
            try {
                const h = document.scrollingElement ? document.scrollingElement.scrollHeight : 0;
                if (h > 0) {
                    window.scrollTo(0, Math.min(2500, Math.floor(h * 0.45)));
                }
            } catch {
                /* */
            }
        });
    } catch {
        /* */
    }
    await sleep(500);
}

async function extractLotPhotos(page) {
    await prepareLotPageForImageHarvest(page);
    const data = await page.evaluate(() => {
        const title = document.title || '';
        const out = new Set();
        const base = document.baseURI;
        const badSub = (s) =>
            /spinner|loading|placeholder|1x1|blank|grey-line|favicon|\/banner\/|gravatar|pixel\.gif/i.test(s);

        function toAbs(s) {
            if (!s) return null;
            const t = s.trim();
            if (!t || t.startsWith('data:') || t.startsWith('blob:')) return null;
            try {
                if (t.startsWith('//')) {
                    return new URL('https:' + t, base).href;
                }
                const u = new URL(t, base);
                if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
                return u.href;
            } catch {
                return null;
            }
        }

        for (const img of document.querySelectorAll('img')) {
            for (const a of [img.getAttribute('src'), img.getAttribute('data-src'), img.getAttribute('data-lazy-src')]) {
                const u = toAbs(a);
                if (u) out.add(u);
            }
            if (img.currentSrc) {
                const u = toAbs(img.currentSrc);
                if (u) out.add(u);
            }
            const sset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
            for (const chunk of sset.split(',')) {
                const p = (chunk || '').trim().split(/\s+/)[0];
                const u = toAbs(p);
                if (u) out.add(u);
            }
        }
        for (const src of document.querySelectorAll('source')) {
            const sset = src.getAttribute('srcset') || '';
            for (const chunk of sset.split(',')) {
                const p = (chunk || '').trim().split(/\s+/)[0];
                const u = toAbs(p);
                if (u) out.add(u);
            }
        }

        const nd = document.getElementById('__NEXT_DATA__');
        if (nd && nd.textContent && nd.textContent.length > 10) {
            const text = nd.textContent;
            const re =
                /https?:\/\/[^\s"'<>`]+?\.(?:jpe?g|png|gif|webp)(?:\?[^"'<>`\s]*)?/gi;
            let m;
            while ((m = re.exec(text)) && out.size < 200) {
                if (!badSub(m[0])) {
                    out.add(m[0]);
                }
            }
        }

        const imgs = [...out].filter((s) => !badSub(s));
        const ogTag = document.querySelector('meta[property="og:title"]');
        const ogT = (ogTag && ogTag.getAttribute('content')) || '';
        const h1el = document.querySelector('h1');
        const h1T = h1el ? (h1el.textContent || '') : '';
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const isGeneric = (s) => /^John Pye Auctions(\s*\||$)/i.test(s) || s === 'John Pye Auctions';
        const titlePick = [norm(ogT), norm(h1T), norm(title)].find((s) => s && !isGeneric(s)) || norm(title) || 'John Pye Auctions';
        return { title: titlePick, imageUrls: imgs };
    });
    data.imageUrls = dedupeImageUrlsPreferFullsize(data.imageUrls);
    data.imageUrls = sortImageUrlsOcrFirst(data.imageUrls);
    return data;
}

/**
 * For John Pye CDN (lotimages etc.), prefer the highest-res variant in sort order.
 * @param {string[]} urls
 */
function sortImageUrlsOcrFirst(urls) {
    if (!Array.isArray(urls) || !urls.length) {
        return urls;
    }
    const score = (u) => {
        const s = (u || '').toLowerCase();
        if (s.includes('_fullsize') || s.includes('fullsize')) {
            return 4;
        }
        if (s.includes('_large')) {
            return 3;
        }
        if (s.includes('thumbfit') || s.includes('thumb/')) {
            return 0;
        }
        if (s.includes('_thumb')) {
            return 0;
        }
        return 2;
    };
    return [...urls].sort((a, b) => score(b) - score(a));
}

/**
 * Try a full-size CDN URL if the page only had a thumb (better OCR on box text).
 * @param {string} u
 */
function preferJohnPyeFullSizeUrl(u) {
    if (!u || typeof u !== 'string') {
        return u;
    }
    if (!/lotimages\.|johnpye/i.test(u)) {
        return u;
    }
    if (/_thumbfit\./i.test(u)) {
        return u.replace(/_thumbfit\./i, '_fullsize.');
    }
    if (/_small\./i.test(u) && !/_fullsize\./i.test(u)) {
        return u.replace(/_small\./i, '_fullsize.');
    }
    return u;
}

/**
 * If set (0-based index, same as internal browse page p and buildBrowsePageUrl), only that page is loaded.
 * Otherwise --single-page uses index 0 only; otherwise full crawl up to maxBrowsePages.
 * @param {object} opts
 * @returns {number | null}
 */
function fixedSingleBrowsePageIndex(opts) {
    if (opts.onlyPageIndex != null) {
        const n = Number(opts.onlyPageIndex);
        if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    }
    if (opts.singlePage) return 0;
    return null;
}

async function collectLotUrlsAllBrowsePages(page, baseNormalized, opts) {
    const globalSeen = new Set();
    const orderedLotUrls = [];
    const pageLog = [];

    const fixedP = fixedSingleBrowsePageIndex(opts);
    const debugThisPage = (p) =>
        Boolean(opts.debugHrefs && (fixedP !== null ? p === fixedP : p === 0));

    async function harvestOneBrowsePage(p) {
        const browseUrl = buildBrowsePageUrl(baseNormalized, p);
        await page.goto(browseUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await sleep(2000);
        const titleAfterNav = await page.title();
        await scrollToLoadListings(page, opts.scrollRounds, opts.pauseMs);
        const found = await collectLotUrls(page, browseUrl, debugThisPage(p));
        const newUrls = [];
        for (const u of found) {
            if (globalSeen.has(u)) continue;
            globalSeen.add(u);
            orderedLotUrls.push(u);
            newUrls.push(u);
        }
        pageLog.push({
            pageIndex: p,
            browseUrl,
            titleAfterNav,
            lotsOnPage: found.length,
            newLotsThisPage: newUrls.length,
            cumulativeLots: orderedLotUrls.length,
        });
        console.log(
            `[browse page ${p}] ${browseUrl} — ${found.length} links on page, ${newUrls.length} new (total ${orderedLotUrls.length})`
        );
        return { foundLen: found.length, newLen: newUrls.length };
    }

    if (fixedP !== null) {
        await harvestOneBrowsePage(fixedP);
        return { orderedLotUrls, pageLog };
    }

    const maxP = Math.max(0, opts.maxBrowsePages - 1);
    for (let p = 0; p <= maxP; p++) {
        const { foundLen, newLen } = await harvestOneBrowsePage(p);
        if (p === 0 && foundLen === 0) break;
        if (p > 0 && newLen === 0) break;
        if (p < maxP) await sleep(opts.browseDelayMs);
    }

    return { orderedLotUrls, pageLog };
}

/**
 * Split lot URLs into consecutive batches (e.g. 100). If batchSize <= 0, returns a single chunk of all URLs.
 * @param {string[]} lotUrls
 * @param {number} batchSize
 * @returns {string[][]}
 */
function chunkLotsForBatches(lotUrls, batchSize) {
    if (!Array.isArray(lotUrls) || lotUrls.length === 0) return [];
    const n = Number(batchSize);
    if (!Number.isFinite(n) || n <= 0) return [lotUrls.slice()];
    const out = [];
    for (let i = 0; i < lotUrls.length; i += n) {
        out.push(lotUrls.slice(i, i + n));
    }
    return out;
}

module.exports = {
    DEFAULT_BROWSE_URL,
    sleep,
    normalizeBrowseBaseUrl,
    sortImageUrlsOcrFirst,
    preferJohnPyeFullSizeUrl,
    buildBrowsePageUrl,
    looksLikeLotDetailUrl,
    scrollToLoadListings,
    collectLotUrls,
    extractLotPhotos,
    dedupeImageUrlsPreferFullsize,
    collectLotUrlsAllBrowsePages,
    chunkLotsForBatches,
};
