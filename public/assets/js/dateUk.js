/**
 * UK-first parsing (day/month for ambiguous slashes; optional MDY via RETURNPAL_AMBIGUOUS_DATE_ORDER).
 * Normalised storage/API dates stay YYYY-MM-DD (formatIso). User-facing labels use formatOrdinalEnGb
 * (e.g. "May 1st 2026"). CSV and filenames should keep formatIso.
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

    const MONTH_NAMES = [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December'
    ];

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

    /**
     * Readable UK-style label: "May 1st 2026". Uses the same parse() rules as formatIso.
     * @param {unknown} input
     * @returns {string}
     */
    function formatOrdinalEnGb(input) {
        const d = parse(input);
        if (!d) return '-';
        const month = MONTH_NAMES[d.getMonth()];
        return month + ' ' + dayWithOrdinal(d.getDate()) + ' ' + d.getFullYear();
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

    function stripSoldDateToIsoHead(v) {
        let s0 = String(v == null ? '' : v)
            .replace(/^\uFEFF/, '')
            .trim()
            .replace(/\u00A0/g, ' ')
            .replace(/\u2007/g, ' ');
        if (!s0) return '';
        if (s0.startsWith("'")) s0 = s0.slice(1).trim();
        if (s0.length >= 2 && s0.startsWith('"') && s0.endsWith('"')) s0 = s0.slice(1, -1).trim();
        const tIdx = s0.indexOf('T');
        if (tIdx !== -1) s0 = s0.slice(0, tIdx).trim();
        else if (/^\d{4}-\d{2}-\d{2}\s/.test(s0)) {
            const m = s0.match(/^(\d{4}-\d{2}-\d{2})/);
            if (m) s0 = m[1];
        }
        if (/\d{1,2}:\d{2}/.test(s0)) {
            s0 = s0.replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(\s*[AaPp][Mm])?.*$/, '').trim();
        }
        return s0;
    }

    function soldDateRepairOpts() {
        const win = w;
        return {
            allOff: String(win.RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL || '').trim() !== '1',
            decemberOff: String(win.RETURNPAL_SOLD_DISPLAY_REPAIR_DECEMBER_ISO || '').trim() === '0',
            novemberOff: String(win.RETURNPAL_SOLD_DISPLAY_REPAIR_NOVEMBER_ISO || '').trim() === '0',
            springOff: String(win.RETURNPAL_SOLD_DISPLAY_REPAIR_SPRING_DAY_ISO || '').trim() === '0',
        };
    }

    function tryRepairMonthDaySwapIso(iso, mo) {
        let s0 = stripSoldDateToIsoHead(iso);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s0)) return s0;
        const o = soldDateRepairOpts();
        if (o.allOff) return s0;
        if (mo === 12 && o.decemberOff) return s0;
        if (mo === 11 && o.novemberOff) return s0;
        if (mo >= 1 && mo <= 10 && o.springOff) return s0;
        const mm = String(mo).padStart(2, '0');
        const m = s0.match(new RegExp('^(\\d{4})-' + mm + '-(\\d{1,2})$'));
        if (!m) return s0;
        const y = parseInt(m[1], 10);
        const d = parseInt(m[2], 10);
        if (!Number.isFinite(y) || !Number.isFinite(d)) return s0;
        if (d === 1 && mo !== 1) return y + '-01-' + mm;
        if (d < 2 || d > 11 || d === mo) return s0;
        return y + '-' + String(d).padStart(2, '0') + '-' + mm;
    }

    /**
     * Sold date for display: ISO YYYY-MM-DD = year, month (2nd), day (3rd). No month/day swap unless
     * window.RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL = '1'.
     * @param {unknown} raw sold_date or sold_date_display from API
     * @returns {string} YYYY-MM-DD or '-'
     */
    function repairSoldDateIsoForDisplay(raw) {
        let head = stripSoldDateToIsoHead(raw);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(head)) {
            const f = formatIso(raw);
            if (f === '-') return '-';
            head = f;
        }
        if (String(w.RETURNPAL_SOLD_DISPLAY_REPAIR_JAN_DAY_ISO || '').trim() !== '0') {
            const jm = head.match(/^(\d{4})-(\d{2})-01$/);
            if (jm && jm[2] !== '01') head = jm[1] + '-01-' + jm[2];
        }
        if (soldDateRepairOpts().allOff) return head;
        for (let mo = 12; mo >= 1; mo--) {
            const n = tryRepairMonthDaySwapIso(head, mo);
            if (n !== head) return n;
        }
        return head;
    }

    w.RP_DATE = {
        parse: parse,
        format: format,
        formatNumeric: formatNumeric,
        formatIso: formatIso,
        formatOrdinalEnGb: formatOrdinalEnGb,
        formatShortMonth: formatShortMonth,
        formatLongMonth: formatLongMonth,
        getTime: getTime,
        stripSoldDateToIsoHead: stripSoldDateToIsoHead,
        repairSoldDateIsoForDisplay: repairSoldDateIsoForDisplay,
    };
})(typeof window !== 'undefined' ? window : global);
