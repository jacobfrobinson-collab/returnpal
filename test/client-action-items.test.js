const assert = require('assert');
const initSqlJs = require('sql.js');
const { getClientActionItems } = require('../src/utils/clientActionItems');

async function makeDb() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY, client_preferences TEXT)`);
    db.run(`CREATE TABLE item_queries (id INTEGER PRIMARY KEY, user_id INTEGER, status TEXT, last_sender TEXT)`);
    db.run(`CREATE TABLE lost_item_enquiries (id INTEGER PRIMARY KEY, user_id INTEGER, status TEXT)`);
    db.run(`CREATE TABLE reimbursement_claims (id INTEGER PRIMARY KEY, user_id INTEGER, case_status TEXT)`);
    db.run(`CREATE TABLE packages (id INTEGER PRIMARY KEY, user_id INTEGER, reference TEXT, status TEXT, date_added TEXT)`);
    db.run(`INSERT INTO users (id, client_preferences) VALUES (1, '{}')`);
    db.run(`INSERT INTO item_queries (user_id, status, last_sender) VALUES (1, 'open', 'admin')`);
    db.run(`INSERT INTO packages (user_id, reference, status, date_added) VALUES (1, 'TRACK-1', 'In Transit', datetime('now', '-20 days'))`);
    return db;
}

(async () => {
    const db = await makeDb();
    const items = getClientActionItems(db, 1);
    assert.ok(items.some((i) => i.type === 'query_reply'));
    assert.ok(items.some((i) => i.type === 'stale_package'));
    assert.ok(items.some((i) => i.type === 'billing'));
    console.log('client-action-items.test.js: ok');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
