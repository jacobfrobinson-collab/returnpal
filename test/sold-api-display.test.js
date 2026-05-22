/**
 * Foolproof sold date display: 2026-02-05 must label as February 5th 2026 (never November).
 * Run: node test/sold-api-display.test.js
 */

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const { normalizeSoldDateForDb } = require('../src/utils/adminBulkImport');
const { mapSoldItemDatesForApi, isoYmdToOrdinalLabel } = require('../src/utils/soldDateDisplayRepair');

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
    const got = isoYmdToOrdinalLabel('2026-02-05');
    assert(got === 'February 5th 2026', 'isoYmdToOrdinalLabel(2026-02-05)');

    const mapped = mapSoldItemDatesForApi('2026-02-05', normalizeSoldDateForDb);
    assert(mapped.iso === '2026-02-05', 'mapSoldItemDatesForApi iso');
    assert(mapped.label === 'February 5th 2026', 'mapSoldItemDatesForApi label');

    const row = simulateSoldApiRow('2026-02-05', 'Game of Thrones: Season 1-3 2014 DVD Box Set New Sealed');
    assert(row.sold_date === '2026-02-05', 'API row sold_date');
    assert(row.sold_date_label === 'February 5th 2026', 'API row sold_date_label');

    const clientLabel = global.RP_SOLD_ISO.labelForSoldItem(row);
    assert(clientLabel === 'February 5th 2026', 'RP_SOLD_ISO.labelForSoldItem (browser module in Node)');

    assert(
        global.RP_SOLD_ISO.labelForSoldItem(row) !== 'November 1st 2026',
        'Game of Thrones row must not show November'
    );

    const datetime = mapSoldItemDatesForApi('2026-02-05 00:00:00', normalizeSoldDateForDb);
    assert(datetime.label === 'February 5th 2026', 'datetime suffix stripped');

    const novDb = simulateSoldApiRow('2026-11-01', 'Other');
    assert(novDb.sold_date_label === 'November 1st 2026', '2026-11-01 correctly November (DB truth)');

    console.log('sold-api-display: all checks passed');
}

run();
