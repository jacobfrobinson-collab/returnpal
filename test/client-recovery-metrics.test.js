const assert = require('assert');
const initSqlJs = require('sql.js');
const {
    getLifetimeRecovered,
    getMilestones,
    getRecoveredBreakdown,
} = require('../src/utils/clientRecoveryMetrics');

async function makeDb() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE sold_items (
        id INTEGER PRIMARY KEY, user_id INTEGER, profit REAL, total_revenue REAL, sold_date TEXT
    )`);
    db.run(`CREATE TABLE reimbursement_claims (
        id INTEGER PRIMARY KEY, user_id INTEGER, recovered_amount REAL,
        created_at TEXT, submitted_at TEXT, resolved_at TEXT
    )`);
    db.run(`CREATE TABLE return_adjustments (
        id INTEGER PRIMARY KEY, user_id INTEGER, product TEXT, amount REAL, status TEXT,
        linked_sold_item_id INTEGER, refund_date TEXT, created_at TEXT, order_number TEXT
    )`);
    db.run(`INSERT INTO sold_items (user_id, profit, total_revenue, sold_date) VALUES (1, 100, 200, '2026-01-15')`);
    db.run(`INSERT INTO reimbursement_claims (user_id, recovered_amount, created_at) VALUES (1, 50, '2026-01-10')`);
    return db;
}

(async () => {
    const db = await makeDb();
    const total = getLifetimeRecovered(db, 1);
    assert.strictEqual(total, 150);
    const breakdown = getRecoveredBreakdown(db, 1, { periodYm: '2026-01' });
    assert.strictEqual(breakdown.total_recovered, 150);
    const m = getMilestones(12000);
    assert.strictEqual(m.earned.length, 1);
    assert.ok(m.next && m.next.id === '50k');
    console.log('client-recovery-metrics.test.js: ok');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
