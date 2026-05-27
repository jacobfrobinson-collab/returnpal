/**
 * Unit tests for return adjustment → sold item linking (product title match).
 */

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const {
    normalizeProductKey,
    productMatchScore,
    findSoldItemIdByOrder,
    findLinkedSoldItemId,
    isReturnAdjustmentLinkPlausible,
    resolveRelinkedSoldItemId,
} = require('../src/utils/returnAdjustmentSoldLink');
const initSqlJs = require('sql.js');

function testNormalizeProductKey() {
    const a = normalizeProductKey('Garmin DriveSmart 51 LMT-S GPS Satellite Navigation');
    const b = normalizeProductKey('garmin drivesmart 51 lmt s gps satellite navigation system touchscreen');
    assert(a.length >= 18 && b.includes('garmin'), 'normalize strips punctuation');
    assert(b.includes('51'), 'keeps alphanumerics');
}

function testNormalizeShortProductSkipped() {
    assert(normalizeProductKey('ab').length < 10, 'short keys');
}

async function testMultiItemOrderRequiresProductMatch() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE sold_items (id INTEGER PRIMARY KEY, user_id INTEGER, order_number TEXT, product TEXT, profit REAL, sold_date TEXT)`);
    db.run(`INSERT INTO sold_items VALUES (1, 5, 'ORD-99', 'Liz Earle Skin Repair Gel Cream 50ml', 3.51, '2026-03-12')`);
    db.run(`INSERT INTO sold_items VALUES (2, 5, 'ORD-99', 'Garmin DriveSmart 51 LMT-S GPS Navigation', 120, '2026-03-12')`);
    assert(findSoldItemIdByOrder(db, 5, 'ORD-99', 'Garmin DriveSmart 51') === 2, 'order + product picks correct line');
    assert(findSoldItemIdByOrder(db, 5, 'ORD-99', 'Liz Earle Skin Repair') === 1, 'order + product picks Liz line');
    assert(findSoldItemIdByOrder(db, 5, 'ORD-99', 'Random Unrelated Product') === null, 'no fuzzy guess on multi-line order');
    assert(findSoldItemIdByOrder(db, 5, 'ORD-99', '') === null, 'order alone does not link when multiple lines');
    const linked = findLinkedSoldItemId(db, 5, {
        orderNumber: 'ORD-99',
        product: 'Garmin DriveSmart 51 LMT-S GPS Satellite Navigation',
    });
    assert(linked === 2, 'findLinkedSoldItemId uses order+product');
}

function testProductMatchScore() {
    assert(productMatchScore('Liz Earle Skin Repair Gel Cream 50ml', 'Liz Earle Skin Repair Gel Cream 50ml Hydrating') >= 60);
    assert(productMatchScore('Liz Earle', 'Garmin DriveSmart 51') === 0);
}

async function testImplausibleLinkClearedOnRelink() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE sold_items (id INTEGER PRIMARY KEY, user_id INTEGER, order_number TEXT, product TEXT, profit REAL, sold_date TEXT)`);
    db.run(`INSERT INTO sold_items VALUES (1, 5, 'ORD-99', 'Liz Earle Skin Repair Gel Cream 50ml', 3.51, '2026-03-12')`);
    db.run(`INSERT INTO sold_items VALUES (2, 5, 'ORD-99', 'Garmin DriveSmart 51 LMT-S GPS Navigation', 120, '2026-03-12')`);
    const adj = {
        order_number: 'ORD-99',
        product: 'Garmin DriveSmart 51 LMT-S GPS Satellite Navigation',
        amount: 151.73,
        linked_sold_item_id: 1,
    };
    assert(!isReturnAdjustmentLinkPlausible(adj, { product: 'Liz Earle Skin Repair Gel Cream 50ml', profit: 3.51, order_number: 'ORD-99' }));
    const next = resolveRelinkedSoldItemId(db, 5, adj);
    assert(next === 2, 'mis-linked large refund moves to matching sold line');
}

function run() {
    testNormalizeProductKey();
    testNormalizeShortProductSkipped();
    testProductMatchScore();
    return testMultiItemOrderRequiresProductMatch()
        .then(() => testImplausibleLinkClearedOnRelink())
        .then(() => {
        console.log('return-adjustment-sold-link.test.js: all passed');
    });
}

run();
