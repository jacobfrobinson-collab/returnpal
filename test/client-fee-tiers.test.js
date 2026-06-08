const assert = require('assert');
const {
    clientShareRateTiered,
    clientShareRateForValue,
    feePercentForValue,
    FEE_TIERS,
} = require('../src/utils/clientFeeTiers');

assert.strictEqual(clientShareRateTiered(50), 0.75);
assert.strictEqual(clientShareRateTiered(50.01), 0.8);
assert.strictEqual(clientShareRateTiered(150), 0.8);
assert.strictEqual(clientShareRateTiered(150.01), 0.85);
assert.strictEqual(feePercentForValue(100, '2026-06-01'), 0.2);
assert.ok(FEE_TIERS.length === 3);
assert.strictEqual(FEE_TIERS[0].fee_percent, 0.25);
assert.strictEqual(FEE_TIERS[1].fee_percent, 0.2);
assert.strictEqual(FEE_TIERS[2].fee_percent, 0.15);
assert.strictEqual(clientShareRateForValue(100, '2024-01-01'), 0.75, 'legacy flat before tiered-since');

console.log('client-fee-tiers.test.js: ok');
