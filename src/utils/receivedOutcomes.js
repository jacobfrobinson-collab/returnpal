'use strict';

const { productMatchScore } = require('./productTitleMatch');
const { linkedQtyForReceived } = require('./saleReceivedMatch');

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

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 */
function loadOutcomeContext(db, userId) {
    const sold = parseResults(
        db.exec('SELECT * FROM sold_items WHERE user_id = ? ORDER BY sold_date DESC', [userId])
    );
    const pending = parseResults(
        db.exec('SELECT * FROM pending_items WHERE user_id = ? ORDER BY received_date DESC', [userId])
    );

    const soldByReceivedId = new Map();
    const soldByRef = new Map();
    const unlinkedSoldByRef = new Map();

    for (const s of sold) {
        const rid = s.received_item_id;
        if (rid && (s.match_status === 'linked' || s.match_status === 'manual')) {
            if (!soldByReceivedId.has(rid)) soldByReceivedId.set(rid, []);
            soldByReceivedId.get(rid).push(s);
        }
        const ref = String(s.reference || '').trim();
        if (ref) {
            if (!soldByRef.has(ref)) soldByRef.set(ref, []);
            soldByRef.get(ref).push(s);
            if (!rid || (s.match_status !== 'linked' && s.match_status !== 'manual')) {
                if (!unlinkedSoldByRef.has(ref)) unlinkedSoldByRef.set(ref, []);
                unlinkedSoldByRef.get(ref).push(s);
            }
        }
    }

    return { sold, pending, soldByReceivedId, soldByRef, unlinkedSoldByRef };
}

function findPendingStage(pending, ref, description) {
    const refNorm = String(ref || '').trim();
    let best = null;
    let bestScore = 0;
    for (const p of pending) {
        if (refNorm && String(p.reference || '').trim() !== refNorm) continue;
        const score = productMatchScore(description, p.product);
        if (score > bestScore) {
            bestScore = score;
            best = p;
        }
    }
    if (!best && refNorm) {
        for (const p of pending) {
            if (String(p.reference || '').trim() === refNorm) {
                best = p;
                break;
            }
        }
    }
    return best ? best.current_stage || '' : '';
}

function mapSoldSummary(s) {
    return {
        id: s.id,
        product: s.product,
        quantity: s.quantity,
        profit: s.profit,
        total_revenue: s.total_revenue,
        sold_date: s.sold_date,
        match_status: s.match_status,
    };
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {object[]} packages from buildPackages
 */
function enrichPackagesWithOutcomes(db, userId, packages) {
    const ctx = loadOutcomeContext(db, userId);

    for (const pkg of packages) {
        const ref = String(pkg.reference || '').trim();
        let soldUnits = 0;
        let soldProfit = 0;
        let matchPendingCount = (ctx.unlinkedSoldByRef.get(ref) || []).length;

        const unlinkedOnRef = ctx.unlinkedSoldByRef.get(ref) || [];

        for (const line of pkg.items || []) {
            const linked = ctx.soldByReceivedId.get(line.id) || [];
            const linkedQty = linked.reduce((a, s) => a + (Number(s.quantity) || 0), 0);
            const linkedProfit = linked.reduce((a, s) => a + (Number(s.profit) || 0), 0);
            const totalQty = Math.max(1, Number(line.quantity) || 1);
            const soldLinkedQty = linkedQtyForReceived(db, line.id);

            const lineUnlinked = unlinkedOnRef.filter((s) => {
                const score = productMatchScore(s.product, line.items_description);
                return score >= 40 || unlinkedOnRef.length === 1;
            });

            line.sold_lines = linked.map(mapSoldSummary);
            line.sold_qty = linkedQty;
            line.sold_profit = Math.round(linkedProfit * 100) / 100;
            line.pending_stage = findPendingStage(ctx.pending, ref, line.items_description);
            line.remaining_qty = Math.max(0, totalQty - soldLinkedQty);
            line.matching_in_progress = linkedQty === 0 && lineUnlinked.length > 0;
            line.unlinked_sale_count = lineUnlinked.length;

            soldUnits += linkedQty;
            soldProfit += linkedProfit;
        }

        const refSold = ctx.soldByRef.get(ref) || [];
        if (!soldUnits && refSold.length) {
            soldUnits = refSold.reduce((a, s) => a + (Number(s.quantity) || 0), 0);
            soldProfit = refSold.reduce((a, s) => a + (Number(s.profit) || 0), 0);
        }

        pkg.sold_units = soldUnits;
        pkg.sold_profit = Math.round(soldProfit * 100) / 100;
        pkg.unsold_units = Math.max(0, (pkg.total_units || 0) - soldUnits);
        pkg.match_pending_count = matchPendingCount;
        pkg.has_unlinked_sales = matchPendingCount > 0;
    }

    return packages;
}

module.exports = {
    enrichPackagesWithOutcomes,
    loadOutcomeContext,
};
