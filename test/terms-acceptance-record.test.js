/** Smoke test: recordTermsAcceptance writes user row + audit log atomically. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const {
    CURRENT_TERMS_VERSION,
    CURRENT_PRICING_ACK_VERSION,
    recordTermsAcceptance,
    enrichUserWithTerms,
} = require('../src/utils/termsOfService');

const tmpDb = path.join(__dirname, '_tmp_terms_accept.db');

(async () => {
    const SQL = await initSqlJs();
    if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
    const db = new SQL.Database();
    db.run('PRAGMA foreign_keys = ON;');
    db.run(`CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT,
        is_admin INTEGER DEFAULT 0,
        terms_accepted_at TEXT,
        terms_version TEXT,
        pricing_ack_at TEXT,
        pricing_ack_version TEXT,
        updated_at TEXT
    )`);
    db.run(`CREATE TABLE terms_acceptance_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        terms_version TEXT NOT NULL,
        pricing_ack_version TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT
    )`);
    db.run(
        `INSERT INTO users (id, email, is_admin) VALUES (1, 'client@test.com', 0)`
    );

    recordTermsAcceptance(db, 1, { ip_address: '127.0.0.1', user_agent: 'test-agent' });

    const user = db.exec('SELECT * FROM users WHERE id = 1')[0];
    const cols = user.columns;
    const row = user.values[0];
    const u = {};
    cols.forEach((c, i) => { u[c] = row[i]; });
    assert.strictEqual(u.terms_version, CURRENT_TERMS_VERSION);
    assert.strictEqual(u.pricing_ack_version, CURRENT_PRICING_ACK_VERSION);
    assert.ok(u.terms_accepted_at);
    assert.ok(u.pricing_ack_at);

    const log = db.exec('SELECT COUNT(*) FROM terms_acceptance_log')[0].values[0][0];
    assert.strictEqual(log, 1);

    const admin = enrichUserWithTerms({ id: 2, is_admin: 1 }, true);
    assert.strictEqual(admin.terms_acceptance_required, false);

    db.close();
    if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
    console.log('terms-acceptance-record: passed');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
