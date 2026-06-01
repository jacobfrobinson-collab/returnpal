/**
 * Invoice month vs sold date consistency (calendar storage + migration).
 * Run: node test/invoice-month-consistency.test.js
 */

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const { calendarYearMonthFromDbDate, calendarIsoDateFromDbDate } = require('../src/utils/soldDateCalendar');
const { computeCanonicalSoldDate } = require('../src/utils/soldDateMigration');
const { normalizeSoldDateForDb } = require('../src/utils/adminBulkImport');
const { mapSoldItemDatesForApi } = require('../src/utils/soldDateDisplayRepair');

function run() {
    const legacyRaw = '2026-05-04';
    const migrated = computeCanonicalSoldDate(legacyRaw);
    assert(migrated.iso === '2026-04-05', 'legacy 2026-05-04 migrates to 5 April calendar');

    assert(
        calendarYearMonthFromDbDate(migrated.iso) === '2026-04',
        'migrated date buckets to April invoice month'
    );
    const apiAfter = mapSoldItemDatesForApi(migrated.iso, normalizeSoldDateForDb);
    assert(apiAfter.iso === '2026-04-05', 'API display iso after migration');
    assert(apiAfter.label === 'April 5th 2026', 'API label after migration');

    assert(calendarYearMonthFromDbDate('2026-04-12') === '2026-04', 'calendar April 12 in April');

    const importIso = normalizeSoldDateForDb('2026-05-02');
    assert(importIso === '2026-05-02', 'import ISO cell unchanged in DB');

    const ambiguous = computeCanonicalSoldDate('2026-02-05');
    assert(ambiguous.ambiguous === true, '2026-02-05 is ambiguous legacy vs calendar');
    assert(ambiguous.iso === '2026-05-02', 'ambiguous picks legacy (May 2) for migration');

    console.log('invoice-month-consistency: all checks passed');
}

run();
process.exit(0);
