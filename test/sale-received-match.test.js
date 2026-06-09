'use strict';

const assert = require('assert');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { productMatchScore } = require('../src/utils/productTitleMatch');
const {
    matchSaleToReceived,
    applySaleReceivedMatch,
    findReceivedMatchCandidates,
    decideMatch,
    manualLinkSaleToReceived,
    scoreReceivedCandidate,
} = require('../src/utils/saleReceivedMatch');

function parseResults(result) {
    if (!result || !result.length) return [];
    const cols = result[0].columns;
    return result[0].values.map((row) => {
        const obj = {};
        cols.forEach((col, i) => {
            obj[col] = row[i];
        });
        return obj;
    });
}

async function makeDb() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)`);
    db.run(`INSERT INTO users (id, email) VALUES (1, 'u@test.com')`);
    db.run(`CREATE TABLE received_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        reference TEXT,
        items_description TEXT,
        quantity INTEGER,
        status TEXT,
        notes TEXT,
        date_received TEXT,
        sku TEXT,
        order_number TEXT
    )`);
    db.run(`CREATE TABLE sold_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        reference TEXT,
        product TEXT,
        quantity INTEGER,
        unit_price REAL,
        total_revenue REAL,
        profit REAL,
        margin REAL,
        sold_date TEXT,
        status TEXT,
        order_number TEXT,
        received_item_id INTEGER,
        match_status TEXT,
        match_confidence INTEGER,
        match_source TEXT
    )`);
    db.run(
        `INSERT INTO received_items (user_id, reference, items_description, quantity, status) VALUES (1, 'RM001', 'Apple iPhone 15 Pro Max Silicone Case Black', 2, 'Processed')`
    );
    db.run(
        `INSERT INTO received_items (user_id, reference, items_description, quantity, status) VALUES (1, 'RM001', 'USB-C Charging Cable 2m Braided', 1, 'Processing')`
    );
    return db;
}

assert.ok(productMatchScore('Apple iPhone 15 Pro Max Silicone Case Black', 'Apple iPhone 15 Pro Max Silicone Case Black') >= 90);

(async () => {
    const db = await makeDb();

    db.run(
        `INSERT INTO sold_items (user_id, reference, product, quantity, profit, match_status) VALUES (1, 'RM001', 'Apple iPhone 15 Pro Max Silicone Case Black', 1, 12.5, 'pending_review')`
    );
    const soldId = parseResults(db.exec('SELECT last_insert_rowid() AS id'))[0].id;

    const result = applySaleReceivedMatch(db, soldId);
    assert.strictEqual(result.match_status, 'linked');
    assert.strictEqual(result.received_item_id, 1);
    assert.ok(result.match_confidence >= 90);

    const row = parseResults(db.exec('SELECT received_item_id, match_status FROM sold_items WHERE id = ?', [soldId]))[0];
    assert.strictEqual(row.received_item_id, 1);
    assert.strictEqual(row.match_status, 'linked');

    db.run(
        `INSERT INTO sold_items (user_id, reference, product, quantity, profit, match_status) VALUES (1, 'RM001', 'Case', 1, 5, 'pending_review')`
    );
    const soldId2 = parseResults(db.exec('SELECT last_insert_rowid() AS id'))[0].id;
    const generic = matchSaleToReceived(db, soldId2);
    assert.strictEqual(generic.match_status, 'pending_review');
    assert.strictEqual(generic.received_item_id, null);

    const soldRow = parseResults(db.exec('SELECT * FROM sold_items WHERE id = ?', [soldId]))[0];
    const cands = findReceivedMatchCandidates(db, 1, soldRow);
    assert.ok(cands.length >= 1);

    const ambiguous = decideMatch(
        { product: 'Apple iPhone 15 Pro Max Silicone Case with MagSafe', reference: 'RM001' },
        [
            { received_item_id: 1, score: 70, remaining_qty: 2 },
            { received_item_id: 2, score: 65, remaining_qty: 1 },
        ]
    );
    assert.strictEqual(ambiguous.match_status, 'pending_review');

    const receivedRow = parseResults(db.exec('SELECT * FROM received_items WHERE id = 2'))[0];
    const scored = scoreReceivedCandidate(db, { product: 'USB-C Charging Cable 2m', reference: 'RM001', quantity: 1 }, receivedRow, 0);
    assert.ok(scored && scored.score > 0);
    assert.ok(Array.isArray(scored.match_reasons) && scored.match_reasons.length > 0);

    db.run(
        `INSERT INTO sold_items (user_id, reference, product, quantity, profit, match_status) VALUES (1, 'RM001', 'USB-C Charging Cable 2m Braided', 1, 8, 'pending_review')`
    );
    const soldId3 = parseResults(db.exec('SELECT last_insert_rowid() AS id'))[0].id;
    manualLinkSaleToReceived(db, soldId3, 2);

    db.run(
        `INSERT INTO sold_items (user_id, reference, product, quantity, profit, match_status) VALUES (1, 'RM001', 'USB-C Charging Cable 2m Braided', 1, 8, 'pending_review')`
    );
    const soldId4 = parseResults(db.exec('SELECT last_insert_rowid() AS id'))[0].id;
    let guardThrown = false;
    try {
        manualLinkSaleToReceived(db, soldId4, 2);
    } catch (e) {
        guardThrown = true;
        assert.ok(String(e.message).includes('remaining'));
    }
    assert.ok(guardThrown, 'over-link should be blocked');

    console.log('sale-received-match.test.js: ok');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
