const { normalizeSoldDateForDb } = require('./adminBulkImport');
const { stripSoldDateToIsoHead, resolveSoldDateIsoForDisplay } = require('./soldDateDisplayRepair');

/** Calendar sort key (same display repairs as sold list). */
function sortKeySoldDate(row) {
    const canon = normalizeSoldDateForDb(row.sold_date);
    const head = canon || stripSoldDateToIsoHead(row.sold_date);
    if (head && /^\d{4}-\d{2}-\d{2}$/.test(String(head))) return resolveSoldDateIsoForDisplay(head);
    return canon || '0000-00-00';
}

/**
 * Most recently sold first (calendar order), then by row id descending.
 * @param {Array<Record<string, unknown>>} items
 * @returns {Array<Record<string, unknown>>}
 */
function sortSoldItemsByDateDesc(items) {
    const list = Array.isArray(items) ? items.slice() : [];
    list.sort((a, b) => {
        const ka = sortKeySoldDate(a);
        const kb = sortKeySoldDate(b);
        if (ka !== kb) return kb.localeCompare(ka);
        return (Number(b.id) || 0) - (Number(a.id) || 0);
    });
    return list;
}

module.exports = { sortSoldItemsByDateDesc };
