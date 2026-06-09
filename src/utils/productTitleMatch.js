'use strict';

/** @param {string} s */
function normalizeProductKey(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** @param {string} s */
function productTokens(s) {
    return normalizeProductKey(s)
        .split(' ')
        .filter((w) => w.length > 1);
}

/**
 * @returns {number} 0 = no match, 100 = exact
 */
function productMatchScore(a, b) {
    const key = normalizeProductKey(a);
    const pk = normalizeProductKey(b);
    if (!key || !pk || key.length < 10) return 0;
    if (pk === key) return 100;
    if (key.length >= 18 && pk.length >= 18) {
        if (pk.includes(key) || key.includes(pk)) return 60;
    }
    const rt = productTokens(a);
    const st = productTokens(b);
    if (rt.length < 4 || st.length < 4) return 0;
    const [shorter, longer] = rt.length <= st.length ? [rt, st] : [st, rt];
    const longerSet = new Set(longer);
    let hit = 0;
    for (const w of shorter) {
        if (longerSet.has(w)) hit++;
    }
    if (hit / shorter.length >= 0.8) return 60;
    return 0;
}

function isGenericProductTitle(product) {
    return productTokens(product).length < 4;
}

module.exports = {
    normalizeProductKey,
    productTokens,
    productMatchScore,
    isGenericProductTitle,
};
