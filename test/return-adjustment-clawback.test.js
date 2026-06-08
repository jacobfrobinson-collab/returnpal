const assert = require('assert');
const initSqlJs = require('sql.js');
const {
    buildClawbackContext,
    clientClawbackForAdjustment,
    clientClawbackMapForAdjustments,
    clientShareRatioForSold,
    clientShareRatioForOrphanRefund,
    uncappedClientClawback,
} = require('../src/utils/returnAdjustmentClawback');
const { clientShareRateTiered, feePercentForValue } = require('../src/utils/clientFeeTiers');
const { computeMonthlyFreeProcessing } = require('../src/utils/monthlyFreeProcessing');

function promoFromSold(soldRows) {
    return computeMonthlyFreeProcessing(soldRows);
}

async function makeDb() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE sold_items (
        id INTEGER PRIMARY KEY, user_id INTEGER, product TEXT, quantity INTEGER,
        unit_price REAL, total_revenue REAL, profit REAL, margin REAL, sold_date TEXT, recovery_route TEXT
    )`);
    db.run(`CREATE TABLE return_adjustments (
        id INTEGER PRIMARY KEY, user_id INTEGER, linked_sold_item_id INTEGER,
        amount REAL, refund_date TEXT, created_at TEXT, status TEXT
    )`);
    return db;
}

(async () => {
    assert.strictEqual(clientShareRateTiered(40), 0.75);
    assert.strictEqual(clientShareRateTiered(100), 0.8);
    assert.strictEqual(clientShareRateTiered(200), 0.85);
    assert.ok(Math.abs(feePercentForValue(40, '2026-03-01') - 0.25) < 0.001);
    assert.ok(Math.abs(feePercentForValue(100, '2026-03-01') - 0.2) < 0.001);
    assert.ok(Math.abs(feePercentForValue(200, '2026-03-01') - 0.15) < 0.001);

    const db = await makeDb();
    const promo = promoFromSold([]);

    const low = { id: 1, quantity: 1, unit_price: 40, total_revenue: 40, profit: 30, margin: 0, sold_date: '2026-03-10' };
    assert.strictEqual(clientShareRatioForSold(low, promo), 0.75);
    assert.strictEqual(uncappedClientClawback({ amount: 40 }, low, promo), 30);

    const mid = { id: 2, quantity: 1, unit_price: 100, total_revenue: 100, profit: 80, margin: 0, sold_date: '2026-03-10' };
    assert.strictEqual(clientShareRatioForSold(mid, promo), 0.8);
    assert.strictEqual(uncappedClientClawback({ amount: 100 }, mid, promo), 80);

    const high = { id: 3, quantity: 1, unit_price: 200, total_revenue: 200, profit: 170, margin: 0, sold_date: '2026-03-10' };
    assert.strictEqual(clientShareRatioForSold(high, promo), 0.85);
    assert.strictEqual(uncappedClientClawback({ amount: 200 }, high, promo), 170, '15% fee tier: client keeps 85%');

    assert.strictEqual(clientShareRatioForOrphanRefund(40, '2026-03-10'), 0.75);
    assert.strictEqual(clientShareRatioForOrphanRefund(100, '2026-03-10'), 0.8);
    assert.strictEqual(uncappedClientClawback({ amount: 100 }, null, promo), 80);

    const earningsOnly = { id: 4, quantity: 1, unit_price: 75, total_revenue: 75, profit: 75, margin: 0, sold_date: '2026-03-10' };
    assert.strictEqual(uncappedClientClawback({ amount: 100 }, earningsOnly, promo), 80);

    db.run(
        `INSERT INTO sold_items (id, user_id, product, quantity, unit_price, total_revenue, profit, margin, sold_date)
         VALUES (1, 10, 'Widget', 1, 100, 100, 80, 0, '2026-03-10'),
                (9, 10, 'Other', 1, 150, 150, 120, 0, '2026-03-11')`
    );
    const sold = [
        { id: 1, user_id: 10, product: 'Widget', quantity: 1, unit_price: 100, total_revenue: 100, profit: 80, sold_date: '2026-03-10' },
        { id: 9, user_id: 10, product: 'Other', quantity: 1, unit_price: 150, total_revenue: 150, profit: 120, sold_date: '2026-03-11' },
    ];
    const promoLinked = promoFromSold(sold);

    const adjustments = [
        { id: 1, linked_sold_item_id: 1, amount: 40, refund_date: '2026-05-01', created_at: '2026-05-01', status: 'applied' },
        { id: 2, linked_sold_item_id: 1, amount: 50, refund_date: '2026-05-02', created_at: '2026-05-02', status: 'applied' },
    ];
    const ctx = { soldById: { '1': sold[0] }, promo: promoLinked };
    const map = clientClawbackMapForAdjustments(adjustments, ctx);
    assert.strictEqual(map.get(1), 32);
    assert.strictEqual(map.get(2), 40);
    assert.strictEqual((map.get(1) || 0) + (map.get(2) || 0), 72);

    db.run(
        `INSERT INTO sold_items (id, user_id, product, quantity, unit_price, total_revenue, profit, sold_date)
         VALUES (2, 10, 'Big item', 1, 200, 200, 200, '2026-04-05')`
    );
    const sold2 = [
        sold[0],
        { id: 2, user_id: 10, product: 'Big item', quantity: 1, unit_price: 200, total_revenue: 200, profit: 200, sold_date: '2026-04-05' },
        { id: 3, user_id: 10, product: 'Small', quantity: 1, unit_price: 10, total_revenue: 10, profit: 7.5, sold_date: '2026-04-06' },
    ];
    const promo2 = promoFromSold(sold2);
    const winnerSold = sold2.find((r) => r.id === 2);
    assert.strictEqual(uncappedClientClawback({ amount: 200 }, winnerSold, promo2), 200);

    const ctxDb = buildClawbackContext(db, 10);
    assert.ok(ctxDb.soldById['1']);
    assert.strictEqual(
        clientClawbackForAdjustment({ amount: 100 }, ctxDb.soldById['1'], ctxDb.promo),
        80
    );

    console.log('return-adjustment-clawback.test.js: ok');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
