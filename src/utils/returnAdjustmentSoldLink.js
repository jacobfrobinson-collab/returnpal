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
function productTokens(s) {
    return normalizeProductKey(s)
        .split(' ')
        .filter((w) => w.length > 1);
}

/** @returns {number} 0 = no match, 100 = exact */
function productMatchScore(refundProduct, soldProduct) {
    const key = normalizeProductKey(refundProduct);
    const pk = normalizeProductKey(soldProduct);
    if (!key || !pk || key.length < 10) return 0;
    if (pk === key) return 100;
    if (key.length >= 18 && pk.length >= 18) {
        if (pk.includes(key) || key.includes(pk)) return 60;
    }
    const rt = productTokens(refundProduct);
    const st = productTokens(soldProduct);
    if (rt.length < 4 || st.length < 4) return 0;
    const [shorter, longer] = rt.length <= st.length ? [rt, st] : [st, rt];
    const longerSet = new Set(longer);
    let hit = 0;
    for (const w of shorter) {
        if (longerSet.has(w)) hit++;
    }
    if (hit / shorter.length >= 0.8) return 60;
    return 0;
}

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

    let bestId = null;
    let bestScore = 0;
    for (const r of rows) {
        const score = productMatchScore(product, r.product);
        if (score > bestScore) {
            bestScore = score;
            bestId = r.id;
        }
    }
    return bestScore >= 60 ? bestId : null;
}

/**
 * One eBay order often has multiple sold lines — never link by order_number alone.
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {string} orderNumber
 * @param {string} [refundProduct]
 */
function findSoldItemIdByOrder(db, userId, orderNumber, refundProduct) {
    const onum = String(orderNumber || '').trim();
    if (!onum) return null;
    const uid = parseInt(userId, 10);
    const rows = parseResults(
        db.exec(
            `SELECT id, product, profit FROM sold_items
             WHERE user_id = ? AND order_number = ?
             ORDER BY sold_date DESC, id DESC`,
            [uid, onum]
        )
    );
    if (!rows.length) return null;
    if (rows.length === 1) {
        const score = refundProduct ? productMatchScore(refundProduct, rows[0].product) : 100;
        return score >= 60 || !refundProduct ? rows[0].id : null;
    }
    if (!refundProduct) return null;

    let bestId = null;
    let bestScore = 0;
    for (const r of rows) {
        const score = productMatchScore(refundProduct, r.product);
        if (score > bestScore) {
            bestScore = score;
            bestId = r.id;
        }
    }
    return bestScore >= 60 ? bestId : null;
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
    const product = String(opts.product || '').trim();
    if (onum) {
        const byOrder = findSoldItemIdByOrder(db, uid, onum, product);
        if (byOrder) return byOrder;
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

    if (product) {
        const byProduct = findSoldItemIdByProduct(db, uid, product);
        if (byProduct) return byProduct;
    }

    return null;
}

function getSoldItemById(db, userId, soldItemId) {
    const sid = parseInt(soldItemId, 10);
    const uid = parseInt(userId, 10);
    if (!Number.isFinite(sid) || sid < 1 || !Number.isFinite(uid) || uid < 1) return null;
    const rows = parseResults(
        db.exec(
            `SELECT id, product, profit, order_number FROM sold_items WHERE user_id = ? AND id = ?`,
            [uid, sid]
        )
    );
    return rows[0] || null;
}

/**
 * Whether an existing link still makes sense (product/order vs refund amount).
 * @param {{ product?: string, amount?: number, order_number?: string }} adjustment
 * @param {{ product?: string, profit?: number, order_number?: string }} sold
 */
function isReturnAdjustmentLinkPlausible(adjustment, sold) {
    if (!sold) return false;
    const score = productMatchScore(adjustment.product, sold.product);
    if (score >= 60) return true;

    const amt = Number(adjustment.amount) || 0;
    const profit = Number(sold.profit) || 0;
    const onum = String(adjustment.order_number || '').trim();
    const soldOnum = String(sold.order_number || '').trim();
    const orderMatch = !!(onum && soldOnum && onum === soldOnum);

    if (orderMatch && score < 60) return false;
    if (profit > 0 && amt > profit + 5 && amt >= profit * 2 && score < 60) return false;
    if (score < 60) return false;
    return true;
}

/**
 * Recompute linked_sold_item_id using current rules; clears implausible links.
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {{ order_number?: string, product?: string, reference?: string, amount?: number, linked_sold_item_id?: number|null }} adjustment
 */
function resolveRelinkedSoldItemId(db, userId, adjustment) {
    const base = {
        orderNumber: adjustment.order_number,
        product: adjustment.product,
        reference: adjustment.reference,
    };
    const tryLink = (opts) => findLinkedSoldItemId(db, userId, opts);

    let next = tryLink(base);
    if (next) {
        const sold = getSoldItemById(db, userId, next);
        if (!isReturnAdjustmentLinkPlausible(adjustment, sold)) {
            next = tryLink({ ...base, reference: '' });
            if (next) {
                const sold2 = getSoldItemById(db, userId, next);
                if (!isReturnAdjustmentLinkPlausible(adjustment, sold2)) next = null;
            }
        }
    }

    const prev =
        adjustment.linked_sold_item_id != null ? parseInt(adjustment.linked_sold_item_id, 10) : null;
    if (!next && prev) {
        const soldPrev = getSoldItemById(db, userId, prev);
        if (isReturnAdjustmentLinkPlausible(adjustment, soldPrev)) return prev;
        return null;
    }
    return next != null && Number.isFinite(next) && next > 0 ? next : null;
}

module.exports = {
    normalizeProductKey,
    productTokens,
    productMatchScore,
    findSoldItemIdByProduct,
    findSoldItemIdByOrder,
    findLinkedSoldItemId,
    getSoldItemById,
    isReturnAdjustmentLinkPlausible,
    resolveRelinkedSoldItemId,
    parseResults,
};
