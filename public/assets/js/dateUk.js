/**
 * UK date handling: parse and display as dd/mm/yyyy.
 * Slashed dates like 10/08/2025 are interpreted as day/month/year (not US month/day).
 */
(function (w) {
    'use strict';

    function pad2(n) {
        return String(n).padStart(2, '0');
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
        const s0 = String(input).trim();
        if (!s0) return null;
        const head = s0.split(/[T ]/)[0];

        let m = head.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) {
            const y = parseInt(m[1], 10);
            const mo = parseInt(m[2], 10);
            const d = parseInt(m[3], 10);
            const dt = new Date(y, mo - 1, d);
            return isNaN(dt.getTime()) ? null : dt;
        }

        m = head.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
        if (m) {
            const day = parseInt(m[1], 10);
            const mo = parseInt(m[2], 10);
            const y = parseInt(m[3], 10);
            if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
                const dt = new Date(y, mo - 1, day);
                return isNaN(dt.getTime()) ? null : dt;
            }
        }

        m = head.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2})$/);
        if (m) {
            const day = parseInt(m[1], 10);
            const mo = parseInt(m[2], 10);
            let y = parseInt(m[3], 10);
            y += y >= 70 ? 1900 : 2000;
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
     * @returns {string} dd/mm/yyyy or '-'
     */
    function format(input) {
        const d = parse(input);
        if (!d) return '-';
        return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear();
    }

    /**
     * @param {unknown} input
     * @returns {string} e.g. 10 Aug 2025
     */
    function formatShortMonth(input) {
        const d = parse(input);
        if (!d) return '';
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    /**
     * @param {unknown} input
     * @returns {string} e.g. 10 August 2025
     */
    function formatLongMonth(input) {
        const d = parse(input);
        if (!d) return '';
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    }

    /**
     * @param {unknown} input
     * @returns {number}
     */
    function getTime(input) {
        const d = parse(input);
        return d ? d.getTime() : 0;
    }

    w.RP_DATE = { parse: parse, format: format, formatShortMonth: formatShortMonth, formatLongMonth: formatLongMonth, getTime: getTime };
})(typeof window !== 'undefined' ? window : global);
