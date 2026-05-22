/**
 * Foolproof sold-date display: YYYY-MM-DD → "February 5th 2026"
 * (2nd segment = month, 3rd = day). No Date(), no timezone, no month/day swap.
 */
(function (w) {
    'use strict';

    const MONTH_NAMES = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
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

    function janDayRepairEnabled() {
        const win = w;
        return String(win.RETURNPAL_SOLD_DISPLAY_REPAIR_JAN_DAY_ISO || '').trim() !== '0';
    }

    /** 2026-11-01 (11 Jan mis-stored) → 2026-01-11 */
    function repairJanFirstOfMonth(iso) {
        if (!janDayRepairEnabled()) return iso;
        const m = iso.match(/^(\d{4})-(\d{2})-01$/);
        if (!m || m[2] === '01') return iso;
        return m[1] + '-01-' + m[2];
    }

    function resolveIsoForDisplay(iso) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
        return repairJanFirstOfMonth(iso);
    }

    /** @returns {string|null} */
    function isoYmdToOrdinalLabel(v) {
        let s = stripToIsoYmd(v);
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = resolveIsoForDisplay(s);
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return null;
        const y = parseInt(m[1], 10);
        const mo = parseInt(m[2], 10);
        const d = parseInt(m[3], 10);
        if (!Number.isFinite(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
        return MONTH_NAMES[mo - 1] + ' ' + dayWithOrdinal(d) + ' ' + y;
    }

    /** @returns {string} YYYY-MM-DD or '' */
    function toSortKey(v) {
        let s = stripToIsoYmd(v);
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = resolveIsoForDisplay(s);
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
    }

    /**
     * @param {{ sold_date_label?: string, sold_date_display?: string, sold_date?: string, sold_date_stored?: string }} item
     * @returns {string}
     */
    function labelForSoldItem(item) {
        if (!item) return '-';
        const preset = item.sold_date_label != null ? String(item.sold_date_label).trim() : '';
        if (preset) return preset;
        const fields = [item.sold_date_display, item.sold_date, item.sold_date_stored];
        for (let i = 0; i < fields.length; i++) {
            const lab = isoYmdToOrdinalLabel(fields[i]);
            if (lab) return lab;
        }
        return '-';
    }

    /**
     * @param {{ sold_date_label?: string, sold_date_display?: string, sold_date?: string, sold_date_stored?: string }} item
     * @returns {string}
     */
    function sortKeyForSoldItem(item) {
        if (!item) return '0000-00-00';
        const fields = [item.sold_date_display, item.sold_date, item.sold_date_stored];
        for (let i = 0; i < fields.length; i++) {
            const k = toSortKey(fields[i]);
            if (k) return k;
        }
        return '0000-00-00';
    }

    w.RP_SOLD_ISO = {
        stripToIsoYmd: stripToIsoYmd,
        isoYmdToOrdinalLabel: isoYmdToOrdinalLabel,
        labelForSoldItem: labelForSoldItem,
        sortKeyForSoldItem: sortKeyForSoldItem,
    };
})(typeof window !== 'undefined' ? window : global);
