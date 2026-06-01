/**
 * Unit tests for sold_date → calendar month (no server).
 * Run: npm run test:unit
 */

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const { calendarYearMonthFromDbDate, calendarIsoDateFromDbDate } = require('../src/utils/soldDateCalendar');
const { normalizeSoldDateForDb } = require('../src/utils/adminBulkImport');
const {
    repairAllMonthDaySwapIsoMisimportForDisplay,
    repairNovemberIsoMisimportForDisplay,
    repairDecemberIsoMisimportForDisplay,
    mapSoldItemDatesForApi,
} = require('../src/utils/soldDateDisplayRepair');

function withAllMonthDaySwapRepair(on, fn) {
    const had = Object.prototype.hasOwnProperty.call(process.env, 'RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL');
    const prev = process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL;
    process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL = on ? '1' : '0';
    try {
        fn();
    } finally {
        if (had) process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL = prev;
        else delete process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL;
    }
}

function withNovemberRepair(on, fn) {
    const had = Object.prototype.hasOwnProperty.call(process.env, 'RETURNPAL_SOLD_DISPLAY_REPAIR_NOVEMBER_ISO');
    const prev = process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_NOVEMBER_ISO;
    process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_NOVEMBER_ISO = on ? '1' : '0';
    try {
        fn();
    } finally {
        if (had) process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_NOVEMBER_ISO = prev;
        else delete process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_NOVEMBER_ISO;
    }
}

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

function withSpringDayRepair(on, fn) {
    const had = Object.prototype.hasOwnProperty.call(process.env, 'RETURNPAL_SOLD_DISPLAY_REPAIR_SPRING_DAY_ISO');
    const prev = process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_SPRING_DAY_ISO;
    process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_SPRING_DAY_ISO = on ? '1' : '0';
    try {
        fn();
    } finally {
        if (had) process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_SPRING_DAY_ISO = prev;
        else delete process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_SPRING_DAY_ISO;
    }
}

function withLegacyStorage(fn) {
    const had = Object.prototype.hasOwnProperty.call(process.env, 'RETURNPAL_SOLD_DATES_LEGACY');
    const prev = process.env.RETURNPAL_SOLD_DATES_LEGACY;
    process.env.RETURNPAL_SOLD_DATES_LEGACY = '1';
    try {
        fn();
    } finally {
        if (had) process.env.RETURNPAL_SOLD_DATES_LEGACY = prev;
        else delete process.env.RETURNPAL_SOLD_DATES_LEGACY;
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

    assert(calendarIsoDateFromDbDate('2026-05-04') === '2026-05-04', 'canonical default: 5 May');
    assert(calendarYearMonthFromDbDate('2026-05-04') === '2026-05', 'May invoice month');

    withLegacyStorage(() => {
        assert(
            calendarIsoDateFromDbDate('2026-05-04') === '2026-04-05',
            'legacy mode: 2026-05-04 → 5 April'
        );
        assert(calendarYearMonthFromDbDate('2026-05-04') === '2026-04', 'legacy April month');
    });

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
    assert(normalizeSoldDateForDb('2026-02-05') === '2026-02-05', 'ISO 2026-02-05 = 5 February');
    withAmbiguousOrder('MDY', () => {
        assert(normalizeSoldDateForDb('2026-01-04') === '2026-01-04', 'Leading ISO not overridden by MDY');
    });

    {
        const feb = mapSoldItemDatesForApi('2026-02-05', normalizeSoldDateForDb);
        assert(feb.iso === '2026-02-05', 'canonical API map: 5 February');
        assert(feb.label === 'February 5th 2026', 'Feb 5 label');
        const sep = mapSoldItemDatesForApi('2026-09-03', normalizeSoldDateForDb);
        assert(sep.label === 'September 3rd 2026', '2026-09-03 → 3 September');

        withLegacyStorage(() => {
            const febLegacy = mapSoldItemDatesForApi('2026-02-05', normalizeSoldDateForDb);
            assert(febLegacy.iso === '2026-05-02', 'legacy API map: May 2');
            assert(febLegacy.label === 'May 2nd 2026', 'legacy May 2 label');
            const sepLegacy = mapSoldItemDatesForApi('2026-09-03', normalizeSoldDateForDb);
            assert(sepLegacy.label === 'March 9th 2026', 'legacy 9 March');
        });

        const had = Object.prototype.hasOwnProperty.call(process.env, 'RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL');
        const prev = process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL;
        delete process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL;
        try {
            assert(
                repairAllMonthDaySwapIsoMisimportForDisplay('2026-02-05') === '2026-02-05',
                'Default: no month/day swap on ISO (Feb 5 stays)'
            );
            assert(
                repairAllMonthDaySwapIsoMisimportForDisplay('2026-10-04') === '2026-10-04',
                'Default: Oct 4 ISO not swapped to April'
            );
        } finally {
            if (had) process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL = prev;
            else delete process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL;
        }
    }

    withAllMonthDaySwapRepair(true, () => {
        withDecemberRepair(false, () => {
            assert(repairDecemberIsoMisimportForDisplay('2026-12-04') === '2026-12-04', 'December repair off leaves ISO as-is');
        });
        withDecemberRepair(true, () => {
            assert(repairDecemberIsoMisimportForDisplay('2026-12-04') === '2026-04-12', 'December repair on: common mis-import');
            assert(repairDecemberIsoMisimportForDisplay('2026-12-01') === '2026-01-12', 'Dec 1 → 12 Jan when legacy repair on');
        });

        withNovemberRepair(false, () => {
            assert(repairNovemberIsoMisimportForDisplay('2026-11-04') === '2026-11-04', 'November repair off leaves ISO as-is');
        });
        withNovemberRepair(true, () => {
            assert(repairNovemberIsoMisimportForDisplay('2026-11-04') === '2026-04-11', 'November repair on: 11 Apr mis-stored as Nov 4');
            assert(repairNovemberIsoMisimportForDisplay('2026-11-12') === '2026-11-12', 'Nov 12 unchanged');
            assert(repairNovemberIsoMisimportForDisplay('2026-11-01') === '2026-01-11', 'Nov 1 → 11 Jan when legacy repair on');
        });

        assert(
            repairAllMonthDaySwapIsoMisimportForDisplay('2026-10-04') === '2026-04-10',
            'Legacy repair on: 10 Apr mis-stored as 2026-10-04'
        );
        assert(
            repairAllMonthDaySwapIsoMisimportForDisplay('2026-10-04 00:00:00') === '2026-04-10',
            'Legacy repair: datetime suffix stripped'
        );

        withSpringDayRepair(false, () => {
            assert(
                repairAllMonthDaySwapIsoMisimportForDisplay('2026-10-04') === '2026-10-04',
                'Spring-day sub-flag off: October swap skipped'
            );
        });
    });

    withAllMonthDaySwapRepair(false, () => {
        assert(
            repairAllMonthDaySwapIsoMisimportForDisplay('2026-10-04') === '2026-10-04',
            'MONTH_DAY_SWAP_ALL not 1: no display swap'
        );
    });

    console.log('sold-date-calendar: all checks passed');
}

run();
process.exit(0);
