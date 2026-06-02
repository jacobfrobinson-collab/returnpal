'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseSpreadsheetBuffer, normalizeSoldDateForDb } = require('../src/utils/adminBulkImport');
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

assert.strictEqual(formatSoldDateForImportCsv('31 Dec 2025'), '2025-12-31', 'sold_date formatted for template');
assert(sampleCsv.includes('2025-12-31'), 'csv line uses iso sold_date');

const rows = parseSpreadsheetBuffer(Buffer.from(sampleCsv, 'utf8'));
assert.strictEqual(rows.length, 1, 'one data row');
assert.strictEqual(rows[0].client_id, 'AY', 'Client ID column');
assert.strictEqual(rows[0].product, 'Mary & May Calendula Mask', 'item_name → product');
assert.strictEqual(rows[0].custom_label, 'Shelf 1E AY', 'SKU → custom_label');
assert.strictEqual(normalizeSoldDateForDb(rows[0].sold_date), '2025-12-31', 'sold_date normalizes for import');
assert.strictEqual(String(rows[0].earnings), '5.06', 'earnings column');
assert.strictEqual(rows[0].order_number, '15-14032-26050', 'order_number preserved');

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
