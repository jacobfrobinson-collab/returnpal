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

    const hadCanon = Object.prototype.hasOwnProperty.call(process.env, 'RETURNPAL_SOLD_DATES_CANONICAL');
    const prevCanon = process.env.RETURNPAL_SOLD_DATES_CANONICAL;
    process.env.RETURNPAL_SOLD_DATES_CANONICAL = '1';
    try {
        assert(
            calendarYearMonthFromDbDate(migrated.iso) === '2026-04',
            'migrated date buckets to April invoice month (canonical mode)'
        );
        const apiAfter = mapSoldItemDatesForApi(migrated.iso, normalizeSoldDateForDb);
        assert(apiAfter.iso === '2026-04-05', 'API display iso after migration');
        assert(apiAfter.label === 'April 5th 2026', 'API label after migration');
    } finally {
        if (hadCanon) process.env.RETURNPAL_SOLD_DATES_CANONICAL = prevCanon;
        else delete process.env.RETURNPAL_SOLD_DATES_CANONICAL;
    }

    assert(
        calendarYearMonthFromDbDate('2026-05-04') === '2026-04',
        'legacy stored 2026-05-04 → April (5 Apr)'
    );
    assert(
        calendarIsoDateFromDbDate('2026-12-04') === '2026-04-12',
        'legacy 2026-12-04 → 12 April calendar iso'
    );

    const importIso = normalizeSoldDateForDb('2026-05-02');
    assert(importIso === '2026-05-02', 'import ISO cell unchanged in DB');

    const ambiguous = computeCanonicalSoldDate('2026-02-05');
    assert(ambiguous.ambiguous === true, '2026-02-05 is ambiguous legacy vs calendar');
    assert(ambiguous.iso === '2026-05-02', 'ambiguous picks legacy (May 2) for migration');

    console.log('invoice-month-consistency: all checks passed');
}

run();
process.exit(0);
