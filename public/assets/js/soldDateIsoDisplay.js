/**
 * @deprecated Sold list uses API sold_date_label / sold_date_display only (see dashboard.js).
 * Calendar helpers kept for any legacy callers; do not use for sold-item display.
 */
(function (w) {
    'use strict';

    function stripToIsoYmd(v) {
        let s0 = String(v == null ? '' : v).trim();
        const tIdx = s0.indexOf('T');
        if (tIdx !== -1) s0 = s0.slice(0, tIdx).trim();
        else if (/^\d{4}-\d{2}-\d{2}\s/.test(s0)) {
            const m = s0.match(/^(\d{4}-\d{2}-\d{2})/);
            if (m) s0 = m[1];
        }
        return s0;
    }

    function sortKeyForSoldItem(item) {
        if (!item) return '0000-00-00';
        const fields = [item.sold_date_display, item.sold_date];
        for (let i = 0; i < fields.length; i++) {
            const s = stripToIsoYmd(fields[i]);
            if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        }
        return '0000-00-00';
    }

    w.RP_SOLD_ISO = {
        stripToIsoYmd: stripToIsoYmd,
        sortKeyForSoldItem: sortKeyForSoldItem,
        labelForSoldItem: function (item) {
            return (item && item.sold_date_label) || '-';
        },
    };
})(typeof window !== 'undefined' ? window : global);
