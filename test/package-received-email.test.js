'use strict';

const assert = require('assert');
const { buildPackageReceivedEmail } = require('../src/utils/sendTransactionalEmail');

process.env.PUBLIC_APP_URL = 'https://www.returnpal.co.uk';

const { html, text, subject } = buildPackageReceivedEmail({
    name: 'Jane Seller',
    reference: 'RM123456789GB',
    description: 'iPhone case ×2, USB cable',
    recipientEmail: 'jane@example.com',
    receivedAt: new Date('2026-06-01T12:00:00Z'),
});

assert.ok(subject.includes('RM123456789GB'));
assert.ok(html.includes('<!DOCTYPE html>'));
assert.ok(html.includes('Parcel checked in'));
assert.ok(html.includes('Parcel details'));
assert.ok(html.includes('RM123456789GB'));
assert.ok(html.includes('Checked in'));
assert.ok(html.includes('What happens next'));
assert.ok(html.includes('iPhone case'));
assert.ok(html.includes('#128BD0'));
assert.ok(html.includes('jane@example.com'));
assert.ok(text.includes('Jane Seller'));
assert.ok(text.includes('View received items'));

console.log('package-received-email.test.js: ok');
