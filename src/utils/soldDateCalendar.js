/**
 * Single place for calendar bucketing of sold_date / created_at strings.
 * After migration, sold_items.sold_date is canonical calendar YYYY-MM-DD (same as bulk import).
 */

const { normalizeSoldDateForDb } = require('./adminBulkImport');
const { stripSoldDateToIsoHead } = require('./soldDateDisplayRepair');

/**
 * @param {unknown} v raw DB or spreadsheet cell
 * @returns {string|null} YYYY-MM-DD or null
 */
function calendarIsoDateFromDbDate(v) {
    const n = normalizeSoldDateForDb(v);
    if (n && /^\d{4}-\d{2}-\d{2}$/.test(n)) return n;
    const head = stripSoldDateToIsoHead(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(head)) return head;
    return n;
}

/**
 * @param {unknown} v raw DB or spreadsheet cell
 * @returns {string|null} YYYY-MM or null
 */
function calendarYearMonthFromDbDate(v) {
    const iso = calendarIsoDateFromDbDate(v);
    if (!iso || iso.length < 7) return null;
    const ym = iso.slice(0, 7);
    return /^\d{4}-\d{2}$/.test(ym) ? ym : null;
}

module.exports = {
    calendarIsoDateFromDbDate,
    calendarYearMonthFromDbDate
};
