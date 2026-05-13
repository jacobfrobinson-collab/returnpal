/**
 * Unit tests for sold_date → calendar month (no server).
 * Run: npm run test:unit
 */

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const { calendarYearMonthFromDbDate, calendarIsoDateFromDbDate } = require('../src/utils/soldDateCalendar');
const { normalizeSoldDateForDb, repairDecemberIsoMisimportForDisplay } = require('../src/utils/adminBulkImport');

/** @param {string|undefined|null} order '' to clear to default DMY */
function withDecemberRepair(on, fn) {
    const had = Object.prototype.hasOwnProperty.call(process.env, 'RETURNPAL_SOLD_DISPLAY_REPAIR_DECEMBER_ISO');
    const prev = process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_DECEMBER_ISO;
    process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_DECEMBER_ISO = on ? '1' : '0';
    try {
        fn();
    } finally {
        if (had) process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_DECEMBER_ISO = prev;
        else delete process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_DECEMBER_ISO;
    }
}

function withAmbiguousOrder(order, fn) {
    const had = Object.prototype.hasOwnProperty.call(process.env, 'RETURNPAL_AMBIGUOUS_DATE_ORDER');
    const prev = process.env.RETURNPAL_AMBIGUOUS_DATE_ORDER;
    if (order == null || order === '') delete process.env.RETURNPAL_AMBIGUOUS_DATE_ORDER;
    else process.env.RETURNPAL_AMBIGUOUS_DATE_ORDER = order;
    try {
        fn();
    } finally {
        if (had) process.env.RETURNPAL_AMBIGUOUS_DATE_ORDER = prev;
        else delete process.env.RETURNPAL_AMBIGUOUS_DATE_ORDER;
    }
}

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

    withAmbiguousOrder('', () => {
        assert(normalizeSoldDateForDb('04/12/2026') === '2026-12-04', 'DMY default: 04/12/2026 → 4 Dec');
        assert(normalizeSoldDateForDb('12/04/2026') === '2026-04-12', 'DMY default: 12/04/2026 → 12 Apr');
        assert(normalizeSoldDateForDb('04-12-2026') === '2026-12-04', 'DMY dashed: 04-12-2026 → 4 Dec');
    });
    withAmbiguousOrder('MDY', () => {
        assert(normalizeSoldDateForDb('04/12/2026') === '2026-04-12', 'MDY: 04/12/2026 → 12 Apr');
        assert(normalizeSoldDateForDb('12/04/2026') === '2026-12-04', 'MDY: 12/04/2026 → 4 Dec');
        assert(normalizeSoldDateForDb('04-12-2026') === '2026-04-12', 'MDY dashed: 04-12-2026 → 12 Apr');
    });

    assert(normalizeSoldDateForDb('2026-01-04') === '2026-01-04', 'Leading ISO YYYY-MM-DD unchanged (4 Jan)');
    withAmbiguousOrder('MDY', () => {
        assert(normalizeSoldDateForDb('2026-01-04') === '2026-01-04', 'Leading ISO not overridden by MDY');
    });

    {
        const had = Object.prototype.hasOwnProperty.call(process.env, 'RETURNPAL_SOLD_DISPLAY_REPAIR_DECEMBER_ISO');
        const prev = process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_DECEMBER_ISO;
        delete process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_DECEMBER_ISO;
        try {
            assert(
                repairDecemberIsoMisimportForDisplay('2026-12-04') === '2026-04-12',
                'Default (env unset): repair 12 Apr mis-stored as 2026-12-04'
            );
            assert(repairDecemberIsoMisimportForDisplay('2026-12-12') === '2026-12-12', 'Dec 12 unchanged when repair default on');
        } finally {
            if (had) process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_DECEMBER_ISO = prev;
            else delete process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_DECEMBER_ISO;
        }
    }

    withDecemberRepair(false, () => {
        assert(repairDecemberIsoMisimportForDisplay('2026-12-04') === '2026-12-04', 'December repair off leaves ISO as-is');
    });
    withDecemberRepair(true, () => {
        assert(repairDecemberIsoMisimportForDisplay('2026-12-04') === '2026-04-12', 'December repair on: common mis-import');
        assert(repairDecemberIsoMisimportForDisplay('2026-12-01') === '2026-12-01', 'Dec 1 not rewritten');
    });

    console.log('sold-date-calendar: all checks passed');
}

run();
