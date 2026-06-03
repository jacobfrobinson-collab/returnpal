'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseSpreadsheetBuffer, normalizeSoldDateForDb } = require('../src/utils/adminBulkImport');
const { mapSoldItemDatesForApi } = require('../src/utils/soldDateDisplayRepair');
const {
    PAYOUT_IMPORT_CSV_HEADER,
    payoutRowToImportCsvLine,
    formatSoldDateForImportCsv,
    readOrderIdsFromPayoutCsv,
} = require('../scripts/ebay-payout-import-csv');

const sampleRow = {
    orderNumber: '15-14032-26050',
    itemTitle: 'Mary & May Calendula Mask',
    customSku: 'Shelf 1E AY',
    clientId: 'AY',
    quantity: 1,
    soldDate: '31 Dec 2025',
    clientPayout: 5.06,
};

const sampleCsv =
    PAYOUT_IMPORT_CSV_HEADER +
    '\n' +
    payoutRowToImportCsvLine(sampleRow) +
    '\n';

assert.strictEqual(formatSoldDateForImportCsv('31 Dec 2025'), '2025-12-31', 'sold_date calendar ISO for Dec 31');
assert(sampleCsv.includes('2025-12-31'), 'csv line uses calendar sold_date');

const rows = parseSpreadsheetBuffer(Buffer.from(sampleCsv, 'utf8'));
assert.strictEqual(rows.length, 1, 'one data row');
assert.strictEqual(rows[0].client_id, 'AY', 'Client ID column');
assert.strictEqual(rows[0].product, 'Mary & May Calendula Mask', 'item_name → product');
assert.strictEqual(rows[0].custom_label, 'Shelf 1E AY', 'SKU → custom_label');
assert.strictEqual(normalizeSoldDateForDb(rows[0].sold_date), '2025-12-31', 'sold_date normalizes for import');
assert.strictEqual(String(rows[0].earnings), '5.06', 'earnings column');
assert.strictEqual(rows[0].order_number, '15-14032-26050', 'order_number preserved');

const api = mapSoldItemDatesForApi(rows[0].sold_date, normalizeSoldDateForDb);
assert.strictEqual(api.label, 'December 31st 2025', 'canonical sold list label');
assert.strictEqual(api.iso, '2025-12-31', 'canonical display iso');
assert.strictEqual(api.iso.slice(0, 7), '2025-12', 'invoice month matches sale');

assert.strictEqual(formatSoldDateForImportCsv('2025-11-01'), '2025-11-01', 'Nov 1 stays calendar ISO');
const novApi = mapSoldItemDatesForApi('2025-11-01', normalizeSoldDateForDb);
assert.strictEqual(novApi.label, 'November 1st 2025', 'Nov 1 not January under canonical');

const ids = readOrderIdsFromPayoutCsv(
    (() => {
        const p = path.join(__dirname, '_payout-import-sample.csv');
        fs.writeFileSync(p, '\uFEFF' + sampleCsv, 'utf8');
        return p;
    })(),
);
assert.strictEqual(ids.size, 1, 'order id read from import-format CSV');
fs.unlinkSync(path.join(__dirname, '_payout-import-sample.csv'));

console.log('payout-csv-import.test.js OK');
