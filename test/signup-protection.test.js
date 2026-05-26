const assert = require('assert');
const {
    isDisposableEmail,
    validateSignupName,
    checkHoneypot,
    checkFormTiming,
} = require('../src/utils/signupProtection');

assert.strictEqual(isDisposableEmail('a@mailinator.com'), true);
assert.strictEqual(isDisposableEmail('a@gmail.com'), false);
assert.strictEqual(isDisposableEmail('b@sub.mailinator.com'), true);

assert.strictEqual(validateSignupName('Jo'), null);
assert.strictEqual(validateSignupName('John Smith'), null);
assert.ok(validateSignupName('a'));
assert.ok(validateSignupName('12345'));
assert.ok(validateSignupName('asdf'));
assert.ok(validateSignupName('test user'));

assert.strictEqual(checkHoneypot({ email: 'a@b.com' }), null);
assert.ok(checkHoneypot({ website: 'http://spam.com' }));

process.env.SIGNUP_MIN_FORM_SECONDS = '2';
assert.ok(checkFormTiming({ form_started_at: Date.now() }));
assert.strictEqual(checkFormTiming({ form_started_at: Date.now() - 5000 }), null);

console.log('signup-protection: all checks passed');
