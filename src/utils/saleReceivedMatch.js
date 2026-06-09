'use strict';

const { productMatchScore, productTokens, isGenericProductTitle } = require('./productTitleMatch');

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

function matchThresholdHigh() {
    return Number(process.env.SALE_MATCH_THRESHOLD_HIGH) || 90;
}

function matchThresholdLow() {
    return Number(process.env.SALE_MATCH_THRESHOLD_LOW) || 60;
}

/**
 * Qty already linked to received line from other sold rows.
 * @param {import('sql.js').Database} db
 * @param {number} receivedItemId
 * @param {number} [excludeSoldId]
 */
function linkedQtyForReceived(db, receivedItemId, excludeSoldId) {
    const rid = parseInt(receivedItemId, 10);
    if (!Number.isFinite(rid) || rid < 1) return 0;
    const ex = excludeSoldId != null ? parseInt(excludeSoldId, 10) : null;
    const rows = parseResults(
        db.exec(
            `SELECT COALESCE(SUM(quantity), 0) AS s FROM sold_items
             WHERE received_item_id = ? AND match_status IN ('linked', 'manual')
             ${Number.isFinite(ex) && ex > 0 ? 'AND id != ?' : ''}`,
            Number.isFinite(ex) && ex > 0 ? [rid, ex] : [rid]
        )
    );
    return Number(rows[0]?.s) || 0;
}

function remainingQtyForReceived(db, receivedRow, excludeSoldId) {
    const total = Math.max(1, Number(receivedRow.quantity) || 1);
    const linked = linkedQtyForReceived(db, receivedRow.id, excludeSoldId);
    return Math.max(0, total - linked);
}

/** Best ASIN from package_products for a received line (by package_id + title). */
function asinForReceivedLine(db, receivedRow) {
    const pid = receivedRow.package_id;
    if (!pid) return '';
    const products = parseResults(
        db.exec('SELECT asin, product_name FROM package_products WHERE package_id = ?', [pid])
    );
    if (!products.length) return '';
    const desc = String(receivedRow.items_description || '').trim();
    let bestAsin = '';
    let bestScore = 0;
    for (const p of products) {
        const asin = String(p.asin || '').trim().toLowerCase();
        if (asin.length < 8) continue;
        const nameScore = productMatchScore(desc, p.product_name);
        if (nameScore > bestScore) {
            bestScore = nameScore;
            bestAsin = asin;
        }
    }
    if (bestAsin && bestScore >= 50) return bestAsin;
    if (products.length === 1) {
        const only = String(products[0].asin || '').trim().toLowerCase();
        if (only.length >= 8) return only;
    }
    return '';
}

/**
 * @param {object} soldRow
 * @param {object} receivedRow
 * @param {number} baseScore
 * @param {{ ref?: boolean, sku?: boolean, asin?: boolean }} boosts
 */
function buildMatchReasons(soldRow, receivedRow, baseScore, boosts) {
    const reasons = [];
    if (baseScore > 0) reasons.push('Title similarity ' + baseScore + '%');
    if (boosts.ref) reasons.push('Same parcel reference');
    if (boosts.sku) reasons.push('SKU found in sold title');
    if (boosts.asin) reasons.push('ASIN match');
    const rem = receivedRow.remaining_qty;
    if (rem != null) reasons.push(rem + ' unit(s) open on line');
    if (!String(soldRow.reference || '').trim()) reasons.push('No reference on sale — weaker match');
    return reasons;
}

/**
 * @param {import('sql.js').Database} db
 * @param {object} soldRow
 * @param {object} receivedRow
 * @param {number} excludeSoldId
 */
function scoreReceivedCandidate(db, soldRow, receivedRow, excludeSoldId) {
    const ref = String(soldRow.reference || '').trim();
    const soldProduct = String(soldRow.product || '').trim();
    const soldQty = Math.max(1, Number(soldRow.quantity) || 1);
    const remaining = remainingQtyForReceived(db, receivedRow, excludeSoldId);
    if (remaining < soldQty) return null;

    const baseScore = productMatchScore(soldProduct, receivedRow.items_description);
    let score = baseScore;
    const boosts = { ref: false, sku: false, asin: false };

    if (score > 0 && receivedRow.sku) {
        const sku = String(receivedRow.sku || '').trim().toLowerCase();
        const soldLower = soldProduct.toLowerCase();
        if (sku.length >= 4 && soldLower.includes(sku)) {
            score = Math.min(100, score + 20);
            boosts.sku = true;
        }
    }

    const asin = asinForReceivedLine(db, receivedRow);
    if (score > 0 && asin.length >= 8 && soldProduct.toLowerCase().includes(asin)) {
        score = Math.min(100, score + 20);
        boosts.asin = true;
    }

    if (ref && String(receivedRow.reference || '').trim() === ref && score >= matchThresholdLow()) {
        score = Math.min(100, score + 10);
        boosts.ref = true;
    }

    if (score <= 0) return null;

    const rowWithRem = { ...receivedRow, remaining_qty: remaining };
    return {
        received_item_id: receivedRow.id,
        reference: receivedRow.reference,
        items_description: receivedRow.items_description,
        quantity: receivedRow.quantity,
        remaining_qty: remaining,
        score,
        base_score: baseScore,
        match_reasons: buildMatchReasons(soldRow, rowWithRem, baseScore, boosts),
    };
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {object} soldRow
 * @param {{ excludeSoldId?: number }} [opts]
 */
function findReceivedMatchCandidates(db, userId, soldRow, opts = {}) {
    const uid = parseInt(userId, 10);
    const excludeSoldId = opts.excludeSoldId;
    const ref = String(soldRow.reference || '').trim();
    const onum = String(soldRow.order_number || '').trim();

    let received = parseResults(
        db.exec('SELECT * FROM received_items WHERE user_id = ? ORDER BY date_received DESC', [uid])
    );

    if (ref) {
        const byRef = received.filter((r) => String(r.reference || '').trim() === ref);
        if (byRef.length) received = byRef;
    } else if (onum) {
        const byOrder = received.filter((r) => String(r.order_number || '').trim() === onum);
        if (byOrder.length) received = byOrder;
    }

    const candidates = [];
    for (const r of received) {
        const scored = scoreReceivedCandidate(db, soldRow, r, excludeSoldId);
        if (scored) candidates.push(scored);
    }

    candidates.sort((a, b) => b.score - a.score || b.remaining_qty - a.remaining_qty);
    return candidates;
}

/**
 * @param {object} soldRow
 * @param {object[]} candidates
 */
function decideMatch(soldRow, candidates) {
    const high = matchThresholdHigh();
    const low = matchThresholdLow();
    const product = String(soldRow.product || '').trim();

    if (!candidates.length) {
        return {
            received_item_id: null,
            match_status: 'pending_review',
            match_confidence: 0,
            match_source: 'none',
            candidates: [],
        };
    }

    if (isGenericProductTitle(product)) {
        const top = candidates[0];
        return {
            received_item_id: null,
            match_status: 'pending_review',
            match_confidence: top.score,
            match_source: 'none',
            candidates: candidates.slice(0, 3),
        };
    }

    const top = candidates[0];
    const inBand = candidates.filter((c) => c.score >= low);

    if (top.score >= high) {
        return {
            received_item_id: top.received_item_id,
            match_status: 'linked',
            match_confidence: top.score,
            match_source: refSource(soldRow, top),
            candidates: candidates.slice(0, 3),
        };
    }

    if (top.score >= low && inBand.length === 1) {
        return {
            received_item_id: top.received_item_id,
            match_status: 'linked',
            match_confidence: top.score,
            match_source: 'auto_title',
            candidates: candidates.slice(0, 3),
        };
    }

    return {
        received_item_id: null,
        match_status: 'pending_review',
        match_confidence: top.score,
        match_source: 'none',
        candidates: candidates.slice(0, 3),
    };
}

function refSource(soldRow, candidate) {
    const ref = String(soldRow.reference || '').trim();
    if (ref && String(candidate.reference || '').trim() === ref) return 'auto_reference';
    return 'auto_title';
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} soldItemId
 * @param {{ force?: boolean }} [opts]
 */
function matchSaleToReceived(db, soldItemId, opts = {}) {
    const sid = parseInt(soldItemId, 10);
    if (!Number.isFinite(sid) || sid < 1) {
        return { received_item_id: null, match_status: 'pending_review', match_confidence: 0, match_source: 'none', candidates: [] };
    }

    const rows = parseResults(db.exec('SELECT * FROM sold_items WHERE id = ?', [sid]));
    if (!rows.length) {
        return { received_item_id: null, match_status: 'pending_review', match_confidence: 0, match_source: 'none', candidates: [] };
    }

    const sold = rows[0];
    if (!opts.force && sold.match_status === 'manual' && sold.received_item_id) {
        return {
            received_item_id: sold.received_item_id,
            match_status: 'manual',
            match_confidence: sold.match_confidence || 100,
            match_source: 'manual',
            candidates: [],
        };
    }
    if (!opts.force && sold.match_status === 'unlinked') {
        return {
            received_item_id: null,
            match_status: 'unlinked',
            match_confidence: 0,
            match_source: 'none',
            candidates: [],
        };
    }

    const candidates = findReceivedMatchCandidates(db, sold.user_id, sold, { excludeSoldId: sid });
    return decideMatch(sold, candidates);
}

function applyMatchResultToSold(db, soldItemId, result) {
    db.run(
        `UPDATE sold_items SET received_item_id = ?, match_status = ?, match_confidence = ?, match_source = ?
         WHERE id = ?`,
        [
            result.received_item_id,
            result.match_status,
            result.match_confidence || 0,
            result.match_source || 'none',
            soldItemId,
        ]
    );
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} soldItemId
 * @param {{ force?: boolean }} [opts]
 */
function applySaleReceivedMatch(db, soldItemId, opts = {}) {
    const result = matchSaleToReceived(db, soldItemId, opts);
    applyMatchResultToSold(db, soldItemId, result);
    return result;
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 */
function rematchSalesForUser(db, userId) {
    const uid = parseInt(userId, 10);
    const rows = parseResults(
        db.exec(
            `SELECT id FROM sold_items WHERE user_id = ?
             AND COALESCE(match_status, 'pending_review') != 'manual'`,
            [uid]
        )
    );
    let linked = 0;
    let queued = 0;
    for (const r of rows) {
        const result = applySaleReceivedMatch(db, r.id, { force: true });
        if (result.match_status === 'linked' || result.match_status === 'manual') linked++;
        else queued++;
    }
    return { processed: rows.length, linked, queued };
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 */
function getSaleMatchQueue(db, userId) {
    const uid = parseInt(userId, 10);
    const sales = parseResults(
        db.exec(
            `SELECT * FROM sold_items WHERE user_id = ?
             AND (match_status = 'pending_review' OR match_status IS NULL OR match_status = '')
             ORDER BY sold_date DESC, id DESC`,
            [uid]
        )
    );

    return sales.map((s) => {
        const candidates = findReceivedMatchCandidates(db, uid, s, { excludeSoldId: s.id });
        const ref = String(s.reference || '').trim();
        return {
            sold_item: {
                id: s.id,
                product: s.product,
                quantity: s.quantity,
                profit: s.profit,
                total_revenue: s.total_revenue,
                reference: s.reference,
                order_number: s.order_number,
                sold_date: s.sold_date,
                match_status: s.match_status,
                match_confidence: s.match_confidence,
                missing_reference: !ref,
            },
            candidates: candidates.slice(0, 3),
        };
    });
}

function getUnlinkedSalesForUser(db, userId) {
    const uid = parseInt(userId, 10);
    return parseResults(
        db.exec(
            `SELECT id, product, quantity, profit, reference, sold_date, match_status
             FROM sold_items WHERE user_id = ? AND match_status = 'unlinked'
             ORDER BY sold_date DESC, id DESC`,
            [uid]
        )
    );
}

function manualLinkSaleToReceived(db, soldItemId, receivedItemId) {
    const sid = parseInt(soldItemId, 10);
    const rid = parseInt(receivedItemId, 10);
    const soldRows = parseResults(db.exec('SELECT * FROM sold_items WHERE id = ?', [sid]));
    if (!soldRows.length) throw new Error('Sale not found');
    const sold = soldRows[0];
    const recRows = parseResults(
        db.exec('SELECT * FROM received_items WHERE id = ? AND user_id = ?', [rid, sold.user_id])
    );
    if (!recRows.length) throw new Error('Received line not found for this client');

    const soldQty = Math.max(1, Number(sold.quantity) || 1);
    const remaining = remainingQtyForReceived(db, recRows[0], sid);
    if (remaining < soldQty) {
        throw new Error(
            'Cannot link: only ' + remaining + ' unit(s) remaining on that received line (sale qty ' + soldQty + ')'
        );
    }

    db.run(
        `UPDATE sold_items SET received_item_id = ?, match_status = 'manual', match_confidence = 100, match_source = 'manual'
         WHERE id = ?`,
        [rid, sid]
    );
}

function reopenSaleMatch(db, soldItemId) {
    const sid = parseInt(soldItemId, 10);
    const rows = parseResults(db.exec('SELECT match_status FROM sold_items WHERE id = ?', [sid]));
    if (!rows.length) throw new Error('Sale not found');
    if (rows[0].match_status !== 'unlinked') {
        throw new Error('Only skipped (no match) sales can be re-opened');
    }
    db.run(
        `UPDATE sold_items SET received_item_id = NULL, match_status = 'pending_review', match_confidence = 0, match_source = 'none'
         WHERE id = ?`,
        [sid]
    );
}

function bulkAutoLinkHighConfidence(db, userId, minScore) {
    const threshold = Number.isFinite(minScore) ? minScore : 95;
    const queue = getSaleMatchQueue(db, userId);
    let linked = 0;
    let skipped = 0;
    for (const row of queue) {
        const cands = row.candidates || [];
        const top = cands[0];
        if (!top || top.score < threshold) {
            skipped++;
            continue;
        }
        const strong = cands.filter((c) => c.score >= threshold);
        if (strong.length !== 1) {
            skipped++;
            continue;
        }
        applyMatchResultToSold(db, row.sold_item.id, {
            received_item_id: top.received_item_id,
            match_status: 'linked',
            match_confidence: top.score,
            match_source: refSource(row.sold_item, top),
            candidates: cands.slice(0, 3),
        });
        linked++;
    }
    return { linked, skipped, threshold };
}

function getGlobalSaleMatchQueueCount(db) {
    const rows = parseResults(
        db.exec(
            `SELECT COUNT(*) AS c FROM sold_items
             WHERE match_status = 'pending_review' OR match_status IS NULL OR match_status = ''`
        )
    );
    return Number(rows[0]?.c) || 0;
}

function getSaleMatchQueueCountsByUser(db) {
    return parseResults(
        db.exec(
            `SELECT user_id, COUNT(*) AS c FROM sold_items
             WHERE match_status = 'pending_review' OR match_status IS NULL OR match_status = ''
             GROUP BY user_id ORDER BY c DESC`
        )
    );
}

/**
 * One-time backfill: rematch all historical sales after deploy.
 * @param {import('sql.js').Database} db
 */
function runSaleMatchBackfillIfNeeded(db) {
    try {
        db.run(`CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT '',
            updated_at TEXT DEFAULT (datetime('now'))
        )`);
        const done = parseResults(
            db.exec("SELECT value FROM app_meta WHERE key = 'sale_received_backfill_v1'")
        );
        if (done.length && done[0].value === 'done') {
            return { skipped: true };
        }

        const users = parseResults(db.exec('SELECT DISTINCT user_id FROM sold_items'));
        let totalLinked = 0;
        let totalProcessed = 0;
        for (const u of users) {
            const r = rematchSalesForUser(db, u.user_id);
            totalLinked += r.linked;
            totalProcessed += r.processed;
        }
        db.run(
            "INSERT OR REPLACE INTO app_meta (key, value, updated_at) VALUES ('sale_received_backfill_v1', 'done', datetime('now'))"
        );
        return { ran: true, users: users.length, processed: totalProcessed, linked: totalLinked };
    } catch (e) {
        console.error('[sale-match-backfill]', e);
        return { error: e && e.message };
    }
}

function skipSaleMatch(db, soldItemId) {
    db.run(
        `UPDATE sold_items SET received_item_id = NULL, match_status = 'unlinked', match_confidence = 0, match_source = 'none'
         WHERE id = ?`,
        [soldItemId]
    );
}

module.exports = {
    parseResults,
    linkedQtyForReceived,
    remainingQtyForReceived,
    asinForReceivedLine,
    buildMatchReasons,
    scoreReceivedCandidate,
    findReceivedMatchCandidates,
    matchSaleToReceived,
    applySaleReceivedMatch,
    rematchSalesForUser,
    getSaleMatchQueue,
    getUnlinkedSalesForUser,
    manualLinkSaleToReceived,
    skipSaleMatch,
    reopenSaleMatch,
    bulkAutoLinkHighConfidence,
    getGlobalSaleMatchQueueCount,
    getSaleMatchQueueCountsByUser,
    runSaleMatchBackfillIfNeeded,
    decideMatch,
};
