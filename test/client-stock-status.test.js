'use strict';

const assert = require('assert');
const initSqlJs = require('sql.js');
const {
    clientStatusFromStage,
    stagesForGroup,
    buildClientStockPayload,
    stockNeedsAttention,
    STOCK_ATTENTION_DAYS,
    LISTING_STAGE,
    LIVE_STAGE,
} = require('../src/utils/clientStockStatus');

(async () => {
    assert.strictEqual(clientStatusFromStage('Ready for Sale').label, 'Live');
    assert.strictEqual(clientStatusFromStage('Ready for Sale').group, 'live');
    assert.strictEqual(clientStatusFromStage('Listing').label, 'Being listed');
    assert.strictEqual(clientStatusFromStage('Initial Inspection').group, 'preparing');
    assert.strictEqual(clientStatusFromStage('Quality Check').group, 'preparing');
    assert.strictEqual(clientStatusFromStage('Return Verification').group, 'preparing');

    assert.deepStrictEqual(stagesForGroup('live'), [LIVE_STAGE]);
    assert.deepStrictEqual(stagesForGroup('listing'), [LISTING_STAGE]);
    assert.ok(stagesForGroup('preparing').length === 3);
    assert.strictEqual(stagesForGroup('all'), null);

    assert.strictEqual(STOCK_ATTENTION_DAYS, 60);
    assert.strictEqual(stockNeedsAttention(59), false);
    assert.strictEqual(stockNeedsAttention(60), true);

    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE pending_items (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        reference TEXT,
        product TEXT,
        quantity INTEGER,
        received_date TEXT,
        current_stage TEXT,
        notes TEXT
    )`);
    db.run(
        `INSERT INTO pending_items (user_id, reference, product, quantity, received_date, current_stage)
         VALUES (1, 'A', 'Widget A', 1, '2026-06-01', 'Initial Inspection')`
    );
    db.run(
        `INSERT INTO pending_items (user_id, reference, product, quantity, received_date, current_stage)
         VALUES (1, 'B', 'Widget B', 2, '2026-06-05', ?)`,
        [LISTING_STAGE]
    );
    db.run(
        `INSERT INTO pending_items (user_id, reference, product, quantity, received_date, current_stage)
         VALUES (1, 'C', 'Widget C', 1, '2026-06-08', ?)`,
        [LIVE_STAGE]
    );

    const all = buildClientStockPayload(db, 1);
    assert.strictEqual(all.summary.total_items, 3);
    assert.strictEqual(all.summary.live, 1);
    assert.strictEqual(all.summary.listing, 2);
    assert.strictEqual(all.summary.preparing, 1);
    assert.strictEqual(all.items[0].client_status_group, 'live');

    const liveOnly = buildClientStockPayload(db, 1, { group: 'live' });
    assert.strictEqual(liveOnly.items.length, 1);
    assert.strictEqual(liveOnly.items[0].product, 'Widget C');

    const search = buildClientStockPayload(db, 1, { search: 'widget b' });
    assert.strictEqual(search.items.length, 1);

    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 61);
    const oldYmd = oldDate.toISOString().slice(0, 10);
    db.run(
        `INSERT INTO pending_items (user_id, reference, product, quantity, received_date, current_stage)
         VALUES (1, 'OLD', 'Old widget', 1, ?, 'Initial Inspection')`,
        [oldYmd]
    );
    const withAttention = buildClientStockPayload(db, 1);
    assert.ok(withAttention.summary.attention_count >= 1, 'attention_count');
    assert.ok(withAttention.attention_items.length >= 1, 'attention_items');
    const oldItem = withAttention.items.find((i) => i.product === 'Old widget');
    assert.ok(oldItem && oldItem.needs_attention, 'needs_attention on old item');
    const recentItem = withAttention.items.find((i) => i.product === 'Widget A');
    assert.ok(recentItem && !recentItem.needs_attention, 'recent item not flagged');
    assert.strictEqual(
        withAttention.attention_items[0].product,
        'Old widget',
        'oldest attention item first'
    );

    console.log('client-stock-status.test.js: ok');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
