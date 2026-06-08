const assert = require('assert');
const initSqlJs = require('sql.js');
const {
    generatePayoutVerificationCode,
    ensurePayoutVerificationCode,
    buildBankDetailsFormUrl,
} = require('../src/utils/payoutVerificationCode');

assert.match(generatePayoutVerificationCode(), /^RP-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

const url = buildBankDetailsFormUrl('https://form.jotform.com/123', 'RP-ABCD-2345', 'client@example.com');
assert.ok(url.includes('RP-ABCD-2345'));
assert.ok(url.includes('client%40example.com') || url.includes('client@example.com'));

(async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, payout_verification_code TEXT, updated_at TEXT)`);
    db.run(`INSERT INTO users (id, email) VALUES (1, 'a@test.com')`);
    const info = ensurePayoutVerificationCode(db, 1);
    assert.ok(info.payout_verification_code);
    assert.match(info.payout_verification_code, /^RP-/);
    const again = ensurePayoutVerificationCode(db, 1);
    assert.strictEqual(again.payout_verification_code, info.payout_verification_code);
    console.log('payout-verification-code.test.js: ok');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
