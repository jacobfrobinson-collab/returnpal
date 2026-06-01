/**
 * Single place for calendar bucketing of sold_date / created_at strings.
 * Uses the same normalisation rules as bulk import and POST /api/sold.
 */

const { normalizeSoldDateForDb } = require('./adminBulkImport');
const { storedSoldYmdToCalendarIso } = require('./soldDateDisplayRepair');

/**
 * @param {unknown} v raw DB or spreadsheet cell
 * @returns {string|null} YYYY-MM-DD or null
 */
function calendarIsoDateFromDbDate(v) {
    const n = normalizeSoldDateForDb(v);
    if (!n || n.length < 10) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(n)) {
        const cal = storedSoldYmdToCalendarIso(n);
        if (/^\d{4}-\d{2}-\d{2}$/.test(cal)) return cal;
    }
    return n;
}

/**
 * @param {unknown} v raw DB or spreadsheet cell
 * @returns {string|null} YYYY-MM or null
 */
function calendarYearMonthFromDbDate(v) {
    const n = normalizeSoldDateForDb(v);
    if (!n || n.length < 10) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(n)) {
        const cal = storedSoldYmdToCalendarIso(n);
        if (/^\d{4}-\d{2}-\d{2}$/.test(cal)) return cal.slice(0, 7);
    }
    const ym = n.slice(0, 7);
    return /^\d{4}-\d{2}$/.test(ym) ? ym : null;
}

module.exports = {
    calendarIsoDateFromDbDate,
    calendarYearMonthFromDbDate
};
