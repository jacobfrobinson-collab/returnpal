/**
 * VAT registration affects client payout (no 20% withholding when registered).
 * Run: node test/client-vat-payout.test.js
 */

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const {
    clientPayoutFromGrossNet,
    invoiceVatOnFees,
    NON_VAT_CLIENT_PAYOUT_RATE,
} = require('../src/utils/clientVatPayout');

assert(NON_VAT_CLIENT_PAYOUT_RATE === 0.8, 'withholding rate');
assert(clientPayoutFromGrossNet(250, false) === 200, 'non-VAT: 20% withheld');
assert(clientPayoutFromGrossNet(250, true) === 250, 'VAT registered: full net');
assert(clientPayoutFromGrossNet(189.58, 1) === 189.58, 'VAT registered preserves amount');
assert(invoiceVatOnFees(50, true) === 10, 'VAT on processing fees');
assert(invoiceVatOnFees(100, false) === 0, 'no VAT on fees when not registered');

console.log('client-vat-payout: all checks passed');
