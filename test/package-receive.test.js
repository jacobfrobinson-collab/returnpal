/**
 * Unit tests for package-first receive queue.
 */

const assert = require('assert');
const initSqlJs = require('sql.js');
const database = require('../src/database');
const {
    getReceiveQueue,
    receivePackagesFromDeclared,
    buildPackageLines,
} = require('../src/utils/packageReceive');

const origPushActivity = database.pushActivity;

async function makeDb() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)`);
    db.run(`CREATE TABLE packages (
        id INTEGER PRIMARY KEY, user_id INTEGER, reference TEXT, status TEXT,
        notes TEXT, order_number TEXT, date_added TEXT, updated_at TEXT
    )`);
    db.run(`CREATE TABLE package_products (
        id INTEGER PRIMARY KEY, package_id INTEGER, product_name TEXT, quantity INTEGER,
        condition TEXT, asin TEXT, cost_of_goods REAL
    )`);
    db.run(`CREATE TABLE received_items (
        id INTEGER PRIMARY KEY, user_id INTEGER, package_id INTEGER, reference TEXT,
        items_description TEXT, quantity INTEGER, status TEXT, notes TEXT, order_number TEXT
    )`);
    db.run(`INSERT INTO users (id, email) VALUES (1, 'c1@test.com'), (2, 'c2@test.com')`);
    return db;
}

function test(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => console.log('  ✓', name))
        .catch((e) => {
            console.error('  ✗', name, e.message);
            process.exitCode = 1;
        });
}

function countReceived(db, userId) {
    const r = db.exec('SELECT COUNT(*) AS c FROM received_items WHERE user_id = ?', [userId]);
    return r[0].values[0][0];
}

(async () => {
    database.pushActivity = async () => {};

    console.log('package-receive');

    await test('queue lists package with remaining units', async () => {
        const db = await makeDb();
        db.run(`INSERT INTO packages (id, user_id, reference, status) VALUES (1, 1, 'TRK-1', 'In Transit')`);
        db.run(`INSERT INTO package_products (package_id, product_name, quantity, condition) VALUES (1, 'Widget', 2, 'Return')`);
        const { queue, count } = getReceiveQueue(db, 1);
        assert.strictEqual(count, 1);
        assert.strictEqual(queue.length, 1);
        assert.strictEqual(queue[0].remaining_units, 2);
    });

    await test('receive creates one row per product and marks delivered', async () => {
        const db = await makeDb();
        db.run(`INSERT INTO packages (id, user_id, reference, status, order_number) VALUES (10, 1, 'TRK-A', 'In Transit', 'ORD-1')`);
        db.run(`INSERT INTO package_products (package_id, product_name, quantity, condition) VALUES (10, 'Item A', 1, 'Return'), (10, 'Item B', 2, 'Used')`);
        const result = await receivePackagesFromDeclared(db, 1, [10]);
        assert.strictEqual(result.received_packages, 1);
        assert.strictEqual(result.received_lines, 2);
        assert.strictEqual(result.delivered_packages, 1);
        assert.strictEqual(countReceived(db, 1), 2);
        const rows = db.exec('SELECT package_id, items_description, quantity, order_number FROM received_items WHERE user_id = 1 ORDER BY id');
        assert.strictEqual(rows[0].values[0][0], 10);
        assert.strictEqual(rows[0].values[0][1], 'Item A');
        assert.strictEqual(rows[0].values[1][1], 'Item B');
        const status = db.exec('SELECT status FROM packages WHERE id = 10');
        assert.strictEqual(status[0].values[0][0], 'Delivered');
    });

    await test('second receive is idempotent', async () => {
        const db = await makeDb();
        db.run(`INSERT INTO packages (id, user_id, reference, status) VALUES (11, 1, 'TRK-B', 'Delivered')`);
        db.run(`INSERT INTO package_products (package_id, product_name, quantity) VALUES (11, 'Only', 1)`);
        await receivePackagesFromDeclared(db, 1, [11]);
        const result = await receivePackagesFromDeclared(db, 1, [11]);
        assert.strictEqual(result.received_lines, 0);
        assert.strictEqual(result.skipped.length, 1);
        assert.strictEqual(countReceived(db, 1), 1);
    });

    await test('partial prior check-in only receives remainder', async () => {
        const db = await makeDb();
        db.run(`INSERT INTO packages (id, user_id, reference, status) VALUES (12, 1, 'TRK-C', 'Delivered')`);
        db.run(`INSERT INTO package_products (package_id, product_name, quantity) VALUES (12, 'Gadget', 3)`);
        db.run(`INSERT INTO received_items (user_id, package_id, reference, items_description, quantity) VALUES (1, 12, 'TRK-C', 'Gadget', 1)`);
        const { lines } = buildPackageLines(db, { id: 12, user_id: 1, reference: 'TRK-C', notes: '' });
        assert.strictEqual(lines[0].remaining_quantity, 2);
        const result = await receivePackagesFromDeclared(db, 1, [12]);
        assert.strictEqual(result.received_lines, 1);
        const qty = db.exec('SELECT SUM(quantity) FROM received_items WHERE package_id = 12');
        assert.strictEqual(qty[0].values[0][0], 3);
    });

    await test('queue excludes other user packages', async () => {
        const db = await makeDb();
        db.run(`INSERT INTO packages (id, user_id, reference, status) VALUES (20, 2, 'OTHER', 'In Transit')`);
        db.run(`INSERT INTO package_products (package_id, product_name, quantity) VALUES (20, 'X', 1)`);
        const { queue } = getReceiveQueue(db, 1);
        assert.strictEqual(queue.length, 0);
        const errResult = await receivePackagesFromDeclared(db, 1, [20]);
        assert.strictEqual(errResult.errors.length, 1);
    });

    database.pushActivity = origPushActivity;

    console.log(process.exitCode ? 'Some tests failed.' : 'All tests passed.');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
