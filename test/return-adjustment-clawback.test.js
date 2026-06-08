const assert = require('assert');
const initSqlJs = require('sql.js');
const {
    buildClawbackContext,
    clientClawbackForAdjustment,
    clientClawbackMapForAdjustments,
    clientShareRatioForSold,
    uncappedClientClawback,
} = require('../src/utils/returnAdjustmentClawback');
const { computeMonthlyFreeProcessing } = require('../src/utils/monthlyFreeProcessing');

const ORIG_FEE = process.env.RETURNPAL_CLIENT_FEE_PERCENT;
process.env.RETURNPAL_CLIENT_FEE_PERCENT = '0.25';

function restoreEnv() {
    if (ORIG_FEE === undefined) delete process.env.RETURNPAL_CLIENT_FEE_PERCENT;
    else process.env.RETURNPAL_CLIENT_FEE_PERCENT = ORIG_FEE;
}

async function makeDb() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE sold_items (
        id INTEGER PRIMARY KEY, user_id INTEGER, product TEXT, quantity INTEGER,
        unit_price REAL, total_revenue REAL, profit REAL, sold_date TEXT, recovery_route TEXT
    )`);
    db.run(`CREATE TABLE return_adjustments (
        id INTEGER PRIMARY KEY, user_id INTEGER, linked_sold_item_id INTEGER,
        amount REAL, refund_date TEXT, created_at TEXT, status TEXT
    )`);
    return db;
}

function promoFromSold(soldRows) {
    return computeMonthlyFreeProcessing(soldRows);
}

(async () => {
    const db = await makeDb();
    db.run(
        `INSERT INTO sold_items (id, user_id, product, quantity, unit_price, total_revenue, profit, sold_date)
         VALUES (1, 10, 'Widget', 1, 100, 100, 75, '2026-03-10')`
    );
    const sold = [{ id: 1, user_id: 10, product: 'Widget', quantity: 1, unit_price: 100, total_revenue: 100, profit: 75, sold_date: '2026-03-10' }];
    const promo = promoFromSold(sold);

    assert.strictEqual(clientShareRatioForSold(sold[0], promo), 0.75);
    assert.strictEqual(uncappedClientClawback({ amount: 100 }, sold[0], promo), 75);
    assert.strictEqual(uncappedClientClawback({ amount: 40 }, sold[0], promo), 30);

    const orphanPromo = promoFromSold([]);
    assert.strictEqual(uncappedClientClawback({ amount: 100 }, null, orphanPromo), 75);

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
    const winnerId = promo2.winner_by_item_id['2'] ? 2 : null;
    assert.ok(winnerId === 2, 'highest gross sale is free-processing winner');
    const winnerSold = sold2.find((r) => r.id === 2);
    assert.strictEqual(uncappedClientClawback({ amount: 200 }, winnerSold, promo2), 200);

    const adjustments = [
        { id: 1, linked_sold_item_id: 1, amount: 40, refund_date: '2026-05-01', created_at: '2026-05-01', status: 'applied' },
        { id: 2, linked_sold_item_id: 1, amount: 50, refund_date: '2026-05-02', created_at: '2026-05-02', status: 'applied' },
    ];
    const ctx = { soldById: { '1': sold[0] }, promo };
    const map = clientClawbackMapForAdjustments(adjustments, ctx);
    assert.strictEqual(map.get(1), 30);
    assert.strictEqual(map.get(2), 37.5);
    assert.strictEqual((map.get(1) || 0) + (map.get(2) || 0), 67.5);

    const adjustments2 = [
        { id: 3, linked_sold_item_id: 1, amount: 60, refund_date: '2026-06-01', created_at: '2026-06-01', status: 'applied' },
        { id: 4, linked_sold_item_id: 1, amount: 60, refund_date: '2026-06-02', created_at: '2026-06-02', status: 'applied' },
    ];
    const map2 = clientClawbackMapForAdjustments(adjustments2, ctx);
    assert.strictEqual(map2.get(3), 45);
    assert.strictEqual(map2.get(4), 30);

    const ctxDb = buildClawbackContext(db, 10);
    assert.ok(ctxDb.soldById['1']);
    assert.strictEqual(
        clientClawbackForAdjustment({ amount: 100 }, ctxDb.soldById['1'], ctxDb.promo),
        75
    );

    restoreEnv();
    console.log('return-adjustment-clawback.test.js: ok');
})().catch((e) => {
    restoreEnv();
    console.error(e);
    process.exit(1);
});
