/**
 * Unit tests for prep-centre hub monthly sales aggregation.
 */

const assert = require('assert');
const initSqlJs = require('sql.js');
const { getHubMonthlySales } = require('../src/utils/clientDelegate');

async function makeDb() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE users (
        id INTEGER PRIMARY KEY, email TEXT, full_name TEXT, company_name TEXT, legacy_client_id TEXT
    )`);
    db.run(`CREATE TABLE client_delegate_access (
        hub_user_id INTEGER NOT NULL, client_user_id INTEGER NOT NULL,
        PRIMARY KEY (hub_user_id, client_user_id)
    )`);
    db.run(`CREATE TABLE sold_items (
        id INTEGER PRIMARY KEY, user_id INTEGER, profit REAL, quantity INTEGER, sold_date TEXT
    )`);

    db.run(`INSERT INTO users (id, email, full_name, legacy_client_id) VALUES
        (15, 'hub@test.com', 'Prep Centre', '0015'),
        (81, 'c1@test.com', 'Client One', 'PPF081'),
        (82, 'c2@test.com', 'Client Two', 'PPF082'),
        (99, 'other@test.com', 'Other', 'PPF099')`);

    db.run('INSERT INTO client_delegate_access (hub_user_id, client_user_id) VALUES (15, 81), (15, 82)');

    db.run(`INSERT INTO sold_items (user_id, profit, quantity, sold_date) VALUES
        (81, 100, 1, '2026-04-10'),
        (81, 50, 2, '2026-04-20'),
        (82, 75, 1, '2026-04-05'),
        (81, 30, 1, '2026-03-15'),
        (82, 20, 1, '2026-03-01'),
        (99, 999, 1, '2026-04-01')`);

    return db;
}

function test(name, fn) {
    try {
        fn();
        console.log('  ✓', name);
    } catch (e) {
        console.error('  ✗', name, e.message);
        process.exitCode = 1;
    }
}

(async () => {
    const db = await makeDb();
    console.log('hub-monthly-sales');

    test('empty hub returns no months', () => {
        const out = getHubMonthlySales(db, 99);
        assert.strictEqual(out.client_count, 0);
        assert.deepStrictEqual(out.months, []);
        assert.deepStrictEqual(out.clients, []);
        assert.strictEqual(out.grand_total, 0);
    });

    test('aggregates profit by calendar month for linked clients only', () => {
        const out = getHubMonthlySales(db, 15);
        assert.strictEqual(out.client_count, 2);
        assert.strictEqual(out.grand_total, 275);
        assert.strictEqual(out.months.length, 2);

        const april = out.months.find((m) => m.period === '2026-04');
        assert.ok(april, 'expected April 2026');
        assert.strictEqual(april.profit_total, 225);
        assert.strictEqual(april.item_count, 4);
        assert.strictEqual(april.clients_with_sales, 2);

        const march = out.months.find((m) => m.period === '2026-03');
        assert.ok(march, 'expected March 2026');
        assert.strictEqual(march.profit_total, 50);
        assert.strictEqual(march.item_count, 2);
    });

    test('by_client breakdown per month', () => {
        const out = getHubMonthlySales(db, 15);
        const april = out.months.find((m) => m.period === '2026-04');
        assert.strictEqual(april.by_client.length, 2);
        const c1 = april.by_client.find((c) => c.client_id === 81);
        const c2 = april.by_client.find((c) => c.client_id === 82);
        assert.strictEqual(c1.profit, 150);
        assert.strictEqual(c1.legacy_client_id, 'PPF081');
        assert.strictEqual(c2.profit, 75);
        assert.strictEqual(c2.item_count, 1);
    });

    test('months sorted newest first', () => {
        const out = getHubMonthlySales(db, 15);
        assert.strictEqual(out.months[0].period, '2026-04');
        assert.strictEqual(out.months[1].period, '2026-03');
    });

    test('clients array includes per-client monthly breakdown', () => {
        const out = getHubMonthlySales(db, 15);
        assert.strictEqual(out.clients.length, 2);
        const c1 = out.clients.find((c) => c.client_id === 81);
        const c2 = out.clients.find((c) => c.client_id === 82);
        assert.strictEqual(c1.profit_total, 180);
        assert.strictEqual(c1.months.length, 2);
        assert.strictEqual(c1.months[0].period, '2026-04');
        assert.strictEqual(c1.months[0].profit, 150);
        assert.strictEqual(c2.profit_total, 95);
        assert.strictEqual(c2.months[1].period, '2026-03');
        assert.strictEqual(c2.months[1].profit, 20);
    });

    console.log(process.exitCode ? 'Some tests failed.' : 'All tests passed.');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
