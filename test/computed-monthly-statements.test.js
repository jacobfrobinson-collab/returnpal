/**
 * Unit tests for computed monthly statement schedule (issue / payout months).
 */

const assert = require('assert');
const {
    statementIssueDateStr,
    statementPayoutEndDateStr,
    computeStatementStatus,
    calendarTodayYmdInTz
} = require('../src/utils/computedMonthlyStatements');

function test(name, fn) {
    try {
        fn();
        console.log('  ✓', name);
    } catch (e) {
        console.error('  ✗', name, e.message);
        process.exitCode = 1;
    }
}

console.log('computed-monthly-statements');

test('April sales → issue May 1, due May 31', () => {
    assert.strictEqual(statementIssueDateStr(2026, 4), '2026-05-01');
    assert.strictEqual(statementPayoutEndDateStr(2026, 4), '2026-05-31');
});

test('December sales → issue Jan 1 next year, due Jan 31', () => {
    assert.strictEqual(statementIssueDateStr(2025, 12), '2026-01-01');
    assert.strictEqual(statementPayoutEndDateStr(2025, 12), '2026-01-31');
});

test('January sales → issue Feb 1, due Feb end', () => {
    assert.strictEqual(statementIssueDateStr(2026, 1), '2026-02-01');
    assert.strictEqual(statementPayoutEndDateStr(2026, 1), '2026-02-28');
});

test('computeStatementStatus: past due is Paid', () => {
    assert.strictEqual(computeStatementStatus('2000-01-15', 'UTC'), 'Paid');
});

test('computeStatementStatus: far future due is Pending', () => {
    assert.strictEqual(computeStatementStatus('2099-12-31', 'UTC'), 'Pending');
});

test('calendarTodayYmdInTz returns YYYY-MM-DD', () => {
    const s = calendarTodayYmdInTz('Europe/London');
    assert(/^\d{4}-\d{2}-\d{2}$/.test(s), 'expected ISO date ' + s);
});

console.log(process.exitCode ? 'Some tests failed.' : 'All tests passed.');
