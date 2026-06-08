/**
 * Email preference helpers (no live SMTP).
 */
const assert = require('assert');
const {
    wantsWeeklyDigest,
    wantsMonthlyDigest,
    wantsMonthlyInvoice,
    wantsEventEmail,
    prefsFromUserRow,
    weeklyDigestRefKey,
} = require('../src/utils/emailPreferences');
const { mergeClientPreferences } = require('../src/utils/clientPreferences');

function testDigestPrefs() {
    assert.strictEqual(wantsWeeklyDigest({ email_digest: 'weekly' }), true);
    assert.strictEqual(wantsWeeklyDigest({ email_digest: 'monthly' }), false);
    assert.strictEqual(wantsWeeklyDigest({ email_digest: 'off' }), false);

    assert.strictEqual(wantsMonthlyDigest({ email_digest: 'monthly' }), true);
    assert.strictEqual(wantsMonthlyDigest({ email_digest: 'weekly' }), false);

    assert.strictEqual(wantsMonthlyInvoice({ email_monthly_invoice: true }), true);
    assert.strictEqual(wantsMonthlyInvoice({ email_monthly_invoice: false }), false);
}

function testEventPrefs() {
    assert.strictEqual(wantsEventEmail({ email_package_delivered: true }, 'package_delivered'), true);
    assert.strictEqual(wantsEventEmail({ email_package_delivered: false }, 'package_delivered'), false);
    assert.strictEqual(wantsEventEmail({}, 'item_sold'), true);
    assert.strictEqual(wantsEventEmail({ email_payout_sent: false }, 'payout_sent'), false);
}

function testLegacyWeeklyColumn() {
    const row = { client_preferences: '', weekly_digest_email: 1 };
    assert.strictEqual(prefsFromUserRow(row).email_digest, 'weekly');

    const row2 = {
        client_preferences: JSON.stringify({ email_digest: 'monthly' }),
        weekly_digest_email: 1,
    };
    assert.strictEqual(prefsFromUserRow(row2).email_digest, 'monthly');
}

function testMergeDigest() {
    const merged = mergeClientPreferences('', { email_digest: 'monthly' });
    assert.strictEqual(merged.email_digest, 'monthly');
    const off = mergeClientPreferences(JSON.stringify({ email_digest: 'weekly' }), { email_digest: 'bogus' });
    assert.strictEqual(off.email_digest, 'off');
}

function testWeeklyRefKey() {
    const key = weeklyDigestRefKey(new Date('2026-06-04T12:00:00Z'));
    assert.ok(key.startsWith('week:'));
    assert.match(key, /^week:\d{4}-\d{2}-\d{2}$/);
}

testDigestPrefs();
testEventPrefs();
testLegacyWeeklyColumn();
testMergeDigest();
testWeeklyRefKey();
console.log('email-preferences.test.js: ok');
