/**
 * Link return_adjustments to sold_items without requiring order_number on sales.
 */

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

/** @param {string} s */
function normalizeProductKey(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {string} product
 * @returns {number|null}
 */
function findSoldItemIdByProduct(db, userId, product) {
    const key = normalizeProductKey(product);
    if (!key || key.length < 10) return null;

    const rows = parseResults(
        db.exec(
            `SELECT id, product FROM sold_items
             WHERE user_id = ?
             ORDER BY sold_date DESC, id DESC`,
            [userId]
        )
    );

    let containsMatch = null;
    for (const r of rows) {
        const pk = normalizeProductKey(r.product);
        if (!pk) continue;
        if (pk === key) return r.id;
        if (key.length >= 18 && pk.length >= 18) {
            if (pk.includes(key) || key.includes(pk)) {
                containsMatch = r.id;
                break;
            }
        }
    }
    return containsMatch;
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {{ linkedSoldItemId?: number|null, orderNumber?: string, product?: string, reference?: string }} opts
 * @returns {number|null}
 */
function findLinkedSoldItemId(db, userId, opts) {
    const uid = parseInt(userId, 10);
    if (!Number.isFinite(uid) || uid < 1) return null;

    let linked = opts.linkedSoldItemId != null ? parseInt(opts.linkedSoldItemId, 10) : null;
    if (Number.isFinite(linked) && linked > 0) return linked;

    const onum = String(opts.orderNumber || '').trim().slice(0, 200);
    if (onum) {
        const matchByOn = parseResults(
            db.exec(
                `SELECT id FROM sold_items
                 WHERE user_id = ? AND order_number = ?
                 ORDER BY sold_date DESC, id DESC
                 LIMIT 1`,
                [uid, onum]
            )
        );
        if (matchByOn.length) return matchByOn[0].id;
    }

    const reference = String(opts.reference || '').trim();
    if (reference) {
        const matchRef = parseResults(
            db.exec(
                `SELECT id FROM sold_items
                 WHERE user_id = ? AND reference = ?
                 ORDER BY sold_date DESC, id DESC
                 LIMIT 1`,
                [uid, reference]
            )
        );
        if (matchRef.length) return matchRef[0].id;
    }

    const product = String(opts.product || '').trim();
    if (product) {
        const byProduct = findSoldItemIdByProduct(db, uid, product);
        if (byProduct) return byProduct;
    }

    return null;
}

module.exports = {
    normalizeProductKey,
    findSoldItemIdByProduct,
    findLinkedSoldItemId,
    parseResults,
};
