/**
 * Sold date display helpers.
 *
 * Stored/API ISO dates YYYY-MM-DD are always calendar year → month (2nd segment) → day (3rd segment).
 * E.g. 2026-02-05 → February 5th 2026. No month/day swap on ISO (that was breaking correct rows).
 *
 * Legacy month/day swap repair is opt-in only: RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL=1
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

function monthDaySwapRepairEnabled() {
    return String(process.env.RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL || '').trim() === '1';
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

/** @param {unknown} iso YYYY-MM-DD — segment 2 = month, segment 3 = day (no Date parsing). */
function isoYmdToOrdinalLabel(iso) {
    const s = stripSoldDateToIsoHead(iso);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    if (!Number.isFinite(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    return MONTH_NAMES[mo - 1] + ' ' + dayWithOrdinal(d) + ' ' + y;
}

/** @deprecated alias */
function formatOrdinalEnGbFromIso(iso) {
    return isoYmdToOrdinalLabel(iso);
}

/**
 * @param {unknown} iso
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
 * Resolve display ISO + label: YYYY-MM-DD = year, month (2nd), day (3rd). No swap on ISO.
 * @param {unknown} rawSoldDate
 * @param {(v: unknown) => string|null} normalizeSoldDateForDb
 */
function mapSoldItemDatesForApi(rawSoldDate, normalizeSoldDateForDb) {
    let iso = normalizeSoldDateForDb(rawSoldDate);
    if (!iso) {
        const head = stripSoldDateToIsoHead(rawSoldDate);
        if (/^\d{4}-\d{2}-\d{2}$/.test(head)) iso = head;
        else if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(head)) iso = normalizeSoldDateForDb(head);
    }
    const isoFinal = iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : stripSoldDateToIsoHead(rawSoldDate);
    const label = /^\d{4}-\d{2}-\d{2}$/.test(String(isoFinal))
        ? isoYmdToOrdinalLabel(isoFinal)
        : '';
    return {
        iso: isoFinal || '',
        label: label || '',
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
    tryRepairMonthDaySwap,
    repairAllMonthDaySwapIsoMisimportForDisplay,
    repairNovemberIsoMisimportForDisplay,
    repairDecemberIsoMisimportForDisplay,
    isoYmdToOrdinalLabel,
    formatOrdinalEnGbFromIso,
    mapSoldItemDatesForApi,
    monthDaySwapRepairEnabled,
};
