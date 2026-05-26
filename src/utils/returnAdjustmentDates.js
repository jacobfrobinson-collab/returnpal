const { normalizeSoldDateForDb } = require('./adminBulkImport');

/**
 * Calendar date used for monthly statements / balance (refund month, not import day).
 * @param {{ refund_date?: string|null, created_at?: string|null, linked_sold_date?: string|null }} row
 */
function effectiveDateForReturnAdjustment(row) {
    const refund = normalizeSoldDateForDb(row.refund_date);
    if (refund) return refund;
    const linked = normalizeSoldDateForDb(row.linked_sold_date);
    if (linked) return linked;
    return normalizeSoldDateForDb(row.created_at) || '';
}

module.exports = { effectiveDateForReturnAdjustment };
