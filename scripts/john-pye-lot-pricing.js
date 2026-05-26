/**
 * Extract hammer / current bid (GBP) from John Pye lot detail pages.
 * Uses structured DOM first, then __NEXT_DATA__, then body regex (lowest priority).
 */
'use strict';

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<{ hammerGbp: number|null, pricingSources: string[] }>}
 */
async function extractLotHammerGbp(page) {
    return page.evaluate(() => {
        const pricingSources = [];
        let best = { v: null, pri: -1 };

        function consider(n, pri, src) {
            if (n == null || Number.isNaN(n)) return;
            if (n < 0 || n > 5_000_000) return;
            if (pri > best.pri) {
                best = { v: n, pri };
                pricingSources.length = 0;
                pricingSources.push(src);
            }
        }

        function parseMoney(str) {
            if (!str) return null;
            const s = String(str);
            let m = s.match(/£\s*([\d,]+(?:\.\d{1,2})?)/);
            if (m) return parseFloat(m[1].replace(/,/g, ''));
            m = s.match(/([\d,]+(?:\.\d{1,2})?)\s*£/);
            if (m) return parseFloat(m[1].replace(/,/g, ''));
            return null;
        }

        for (const tr of document.querySelectorAll('tr')) {
            const cells = [...tr.querySelectorAll('th,td')].map((td) =>
                (td.textContent || '').replace(/\s+/g, ' ').trim()
            );
            if (cells.length < 2) continue;
            const label = cells[0].replace(/:+$/, '').toLowerCase();
            if (
                !/\b(current bid|sold for|sold price|hammer|winning bid|final bid|high bid|realised)\b/i.test(
                    label
                )
            ) {
                continue;
            }
            const v = parseMoney(cells[1]);
            if (v != null) consider(v, 100, `tr:${label.slice(0, 40)}`);
        }

        for (const dt of document.querySelectorAll('dt')) {
            const label = (dt.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!/\b(current bid|sold|hammer|winning|final|realised)\b/i.test(label)) continue;
            let sib = dt.nextElementSibling;
            while (sib && sib.tagName !== 'DD') sib = sib.nextElementSibling;
            if (sib) {
                const v = parseMoney(sib.textContent || '');
                if (v != null) consider(v, 95, `dl:${label.slice(0, 40)}`);
            }
        }

        for (const el of document.querySelectorAll('[class*="bid" i], [class*="Bid"], [class*="price" i]')) {
            const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!/£/.test(t)) continue;
            if (label && /\b(bid|sold|hammer|price)\b/i.test(label)) {
                const v = parseMoney(t);
                if (v != null) consider(v, 85, `attr:${(label || t).slice(0, 50)}`);
            }
        }

        const nd = document.getElementById('__NEXT_DATA__');
        if (nd && nd.textContent) {
            try {
                const j = JSON.parse(nd.textContent);
                let steps = 0;
                function walk(obj, path) {
                    if (steps++ > 8000 || obj == null) return;
                    if (typeof obj === 'number' && obj >= 0 && obj < 1e7) {
                        const pk = path.toLowerCase();
                        const bidKeys = [
                            'currentbid',
                            'soldprice',
                            'winningbid',
                            'hammerprice',
                            'finalprice',
                            'highbid',
                            'leadingbid',
                            'lotprice',
                            'saleprice',
                            'bidamount',
                            'realisedprice',
                            'hammer',
                        ];
                        const hitKey = bidKeys.find(
                            (k) =>
                                pk.includes(`.${k}`) ||
                                pk.includes(`_${k}`) ||
                                pk.endsWith(k) ||
                                pk.includes(`['${k}']`) ||
                                pk.includes(`["${k}"]`)
                        );
                        if (hitKey) consider(obj, 80, `next:${path.slice(0, 100)}`);
                        return;
                    }
                    if (typeof obj !== 'object') return;
                    if (Array.isArray(obj)) {
                        for (let i = 0; i < Math.min(obj.length, 120); i++) walk(obj[i], `${path}[${i}]`);
                    } else {
                        for (const k of Object.keys(obj)) {
                            walk(obj[k], `${path}.${k}`);
                        }
                    }
                }
                walk(j, '$');
            } catch {
                /* ignore */
            }
        }

        const body = document.body ? document.body.innerText : '';
        const pats = [
            { re: /current\s+bid[^\d£]*£\s*([\d,]+\.?\d*)/i, pri: 55 },
            { re: /winning\s+bid[^\d£]*£\s*([\d,]+\.?\d*)/i, pri: 55 },
            { re: /sold\s+(?:for|at|price)?[^\d£]*£\s*([\d,]+\.?\d*)/i, pri: 54 },
            { re: /hammer(?:\s+price)?[^\d£]*£\s*([\d,]+\.?\d*)/i, pri: 54 },
            { re: /final\s+bid[^\d£]*£\s*([\d,]+\.?\d*)/i, pri: 53 },
            { re: /realised(?:\s+price)?[^\d£]*£\s*([\d,]+\.?\d*)/i, pri: 53 },
            { re: /£\s*([\d,]+\.?\d*)[^\n]{0,60}(?:sold|hammer|final\s+bid|winning)/i, pri: 30 },
        ];
        for (const { re, pri } of pats) {
            const m = body.match(re);
            if (m) consider(parseFloat(m[1].replace(/,/g, '')), pri, 'body-regex');
        }

        return { hammerGbp: best.v, pricingSources };
    });
}

/**
 * @param {number|null} hammerGbp
 * @param {{ premiumPercent: number, vatPercent: number, deliveryGbp: number }} fees
 */
function computeBuyerCostsGbp(hammerGbp, fees) {
    if (hammerGbp == null || Number.isNaN(Number(hammerGbp))) {
        return {
            buyersPremiumGbp: null,
            vatGbp: null,
            deliveryGbp: fees.deliveryGbp,
            totalCostGbp: null,
        };
    }
    const hammer = Number(hammerGbp);
    const premium = hammer * (fees.premiumPercent / 100);
    const subtotal = hammer + premium;
    const vat = subtotal * (fees.vatPercent / 100);
    const delivery = Number(fees.deliveryGbp) || 0;
    const total = subtotal + vat + delivery;
    return {
        buyersPremiumGbp: Math.round(premium * 100) / 100,
        vatGbp: Math.round(vat * 100) / 100,
        deliveryGbp: Math.round(delivery * 100) / 100,
        totalCostGbp: Math.round(total * 100) / 100,
    };
}

function profitAfterCostsGbp(resaleMid, totalCostGbp) {
    if (resaleMid == null || totalCostGbp == null) return null;
    return Math.round((Number(resaleMid) - Number(totalCostGbp)) * 100) / 100;
}

module.exports = {
    extractLotHammerGbp,
    computeBuyerCostsGbp,
    profitAfterCostsGbp,
};
