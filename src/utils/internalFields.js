/** Fields stored for operations/admin only; never send to non-admin client APIs. */
const ORDER_NUMBER_KEY = 'order_number';

function clientIsAdmin(req) {
    return !!(req.user && (req.user.is_admin === true || req.user.is_admin === 1));
}

function redactOrderNumberForClientRow(row) {
    if (!row || typeof row !== 'object') return row;
    if (Object.prototype.hasOwnProperty.call(row, ORDER_NUMBER_KEY)) {
        const o = { ...row };
        delete o[ORDER_NUMBER_KEY];
        return o;
    }
    return row;
}

function redactOrderNumberForClientRows(arr) {
    if (!Array.isArray(arr)) return arr;
    return arr.map(redactOrderNumberForClientRow);
}

module.exports = {
    ORDER_NUMBER_KEY,
    clientIsAdmin,
    redactOrderNumberForClientRow,
    redactOrderNumberForClientRows
};
