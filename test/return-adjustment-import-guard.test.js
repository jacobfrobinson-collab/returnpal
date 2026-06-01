/**
 * Refund import requires a matching sold_items row (unless RETURNPAL_ALLOW_ORPHAN_REFUND_IMPORT=1).
 */

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const initSqlJs = require('sql.js');
const {
    resolveReturnAdjustmentImportLink,
    allowOrphanRefundImport,
} = require('../src/utils/returnAdjustmentSoldLink');

async function setupDb() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE sold_items (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        order_number TEXT,
        product TEXT,
        profit REAL,
        sold_date TEXT,
        reference TEXT
    )`);
    db.run(
        `INSERT INTO sold_items VALUES (10, 5, 'ORD-ABC', 'Nightmare Before Christmas Card Game Family Fun Disney', 12.5, '2026-01-15', '')`
    );
    return db;
}

async function testAutoMatchByOrderAndProduct() {
    const prev = process.env.RETURNPAL_ALLOW_ORPHAN_REFUND_IMPORT;
    delete process.env.RETURNPAL_ALLOW_ORPHAN_REFUND_IMPORT;
    const db = await setupDb();
    const link = resolveReturnAdjustmentImportLink(db, 5, {
        order_number: 'ORD-ABC',
        product: 'Nightmare Before Christmas Card Game Family Fun Disney',
        amount: 12.5,
    });
    assert(link.matched && link.linkedSoldItemId === 10, 'matches existing sale');
    assert(link.matchSource === 'auto', 'auto link');
    if (prev !== undefined) process.env.RETURNPAL_ALLOW_ORPHAN_REFUND_IMPORT = prev;
}

async function testSkipWhenNoSale() {
    const prev = process.env.RETURNPAL_ALLOW_ORPHAN_REFUND_IMPORT;
    delete process.env.RETURNPAL_ALLOW_ORPHAN_REFUND_IMPORT;
    const db = await setupDb();
    const link = resolveReturnAdjustmentImportLink(db, 5, {
        order_number: 'ORD-CANCELLED-ONLY',
        product: 'Some cancelled item',
        amount: 5,
    });
    assert(!link.matched && link.linkedSoldItemId == null, 'no sale → not matched');
    if (prev !== undefined) process.env.RETURNPAL_ALLOW_ORPHAN_REFUND_IMPORT = prev;
}

async function testExplicitLinkedSoldItemId() {
    const prev = process.env.RETURNPAL_ALLOW_ORPHAN_REFUND_IMPORT;
    delete process.env.RETURNPAL_ALLOW_ORPHAN_REFUND_IMPORT;
    const db = await setupDb();
    const link = resolveReturnAdjustmentImportLink(db, 5, {
        linked_sold_item_id: 10,
        order_number: '',
        product: 'unrelated title',
        amount: 1,
    });
    assert(link.matched && link.linkedSoldItemId === 10, 'explicit id wins');
    assert(link.matchSource === 'explicit', 'explicit source');
    if (prev !== undefined) process.env.RETURNPAL_ALLOW_ORPHAN_REFUND_IMPORT = prev;
}

async function testOrphanEnvAllowsImport() {
    const prev = process.env.RETURNPAL_ALLOW_ORPHAN_REFUND_IMPORT;
    process.env.RETURNPAL_ALLOW_ORPHAN_REFUND_IMPORT = '1';
    const db = await setupDb();
    const link = resolveReturnAdjustmentImportLink(db, 5, {
        order_number: 'ORD-NONE',
        product: 'orphan refund',
        amount: 3,
    });
    assert(link.matched && link.matchSource === 'orphan_allowed', 'env allows orphan');
    process.env.RETURNPAL_ALLOW_ORPHAN_REFUND_IMPORT = prev;
    if (prev === undefined) delete process.env.RETURNPAL_ALLOW_ORPHAN_REFUND_IMPORT;
}

function run() {
    assert(allowOrphanRefundImport() === false || process.env.RETURNPAL_ALLOW_ORPHAN_REFUND_IMPORT, 'default off unless env set');
    return testAutoMatchByOrderAndProduct()
        .then(() => testSkipWhenNoSale())
        .then(() => testExplicitLinkedSoldItemId())
        .then(() => testOrphanEnvAllowsImport())
        .then(() => {
            console.log('return-adjustment-import-guard.test.js: all passed');
        });
}

run();
