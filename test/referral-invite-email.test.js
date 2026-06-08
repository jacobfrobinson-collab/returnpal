const assert = require('assert');
const { buildReferralInviteEmail } = require('../src/utils/sendReferralInviteEmail');

const built = buildReferralInviteEmail({
    inviteeEmail: 'seller@example.com',
    referrerName: 'Jane Seller',
    referralLink: 'https://www.returnpal.co.uk/register.html?ref=RP16',
    personalMessage: 'You should try this. It saved me a fortune on returns.',
});

assert.ok(built.subject.includes("Jane Seller thinks you'll love this"));
assert.ok(built.html.includes('Jane Seller'));
assert.ok(built.html.includes('register.html?ref=RP16'));
assert.ok(built.html.includes('Sign up for ReturnPal'));
assert.ok(built.html.includes('ReturnPal vs typical returns services'));
assert.ok(built.html.includes('Best route for best value'));
assert.ok(built.html.includes('Often listed on eBay'));
assert.ok(!built.html.includes('\u2014'));
assert.ok(built.html.includes('You should try this'));
assert.ok(built.text.includes('Jane Seller'));

console.log('referral-invite-email.test.js: ok');
