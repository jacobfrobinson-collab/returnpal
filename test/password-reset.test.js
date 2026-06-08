const assert = require('assert');
const {
    hashToken,
    createResetToken,
    findValidTokenRow,
    ensurePasswordResetSchema,
    tokenTtlHours,
} = require('../src/utils/passwordReset');

async function withMemoryDb(fn) {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('PRAGMA foreign_keys = ON;');
    db.run(`
        CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            email TEXT NOT NULL,
            password TEXT NOT NULL
        )
    `);
    db.run('INSERT INTO users (id, email, password) VALUES (1, ?, ?)', ['seller@test.com', 'hash']);
    ensurePasswordResetSchema(db);
    return fn(db);
}

withMemoryDb(async (db) => {
    assert.ok(tokenTtlHours() >= 1);
    const { token, ttlHours } = createResetToken(db, 1);
    assert.ok(token && token.length >= 32);
    assert.ok(ttlHours >= 1);
    assert.strictEqual(hashToken(token), hashToken(token));
    const row = findValidTokenRow(db, token);
    assert.ok(row);
    assert.strictEqual(row.user_id, 1);
    assert.strictEqual(findValidTokenRow(db, 'not-a-real-token'), null);
    db.run(`UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?`, [row.id]);
    assert.strictEqual(findValidTokenRow(db, token), null);
});

console.log('password-reset.test.js: ok');
