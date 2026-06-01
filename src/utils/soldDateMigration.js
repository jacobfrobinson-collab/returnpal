/**
 * One-time migration: legacy YYYY-DD-MM stored strings → calendar YYYY-MM-DD.
 * Matches what the sold dashboard displayed before migration.
 */

const { normalizeSoldDateForDb } = require('./adminBulkImport');
const { stripSoldDateToIsoHead, parseStoredSoldYmd, storedSoldYmdToCalendarIso } = require('./soldDateDisplayRepair');

/**
 * @param {unknown} raw
 * @returns {{ y: number, mid: number, last: number }|null}
 */
function parseIsoSegments(raw) {
    const head = stripSoldDateToIsoHead(raw);
    const m = head.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return {
        y: parseInt(m[1], 10),
        mid: parseInt(m[2], 10),
        last: parseInt(m[3], 10),
    };
}

/**
 * @param {unknown} raw
 * @returns {{
 *   iso: string|null,
 *   ambiguous: boolean,
 *   strategy: string,
 *   legacyIso?: string|null,
 *   directIso?: string|null,
 *   legacyYm?: string|null,
 *   directYm?: string|null,
 * }}
 */
function computeCanonicalSoldDate(raw) {
    const head = stripSoldDateToIsoHead(raw);
    if (!head) {
        return { iso: null, ambiguous: false, strategy: 'empty' };
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(head)) {
        const norm = normalizeSoldDateForDb(raw);
        return {
            iso: norm,
            ambiguous: false,
            strategy: norm ? 'normalize_non_iso' : 'unparseable',
        };
    }

    const directIso = normalizeSoldDateForDb(head);
    const legacyIso = parseStoredSoldYmd(head) ? storedSoldYmdToCalendarIso(head) : head;

    const seg = parseIsoSegments(head);
    if (seg && seg.mid > 12) {
        return {
            iso: directIso || head,
            ambiguous: false,
            strategy: 'calendar_mid_gt_12',
            legacyIso,
            directIso: directIso || head,
        };
    }
    if (seg && seg.last > 12) {
        return {
            iso: legacyIso,
            ambiguous: false,
            strategy: 'legacy_last_gt_12',
            legacyIso,
            directIso,
        };
    }

    const legacyYm = legacyIso && legacyIso.length >= 7 ? legacyIso.slice(0, 7) : null;
    const directYm = directIso && directIso.length >= 7 ? directIso.slice(0, 7) : null;
    const ambiguous = !!(legacyYm && directYm && legacyYm !== directYm);

    if (legacyIso === head && directIso === head) {
        return {
            iso: head,
            ambiguous: false,
            strategy: 'already_canonical',
            legacyIso,
            directIso,
        };
    }

    if (ambiguous) {
        return {
            iso: legacyIso,
            ambiguous: true,
            strategy: 'legacy_ambiguous',
            legacyIso,
            directIso,
            legacyYm,
            directYm,
        };
    }

    return {
        iso: legacyIso || directIso || head,
        ambiguous: false,
        strategy: legacyIso !== head ? 'legacy_convert' : 'direct',
        legacyIso,
        directIso,
    };
}

module.exports = {
    computeCanonicalSoldDate,
    parseIsoSegments,
};
