/**
 * Sold date display: stored YYYY-MM-DD means YYYY-DD-MM (year, day, month).
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
    assert(storedSoldYmdToOrdinalLabel('2026-02-05') === 'May 2nd 2026', 'day 2, month 5');
    assert(storedSoldYmdToCalendarIso('2026-02-05') === '2026-05-02', 'calendar ISO for sort');

    const mapped = mapSoldItemDatesForApi('2026-02-05', normalizeSoldDateForDb);
    assert(mapped.iso === '2026-05-02', 'mapSoldItemDatesForApi calendar iso');
    assert(mapped.label === 'May 2nd 2026', 'mapSoldItemDatesForApi label');

    const nov = mapSoldItemDatesForApi('2026-11-01', normalizeSoldDateForDb);
    assert(nov.iso === '2026-01-11', '2026-11-01 → 11 Jan calendar');
    assert(nov.label === 'January 11th 2026', '11 Jan label');

    const mar9 = mapSoldItemDatesForApi('2026-09-03', normalizeSoldDateForDb);
    assert(mar9.iso === '2026-03-09', '2026-09-03 → 9 Mar calendar');
    assert(mar9.label === 'March 9th 2026', '9 Mar label');

    const row = simulateSoldApiRow('2026-11-01', 'Game of Thrones: Season 1-3 2014 DVD Box Set New Sealed');
    assert(row.sold_date === '2026-01-11', 'API row sold_date calendar');
    assert(row.sold_date_label === 'January 11th 2026', 'API row sold_date_label');

    const clientLabel = global.RP_SOLD_ISO.labelForSoldItem(row);
    assert(clientLabel === 'January 11th 2026', 'RP_SOLD_ISO.labelForSoldItem');

    const datetime = mapSoldItemDatesForApi('2026-09-03 00:00:00', normalizeSoldDateForDb);
    assert(datetime.label === 'March 9th 2026', 'datetime suffix stripped');

    console.log('sold-api-display: all checks passed');
}

run();
