const assert = require('assert');
const initSqlJs = require('sql.js');
const { maybeGrantReferralCredit, getPendingReferralCreditsTotal } = require('../src/utils/referralCredits');

async function makeDb() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY, referred_by INTEGER)`);
    db.run(`CREATE TABLE packages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER)`);
    db.run(`CREATE TABLE referral_credits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referrer_user_id INTEGER, referred_user_id INTEGER UNIQUE,
        amount REAL, status TEXT, applied_period_ym TEXT
    )`);
    db.run(`INSERT INTO users (id, referred_by) VALUES (1, NULL), (2, 1)`);
    return db;
}

(async () => {
    const db = await makeDb();
    db.run(`INSERT INTO packages (user_id) VALUES (2)`);
    const r1 = maybeGrantReferralCredit(db, 2);
    assert.strictEqual(r1.granted, true);
    assert.strictEqual(r1.amount, 10);
    const r2 = maybeGrantReferralCredit(db, 2);
    assert.strictEqual(r2.granted, false);
    assert.strictEqual(getPendingReferralCreditsTotal(db, 1), 10);
    console.log('referral-credits.test.js: ok');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
