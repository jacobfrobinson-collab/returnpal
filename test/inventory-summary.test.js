/**
 * Inventory summary payload — pipeline counts and financial fields.
 * Run: node test/inventory-summary.test.js
 */

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const initSqlJs = require('sql.js');
const { buildInventorySummaryPayload } = require('../src/utils/inventorySummary');

async function createDb() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE packages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        reference TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE received_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        reference TEXT NOT NULL,
        items_description TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE sold_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        reference TEXT NOT NULL,
        product TEXT NOT NULL,
        quantity INTEGER DEFAULT 1,
        unit_price REAL DEFAULT 0,
        total_revenue REAL DEFAULT 0,
        profit REAL DEFAULT 0,
        sold_date TEXT,
        status TEXT DEFAULT 'Completed'
    )`);
    db.run(`CREATE TABLE pending_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        reference TEXT NOT NULL,
        product TEXT NOT NULL,
        received_date TEXT,
        current_stage TEXT DEFAULT 'Initial Inspection'
    )`);
    db.run(`CREATE TABLE return_adjustments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        product TEXT NOT NULL,
        amount REAL NOT NULL,
        status TEXT DEFAULT 'applied'
    )`);
    return db;
}

async function testSoldOnlyNoMisleadingRemaining() {
    const db = await createDb();
    const uid = 1;
    for (let i = 0; i < 3; i++) {
        db.run(
            `INSERT INTO sold_items (user_id, reference, product, profit, total_revenue, sold_date)
             VALUES (?, 'R', ?, 50, 100, '2026-04-01')`,
            [uid, 'Product ' + i]
        );
    }
    const data = buildInventorySummaryPayload(db, uid);
    assert(data.pipeline.sold === 3, 'sold count');
    assert(data.pipeline.received === 0, 'no received');
    assert(data.estimated_pipeline_value === null, 'no estimate without processing');
    assert(data.potential_remaining_value === null, 'no remaining when no estimate');
    assert(
        data.pipeline_hints.length > 0,
        'hint when sales without intake'
    );
}

async function testPipelineAndAttention() {
    const db = await createDb();
    const uid = 2;
    db.run(`INSERT INTO packages (user_id, reference) VALUES (?, 'PKG-1')`, [uid]);
    db.run(
        `INSERT INTO received_items (user_id, reference, items_description) VALUES (?, 'R1', 'Widget')`,
        [uid]
    );
    db.run(
        `INSERT INTO pending_items (user_id, reference, product, current_stage, received_date)
         VALUES (?, 'P1', 'Pending widget', 'Listing', '2026-05-01')`,
        [uid]
    );
    db.run(
        `INSERT INTO sold_items (user_id, reference, product, profit, total_revenue, sold_date)
         VALUES (?, 'S1', 'Sold widget', 10, 30, '2026-05-15')`,
        [uid]
    );
    db.run(
        `INSERT INTO return_adjustments (user_id, product, amount, status)
         VALUES (?, 'Milwaukee M18 Impact Wrench', 25, 'applied')`,
        [uid]
    );
    const data = buildInventorySummaryPayload(db, uid);
    assert(data.packages_sent === 1, 'packages_sent');
    assert(data.pipeline.sent === 1, 'pipeline sent');
    assert(data.pipeline.received === 1, 'pipeline received');
    assert(data.pipeline.listing === 1, 'pipeline listing');
    assert(data.pipeline.sold === 1, 'pipeline sold');
    assert(data.attention_items.length === 1, 'attention row');
    assert(data.recent_sold.length === 1, 'recent sold');
    assert(data.recent_sold[0].sold_date_label, 'sold_date_label from API mapping');
    assert(
        Array.isArray(data.user_return_categories) && data.user_return_categories.length >= 1,
        'per-user return categories'
    );
    assert(data.recovered_profit === 10, 'recovered_profit sum');
}

async function testPotentialRemainingNonNegative() {
    const db = await createDb();
    const uid = 3;
    db.run(
        `INSERT INTO pending_items (user_id, reference, product, current_stage, received_date)
         VALUES (?, 'P1', 'Item', 'Initial Inspection', '2026-05-01')`,
        [uid]
    );
    db.run(
        `INSERT INTO sold_items (user_id, reference, product, profit, total_revenue, unit_price, quantity, sold_date)
         VALUES (?, 'S1', 'Past sale', 500, 600, 60, 10, '2026-01-01')`,
        [uid]
    );
    const data = buildInventorySummaryPayload(db, uid);
    assert(data.estimated_pipeline_value != null && data.estimated_pipeline_value > 0, 'has estimate');
    assert(
        data.potential_remaining_value === null || data.potential_remaining_value >= 0,
        'remaining never negative'
    );
}

async function run() {
    await testSoldOnlyNoMisleadingRemaining();
    await testPipelineAndAttention();
    await testPotentialRemainingNonNegative();
    console.log('inventory-summary.test.js: all passed');
}

run()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
