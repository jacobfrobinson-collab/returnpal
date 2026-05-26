/**
 * eBay UK — sold (completed) listing search page: extract GBP prices (median/min/max) for a query.
 * No official API: uses the same Playwright page as the caller (separate tab recommended).
 * Estimates only. Be polite: delay between requests (JOHN_PYE_EBAY_DELAY_MS). Site layout may change.
 */
'use strict';

const DEFAULT_DELAY_MS = 2200;
const DEFAULT_FALLBACK_MS = 650;
const MAX_RESULTS = 30;

const PRINTER_BRAND_WORDS = new Set([
    'canon',
    'hp',
    'hewlett',
    'epson',
    'brother',
    'lexmark',
    'samsung',
    'dell',
    'ricoh',
    'xerox',
    'kyocera',
    'kodak',
    'olivetti',
    'okidata',
    'oki',
    'minolta',
    'panasonic',
]);

/**
 * @param {string} s
 * @returns {number | null}
 */
function parseOneGbpNumber(s) {
    if (s == null) {
        return null;
    }
    const t = String(s).replace(/\s+/g, ' ').replace(/\u00a0/g, ' ').trim();
    const m = t.match(/£\s*([0-9,]+(?:\.[0-9]{1,2})?)/);
    if (!m) {
        return null;
    }
    const n = parseFloat(m[1].replace(/,/g, ''), 10);
    return Number.isFinite(n) && n > 0 && n < 2_000_000 ? n : null;
}

function medianOf(nums) {
    if (!nums.length) {
        return null;
    }
    const a = [...nums].sort((x, y) => x - y);
    const m = (a.length - 1) >> 1;
    if (a.length % 2 === 0) {
        return (a[m] + a[m + 1]) / 2;
    }
    return a[m];
}

/**
 * @param {import('playwright').Page} page
 */
async function tryAcceptCookies(page) {
    const sels = [
        '#gdpr-banner-accept',
        'button#gdpr-accept',
        '#cc-banner-accept',
        'button[id^="onetrust-"]',
    ];
    for (const s of sels) {
        try {
            const el = await page.$(s);
            if (el) {
                await el.click().catch(() => {});
                await page.waitForTimeout(400);
                return;
            }
        } catch {
            /* */
        }
    }
}

/**
 * @param {import('playwright').Page} page
 * @param {string} searchQuery
 * @param {{ maxListings?: number, timeoutMs?: number }} [opts]
 */
async function fetchEbayUkSoldPricesGbp(page, searchQuery, opts = {}) {
    const maxL = Math.min(
        MAX_RESULTS,
        Math.max(5, Math.floor(opts.maxListings) || 24),
    );
    const timeoutMs = opts.timeoutMs == null ? 32_000 : Math.max(5_000, Math.floor(opts.timeoutMs));

    const u = new URL('https://www.ebay.co.uk/sch/i.html');
    u.searchParams.set('_nkw', searchQuery);
    u.searchParams.set('LH_Sold', '1');
    u.searchParams.set('LH_Complete', '1');
    u.searchParams.set('_dmd', '1');
    u.searchParams.set('_sop', '10');

    const out = { searchQuery, prices: [], minGbp: null, maxGbp: null, medianGbp: null, count: 0, listUrl: u.href, error: null };

    let nav;
    try {
        nav = await page.goto(u.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } catch (e) {
        out.error = e && e.message ? String(e.message) : 'navigation failed';
        return out;
    }
    if (nav && (nav.status() === 404 || nav.status() >= 500)) {
        out.error = 'HTTP ' + (nav && nav.status());
        return out;
    }

    await tryAcceptCookies(page);
    const bodyT = (await page.innerText('body').catch(() => '')) || '';
    if (/\b(captcha|robot|verify you are human|access denied|looking for something)/i.test(bodyT)) {
        out.error = 'blocked or captcha';
        return out;
    }

    await page.waitForTimeout(600);

    const { prices, raw } = await page
        .evaluate(
            (max) => {
                const takeFirstGbp = (text) => {
                    if (!text) {
                        return null;
                    }
                    const m = String(text)
                        .replace(/\s+/g, ' ')
                        .match(/£\s*([0-9,]+(?:\.[0-9]{1,2})?)/);
                    if (!m) {
                        return null;
                    }
                    const n = parseFloat(m[1].replace(/,/g, ''), 10);
                    return Number.isFinite(n) && n > 0 ? n : null;
                };
                const items = document.querySelectorAll('ul.srp-results li.s-item, .srp-river-results li.s-item, li.s-item');
                const p = [];
                for (const li of items) {
                    if (p.length >= max) {
                        break;
                    }
                    const cl = (li.className || '') + ' ' + (li.getAttribute('class') || '');
                    if (
                        /s-item--message|s-item--level|s-item--deals|s-item--watch|s-item--header|s-item--store-header|s-item--loading/i.test(
                            cl,
                        )
                    ) {
                        continue;
                    }
                    const priceEls = li.querySelectorAll('.s-item__price, [class*="s-item__price"]');
                    let g = null;
                    for (const pe of priceEls) {
                        g = takeFirstGbp((pe && pe.textContent) || '');
                        if (g != null) {
                            break;
                        }
                    }
                    if (g == null) {
                        g = takeFirstGbp((li.textContent || '').slice(0, 500));
                    }
                    if (g != null) {
                        p.push(g);
                    }
                }
                return { prices: p, raw: items ? items.length : 0 };
            },
            maxL,
        )
        .catch(() => ({ prices: [], raw: 0 }));

    out.count = prices ? prices.length : 0;
    if (!prices || !prices.length) {
        if (/no (exact )?matches? found|0 result|doesn't seem to be anything matching/i.test(bodyT)) {
            out.error = 'no sold results';
        } else if (!raw) {
            out.error = 'no s-item (layout may have changed)';
        } else {
            out.error = 'no price parsed';
        }
        return out;
    }

    const sorted = [...prices].sort((a, b) => a - b);
    out.minGbp = sorted[0];
    out.maxGbp = sorted[sorted.length - 1];
    out.medianGbp = medianOf(sorted);
    out.prices = sorted;
    return out;
}

/**
 * @param {string} t
 */
function isModelLikeToken(t) {
    if (!t) {
        return false;
    }
    const s = String(t);
    if (/^[\d.,\sx\-]+$/i.test(s) && /^\d+[\d.,\sx\-]*$/.test(s)) {
        return true;
    }
    if (/\b\d{3,5}\b/.test(s) && s.length < 20) {
        return true;
    }
    if (/^[A-Za-z]{0,4}\d{3,}[A-Za-z0-9()\-+]*$/i.test(s) && s.length < 32) {
        return true;
    }
    if (/^series$/i.test(s) && s.length < 8) {
        return false;
    }
    if (/[a-zA-Z]/.test(s) && /\d/.test(s) && s.length < 20 && s.split(/[\s\-+/_]/).length === 1) {
        return true;
    }
    return false;
}

/**
 * Wider eBay search strings when a model-specific search returns no sold data.
 * Order: most specific first, then product line, then *brand* + printer.
 * @param {string} q
 * @returns {string[]}
 */
function buildEbayQueryFallbacks(q) {
    const out = [];
    const seen = new Set();
    const add = (s) => {
        const t = String(s || '')
            .replace(/\s+/g, ' ')
            .replace(/^\s*-\s*|\s*-\s*$/g, '')
            .trim();
        if (t.length < 2) {
            return;
        }
        const k = t.toLowerCase();
        if (seen.has(k)) {
            return;
        }
        seen.add(k);
        out.push(t);
    };
    const base = String(q || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!base) {
        return [];
    }
    add(base);
    add(base.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim());
    const words = base
        .replace(/\([^)]*\)/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
    let w = words.slice();
    for (let guard = 0; guard < 4 && w.length > 0; guard++) {
        if (!isModelLikeToken(w[w.length - 1]) || w.length < 2) {
            break;
        }
        w = w.slice(0, -1);
        if (w.length) {
            add(w.join(' '));
        }
    }
    if (words.length >= 3) {
        const two = words.slice(0, 2).join(' ');
        if (two.length >= 4) {
            add(two);
        }
    }
    const f0 = (words[0] || '').toLowerCase();
    if (f0 && PRINTER_BRAND_WORDS.has(f0)) {
        if (words.length >= 2 && !/\b(printer|inkjet|laser)\b/i.test(base)) {
            add(`${words[0]} ${words[1]} printer`);
        }
        if (f0 === 'hp') {
            add('HP printer');
        } else {
            const cap = words[0].charAt(0).toUpperCase() + words[0].slice(1);
            add(`${cap} printer`);
        }
    }
    return out.slice(0, 8);
}

/**
 * @param {import('playwright').Page} page
 * @param {string} primaryQuery
 * @param {{ maxListings?: number, timeoutMs?: number, fallbackDelayMs?: number }} [opts]
 */
async function fetchEbayUkSoldPricesGbpWithFallbacks(page, primaryQuery, opts) {
    const o = opts || {};
    const minC = (() => {
        const n = parseInt(String(process.env.JOHN_PYE_EBAY_MIN_SOLD || '1').trim(), 10);
        return Number.isFinite(n) && n >= 1 && n <= 50 ? n : 1;
    })();
    const fb =
        o.fallbackDelayMs != null
            ? Math.max(0, Math.floor(o.fallbackDelayMs))
            : (() => {
                  const n = parseInt(
                      String(process.env.JOHN_PYE_EBAY_FALLBACK_DELAY_MS || String(DEFAULT_FALLBACK_MS)).trim(),
                      10,
                  );
                  return Number.isFinite(n) && n >= 0 && n < 30_000 ? n : DEFAULT_FALLBACK_MS;
              })();
    const chain = buildEbayQueryFallbacks(primaryQuery);
    if (!chain.length) {
        const r = {
            count: 0,
            minGbp: null,
            maxGbp: null,
            medianGbp: null,
            prices: [],
            error: 'empty query',
            listUrl: '',
        };
        return { result: r, usedQuery: String(primaryQuery || ''), primaryQuery, fromFallback: false, attempts: [] };
    }
    const attempts = [];
    let lastR = null;
    for (let j = 0; j < chain.length; j++) {
        if (j > 0) {
            // eslint-disable-next-line no-await-in-loop
            await page.waitForTimeout(fb);
        }
        const qq = chain[j];
        // eslint-disable-next-line no-await-in-loop
        const r = await fetchEbayUkSoldPricesGbp(page, qq, o);
        attempts.push({ query: qq, count: r.count, median: r.medianGbp, error: r.error });
        lastR = r;
        if (r.medianGbp != null && r.medianGbp > 0 && r.count >= minC) {
            return { result: r, usedQuery: qq, primaryQuery, fromFallback: j > 0, attempts };
        }
    }
    return {
        result: lastR,
        usedQuery: chain[chain.length - 1],
        primaryQuery,
        fromFallback: chain.length > 1,
        attempts,
        exhausted: true,
    };
}

/**
 * @param {import('playwright').Page} page
 * @param {string[]} searchQueries
 * @param {{ delayMs?: number, onQuery?: (i: number, n: number, q: string) => void, maxListingsPerQuery?: number, timeoutPerQuery?: number }} [opts]
 * @returns {Promise<Map<string, Awaited<ReturnType<typeof fetchEbayUkSoldPricesGbp>>>}
 */
async function fetchEbayUkCompsByQueries(page, searchQueries, opts = {}) {
    const delayMs = Math.max(0, Math.floor(opts.delayMs) || defaultDelayMs());
    const map = new Map();
    const qs = Array.from(
        new Set(
            (searchQueries || [])
                .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
                .filter((s) => s.length > 1),
        ),
    );
    let i = 0;
    for (const q of qs) {
        if (i > 0) {
            await page.waitForTimeout(delayMs);
        }
        if (typeof opts.onQuery === 'function') {
            try {
                opts.onQuery(i, qs.length, q);
            } catch {
                /* */
            }
        }
        // eslint-disable-next-line no-await-in-loop
        const r = await fetchEbayUkSoldPricesGbp(page, q, {
            maxListings: opts.maxListingsPerQuery,
            timeoutMs: opts.timeoutPerQuery,
        });
        map.set(q, r);
        i++;
    }
    return map;
}

function defaultDelayMs() {
    const n = parseInt(process.env.JOHN_PYE_EBAY_DELAY_MS || String(DEFAULT_DELAY_MS), 10);
    return Number.isFinite(n) && n >= 0 && n < 60_000 ? n : DEFAULT_DELAY_MS;
}

function defaultFallbackDelayMs() {
    const n = parseInt(process.env.JOHN_PYE_EBAY_FALLBACK_DELAY_MS || String(DEFAULT_FALLBACK_MS), 10);
    return Number.isFinite(n) && n >= 0 && n < 30_000 ? n : DEFAULT_FALLBACK_MS;
}

module.exports = {
    parseOneGbpNumber,
    buildEbayQueryFallbacks,
    fetchEbayUkSoldPricesGbp,
    fetchEbayUkSoldPricesGbpWithFallbacks,
    fetchEbayUkCompsByQueries,
    medianOf,
    defaultDelayMs,
    defaultFallbackDelayMs,
    MAX_RESULTS,
};
