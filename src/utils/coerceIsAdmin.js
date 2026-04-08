/** Normalise DB / JSON admin flags to boolean (sql.js may return 0/1, null, string, or BigInt). */
function coerceIsAdmin(value) {
    if (value === true || value === 1 || value === 1n) return true;
    if (value === false || value === 0 || value === 0n || value == null || value === '') return false;
    if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        return s === '1' || s === 'true';
    }
    return Boolean(value);
}

module.exports = { coerceIsAdmin };
