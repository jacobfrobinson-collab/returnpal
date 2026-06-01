/**
 * Sold date display for API rows (canonical calendar storage — production default).
 * Run: node test/sold-api-display.test.js
 */

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const { normalizeSoldDateForDb } = require('../src/utils/adminBulkImport');
const {
    mapSoldItemDatesForApi,
    storedSoldYmdToOrdinalLabel,
    storedSoldYmdToCalendarIso,
} = require('../src/utils/soldDateDisplayRepair');

require('../public/assets/js/soldDateIsoDisplay.js');

function simulateSoldApiRow(sold_date, product) {
    const dates = mapSoldItemDatesForApi(sold_date, normalizeSoldDateForDb);
    return {
        id: 999,
        product,
        sold_date_stored: dates.stored,
        sold_date: dates.iso || sold_date,
        sold_date_display: dates.iso || sold_date,
        sold_date_label: dates.label,
    };
}

function run() {
    assert(storedSoldYmdToOrdinalLabel('2026-02-05') === 'May 2nd 2026', 'legacy helper unchanged');

    const migrated = mapSoldItemDatesForApi('2026-04-12', normalizeSoldDateForDb);
    assert(migrated.label === 'April 12th 2026', 'migrated DB row April 12 not December 4');

    const nov = mapSoldItemDatesForApi('2026-11-01', normalizeSoldDateForDb);
    assert(nov.iso === '2026-11-01', 'calendar Nov 1');
    assert(nov.label === 'November 1st 2026', 'Nov 1 label');

    const row = simulateSoldApiRow('2026-01-11', 'Game of Thrones: Season 1-3 2014 DVD Box Set New Sealed');
    assert(row.sold_date === '2026-01-11', 'API row sold_date calendar');
    assert(row.sold_date_label === 'January 11th 2026', 'API row sold_date_label');

    const clientLabel = global.RP_SOLD_ISO.labelForSoldItem(row);
    assert(clientLabel === 'January 11th 2026', 'RP_SOLD_ISO uses API label');

    console.log('sold-api-display: all checks passed');
}

run();
process.exit(0);
