const { normalizeSoldDateForDb } = require('./adminBulkImport');

/**
 * Most recently sold first (calendar order), then by row id descending.
 * @param {Array<Record<string, unknown>>} items
 * @returns {Array<Record<string, unknown>>}
 */
function sortSoldItemsByDateDesc(items) {
    const list = Array.isArray(items) ? items.slice() : [];
    list.sort((a, b) => {
        const ka = normalizeSoldDateForDb(a.sold_date) || '0000-00-00';
        const kb = normalizeSoldDateForDb(b.sold_date) || '0000-00-00';
        if (ka !== kb) return kb.localeCompare(ka);
        return (Number(b.id) || 0) - (Number(a.id) || 0);
    });
    return list;
}

module.exports = { sortSoldItemsByDateDesc };
