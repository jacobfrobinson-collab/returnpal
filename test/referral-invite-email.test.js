const assert = require('assert');
const { buildReferralInviteEmail } = require('../src/utils/sendReferralInviteEmail');

const built = buildReferralInviteEmail({
    inviteeEmail: 'seller@example.com',
    referrerName: 'Jane Seller',
    referralLink: 'https://www.returnpal.co.uk/register.html?ref=RP16',
    personalMessage: 'You should try this — it saved me a fortune on returns.',
});

assert.ok(built.subject.includes('Jane Seller'));
assert.ok(built.html.includes('Jane Seller'));
assert.ok(built.html.includes('register.html?ref=RP16'));
assert.ok(built.html.includes('Create your free ReturnPal account'));
assert.ok(built.html.includes('You should try this'));
assert.ok(built.text.includes('Jane Seller'));

console.log('referral-invite-email.test.js: ok');
