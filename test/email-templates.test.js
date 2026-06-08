/**
 * Branded email template helpers (no live SMTP).
 */
const assert = require('assert');
const {
    formatGbp,
    wrapBrandedEmail,
    summaryTableHtml,
    heroAmountBlock,
} = require('../src/utils/emailTemplates');

process.env.PUBLIC_APP_URL = 'https://www.returnpal.co.uk';

assert.strictEqual(formatGbp(12.5), '£12.50');
assert.strictEqual(formatGbp(-3), '-£3.00');

const html = wrapBrandedEmail({
    title: 'Test',
    subtitle: 'Sub',
    bodyHtml: '<p>Body</p>',
    recipientEmail: 'user@example.com',
    preheader: 'Preview',
});
assert.ok(html.includes('ReturnPal'));
assert.ok(html.includes('#128BD0'));
assert.ok(html.includes('user@example.com'));
assert.ok(html.includes('<!DOCTYPE html>'));

const table = summaryTableHtml('Period summary', [
    { label: 'Sales', value: '£10.00', emphasis: true },
]);
assert.ok(table.includes('Period summary'));
assert.ok(table.includes('£10.00'));

const hero = heroAmountBlock({
    label: 'Payout',
    amount: 99,
    statusLabel: 'Paid',
    statusTone: 'success',
});
assert.ok(hero.includes('£99.00'));
assert.ok(hero.includes('Paid'));

console.log('email-templates.test.js: ok');
