const assert = require('assert');
const initSqlJs = require('sql.js');
const {
    generatePayoutVerificationCode,
    ensurePayoutVerificationCode,
    buildBankDetailsFormUrl,
    normalizePayoutVerificationCodeInput,
    lookupClientByPayoutVerificationCode,
    recordPayoutDetailsFromWebhook,
    extractPayoutCodeFromJotformBody,
    setPayoutDetailsOnFile,
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
    db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, full_name TEXT, company_name TEXT, payout_verification_code TEXT, payout_details_on_file INTEGER DEFAULT 0, payout_details_submitted_at TEXT DEFAULT '', updated_at TEXT)`);
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

    assert.strictEqual(
        extractPayoutCodeFromJotformBody({
            rawRequest: JSON.stringify({ payout_verification_code: 'RP-ABCD-2345' }),
        }),
        'RP-ABCD-2345'
    );
    assert.strictEqual(
        extractPayoutCodeFromJotformBody({ payout_verification_code: 'RP-ABCD-2345' }),
        'RP-ABCD-2345'
    );

    const webhookResult = recordPayoutDetailsFromWebhook(db, 'RP-TEST-CODE');
    assert.ok(webhookResult);
    assert.strictEqual(webhookResult.userId, 1);
    assert.strictEqual(webhookResult.payout_details_on_file, true);
    const afterWebhook = ensurePayoutVerificationCode(db, 1);
    assert.strictEqual(afterWebhook.payout_details_on_file, true);

    setPayoutDetailsOnFile(db, 1, { onFile: false });
    const cleared = ensurePayoutVerificationCode(db, 1);
    assert.strictEqual(cleared.payout_details_on_file, false);

    console.log('payout-verification-code.test.js: ok');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
