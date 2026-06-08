const assert = require('assert');
const initSqlJs = require('sql.js');
const {
    accrueReferralCreditsForPeriod,
    applyPendingReferralCredits,
    getPendingReferralCreditsForPeriod,
    referredUserActiveInPeriod,
} = require('../src/utils/referralCredits');

async function makeDb() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY, referred_by INTEGER)`);
    db.run(`CREATE TABLE packages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, date_added TEXT)`);
    db.run(`CREATE TABLE referral_credits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referrer_user_id INTEGER, referred_user_id INTEGER,
        credit_period_ym TEXT NOT NULL,
        amount REAL, status TEXT, applied_period_ym TEXT,
        UNIQUE(referrer_user_id, referred_user_id, credit_period_ym)
    )`);
    db.run(`INSERT INTO users (id, referred_by) VALUES (1, NULL), (2, 1), (3, 1)`);
    return db;
}

(async () => {
    const db = await makeDb();
    db.run(`INSERT INTO packages (user_id, date_added) VALUES (2, '2026-03-15 10:00:00')`);
    assert.strictEqual(referredUserActiveInPeriod(db, 2, '2026-03'), true);
    assert.strictEqual(referredUserActiveInPeriod(db, 2, '2026-04'), false);

    const accrued = accrueReferralCreditsForPeriod(db, 1, '2026-03');
    assert.strictEqual(accrued, 10);
    const again = accrueReferralCreditsForPeriod(db, 1, '2026-03');
    assert.strictEqual(again, 0);

    db.run(`INSERT INTO packages (user_id, date_added) VALUES (2, '2026-04-02 10:00:00')`);
    const april = accrueReferralCreditsForPeriod(db, 1, '2026-04');
    assert.strictEqual(april, 10);
    assert.strictEqual(getPendingReferralCreditsForPeriod(db, 1, '2026-04'), 10);

    const applied = applyPendingReferralCredits(db, 1, '2026-03');
    assert.strictEqual(applied, 10);
    assert.strictEqual(getPendingReferralCreditsForPeriod(db, 1, '2026-03'), 0);
    assert.strictEqual(getPendingReferralCreditsForPeriod(db, 1, '2026-04'), 10);

    console.log('referral-credits.test.js: ok');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
