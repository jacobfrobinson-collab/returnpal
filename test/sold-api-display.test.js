/**
 * Sold date display for API rows (calendar YYYY-MM-DD storage).
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
    assert(storedSoldYmdToOrdinalLabel('2026-02-05') === 'May 2nd 2026', 'legacy helper: day 2, month 5');
    assert(storedSoldYmdToCalendarIso('2026-02-05') === '2026-05-02', 'legacy helper calendar iso');

    const mapped = mapSoldItemDatesForApi('2026-02-05', normalizeSoldDateForDb);
    assert(mapped.iso === '2026-02-05', 'mapSoldItemDatesForApi calendar iso');
    assert(mapped.label === 'February 5th 2026', 'mapSoldItemDatesForApi label');

    const nov = mapSoldItemDatesForApi('2026-11-01', normalizeSoldDateForDb);
    assert(nov.iso === '2026-11-01', '2026-11-01 → 1 November calendar');
    assert(nov.label === 'November 1st 2026', '1 Nov label');

    const mar9 = mapSoldItemDatesForApi('2026-09-03', normalizeSoldDateForDb);
    assert(mar9.iso === '2026-09-03', '2026-09-03 calendar');
    assert(mar9.label === 'September 3rd 2026', '3 Sep label');

    const row = simulateSoldApiRow('2026-11-01', 'Game of Thrones: Season 1-3 2014 DVD Box Set New Sealed');
    assert(row.sold_date === '2026-11-01', 'API row sold_date calendar');
    assert(row.sold_date_label === 'November 1st 2026', 'API row sold_date_label');

    const clientLabel = global.RP_SOLD_ISO.labelForSoldItem(row);
    assert(clientLabel === 'November 1st 2026', 'RP_SOLD_ISO.labelForSoldItem');

    const datetime = mapSoldItemDatesForApi('2026-09-03 00:00:00', normalizeSoldDateForDb);
    assert(datetime.label === 'September 3rd 2026', 'datetime suffix stripped');

    console.log('sold-api-display: all checks passed');
}

run();
process.exit(0);
