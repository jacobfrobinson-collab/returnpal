const assert = require('assert');
const {
    isSignupApprovalRequired,
    defaultAccountStatusForSignup,
    accountStatusBlocksAccess,
} = require('../src/utils/accountApproval');

const prev = process.env.SIGNUP_REQUIRE_ADMIN_APPROVAL;
process.env.SIGNUP_REQUIRE_ADMIN_APPROVAL = '0';
assert.strictEqual(isSignupApprovalRequired(), false);
assert.strictEqual(defaultAccountStatusForSignup(), 'approved');

process.env.SIGNUP_REQUIRE_ADMIN_APPROVAL = '1';
assert.strictEqual(isSignupApprovalRequired(), true);
assert.strictEqual(defaultAccountStatusForSignup(), 'pending');

assert.strictEqual(accountStatusBlocksAccess('pending', false), true);
assert.strictEqual(accountStatusBlocksAccess('pending', true), false);
assert.strictEqual(accountStatusBlocksAccess('approved', false), false);

process.env.SIGNUP_REQUIRE_ADMIN_APPROVAL = prev;
console.log('account-approval: all checks passed');
