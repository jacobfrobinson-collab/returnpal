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

    function formatPpfClientId(num) {
        const n = parseInt(String(num), 10);
        if (!Number.isFinite(n) || n < 0) return '';
        return 'PPF' + String(n).padStart(3, '0');
    }

    function normalizeClientIdSpecifier(spec) {
        const s = String(spec || '').trim();
        if (!s) return '';
        const ppfOnly = s.match(/^PPF[-\s]?0*(\d{1,5})$/i);
        if (ppfOnly) return formatPpfClientId(ppfOnly[1]);
        return s;
    }

    function extractLegacyClientIdFromText(text) {
        const s = String(text || '');
        if (!s.trim()) return '';

        const ppf = s.match(/PPF[-\s]?0*(\d{1,5})/i);
        if (ppf) return formatPpfClientId(ppf[1]);

        const du = s.match(/DU\d+-\d+(?:New)?PPF[-\s]?0*(\d{1,5})/i);
        if (du) return formatPpfClientId(du[1]);

        const ppfTight = s.match(/\b(PPF\d{1,5})\b/i);
        if (ppfTight) {
            const inner = ppfTight[1].match(/PPF0*(\d{1,5})/i);
            if (inner) return formatPpfClientId(inner[1]);
        }

        if (/\bPPF\b/i.test(s) && !/\d/.test(s)) return 'PPF';

        const tagged = s.match(/\b(?:NewOther|New|USED|Used|Shelf)\s+([A-Za-z]{2,6}\d?)\b/i);
        if (tagged) return String(tagged[1]).toUpperCase();

        const tail = s.match(/\s([A-Za-z]{2,4})\s*$/);
        if (tail) return String(tail[1]).toUpperCase();

        return '';
    }

    function rowSkuHaystack(row) {
        return [row.custom_label, row.product, row.notes, row.client_id].filter(Boolean).join(' ');
    }

    function textIncludesInsensitive(haystack, needle) {
        const n = String(needle || '').trim();
        if (!n) return false;
        return String(haystack || '')
            .toLowerCase()
            .includes(n.toLowerCase());
    }

    function textMatchesBulkContains(haystack, needle) {
        if (textIncludesInsensitive(haystack, needle)) return true;
        var want = extractLegacyClientIdFromText(needle);
        if (!want) return false;
        var got = extractLegacyClientIdFromText(haystack);
        return !!got && got === want;
    }

    function bulkSetClientIdValue(raw) {
        const s = String(raw || '').trim();
        if (!s) return '';
        const fromText = extractLegacyClientIdFromText(s);
        if (fromText) return fromText;
        return normalizeClientIdSpecifier(s);
    }

    return {
        formatPpfClientId,
        normalizeClientIdSpecifier,
        extractLegacyClientIdFromText,
        rowSkuHaystack,
        textIncludesInsensitive,
        textMatchesBulkContains,
        bulkSetClientIdValue,
    };
});
