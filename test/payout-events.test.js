const assert = require('assert');
const initSqlJs = require('sql.js');
const {
    markPayoutPaid,
    resolveStatementStatus,
    payoutEtaFields,
} = require('../src/utils/payoutEvents');

async function makeDb() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY)`);
    db.run(`CREATE TABLE payout_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER, period_ym TEXT UNIQUE, status TEXT,
        amount REAL, due_date TEXT, bank_reference TEXT, client_bank_note TEXT,
        paid_at TEXT, marked_by_admin_id INTEGER
    )`);
    db.run(`INSERT INTO users (id) VALUES (1)`);
    return db;
}

(async () => {
    const db = await makeDb();
    markPayoutPaid(db, 1, '2026-01', {
        amount: 500,
        due_date: '2026-02-28',
        bank_reference: 'FP123',
        adminId: 99,
    });
    assert.strictEqual(resolveStatementStatus(db, 1, '2026-01', '2099-12-31', 'UTC'), 'Paid');
    const eta = payoutEtaFields('2099-06-15', 'UTC');
    assert.ok(eta.days_until_due > 0);
    assert.ok(eta.payout_date_label.length > 5);
    console.log('payout-events.test.js: ok');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
