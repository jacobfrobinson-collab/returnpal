/**
 * Run: node test/return-adjustment-duplicate.test.js
 */

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const initSqlJs = require('sql.js');
const { findReturnAdjustmentDuplicate } = require('../src/utils/returnAdjustmentDuplicate');

async function run() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(
        `CREATE TABLE return_adjustments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            product TEXT NOT NULL,
            reference TEXT DEFAULT '',
            amount REAL NOT NULL,
            status TEXT DEFAULT 'applied',
            order_number TEXT DEFAULT '',
            refund_date TEXT DEFAULT ''
        )`
    );
    db.run(
        `INSERT INTO return_adjustments (user_id, product, reference, amount, status, order_number, refund_date)
         VALUES (1, 'Item', 'TXN-1', 17.82, 'applied', '12-14516-51505', '2026-05-25')`
    );

    const dup = findReturnAdjustmentDuplicate(db, 1, {
        order_number: '12-14516-51505',
        amount: 17.82,
        refund_date: '2026-05-25',
    });
    assert(dup && dup.id === 1, 'order+amount+date match');

    const notDup = findReturnAdjustmentDuplicate(db, 1, {
        order_number: '12-14516-51505',
        amount: 99.99,
        refund_date: '2026-05-25',
    });
    assert(!notDup, 'different amount not duplicate');

    console.log('return-adjustment-duplicate.test.js: all passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
