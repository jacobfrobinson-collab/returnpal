/**
 * UK-first parsing (day/month for ambiguous slashes; optional MDY via RETURNPAL_AMBIGUOUS_DATE_ORDER).
 * All display helpers use calendar YYYY-MM-DD (ISO date) so the site never shows ambiguous US/UK layouts.
 * format(), formatIso(), formatNumeric(), formatShortMonth(), formatLongMonth() all return YYYY-MM-DD (or '' / '-').
 */
(function (w) {
    'use strict';

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    function ambiguousSlashOrderMdy() {
        return String(w.RETURNPAL_AMBIGUOUS_DATE_ORDER || '')
            .trim()
            .toUpperCase() === 'MDY';
    }

    /**
     * @param {unknown} input
     * @returns {Date|null}
     */
    function parse(input) {
        if (input == null || input === '') return null;
        if (input instanceof Date) {
            return isNaN(input.getTime()) ? null : input;
        }
        if (typeof input === 'number' && Number.isFinite(input)) {
            const x = input;
            if (x > 20000 && x < 120000) {
                const serial = Math.floor(x);
                const epochMs = Date.UTC(1899, 11, 30) + serial * 86400000;
                const dt = new Date(epochMs);
                return isNaN(dt.getTime()) ? null : dt;
            }
        }
        const s0 = String(input).trim();
        if (!s0) return null;
        const head = s0.split(/[T ]/)[0].trim();

        if (/^-?\d{5,6}(\.\d+)?$/.test(head)) {
            const serial = Math.floor(parseFloat(head, 10));
            if (serial > 20000 && serial < 120000) {
                const epochMs = Date.UTC(1899, 11, 30) + serial * 86400000;
                const dt = new Date(epochMs);
                return isNaN(dt.getTime()) ? null : dt;
            }
        }

        let m = head.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/);
        if (m) {
            const y = parseInt(m[1], 10);
            const mo = parseInt(m[2], 10);
            const d = parseInt(m[3], 10);
            if (y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
                const dt = new Date(y, mo - 1, d);
                return isNaN(dt.getTime()) ? null : dt;
            }
        }

        m = head.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
        if (m) {
            const a = parseInt(m[1], 10);
            const b = parseInt(m[2], 10);
            const y = parseInt(m[3], 10);
            let mo;
            let day;
            if (b > 12) {
                mo = a;
                day = b;
            } else if (a > 12) {
                day = a;
                mo = b;
            } else if (ambiguousSlashOrderMdy()) {
                mo = a;
                day = b;
            } else {
                day = a;
                mo = b;
            }
            if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
                const dt = new Date(y, mo - 1, day);
                return isNaN(dt.getTime()) ? null : dt;
            }
        }

        m = head.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2})$/);
        if (m) {
            const a = parseInt(m[1], 10);
            const b = parseInt(m[2], 10);
            let y = parseInt(m[3], 10);
            y += y >= 70 ? 1900 : 2000;
            let mo;
            let day;
            if (b > 12) {
                mo = a;
                day = b;
            } else if (a > 12) {
                day = a;
                mo = b;
            } else if (ambiguousSlashOrderMdy()) {
                mo = a;
                day = b;
            } else {
                day = a;
                mo = b;
            }
            if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
                const dt = new Date(y, mo - 1, day);
                return isNaN(dt.getTime()) ? null : dt;
            }
        }

        const fallback = new Date(s0);
        return isNaN(fallback.getTime()) ? null : fallback;
    }

    /**
     * @param {unknown} input
     * @returns {string} YYYY-MM-DD or '-'
     */
    function formatIso(input) {
        const d = parse(input);
        if (!d) return '-';
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    /**
     * @param {unknown} input
     * @returns {string} YYYY-MM-DD or '-' (same as formatIso — site-wide standard)
     */
    function format(input) {
        return formatIso(input);
    }

    /**
     * @param {unknown} input
     * @returns {string} YYYY-MM-DD or '-' (same as ISO for consistency)
     */
    function formatNumeric(input) {
        return formatIso(input);
    }

    /**
     * @param {unknown} input
     * @returns {string} YYYY-MM-DD or '' if missing
     */
    function formatShortMonth(input) {
        const s = formatIso(input);
        return s === '-' ? '' : s;
    }

    /**
     * @param {unknown} input
     * @returns {string} YYYY-MM-DD or '' if missing
     */
    function formatLongMonth(input) {
        const s = formatIso(input);
        return s === '-' ? '' : s;
    }

    /**
     * @param {unknown} input
     * @returns {number}
     */
    function getTime(input) {
        const d = parse(input);
        return d ? d.getTime() : 0;
    }

    w.RP_DATE = {
        parse: parse,
        format: format,
        formatNumeric: formatNumeric,
        formatIso: formatIso,
        formatShortMonth: formatShortMonth,
        formatLongMonth: formatLongMonth,
        getTime: getTime
    };
})(typeof window !== 'undefined' ? window : global);
