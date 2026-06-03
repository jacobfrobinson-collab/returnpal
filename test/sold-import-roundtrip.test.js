'use strict';

/**
 * Import → display → invoice month must agree under canonical (production) mode.
 * Run: node test/sold-import-roundtrip.test.js
 */

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const { normalizeSoldDateForDb } = require('../src/utils/adminBulkImport');
const { mapSoldItemDatesForApi } = require('../src/utils/soldDateDisplayRepair');
const { soldDatesCanonicalStorage } = require('../src/utils/soldDateStorageMode');
const { formatSoldDateForImportCsv } = require('../scripts/ebay-payout-import-csv');

function run() {
    assert(soldDatesCanonicalStorage(), 'canonical storage is default');

    const cases = [
        { in: '2025-10-15', label: 'October 15th 2025', ym: '2025-10' },
        { in: '2025-11-01', label: 'November 1st 2025', ym: '2025-11' },
        { in: '2025-12-27', label: 'December 27th 2025', ym: '2025-12' },
        { in: '15/10/2025', label: 'October 15th 2025', ym: '2025-10' },
        { in: '31 Dec 2025', label: 'December 31st 2025', ym: '2025-12' },
    ];

    for (const c of cases) {
        const stored = normalizeSoldDateForDb(c.in);
        assert(stored, 'normalize: ' + c.in);
        const csvIso = formatSoldDateForImportCsv(c.in);
        assert(csvIso === stored, 'payout CSV matches DB for ' + c.in + ' (' + csvIso + ' vs ' + stored + ')');
        const api = mapSoldItemDatesForApi(stored, normalizeSoldDateForDb);
        assert(api.label === c.label, 'label for ' + c.in + ' got ' + api.label);
        assert(api.iso.slice(0, 7) === c.ym, 'invoice month for ' + c.in);
    }

    console.log('sold-import-roundtrip.test.js OK');
}

run();
process.exit(0);
