const assert = require('assert');
const {
    isDateSentEligible,
    earliestEligibleDateSentYmd,
    normalizeDateSentYmd,
} = require('../src/utils/lostItemEnquiry');

function withFixedToday(ymd, fn) {
    const RealDate = Date;
    const [y, m, d] = ymd.split('-').map(Number);
    global.Date = class extends RealDate {
        constructor(...args) {
            if (args.length === 0) {
                super(y, m - 1, d);
            } else {
                super(...args);
            }
        }
        static now() {
            return new RealDate(y, m - 1, d).getTime();
        }
    };
    try {
        fn();
    } finally {
        global.Date = RealDate;
    }
}

withFixedToday('2026-06-01', () => {
    const cutoff = earliestEligibleDateSentYmd('Europe/London');
    assert.strictEqual(cutoff, '2026-04-01');

    assert.strictEqual(normalizeDateSentYmd('2026-03-15'), '2026-03-15');
    assert.strictEqual(normalizeDateSentYmd('bad'), null);

    const ok = isDateSentEligible('2026-03-01', 'Europe/London');
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.date_sent, '2026-03-01');

    const tooRecent = isDateSentEligible('2026-05-01', 'Europe/London');
    assert.strictEqual(tooRecent.ok, false);
    assert.ok(tooRecent.error.includes('2 months'));

    const future = isDateSentEligible('2026-07-01', 'Europe/London');
    assert.strictEqual(future.ok, false);
    assert.ok(future.error.includes('future'));
});

console.log('lost-item-enquiry.test.js: ok');
