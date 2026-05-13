/**
 * Unit tests for sold_date → calendar month (no server).
 * Run: npm run test:unit
 */

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const { calendarYearMonthFromDbDate, calendarIsoDateFromDbDate } = require('../src/utils/soldDateCalendar');

function run() {
    assert(calendarYearMonthFromDbDate('2026-03-25') === '2026-03', 'ISO date → March 2026');
    assert(calendarIsoDateFromDbDate('2026-03-25') === '2026-03-25', 'ISO passthrough');

    assert(calendarYearMonthFromDbDate('2026-03-25 10:00:00') === '2026-03', 'datetime without T');
    assert(calendarYearMonthFromDbDate('2026-03-25T12:00:00.000Z') === '2026-03', 'ISO with Z');

    assert(calendarYearMonthFromDbDate('25/03/2026') === '2026-03', 'UK DMY clear day>12 not needed when day=25');

    assert(calendarYearMonthFromDbDate(null) === null, 'null → null');
    assert(calendarYearMonthFromDbDate('') === null, 'empty → null');
    assert(calendarYearMonthFromDbDate('not a date') === null, 'garbage → null');

    const excelYm = calendarYearMonthFromDbDate('45995');
    assert(excelYm && /^\d{4}-\d{2}$/.test(excelYm), 'Excel serial string should yield valid YYYY-MM');

    console.log('sold-date-calendar: all checks passed');
}

run();
