'use strict';

const assert = require('assert');
const { parsePackagePaste, normalizeRow } = require('../src/utils/packageBulkImport');

const paste = `Reference\tProduct\tQty\tCondition
RM001\tWidget A\t2\tNew
RM002\tWidget B\t1`;

const rows = parsePackagePaste(paste);
assert.strictEqual(rows.length, 2);
assert.strictEqual(rows[0].reference, 'RM001');
assert.strictEqual(rows[0].productName, 'Widget A');
assert.strictEqual(rows[0].quantity, 2);
assert.strictEqual(rows[0].condition, 'New');

const csv = 'TRACK-1,SKU-99,3,Used';
const rows2 = parsePackagePaste(csv);
assert.strictEqual(rows2.length, 1);
assert.strictEqual(rows2[0].reference, 'TRACK-1');
assert.strictEqual(rows2[0].condition, 'Used');

assert.strictEqual(normalizeRow({ reference: '', product: 'x' }), null);
assert.strictEqual(normalizeRow({ Reference: 'A', Product: 'B' }).quantity, 1);

console.log('package-bulk-import.test.js: ok');
