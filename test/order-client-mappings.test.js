/**
 * Run: node test/order-client-mappings.test.js
 */

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const initSqlJs = require('sql.js');
const {
    loadOrderClientMap,
    upsertOrderClientMapping,
    upsertOrderClientMappingsFromReview,
    canonicalOrderNumber,
} = require('../src/utils/orderClientMappings');

async function run() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(
        `CREATE TABLE order_client_mappings (
            order_number TEXT PRIMARY KEY,
            client_specifier TEXT NOT NULL,
            source TEXT DEFAULT 'admin_review',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )`
    );

    assert(canonicalOrderNumber(' 12-14516-51505 ') === '12-14516-51505', 'canonical order');

    upsertOrderClientMapping(db, '12-14516-51505', 'AV', 'test');
    upsertOrderClientMapping(db, '22-14533-26163', 'PPF-32', 'test');

    const map = loadOrderClientMap(db);
    assert(map['12-14516-51505'] === 'AV', 'AV saved');
    assert(map['22-14533-26163'] === 'PPF032', 'PPF normalized');

    const n = upsertOrderClientMappingsFromReview(
        db,
        [{ order_number: '26-14531-78143', client_id: 'AI' }],
        'review'
    );
    assert(n === 1, 'batch upsert');
    assert(loadOrderClientMap(db)['26-14531-78143'] === 'AI', 'AI on order');

    console.log('order-client-mappings.test.js: all passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
