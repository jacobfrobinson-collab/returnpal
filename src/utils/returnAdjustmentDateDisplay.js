/**
 * Refund / return_adjustment dates only — not sold items.
 * Calendar YYYY-MM-DD in DB; fixes eBay M/D/Y imports and legacy YYYY-DD-MM mis-storage.
 */
const { saveDb } = require('../database');
const { normalizeSoldDateForDb } = require('./adminBulkImport');
const {
    stripSoldDateToIsoHead,
    parseStoredSoldYmd,
    storedSoldYmdToCalendarIso,
    resolveSoldDateIsoForDisplay,
} = require('./soldDateDisplayRepair');

function parseResults(result) {
    if (!result || !result.length) return [];
    const cols = result[0].columns;
    return result[0].values.map((row) => {
        const obj = {};
        cols.forEach((col, i) => {
            obj[col] = row[i];
        });
        return obj;
    });
}

/** Slash dates on refund imports (eBay) — US M/D/Y; ISO and UK D/M/Y unchanged. */
function normalizeRefundDateFromSpreadsheet(raw) {
    const head = stripSoldDateToIsoHead(raw);
    if (!head) return '';
    if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(head)) {
        const had = Object.prototype.hasOwnProperty.call(process.env, 'RETURNPAL_AMBIGUOUS_DATE_ORDER');
        const prev = process.env.RETURNPAL_AMBIGUOUS_DATE_ORDER;
        process.env.RETURNPAL_AMBIGUOUS_DATE_ORDER =
            process.env.RETURNPAL_EBAY_REFUND_DATE_ORDER || 'MDY';
        try {
            return normalizeSoldDateForDb(head) || '';
        } finally {
            if (had) process.env.RETURNPAL_AMBIGUOUS_DATE_ORDER = prev;
            else delete process.env.RETURNPAL_AMBIGUOUS_DATE_ORDER;
        }
    }
    return normalizeSoldDateForDb(head) || '';
}

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

function calendarIsoToOrdinalLabel(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    if (mo < 1 || mo > 12 || day < 1 || day > 31) return '';
    return MONTH_NAMES[mo - 1] + ' ' + dayWithOrdinal(day) + ' ' + y;
}

/**
 * When refund month is wrong (e.g. Aug) but linked sale was in spring (Apr), use sale month.
 * Refunds only — does not change sold_items.
 * @param {string} refundIso calendar YYYY-MM-DD
 * @param {unknown} linkedSoldDate raw sold_date from sold_items
 */
function alignRefundDateToLinkedSale(refundIso, linkedSoldDate) {
    if (!refundIso || !linkedSoldDate) return refundIso;
    const soldCal = resolveSoldDateIsoForDisplay(linkedSoldDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(soldCal) || !/^\d{4}-\d{2}-\d{2}$/.test(refundIso)) {
        return refundIso;
    }
    const rM = parseInt(refundIso.slice(5, 7), 10);
    const sM = parseInt(soldCal.slice(5, 7), 10);
    const rD = parseInt(refundIso.slice(8, 10), 10);
    const sD = parseInt(soldCal.slice(8, 10), 10);
    if (!Number.isFinite(rM) || !Number.isFinite(sM)) return refundIso;

    // UK 04/08 mis-read as ISO 2026-08-04 (4 Aug) while sale was in April — prefer April sale date.
    if (rM === 8 && rD === 4 && sM === 4) {
        return soldCal;
    }
    // Refund month far from sale month (e.g. summer refund date for spring sale).
    if (Math.abs(rM - sM) >= 3 && sM >= 3 && sM <= 6 && rM >= 7) {
        return soldCal;
    }
    return refundIso;
}

/**
 * Calendar YYYY-MM-DD for a refund_date cell (storage or display).
 * @param {unknown} raw
 * @param {{ linked_sold_date?: unknown }} [opts]
 * @returns {string}
 */
function resolveRefundDateCalendarIso(raw, opts = {}) {
    const head = stripSoldDateToIsoHead(raw);
    if (!head) return '';

    const normalized = normalizeRefundDateFromSpreadsheet(raw);
    if (normalized && !/^\d{4}-\d{2}-\d{2}$/.test(head)) {
        return alignRefundDateToLinkedSale(normalized, opts.linked_sold_date);
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(head)) {
        return alignRefundDateToLinkedSale(normalized || '', opts.linked_sold_date);
    }

    const ukApr9 = tryUkRefundAugustFourthToAprilNinth(head);
    if (ukApr9) {
        return alignRefundDateToLinkedSale(ukApr9, opts.linked_sold_date);
    }

    let iso = normalized || head;

    const soldCal = storedSoldYmdToCalendarIso(head);
    if (/^\d{4}-\d{2}-\d{2}$/.test(soldCal) && soldCal !== head) {
        const p = parseStoredSoldYmd(head);
        const naiveMo = parseInt(head.slice(5, 7), 10);
        const naiveDay = parseInt(head.slice(8, 10), 10);
        // Mis-storage as YYYY-DD-MM (e.g. 2026-09-04 = 9 Apr).
        if (
            p &&
            p.month >= 1 &&
            p.month <= 12 &&
            p.day >= 1 &&
            p.day <= 31 &&
            naiveMo >= 9 &&
            naiveMo <= 12 &&
            naiveDay >= 1 &&
            naiveDay <= 31 &&
            naiveMo !== p.month &&
            p.month <= 6
        ) {
            iso = soldCal;
        }
    }

    return alignRefundDateToLinkedSale(iso, opts.linked_sold_date);
}

/**
 * eBay UK: 04/08 stored as ISO month 08 day 04 (4 Aug) vs intended 09/04 (9 Apr).
 * @param {string} iso calendar YYYY-MM-DD
 * @returns {string|null}
 */
function tryUkRefundAugustFourthToAprilNinth(iso) {
    const m = String(iso || '').match(/^(\d{4})-08-04$/);
    if (!m) return null;
    const y = m[1];
    const had = Object.prototype.hasOwnProperty.call(process.env, 'RETURNPAL_AMBIGUOUS_DATE_ORDER');
    const prev = process.env.RETURNPAL_AMBIGUOUS_DATE_ORDER;
    delete process.env.RETURNPAL_AMBIGUOUS_DATE_ORDER;
    try {
        const uk0904 = normalizeSoldDateForDb(`09/04/${y}`);
        const uk0408 = normalizeSoldDateForDb(`04/08/${y}`);
        if (uk0904 === `${y}-04-09` && uk0408 === `${y}-08-04`) {
            return uk0904;
        }
    } finally {
        if (had) process.env.RETURNPAL_AMBIGUOUS_DATE_ORDER = prev;
        else delete process.env.RETURNPAL_AMBIGUOUS_DATE_ORDER;
    }
    return null;
}

/**
 * @param {unknown} raw refund_date from DB
 * @returns {{ iso: string, label: string, stored: unknown }}
 */
function mapReturnAdjustmentDatesForApi(raw, opts = {}) {
    const iso = resolveRefundDateCalendarIso(raw, opts);
    const label = iso ? calendarIsoToOrdinalLabel(iso) : '';
    return { iso: iso || '', label: label || '', stored: raw };
}

/**
 * Write corrected calendar refund_date when import/display resolution differs (refunds only).
 * @param {import('sql.js').Database} db
 * @param {{ userId?: number, ids?: number[] }} [filter]
 * @returns {number}
 */
function persistReturnAdjustmentRefundDateCorrections(db, filter = {}) {
    const userId = filter.userId != null ? parseInt(filter.userId, 10) : null;
    const ids = filter.ids && filter.ids.length ? filter.ids.map((id) => parseInt(id, 10)).filter(Number.isFinite) : null;
    let sql = `SELECT r.id, r.refund_date, s.sold_date AS linked_sold_date
               FROM return_adjustments r
               LEFT JOIN sold_items s ON s.id = r.linked_sold_item_id AND s.user_id = r.user_id
               WHERE r.refund_date IS NOT NULL AND length(trim(r.refund_date)) > 0`;
    const params = [];
    if (Number.isFinite(userId) && userId > 0) {
        sql += ' AND r.user_id = ?';
        params.push(userId);
    }
    if (ids && ids.length) {
        sql += ` AND r.id IN (${ids.map(() => '?').join(',')})`;
        params.push(...ids);
    }
    const rows = parseResults(db.exec(sql, params));
    let updated = 0;
    for (const r of rows) {
        const raw = String(r.refund_date || '').trim();
        const fixed = resolveRefundDateCalendarIso(raw, { linked_sold_date: r.linked_sold_date });
        if (!fixed || fixed === raw) continue;
        db.run('UPDATE return_adjustments SET refund_date = ? WHERE id = ?', [fixed, r.id]);
        updated++;
    }
    if (updated) saveDb();
    return updated;
}

/**
 * API row + optional persist (client dashboard auto-fix for prior imports).
 * @param {import('sql.js').Database|null} db pass to persist corrections
 * @param {{ id: number, refund_date?: string|null }} row
 */
function mapReturnAdjustmentRowForApi(db, row) {
    const dates = mapReturnAdjustmentDatesForApi(row.refund_date, {
        linked_sold_date: row.sold_date || row.linked_sold_date,
    });
    if (db && row.id != null && dates.iso && dates.iso !== String(row.refund_date || '').trim()) {
        db.run('UPDATE return_adjustments SET refund_date = ? WHERE id = ?', [dates.iso, row.id]);
    }
    return {
        ...row,
        refund_date: dates.iso || row.refund_date,
        refund_date_display: dates.label || '',
    };
}

module.exports = {
    resolveRefundDateCalendarIso,
    alignRefundDateToLinkedSale,
    tryUkRefundAugustFourthToAprilNinth,
    normalizeRefundDateFromSpreadsheet,
    mapReturnAdjustmentDatesForApi,
    persistReturnAdjustmentRefundDateCorrections,
    mapReturnAdjustmentRowForApi,
};
