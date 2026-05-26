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
 * Calendar YYYY-MM-DD for a refund_date cell (storage or display).
 * @param {unknown} raw
 * @returns {string}
 */
function resolveRefundDateCalendarIso(raw) {
    const head = stripSoldDateToIsoHead(raw);
    if (!head) return '';

    const normalized = normalizeRefundDateFromSpreadsheet(raw);
    if (normalized && !/^\d{4}-\d{2}-\d{2}$/.test(head)) {
        return normalized;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(head)) {
        return normalized || '';
    }

    const soldCal = storedSoldYmdToCalendarIso(head);
    if (/^\d{4}-\d{2}-\d{2}$/.test(soldCal) && soldCal !== head) {
        const p = parseStoredSoldYmd(head);
        const naiveMo = parseInt(head.slice(5, 7), 10);
        const naiveDay = parseInt(head.slice(8, 10), 10);
        // Typical mis-storage: 2026-09-04 meaning 9 April (sold YYYY-DD-MM), shown as September.
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
            naiveMo !== p.month
        ) {
            return soldCal;
        }
    }

    return normalized || head;
}

/**
 * @param {unknown} raw refund_date from DB
 * @returns {{ iso: string, label: string, stored: unknown }}
 */
function mapReturnAdjustmentDatesForApi(raw) {
    const iso = resolveRefundDateCalendarIso(raw);
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
    let sql = `SELECT id, refund_date FROM return_adjustments
               WHERE refund_date IS NOT NULL AND length(trim(refund_date)) > 0`;
    const params = [];
    if (Number.isFinite(userId) && userId > 0) {
        sql += ' AND user_id = ?';
        params.push(userId);
    }
    if (ids && ids.length) {
        sql += ` AND id IN (${ids.map(() => '?').join(',')})`;
        params.push(...ids);
    }
    const rows = parseResults(db.exec(sql, params));
    let updated = 0;
    for (const r of rows) {
        const raw = String(r.refund_date || '').trim();
        const fixed = resolveRefundDateCalendarIso(raw);
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
    const dates = mapReturnAdjustmentDatesForApi(row.refund_date);
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
    normalizeRefundDateFromSpreadsheet,
    mapReturnAdjustmentDatesForApi,
    persistReturnAdjustmentRefundDateCorrections,
    mapReturnAdjustmentRowForApi,
};
