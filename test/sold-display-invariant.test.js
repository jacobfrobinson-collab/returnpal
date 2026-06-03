/**
 * Sold display must not re-interpret migrated calendar DB as legacy YYYY-DD-MM.
 * Run: node test/sold-display-invariant.test.js
 */

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const { normalizeSoldDateForDb } = require('../src/utils/adminBulkImport');
const { mapSoldItemDatesForApi } = require('../src/utils/soldDateDisplayRepair');
const { soldDatesCanonicalStorage } = require('../src/utils/soldDateStorageMode');

function run() {
    assert(soldDatesCanonicalStorage(), 'canonical is default (unset env)');

    const migrated = mapSoldItemDatesForApi('2026-04-12', normalizeSoldDateForDb);
    assert(migrated.label === 'April 12th 2026', 'calendar row must not show as December 4th');
    assert(migrated.iso === '2026-04-12', 'iso unchanged');

    const jan11 = mapSoldItemDatesForApi('2026-01-11', normalizeSoldDateForDb);
    assert(jan11.label === 'January 11th 2026', 'Jan 11 not November 1');

    const hadSwap = Object.prototype.hasOwnProperty.call(
        process.env,
        'RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL'
    );
    const prevSwap = process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL;
    process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL = '1';
    delete require.cache[require.resolve('../src/utils/soldDateStorageMode.js')];
    delete require.cache[require.resolve('../src/utils/soldDateDisplayRepair.js')];
    const { mapSoldItemDatesForApi: mapWithSwap } = require('../src/utils/soldDateDisplayRepair');
    const dec3 = mapWithSwap('2025-12-03', normalizeSoldDateForDb);
    assert(dec3.label === 'December 3rd 2025', 'swap repair must not rewrite calendar Dec 2025');
    if (hadSwap) process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL = prevSwap;
    else delete process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL;

    console.log('sold-display-invariant: all checks passed');
}

run();
process.exit(0);
