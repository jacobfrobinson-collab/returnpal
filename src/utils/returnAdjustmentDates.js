const { normalizeSoldDateForDb } = require('./adminBulkImport');
const { calendarIsoDateFromDbDate } = require('./soldDateCalendar');
const { resolveRefundDateCalendarIso } = require('./returnAdjustmentDateDisplay');

/**
 * Calendar date used for monthly statements / balance (refund month, not import day).
 * @param {{ refund_date?: string|null, created_at?: string|null, linked_sold_date?: string|null }} row
 */
function effectiveDateForReturnAdjustment(row) {
    const refund = resolveRefundDateCalendarIso(row.refund_date, {
        linked_sold_date: row.linked_sold_date,
    });
    if (refund) return refund;
    const linked = calendarIsoDateFromDbDate(row.linked_sold_date);
    if (linked) return linked;
    return calendarIsoDateFromDbDate(row.created_at) || normalizeSoldDateForDb(row.created_at) || '';
}

module.exports = { effectiveDateForReturnAdjustment };
