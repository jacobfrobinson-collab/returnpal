'use strict';

const assert = require('assert');
const initSqlJs = require('sql.js');
const { computeClientResaleNetEarnings } = require('../src/utils/clientNetEarnings');
async function createDb() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY)`);
    db.run(`INSERT INTO users (id) VALUES (1)`);
    db.run(`CREATE TABLE sold_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        reference TEXT,
        product TEXT,
        quantity INTEGER DEFAULT 1,
        profit REAL,
        total_revenue REAL,
        sold_date TEXT,
        status TEXT,
        order_number TEXT
    )`);
    db.run(`CREATE TABLE return_adjustments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        product TEXT,
        amount REAL,
        status TEXT,
        linked_sold_item_id INTEGER,
        refund_date TEXT,
        created_at TEXT,
        order_number TEXT
    )`);
    return db;
}

(async () => {
    const db = await createDb();
    db.run(
        `INSERT INTO sold_items (user_id, product, profit, quantity) VALUES (1, 'Widget A', 100, 1)`
    );
    db.run(
        `INSERT INTO sold_items (user_id, product, profit, quantity) VALUES (1, 'Widget B', 50, 1)`
    );
    db.run(
        `INSERT INTO return_adjustments (user_id, product, amount, status, linked_sold_item_id)
         VALUES (1, 'Widget A return', 40, 'applied', 1)`
    );

    const earnings = computeClientResaleNetEarnings(db, 1);
    assert.strictEqual(earnings.gross_profit, 150);
    assert.ok(earnings.returns_applied > 0, 'clawback applied');
    assert.strictEqual(earnings.net_earnings_after_returns, earnings.gross_profit - earnings.returns_applied);

    console.log('client-net-earnings.test.js: ok');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
