/**
 * Sold-date display: stored YYYY-MM-DD in DB means YYYY-DD-MM (year, day, month)
 * until RETURNPAL_SOLD_DATES_CANONICAL=1 after migrate-sold-dates --apply.
 */
(function (w) {
    'use strict';

    const MONTH_NAMES = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
    ];

    function canonicalStorage() {
        return String(w.RETURNPAL_SOLD_DATES_CANONICAL || '').trim() === '1';
    }

    function dayWithOrdinal(n) {
        const d = Math.floor(Math.abs(Number(n)) || 0);
        if (d < 1 || d > 31) return String(n);
        const j = d % 10;
        const k = d % 100;
        if (k >= 11 && k <= 13) return d + 'th';
        if (j === 1) return d + 'st';
        if (j === 2) return d + 'nd';
        if (j === 3) return d + 'rd';
        return d + 'th';
    }

    function stripToIsoYmd(v) {
        let s0 = String(v == null ? '' : v)
            .replace(/^\uFEFF/, '')
            .trim()
            .replace(/\u00A0/g, ' ');
        if (!s0) return '';
        const tIdx = s0.indexOf('T');
        if (tIdx !== -1) s0 = s0.slice(0, tIdx).trim();
        else if (/^\d{4}-\d{2}-\d{2}\s/.test(s0)) {
            const m = s0.match(/^(\d{4}-\d{2}-\d{2})/);
            if (m) s0 = m[1];
        }
        if (/\d{1,2}:\d{2}/.test(s0)) {
            s0 = s0.replace(/\s+\d{1,2}:\d{2}(:\d{2})?.*$/, '').trim();
        }
        return s0;
    }

    /** Legacy stored YYYY-DD-MM */
    function parseStoredSoldYmd(v) {
        const s = stripToIsoYmd(v);
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return null;
        const y = parseInt(m[1], 10);
        const day = parseInt(m[2], 10);
        const month = parseInt(m[3], 10);
        if (!Number.isFinite(y) || month < 1 || month > 12 || day < 1 || day > 31) return null;
        return { y: y, day: day, month: month };
    }

    function storedToCalendarIso(v) {
        const p = parseStoredSoldYmd(v);
        if (!p) return stripToIsoYmd(v);
        return (
            String(p.y) +
            '-' +
            String(p.month).padStart(2, '0') +
            '-' +
            String(p.day).padStart(2, '0')
        );
    }

    function parseCalendarIso(v) {
        const s = stripToIsoYmd(v);
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return null;
        const y = parseInt(m[1], 10);
        const month = parseInt(m[2], 10);
        const day = parseInt(m[3], 10);
        if (!Number.isFinite(y) || month < 1 || month > 12 || day < 1 || day > 31) return null;
        return { y: y, month: month, day: day };
    }

    function isoYmdToOrdinalLabel(v) {
        if (canonicalStorage()) {
            const p = parseCalendarIso(v);
            if (!p) return null;
            return MONTH_NAMES[p.month - 1] + ' ' + dayWithOrdinal(p.day) + ' ' + p.y;
        }
        const p = parseStoredSoldYmd(v);
        if (!p) return null;
        return MONTH_NAMES[p.month - 1] + ' ' + dayWithOrdinal(p.day) + ' ' + p.y;
    }

    function toSortKey(v) {
        if (canonicalStorage()) {
            const s = stripToIsoYmd(v);
            return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
        }
        const s = storedToCalendarIso(v);
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
    }

    function labelForSoldItem(item) {
        if (!item) return '-';
        const fields = [item.sold_date_stored, item.sold_date, item.sold_date_display];
        for (let i = 0; i < fields.length; i++) {
            const lab = isoYmdToOrdinalLabel(fields[i]);
            if (lab) return lab;
        }
        return '-';
    }

    function sortKeyForSoldItem(item) {
        if (!item) return '0000-00-00';
        const fields = [item.sold_date_stored, item.sold_date, item.sold_date_display];
        for (let i = 0; i < fields.length; i++) {
            const k = toSortKey(fields[i]);
            if (k) return k;
        }
        return '0000-00-00';
    }

    w.RP_SOLD_ISO = {
        stripToIsoYmd: stripToIsoYmd,
        parseStoredSoldYmd: parseStoredSoldYmd,
        storedToCalendarIso: storedToCalendarIso,
        isoYmdToOrdinalLabel: isoYmdToOrdinalLabel,
        labelForSoldItem: labelForSoldItem,
        sortKeyForSoldItem: sortKeyForSoldItem,
    };
})(typeof window !== 'undefined' ? window : global);
