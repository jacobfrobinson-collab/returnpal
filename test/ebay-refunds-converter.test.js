/**
 * Unit tests for eBay refunds → ReturnPal converter.
 * Run: node test/ebay-refunds-converter.test.js
 */

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const path = require('path');
const fs = require('fs');
const {
    buildOrderClientMapFromOrdersAoa,
    parseRefundRowsFromTransactionSheet,
    applyDedupeAndSplit,
    rowsToImportAoa,
    isRefundTransactionRow,
    canonicalOrderNumber,
    dedupeKey,
    normalizeEbayTxnDate,
} = require('../scripts/convert-ebay-refunds-to-returnpal');

function testCanonicalOrderNumber() {
    assert(canonicalOrderNumber('  12-34567-89012  ') === '12-34567-89012', 'ebay order format');
}

function testOrderClientMap() {
    const aoa = [
        ['date', 'order', 'title', 'sku', 'qty', '', 'earn', 'client'],
        ['', '12-34567-89012', 'A', '', 1, '', 10, 'ac'],
        ['', '12-34567-89014', 'B', '', 1, '', 8, 'ppf'],
    ];
    const map = buildOrderClientMapFromOrdersAoa(aoa);
    assert(map['12-34567-89012'] === 'ac', 'map ac');
    assert(map['12-34567-89014'] === 'ppf', 'map ppf');
}

function testRefundRowDetection() {
    const hints = ['refund', 'return'];
    assert(isRefundTransactionRow({ type: 'Refund' }, hints), 'refund type');
    assert(!isRefundTransactionRow({ type: 'Order', amount: '25.00' }, hints), 'sale not refund');
}

function testParseSnippet() {
    const csvPath = path.join(__dirname, 'fixtures', 'ebay-transactions-refunds-snippet.csv');
    const text = fs.readFileSync(csvPath, 'utf8');
    const XLSX = require('xlsx');
    const wb = XLSX.read(text, { type: 'string', raw: true });
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });

    const orderClientMap = {
        '12-34567-89012': 'ac',
        '12-34567-89014': 'ppf',
    };
    const { rows, skipped } = parseRefundRowsFromTransactionSheet(aoa, { orderClientMap });
    assert(rows.length === 2, 'two refund rows, not sale');
    assert(skipped.notRefund === 1, 'one sale skipped');
    assert(rows[0].amount === 15.5, 'absolute amount');
    assert(rows[0].clientId === 'ac', 'client from map');
    assert(rows[1].clientId === 'ppf', 'client ppf');
}

function testDedupe() {
    const rows = [
        {
            clientId: 'ac',
            orderNumber: '12-34567-89012',
            product: 'X',
            amount: 10,
            txnId: 'T1',
            notes: '',
            status: 'applied',
        },
    ];
    const state = { keys: {} };
    const first = applyDedupeAndSplit(rows, { state, recordState: true });
    assert(first.out.length === 1, 'first pass');
    const second = applyDedupeAndSplit(rows, { state: first.state, recordState: true });
    assert(second.out.length === 0, 'duplicate skipped');
    assert(second.duplicates === 1, 'dup count');
}

function testEbayTxnDateMdy() {
    const had = Object.prototype.hasOwnProperty.call(process.env, 'RETURNPAL_AMBIGUOUS_DATE_ORDER');
    const prev = process.env.RETURNPAL_AMBIGUOUS_DATE_ORDER;
    try {
        assert(normalizeEbayTxnDate('4/9/26') === '2026-04-09', 'US-style 4/9/26 → 9 April');
        assert(normalizeEbayTxnDate('2026-04-09') === '2026-04-09', 'ISO unchanged');
    } finally {
        if (had) process.env.RETURNPAL_AMBIGUOUS_DATE_ORDER = prev;
        else delete process.env.RETURNPAL_AMBIGUOUS_DATE_ORDER;
    }
}

function testOutputHeader() {
    const aoa = rowsToImportAoa([
        {
            clientId: 'ac',
            orderNumber: '1',
            product: 'P',
            amount: 5,
            reference: '',
            notes: 'n',
            status: 'applied',
        },
    ]);
    assert(aoa[0][0] === 'Client ID', 'header');
    assert(aoa[1][2] === 'P', 'product col');
    assert(aoa[1][8] === 'applied', 'status');
    assert(aoa[0].indexOf('refund_date') >= 0, 'refund_date column');
}

function run() {
    testCanonicalOrderNumber();
    testOrderClientMap();
    testRefundRowDetection();
    testParseSnippet();
    testDedupe();
    testEbayTxnDateMdy();
    testOutputHeader();
    console.log('ebay-refunds-converter.test.js: all passed');
}

run();
