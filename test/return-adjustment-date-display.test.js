/**
 * Refund date calendar vs sold-format mis-storage.
 * Run: node test/return-adjustment-date-display.test.js
 */
const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const {
    resolveRefundDateCalendarIso,
    mapReturnAdjustmentDatesForApi,
    normalizeRefundDateFromSpreadsheet,
} = require('../src/utils/returnAdjustmentDateDisplay');

function run() {
    assert(resolveRefundDateCalendarIso('2026-04-09') === '2026-04-09', 'calendar April 9');
    assert(
        resolveRefundDateCalendarIso('2026-09-04') === '2026-04-09',
        'sold-format 2026-09-04 → 9 April 2026'
    );
    assert(
        mapReturnAdjustmentDatesForApi('2026-09-04').label === 'April 9th 2026',
        'display label April 9'
    );
    assert(
        mapReturnAdjustmentDatesForApi('2026-08-04').label === 'April 9th 2026',
        'UK 04/08 mis-import as 2026-08-04 → 9 April'
    );
    assert(
        mapReturnAdjustmentDatesForApi('2026-08-04', {
            linked_sold_date: '2026-04-09',
        }).label === 'April 9th 2026',
        'linked April sale aligns refund'
    );
    assert(
        normalizeRefundDateFromSpreadsheet('4/9/26') === '2026-04-09',
        'eBay slash date 4/9/26 → 9 April'
    );
    console.log('return-adjustment-date-display: ok');
}

run();
