'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { extractPayoutCodeFromJotformBody } = require('../src/utils/payoutVerificationCode');

assert.strictEqual(extractPayoutCodeFromJotformBody(null), '');
assert.strictEqual(extractPayoutCodeFromJotformBody({}), '');

const body = {
    rawRequest: JSON.stringify({
        payout_verification_code: 'RP-ABCD-2345',
        account_number: '12345678',
    }),
};
assert.strictEqual(extractPayoutCodeFromJotformBody(body), 'RP-ABCD-2345');
assert.strictEqual(
    extractPayoutCodeFromJotformBody({
        rawRequest: JSON.stringify({ q12_fullName: 'Test', q13_code: 'RP-HJKL-3456' }),
    }),
    'RP-HJKL-3456'
);

function secretsMatch(provided, expected) {
    if (!expected || !provided) return false;
    const a = Buffer.from(String(provided));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

assert.strictEqual(secretsMatch('secret', 'secret'), true);
assert.strictEqual(secretsMatch('wrong', 'secret'), false);

console.log('jotform-payout-webhook.test.js: ok');
