/**
 * Simulates production DB without thread columns, then API list paths.
 * Run: node test/query-api-integration.test.js
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    ensureQueryThreadSchema,
    backfillLegacyQueryMessages,
    listQueriesForUser,
    listOpenQueriesForAdmin,
} = require('../src/utils/itemQueryThread');

async function run() {
    const SQL = await initSqlJs();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-q-'));
    const dbPath = path.join(dir, 'test.db');

    const db = new SQL.Database();
    db.run(`
        CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            email TEXT,
            full_name TEXT NOT NULL
        )
    `);
    db.run(`INSERT INTO users (id, email, full_name) VALUES (1, 'c@test.com', 'Client')`);
    db.run(`
        CREATE TABLE item_queries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            context_type TEXT NOT NULL,
            context_id INTEGER,
            context_label TEXT DEFAULT '',
            message TEXT NOT NULL,
            status TEXT DEFAULT 'open',
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);
    db.run(
        `INSERT INTO item_queries (user_id, context_type, context_label, message, status)
         VALUES (1, 'general', 'Test', 'Hello from client', 'open')`
    );
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    db.close();

    const db2 = new SQL.Database(fs.readFileSync(dbPath));
    db2.run('PRAGMA foreign_keys = ON;');
    ensureQueryThreadSchema(db2);
    if (backfillLegacyQueryMessages(db2)) {
        fs.writeFileSync(dbPath, Buffer.from(db2.export()));
    }
    const userList = listQueriesForUser(db2, 1);
    const adminList = listOpenQueriesForAdmin(db2);
    if (!userList.length) throw new Error('user list empty');
    if (!adminList.length) throw new Error('admin list empty');
    if (!userList[0].messages.length) throw new Error('no messages');
    console.log('query-api-integration: all passed');
    fs.rmSync(dir, { recursive: true, force: true });
}

run()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
