/**
 * Calendar bucketing for sold_date (canonical YYYY-MM-DD in DB after migration).
 * Legacy YYYY-DD-MM conversion lives only in soldDateMigration.js + RETURNPAL_SOLD_DATES_LEGACY=1.
 */

const { normalizeSoldDateForDb } = require('./adminBulkImport');
const { stripSoldDateToIsoHead, storedSoldYmdToCalendarIso } = require('./soldDateDisplayRepair');
const { soldDatesCanonicalStorage } = require('./soldDateStorageMode');

/**
 * @param {unknown} v raw DB or spreadsheet cell
 * @returns {string|null} YYYY-MM-DD or null
 */
function calendarIsoDateFromDbDate(v) {
    const head = stripSoldDateToIsoHead(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(head) && !soldDatesCanonicalStorage()) {
        const legacyCal = storedSoldYmdToCalendarIso(head);
        if (/^\d{4}-\d{2}-\d{2}$/.test(legacyCal)) return legacyCal;
    }
    const n = normalizeSoldDateForDb(v);
    if (n && /^\d{4}-\d{2}-\d{2}$/.test(n)) return n;
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
    calendarYearMonthFromDbDate,
};
