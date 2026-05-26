/**
 * eBay refund review helpers (SKU → Client ID). Keep in sync with src/utils/ebayRefundSkuClient.js
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.EbayRefundReview = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    var TWO_LETTER_BLACKLIST = { OS: true, EU: true };
    var TWO_LETTER_SKU_NOISE = { NEW: true, USED: true, UK: true, US: true };

    function formatNumberedClientId(prefix, num) {
        var n = parseInt(String(num), 10);
        if (!isFinite(n) || n < 0) return prefix;
        return prefix + String(n).padStart(3, '0');
    }

    function formatPpfClientId(num) {
        return formatNumberedClientId('PPF', num);
    }

    function formatFtfClientId(num) {
        return formatNumberedClientId('FTF', num);
    }

    function canonicalizeClientIdCandidate(raw) {
        var s = String(raw || '')
            .trim()
            .toUpperCase();
        if (!s) return '';

        var ppfNum = s.match(/^PPF[-\s]?0*(\d{1,5})$/);
        if (ppfNum) return formatPpfClientId(ppfNum[1]);
        if (s === 'PPF') return 'PPF';

        var ftfNum = s.match(/^FTF[-\s]?0*(\d{1,5})$/);
        if (ftfNum) return formatFtfClientId(ftfNum[1]);
        if (s === 'FTF') return 'FTF';

        var ppfTight = s.match(/^PPF(\d{1,5})$/);
        if (ppfTight) return formatPpfClientId(ppfTight[1]);

        var ftfTight = s.match(/^FTF(\d{1,5})$/);
        if (ftfTight) return formatFtfClientId(ftfTight[1]);

        if (/^[A-Z]{2}$/.test(s) && !TWO_LETTER_BLACKLIST[s] && !TWO_LETTER_SKU_NOISE[s]) return s;

        return '';
    }

    function normalizeClientIdSpecifier(spec) {
        var s = String(spec || '').trim();
        if (!s) return '';
        var canon = canonicalizeClientIdCandidate(s);
        if (canon) return canon;
        return s;
    }

    function extractTwoLetterClientIdFromText(s) {
        var upper = String(s || '').toUpperCase();
        var tokens = upper.match(/\b[A-Z]{2}\b/g) || [];
        var filtered = tokens.filter(function (t) {
            return !TWO_LETTER_BLACKLIST[t] && !TWO_LETTER_SKU_NOISE[t];
        });
        if (!filtered.length) return '';
        return filtered[filtered.length - 1];
    }

    function extractLegacyClientIdFromText(text) {
        var s = String(text || '');
        if (!s.trim()) return '';

        var ppf = s.match(/PPF[-\s]?0*(\d{1,5})/i);
        if (ppf) return formatPpfClientId(ppf[1]);

        var du = s.match(/DU\d+-\d+(?:New)?PPF[-\s]?0*(\d{1,5})/i);
        if (du) return formatPpfClientId(du[1]);

        var ftf = s.match(/FTF[-\s]?0*(\d{1,5})/i);
        if (ftf) return formatFtfClientId(ftf[1]);

        var ppfTight = s.match(/\b(PPF\d{1,5})\b/i);
        if (ppfTight) {
            var innerP = ppfTight[1].match(/PPF0*(\d{1,5})/i);
            if (innerP) return formatPpfClientId(innerP[1]);
        }

        var ftfTight = s.match(/\b(FTF\d{1,5})\b/i);
        if (ftfTight) {
            var innerF = ftfTight[1].match(/FTF0*(\d{1,5})/i);
            if (innerF) return formatFtfClientId(innerF[1]);
        }

        if (/\bPPF\b/i.test(s) && !/\d/.test(s)) return 'PPF';
        if (/\bFTF\b/i.test(s) && !/\d/.test(s)) return 'FTF';

        var tagged = s.match(/\b(?:NewOther|New|USED|Used|Shelf)\s+([A-Za-z]{2,6})\b/i);
        if (tagged) {
            var fromTag = canonicalizeClientIdCandidate(tagged[1]);
            if (fromTag) return fromTag;
        }

        var beforeNew = [];
        var re = /([A-Z]{2})(?=NEW\b)/gi;
        var m;
        while ((m = re.exec(s)) !== null) beforeNew.push(m[1]);
        for (var i = beforeNew.length - 1; i >= 0; i--) {
            var code = canonicalizeClientIdCandidate(beforeNew[i]);
            if (code && code.length === 2) return code;
        }

        return extractTwoLetterClientIdFromText(s);
    }

    function rowSkuHaystack(row) {
        return [row.custom_label, row.product, row.notes, row.client_id].filter(Boolean).join(' ');
    }

    function textIncludesInsensitive(haystack, needle) {
        var n = String(needle || '').trim();
        if (!n) return false;
        return String(haystack || '')
            .toLowerCase()
            .indexOf(n.toLowerCase()) >= 0;
    }

    function textMatchesBulkContains(haystack, needle) {
        if (textIncludesInsensitive(haystack, needle)) return true;
        var want = extractLegacyClientIdFromText(needle) || canonicalizeClientIdCandidate(needle);
        if (!want) return false;
        var got = extractLegacyClientIdFromText(haystack);
        return !!got && got === want;
    }

    function bulkSetClientIdValue(raw) {
        var s = String(raw || '').trim();
        if (!s) return '';
        var fromText = extractLegacyClientIdFromText(s);
        if (fromText) return fromText;
        return normalizeClientIdSpecifier(s);
    }

    return {
        formatPpfClientId: formatPpfClientId,
        formatFtfClientId: formatFtfClientId,
        normalizeClientIdSpecifier: normalizeClientIdSpecifier,
        extractLegacyClientIdFromText: extractLegacyClientIdFromText,
        rowSkuHaystack: rowSkuHaystack,
        textIncludesInsensitive: textIncludesInsensitive,
        textMatchesBulkContains: textMatchesBulkContains,
        bulkSetClientIdValue: bulkSetClientIdValue,
    };
});
