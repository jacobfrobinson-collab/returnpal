/**
 * Sold date display helpers.
 *
 * Stored sold_date values look like YYYY-MM-DD but mean YYYY-DD-MM:
 *   1st segment = year, 2nd = day of month, 3rd = month (1–12).
 * E.g. 2026-11-01 → 11 January 2026; 2026-09-03 → 9 March 2026.
 *
 * Display/sort ISO returned to clients is calendar YYYY-MM-DD (year-month-day).
 *
 * Legacy month/day swap repair is opt-in: RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL=1
 */

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

/** @param {unknown} v */
function stripSoldDateToIsoHead(v) {
    let s0 = String(v == null ? '' : v)
        .replace(/^\uFEFF/, '')
        .trim()
        .replace(/\u00A0/g, ' ')
        .replace(/\u2007/g, ' ');
    if (!s0) return '';
    if (s0.startsWith("'")) s0 = s0.slice(1).trim();
    if (s0.length >= 2 && s0.startsWith('"') && s0.endsWith('"')) s0 = s0.slice(1, -1).trim();
    const tIdx = s0.indexOf('T');
    if (tIdx !== -1) s0 = s0.slice(0, tIdx).trim();
    else if (/^\d{4}-\d{2}-\d{2}\s/.test(s0)) {
        const m = s0.match(/^(\d{4}-\d{2}-\d{2})/);
        if (m) s0 = m[1];
    }
    if (/\d{1,2}:\d{2}/.test(s0)) {
        s0 = s0.replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(\s*[AaPp][Mm])?.*$/, '').trim();
    }
    return s0;
}

/**
 * Parse stored YYYY-DD-MM.
 * @param {unknown} iso
 * @returns {{ y: number, day: number, month: number }|null}
 */
function parseStoredSoldYmd(iso) {
    const s = stripSoldDateToIsoHead(iso);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const y = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    const month = parseInt(m[3], 10);
    if (!Number.isFinite(y) || month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { y, day, month };
}

/** Calendar YYYY-MM-DD for sort and API sold_date / sold_date_display. */
function storedSoldYmdToCalendarIso(iso) {
    const p = parseStoredSoldYmd(iso);
    if (!p) return stripSoldDateToIsoHead(iso) || String(iso == null ? '' : iso);
    return (
        String(p.y) +
        '-' +
        String(p.month).padStart(2, '0') +
        '-' +
        String(p.day).padStart(2, '0')
    );
}

/**
 * Calendar sale date → legacy dashboard storage wire (YYYY-DD-MM: year, day, month).
 * Use in payout / bulk-import CSV when production still reads sold_date in legacy mode.
 * @param {unknown} iso calendar YYYY-MM-DD
 */
function calendarIsoToLegacyStoredIso(iso) {
    const s = stripSoldDateToIsoHead(iso);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return s || String(iso == null ? '' : iso);
    return m[1] + '-' + m[3] + '-' + m[2];
}

function monthDaySwapRepairEnabled() {
    return String(process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL || '').trim() === '1';
}

const { soldDatesCanonicalStorage } = require('./soldDateStorageMode');

/** @deprecated jan-day hack; stored format is YYYY-DD-MM — no-op when parse succeeds */
function repairIsoFirstOfMonthToJanuary(iso) {
    return stripSoldDateToIsoHead(iso) || iso;
}

function janDayRepairEnabled() {
    return false;
}

/** Canonical display/sort ISO (calendar). */
function resolveSoldDateIsoForDisplay(iso) {
    let s = storedSoldYmdToCalendarIso(iso);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return stripSoldDateToIsoHead(iso);
    if (monthDaySwapRepairEnabled()) s = repairAllMonthDaySwapIsoMisimportForDisplay(s);
    return s;
}

function repairEnvOff(name) {
    return String(process.env[name] || '').trim() === '0';
}

function dayWithOrdinal(n) {
    const d = Math.floor(Math.abs(Number(n)) || 0);
    if (d < 1 || d > 31) return String(n);
    const j = d % 10;
    const k = d % 100;
    if (k >= 11 && k <= 13) return d + 'th';
    if (j === 1) return d + 'st';
    if (j === 2) return d + 'nd';
    if (j === 3) return d + 'rd';
    return d + 'th';
}

/** User-facing label from stored YYYY-DD-MM. */
function storedSoldYmdToOrdinalLabel(iso) {
    const p = parseStoredSoldYmd(iso);
    if (!p) return '';
    return MONTH_NAMES[p.month - 1] + ' ' + dayWithOrdinal(p.day) + ' ' + p.y;
}

/** @param {unknown} iso stored YYYY-DD-MM */
function isoYmdToOrdinalLabel(iso) {
    return storedSoldYmdToOrdinalLabel(iso);
}

/** @deprecated alias */
function formatOrdinalEnGbFromIso(iso) {
    return storedSoldYmdToOrdinalLabel(iso);
}

/**
 * @param {unknown} iso calendar or stored — used only by legacy swap repair
 * @param {number} mo middle month 1..12
 * @param {{ decemberOff?: boolean, novemberOff?: boolean, springOff?: boolean, allOff?: boolean }} [opts]
 */
function tryRepairMonthDaySwap(iso, mo, opts) {
    const s0 = stripSoldDateToIsoHead(iso);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s0)) return s0;
    const o = opts || {};
    if (o.allOff || !monthDaySwapRepairEnabled()) return s0;
    if (mo === 12 && (o.decemberOff || repairEnvOff('RETURNPAL_SOLD_DISPLAY_REPAIR_DECEMBER_ISO'))) return s0;
    if (mo === 11 && (o.novemberOff || repairEnvOff('RETURNPAL_SOLD_DISPLAY_REPAIR_NOVEMBER_ISO'))) return s0;
    if (mo >= 1 && mo <= 10 && (o.springOff || repairEnvOff('RETURNPAL_SOLD_DISPLAY_REPAIR_SPRING_DAY_ISO'))) {
        return s0;
    }
    const mm = String(mo).padStart(2, '0');
    const m = s0.match(new RegExp(`^(\\d{4})-${mm}-(\\d{1,2})$`));
    if (!m) return s0;
    const y = parseInt(m[1], 10);
    const d = parseInt(m[2], 10);
    if (!Number.isFinite(y) || !Number.isFinite(d)) return s0;
    if (d === 1 && mo !== 1) return y + '-01-' + mm;
    if (d < 2 || d > 11 || d === mo) return s0;
    return y + '-' + String(d).padStart(2, '0') + '-' + mm;
}

/** @param {unknown} iso */
function repairAllMonthDaySwapIsoMisimportForDisplay(iso) {
    if (!monthDaySwapRepairEnabled()) return stripSoldDateToIsoHead(iso) || iso;
    let s = stripSoldDateToIsoHead(iso);
    if (!s) return iso;
    for (const mo of [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]) {
        const n = tryRepairMonthDaySwap(s, mo);
        if (n !== s) return n;
    }
    return s;
}

/**
 * @param {unknown} rawSoldDate
 * @param {(v: unknown) => string|null} normalizeSoldDateForDb
 */
/** Ordinal label from calendar YYYY-MM-DD (post-migration storage). */
function calendarIsoToOrdinalLabel(iso) {
    const s = stripSoldDateToIsoHead(iso);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    if (mo < 1 || mo > 12 || day < 1 || day > 31) return '';
    return MONTH_NAMES[mo - 1] + ' ' + dayWithOrdinal(day) + ' ' + y;
}

function mapSoldItemDatesForApi(rawSoldDate, normalizeSoldDateForDb) {
    const storedHead = stripSoldDateToIsoHead(rawSoldDate);

    if (!soldDatesCanonicalStorage() && /^\d{4}-\d{2}-\d{2}$/.test(storedHead)) {
        const isoFinal = resolveSoldDateIsoForDisplay(storedHead);
        return {
            iso: isoFinal,
            label: storedSoldYmdToOrdinalLabel(storedHead) || '',
            stored: rawSoldDate,
        };
    }

    let iso = normalizeSoldDateForDb(rawSoldDate);
    if (!iso && /^\d{4}-\d{2}-\d{2}$/.test(storedHead)) iso = storedHead;
    if (!iso && /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(storedHead)) {
        iso = normalizeSoldDateForDb(storedHead);
    }
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
        return { iso: '', label: '', stored: rawSoldDate };
    }
    let isoFinal = iso;
    if (monthDaySwapRepairEnabled()) {
        isoFinal = repairAllMonthDaySwapIsoMisimportForDisplay(iso);
    }
    return {
        iso: isoFinal,
        label: calendarIsoToOrdinalLabel(isoFinal) || '',
        stored: rawSoldDate,
    };
}

/** @deprecated */
function repairNovemberIsoMisimportForDisplay(iso) {
    return tryRepairMonthDaySwap(iso, 11);
}

/** @deprecated */
function repairDecemberIsoMisimportForDisplay(iso) {
    return tryRepairMonthDaySwap(iso, 12);
}

module.exports = {
    stripSoldDateToIsoHead,
    parseStoredSoldYmd,
    storedSoldYmdToCalendarIso,
    calendarIsoToLegacyStoredIso,
    storedSoldYmdToOrdinalLabel,
    calendarIsoToOrdinalLabel,
    repairIsoFirstOfMonthToJanuary,
    resolveSoldDateIsoForDisplay,
    tryRepairMonthDaySwap,
    repairAllMonthDaySwapIsoMisimportForDisplay,
    repairNovemberIsoMisimportForDisplay,
    repairDecemberIsoMisimportForDisplay,
    isoYmdToOrdinalLabel,
    formatOrdinalEnGbFromIso,
    mapSoldItemDatesForApi,
    monthDaySwapRepairEnabled,
    soldDatesCanonicalStorage,
    janDayRepairEnabled,
};
