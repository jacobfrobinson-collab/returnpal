'use strict';

/** Never treat as client codes (region / listing noise). */
const TWO_LETTER_BLACKLIST = new Set(['OS', 'EU']);

/** Other 2-letter tokens that appear in SKUs but are not clients. */
const TWO_LETTER_SKU_NOISE = new Set(['NEW', 'USED', 'UK', 'US']);

/**
 * Canonical numbered client id (PPF001, FTF032).
 * @param {'PPF'|'FTF'} prefix
 * @param {string|number} num
 */
function formatNumberedClientId(prefix, num) {
    const n = parseInt(String(num), 10);
    if (!Number.isFinite(n) || n < 0) return prefix;
    return prefix + String(n).padStart(3, '0');
}

/** @param {string|number} num */
function formatPpfClientId(num) {
    return formatNumberedClientId('PPF', num);
}

/** @param {string|number} num */
function formatFtfClientId(num) {
    return formatNumberedClientId('FTF', num);
}

/**
 * Normalize a single client token (AI, PPF032, ppf-32, FTF).
 * @param {string} raw
 */
function canonicalizeClientIdCandidate(raw) {
    const s = String(raw || '')
        .trim()
        .toUpperCase();
    if (!s) return '';

    const ppfNum = s.match(/^PPF[-\s]?0*(\d{1,5})$/);
    if (ppfNum) return formatPpfClientId(ppfNum[1]);
    if (s === 'PPF') return 'PPF';

    const ftfNum = s.match(/^FTF[-\s]?0*(\d{1,5})$/);
    if (ftfNum) return formatFtfClientId(ftfNum[1]);
    if (s === 'FTF') return 'FTF';

    const ppfTight = s.match(/^PPF(\d{1,5})$/);
    if (ppfTight) return formatPpfClientId(ppfTight[1]);

    const ftfTight = s.match(/^FTF(\d{1,5})$/);
    if (ftfTight) return formatFtfClientId(ftfTight[1]);

    if (/^[A-Z]{2}$/.test(s) && !TWO_LETTER_BLACKLIST.has(s) && !TWO_LETTER_SKU_NOISE.has(s)) {
        return s;
    }

    return '';
}

/**
 * Normalize an existing Client ID field (ppf-32 → PPF032, ai → AI).
 * @param {string} spec
 */
function normalizeClientIdSpecifier(spec) {
    const s = String(spec || '').trim();
    if (!s) return '';
    const canon = canonicalizeClientIdCandidate(s);
    if (canon) return canon;
    return s;
}

/**
 * Last meaningful 2-letter client code in text (excludes OS, EU, NEW, etc.).
 * @param {string} s
 */
function extractTwoLetterClientIdFromText(s) {
    const upper = String(s || '').toUpperCase();
    const tokens = upper.match(/\b[A-Z]{2}\b/g) || [];
    const filtered = tokens.filter(
        (t) => !TWO_LETTER_BLACKLIST.has(t) && !TWO_LETTER_SKU_NOISE.has(t)
    );
    if (!filtered.length) return '';
    return filtered[filtered.length - 1];
}

/**
 * Detect legacy client id from SKU / custom label / title text.
 * @param {string} text
 */
function extractLegacyClientIdFromText(text) {
    const s = String(text || '');
    if (!s.trim()) return '';

    const ppf = s.match(/PPF[-\s]?0*(\d{1,5})/i);
    if (ppf) return formatPpfClientId(ppf[1]);

    const du = s.match(/DU\d+-\d+(?:New)?PPF[-\s]?0*(\d{1,5})/i);
    if (du) return formatPpfClientId(du[1]);

    const ftf = s.match(/FTF[-\s]?0*(\d{1,5})/i);
    if (ftf) return formatFtfClientId(ftf[1]);

    const ppfTight = s.match(/\b(PPF\d{1,5})\b/i);
    if (ppfTight) {
        const inner = ppfTight[1].match(/PPF0*(\d{1,5})/i);
        if (inner) return formatPpfClientId(inner[1]);
    }

    const ftfTight = s.match(/\b(FTF\d{1,5})\b/i);
    if (ftfTight) {
        const inner = ftfTight[1].match(/FTF0*(\d{1,5})/i);
        if (inner) return formatFtfClientId(inner[1]);
    }

    if (/\bPPF\b/i.test(s) && !/\d/.test(s)) return 'PPF';
    if (/\bFTF\b/i.test(s) && !/\d/.test(s)) return 'FTF';

    const tagged = s.match(/\b(?:NewOther|New|USED|Used|Shelf)\s+([A-Za-z]{2,6})\b/i);
    if (tagged) {
        const fromTag = canonicalizeClientIdCandidate(tagged[1]);
        if (fromTag) return fromTag;
    }

    const beforeNew = [...s.toUpperCase().matchAll(/([A-Z]{2})(?=NEW\b)/g)].map((m) => m[1]);
    for (let i = beforeNew.length - 1; i >= 0; i--) {
        const code = canonicalizeClientIdCandidate(beforeNew[i]);
        if (code && code.length === 2) return code;
    }

    return extractTwoLetterClientIdFromText(s);
}

/**
 * @param {{ custom_label?: string, product?: string, notes?: string, client_id?: string }} row
 */
function rowSkuHaystack(row) {
    return [row.custom_label, row.product, row.notes, row.client_id]
        .filter(Boolean)
        .join(' ');
}

/**
 * Case-insensitive substring match for bulk rules.
 * @param {string} haystack
 * @param {string} needle
 */
function textIncludesInsensitive(haystack, needle) {
    const n = String(needle || '').trim();
    if (!n) return false;
    return String(haystack || '')
        .toLowerCase()
        .includes(n.toLowerCase());
}

/**
 * Bulk "contains" — substring match, or same detected legacy id (PPF032 ↔ PPF-032, AI ↔ ai).
 * @param {string} haystack
 * @param {string} needle
 */
function textMatchesBulkContains(haystack, needle) {
    if (textIncludesInsensitive(haystack, needle)) return true;
    const want = extractLegacyClientIdFromText(needle) || canonicalizeClientIdCandidate(needle);
    if (!want) return false;
    const got = extractLegacyClientIdFromText(haystack);
    return !!got && got === want;
}

/**
 * Pick Client ID value for bulk-set (normalize PPF/FTF/2-letter variants).
 * @param {string} raw
 */
function bulkSetClientIdValue(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    const fromText = extractLegacyClientIdFromText(s);
    if (fromText) return fromText;
    return normalizeClientIdSpecifier(s);
}

module.exports = {
    formatPpfClientId,
    formatFtfClientId,
    formatNumberedClientId,
    canonicalizeClientIdCandidate,
    normalizeClientIdSpecifier,
    extractLegacyClientIdFromText,
    extractTwoLetterClientIdFromText,
    rowSkuHaystack,
    textIncludesInsensitive,
    textMatchesBulkContains,
    bulkSetClientIdValue,
    TWO_LETTER_BLACKLIST,
};
