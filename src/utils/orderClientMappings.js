'use strict';

const { saveDb } = require('../database');
const { canonicalizeClientIdCandidate } = require('./ebayRefundSkuClient');

function parseResults(result) {
    if (!result || !result.length) return [];
    const cols = result[0].columns;
    return result[0].values.map((row) => {
        const obj = {};
        cols.forEach((col, i) => {
            obj[col] = row[i];
        });
        return obj;
    });
}

function canonicalOrderNumber(raw) {
    const s = String(raw || '')
        .trim()
        .replace(/\s+/g, '');
    if (!s) return '';
    const m = s.match(/\d{2}-\d{5}-\d{5}|\d{3}-\d{7}-\d{7}/);
    return m ? m[0] : s;
}

/**
 * @param {import('sql.js').Database} db
 */
function loadOrderClientMap(db) {
    const map = Object.create(null);
    const rows = parseResults(
        db.exec(
            `SELECT order_number, client_specifier FROM order_client_mappings
             WHERE TRIM(order_number) <> '' AND TRIM(client_specifier) <> ''`
        )
    );
    for (const r of rows) {
        const onum = canonicalOrderNumber(r.order_number);
        const spec = canonicalizeClientIdCandidate(r.client_specifier) || String(r.client_specifier || '').trim();
        if (onum && spec) map[onum] = spec;
    }
    return map;
}

/**
 * @param {import('sql.js').Database} db
 * @param {string} orderNumber
 * @param {string} clientSpecifier
 * @param {string} [source]
 */
function upsertOrderClientMapping(db, orderNumber, clientSpecifier, source) {
    const onum = canonicalOrderNumber(orderNumber);
    const spec = canonicalizeClientIdCandidate(clientSpecifier) || String(clientSpecifier || '').trim();
    if (!onum || !spec) return false;
    const src = String(source || 'admin_review').slice(0, 64);
    db.run(
        `INSERT INTO order_client_mappings (order_number, client_specifier, source, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(order_number) DO UPDATE SET
           client_specifier = excluded.client_specifier,
           source = excluded.source,
           updated_at = datetime('now')`,
        [onum, spec, src]
    );
    return true;
}

/**
 * @param {import('sql.js').Database} db
 * @param {Array<{ order_number?: string, orderNumber?: string, client_specifier?: string, client_id?: string, clientId?: string }>} rows
 * @param {string} [source]
 */
function upsertOrderClientMappingsFromReview(db, rows, source) {
    let n = 0;
    for (const r of rows || []) {
        const onum = canonicalOrderNumber(
            r.order_number != null ? r.order_number : r.orderNumber || (r.row_data && r.row_data.order_number)
        );
        const spec = String(
            r.client_specifier != null
                ? r.client_specifier
                : r.client_id != null
                  ? r.client_id
                  : r.clientId || ''
        ).trim();
        if (upsertOrderClientMapping(db, onum, spec, source)) n++;
    }
    if (n) saveDb();
    return n;
}

module.exports = {
    canonicalOrderNumber,
    loadOrderClientMap,
    upsertOrderClientMapping,
    upsertOrderClientMappingsFromReview,
};
