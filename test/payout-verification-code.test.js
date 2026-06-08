const assert = require('assert');
const initSqlJs = require('sql.js');
const {
    generatePayoutVerificationCode,
    ensurePayoutVerificationCode,
    buildBankDetailsFormUrl,
    normalizePayoutVerificationCodeInput,
    lookupClientByPayoutVerificationCode,
} = require('../src/utils/payoutVerificationCode');

assert.match(generatePayoutVerificationCode(), /^RP-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

const url = buildBankDetailsFormUrl('https://form.jotform.com/123', 'RP-ABCD-2345', 'client@example.com');
assert.ok(url.includes('RP-ABCD-2345'));
assert.ok(url.includes('client%40example.com') || url.includes('client@example.com'));

assert.strictEqual(normalizePayoutVerificationCodeInput('rp-untm-gatc'), 'RP-UNTM-GATC');
assert.strictEqual(normalizePayoutVerificationCodeInput(' RP UNTM GATC '), 'RP-UNTM-GATC');
assert.strictEqual(normalizePayoutVerificationCodeInput('UNTM-GATC'), 'RP-UNTM-GATC');
assert.strictEqual(normalizePayoutVerificationCodeInput(''), '');
assert.strictEqual(normalizePayoutVerificationCodeInput('RP-AB'), '');

(async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, full_name TEXT, company_name TEXT, payout_verification_code TEXT, updated_at TEXT)`);
    db.run(`INSERT INTO users (id, email, full_name, company_name) VALUES (1, 'a@test.com', 'Test User', 'Co')`);
    const info = ensurePayoutVerificationCode(db, 1);
    assert.ok(info.payout_verification_code);
    assert.match(info.payout_verification_code, /^RP-/);
    const again = ensurePayoutVerificationCode(db, 1);
    assert.strictEqual(again.payout_verification_code, info.payout_verification_code);

    db.run(`UPDATE users SET payout_verification_code = 'RP-TEST-CODE' WHERE id = 1`);
    const match = lookupClientByPayoutVerificationCode(db, 'rp test code');
    assert.ok(match);
    assert.strictEqual(match.id, 1);
    assert.strictEqual(match.payout_verification_code, 'RP-TEST-CODE');
    assert.strictEqual(match.client_code, 'RP0001');
    assert.strictEqual(match.email, 'a@test.com');
    assert.strictEqual(lookupClientByPayoutVerificationCode(db, 'RP-NOMATCH-XXXX'), null);

    console.log('payout-verification-code.test.js: ok');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
