/**
 * RP_DATE.formatOrdinalEnGb (loaded via dateUk.js in browser; global in Node).
 */
require('../public/assets/js/dateUk.js');

const assert = require('assert');
const { formatOrdinalEnGb } = global.RP_DATE;

assert.strictEqual(formatOrdinalEnGb('2026-05-01'), 'May 1st 2026');
assert.strictEqual(formatOrdinalEnGb('2026-05-22'), 'May 22nd 2026');
assert.strictEqual(formatOrdinalEnGb('2026-05-23'), 'May 23rd 2026');
assert.strictEqual(formatOrdinalEnGb('2026-05-11'), 'May 11th 2026');
assert.strictEqual(formatOrdinalEnGb('2026-12-31'), 'December 31st 2026');
console.log('ordinal-date-display: ok');
