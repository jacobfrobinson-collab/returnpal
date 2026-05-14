const {
    normalizeSoldDateForDb,
    repairNovemberIsoMisimportForDisplay,
    repairDecemberIsoMisimportForDisplay,
} = require('./adminBulkImport');

/** Calendar sort key aligned with sold list display repairs (Nov/Dec mis-import). */
function sortKeySoldDate(row) {
    const canon = normalizeSoldDateForDb(row.sold_date);
    const raw = canon || String(row.sold_date || '').trim();
    const chain = repairDecemberIsoMisimportForDisplay(repairNovemberIsoMisimportForDisplay(raw));
    if (chain && /^\d{4}-\d{2}-\d{2}$/.test(String(chain))) return chain;
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
