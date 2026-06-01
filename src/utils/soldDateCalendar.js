/**
 * Calendar bucketing for sold_date / created_at.
 * Default: legacy YYYY-DD-MM in sold_items until RETURNPAL_SOLD_DATES_CANONICAL=1 (post-migration).
 */

const { normalizeSoldDateForDb } = require('./adminBulkImport');
const {
    stripSoldDateToIsoHead,
    storedSoldYmdToCalendarIso,
    soldDatesCanonicalStorage,
} = require('./soldDateDisplayRepair');

/**
 * @param {unknown} v raw DB or spreadsheet cell
 * @returns {string|null} YYYY-MM-DD or null
 */
function calendarIsoDateFromDbDate(v) {
    const n = normalizeSoldDateForDb(v);
    if (!n || n.length < 10) {
        const head = stripSoldDateToIsoHead(v);
        if (/^\d{4}-\d{2}-\d{2}$/.test(head) && !soldDatesCanonicalStorage()) {
            const cal = storedSoldYmdToCalendarIso(head);
            if (/^\d{4}-\d{2}-\d{2}$/.test(cal)) return cal;
        }
        return n;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(n)) {
        if (!soldDatesCanonicalStorage()) {
            const cal = storedSoldYmdToCalendarIso(n);
            if (/^\d{4}-\d{2}-\d{2}$/.test(cal)) return cal;
        }
        return n;
    }
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
    calendarYearMonthFromDbDate,
};
