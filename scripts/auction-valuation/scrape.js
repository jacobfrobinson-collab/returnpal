/**
 * Generic lot page scrape via Playwright (heuristic).
 * Respect each site's Terms of Service and robots.txt; for personal research only.
 */
'use strict';

const DEFAULT_NAV_TIMEOUT_MS = 45000;
const DEFAULT_MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 1_500_000;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function toAbsoluteUrl(base, href) {
    if (!href || typeof href !== 'string') return null;
    const t = href.trim();
    if (!t || t.startsWith('data:') || t.startsWith('javascript:')) return null;
    try {
        return new URL(t, base).href;
    } catch {
        return null;
    }
}

function scoreImageUrl(u) {
    if (!u) return -1;
    const lower = u.toLowerCase();
    let score = 0;
    if (lower.includes('logo')) score -= 50;
    if (lower.includes('icon')) score -= 40;
    if (lower.includes('avatar')) score -= 40;
    if (lower.includes('sprite')) score -= 30;
    if (lower.includes('placeholder')) score -= 30;
    if (/\.(jpe?g|png|webp)(\?|$)/i.test(lower)) score += 20;
    if (lower.includes('thumb')) score -= 10;
    if (lower.includes('large') || lower.includes('full') || lower.includes('zoom')) score += 15;
    return score;
}

/**
 * Collect title, meta description, and candidate image URLs from the loaded page.
 * @param {import('playwright').Page} page
 * @param {string} lotUrl
 * @param {{ maxImages?: number }} [opts]
 */
async function collectFromDom(page, lotUrl, opts = {}) {
    const maxImages = opts.maxImages ?? DEFAULT_MAX_IMAGES;
    const data = await page.evaluate((base) => {
        const title = document.title || '';
        const ogDesc =
            document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
            document.querySelector('meta[name="description"]')?.getAttribute('content') ||
            '';
        const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
        const twImage =
            document.querySelector('meta[name="twitter:image"]')?.getAttribute('content') ||
            document.querySelector('meta[name="twitter:image:src"]')?.getAttribute('content') ||
            '';

        const imgs = Array.from(document.querySelectorAll('img[src]'))
            .map((img) => ({
                src: img.getAttribute('src') || '',
                w: img.naturalWidth || img.width || 0,
                h: img.naturalHeight || img.height || 0,
            }))
            .filter((x) => x.src && !x.src.startsWith('data:'));

        return { title, ogDesc, ogImage, twImage, imgs, base };
    }, lotUrl);

    const seen = new Set();
    const candidates = [];

    const push = (href) => {
        const abs = toAbsoluteUrl(lotUrl, href);
        if (!abs || seen.has(abs)) return;
        seen.add(abs);
        candidates.push(abs);
    };

    push(data.ogImage);
    push(data.twImage);
    const sortedImgs = [...data.imgs].sort((a, b) => b.w * b.h - a.w * a.h);
    for (const { src } of sortedImgs) push(src);

    candidates.sort((a, b) => scoreImageUrl(b) - scoreImageUrl(a));
    return {
        title: (data.title || '').trim(),
        metaDescription: (data.ogDesc || '').trim(),
        imageUrls: candidates.slice(0, maxImages),
    };
}

/**
 * Fetch image bytes using the browser context (cookies/referrer). Returns base64 or null.
 * @param {import('playwright').APIRequestContext} request
 * @param {string} imageUrl
 * @param {string} referer
 */
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

/**
 * @param {import('playwright').Browser} browser
 * @param {string} lotUrl
 * @param {{ headed?: boolean, slowMo?: number, navTimeoutMs?: number, retries?: number, maxImages?: number }} opts
 */
async function scrapeLotPage(browser, lotUrl, opts = {}) {
    const navTimeoutMs = opts.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
    const retries = Math.max(0, Math.min(5, opts.retries ?? 2));
    let lastErr = null;
    const context = await browser.newContext({
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    try {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                await page.goto(lotUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: navTimeoutMs,
                });
                await sleep(800);
                const dom = await collectFromDom(page, lotUrl, { maxImages: opts.maxImages ?? DEFAULT_MAX_IMAGES });
                const request = context.request;
                const imagesForLlm = [];
                const topUrls = dom.imageUrls.slice(0, 3);
                for (const imgUrl of topUrls) {
                    const fetched = await fetchImageBase64(request, imgUrl, lotUrl);
                    if (fetched) {
                        imagesForLlm.push({
                            url: imgUrl,
                            mimeType: fetched.mimeType,
                            base64: fetched.base64,
                        });
                    }
                }
                return {
                    url: lotUrl,
                    title: dom.title,
                    metaDescription: dom.metaDescription,
                    imageUrls: dom.imageUrls,
                    imagesForLlm,
                };
            } catch (e) {
                lastErr = e;
                if (attempt < retries) await sleep(500 * (attempt + 1));
            }
        }
        throw lastErr || new Error('scrape failed');
    } finally {
        await context.close();
    }
}

module.exports = {
    scrapeLotPage,
    collectFromDom,
    fetchImageBase64,
    toAbsoluteUrl,
    DEFAULT_NAV_TIMEOUT_MS,
    MAX_IMAGE_BYTES,
};
