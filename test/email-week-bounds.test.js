const assert = require('assert');
const { calendarWeekMonSun, weekLabel } = require('../src/utils/emailWeekBounds');

/** 2026-06-07 is a Sunday in UK — week is Mon 1 Jun – Sun 7 Jun. */
const bounds = calendarWeekMonSun(new Date('2026-06-07T17:00:00Z'), 'Europe/London');
assert.strictEqual(bounds.startYmd, '2026-06-01');
assert.strictEqual(bounds.endYmd, '2026-06-07');

/** 2026-06-08 is a Monday — new week Mon 8 – Sun 14. */
const mon = calendarWeekMonSun(new Date('2026-06-08T10:00:00Z'), 'Europe/London');
assert.strictEqual(mon.startYmd, '2026-06-08');
assert.strictEqual(mon.endYmd, '2026-06-14');

assert.ok(weekLabel('2026-06-02', '2026-06-08').includes('Jun'));

console.log('email-week-bounds.test.js: ok');
