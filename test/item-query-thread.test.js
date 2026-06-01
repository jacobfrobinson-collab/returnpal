/**
 * Run: node test/item-query-thread.test.js
 */

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const initSqlJs = require('sql.js');
const {
    appendQueryMessage,
    deleteClientMessage,
    listQueriesForUser,
    listOpenQueriesForAdmin,
} = require('../src/utils/itemQueryThread');

async function run() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, full_name TEXT)`);
    db.run(`INSERT INTO users (id, email, full_name) VALUES (1, 'c@test.com', 'Client'), (2, 'admin@test.com', 'Admin')`);
    db.run(`
        CREATE TABLE item_queries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            context_type TEXT,
            context_id INTEGER,
            context_label TEXT,
            message TEXT,
            status TEXT DEFAULT 'open',
            last_sender TEXT DEFAULT 'client',
            created_at TEXT,
            updated_at TEXT,
            admin_reply TEXT DEFAULT '',
            replied_at TEXT DEFAULT ''
        )
    `);
    db.run(`
        CREATE TABLE item_query_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            query_id INTEGER NOT NULL,
            sender_role TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);
    db.run(
        `INSERT INTO item_queries (user_id, context_type, context_label, message, status, last_sender)
         VALUES (1, 'general', 'Test', 'Hello', 'open', 'client')`
    );
    db.run(`INSERT INTO item_query_messages (query_id, sender_role, body) VALUES (1, 'client', 'Hello')`);

    let adminOpen = listOpenQueriesForAdmin(db);
    assert(adminOpen.length === 1, 'admin sees client thread');

    appendQueryMessage(db, 1, 'admin', 'Hi there');
    adminOpen = listOpenQueriesForAdmin(db);
    assert(adminOpen.length === 0, 'admin queue empty after reply');

    const clientList = listQueriesForUser(db, 1);
    assert(clientList[0].can_client_reply === true, 'client can follow up');
    assert(clientList[0].messages.length === 2, 'two messages');

    appendQueryMessage(db, 1, 'client', 'Thanks, one more thing');
    adminOpen = listOpenQueriesForAdmin(db);
    assert(adminOpen.length === 1, 'admin sees follow-up');
    const afterFollow = listQueriesForUser(db, 1);
    assert(afterFollow[0].status === 'open', 'still open');
    assert(afterFollow[0].can_client_reply === false, 'waiting on admin');

    const clientMsg = afterFollow[0].messages.find((m) => m.body === 'Thanks, one more thing');
    assert(clientMsg && clientMsg.can_delete, 'follow-up deletable after admin replied');
    const del = deleteClientMessage(db, 1, 1, clientMsg.id);
    assert(del.deleted === 'message', 'message deleted');
    const afterDel = listQueriesForUser(db, 1);
    assert(afterDel[0].messages.length === 2, 'one client msg removed');
    assert(afterDel[0].messages.every((m) => m.body !== 'Thanks, one more thing'), 'follow-up gone');

    console.log('item-query-thread.test.js: all passed');
}

run()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
