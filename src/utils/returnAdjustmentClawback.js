'use strict';

const {
    computeMonthlyFreeProcessing,
    grossSale,
    parseFeePercent,
} = require('./monthlyFreeProcessing');

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

function roundMoney(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * @param {object|null} soldItem
 * @param {{ fee_percent: number, revenue_interpreted_as_net: boolean, winner_by_item_id: Record<string, object> }} promo
 */
function clientShareRatioForSold(soldItem, promo) {
    if (!soldItem) return 1 - (promo.fee_percent || parseFeePercent());
    const profit = Number(soldItem.profit) || 0;
    const feeP = promo.fee_percent || parseFeePercent();
    const netMode = !!promo.revenue_interpreted_as_net;
    const gross = grossSale(soldItem, feeP, netMode);
    if (gross > 0 && profit > 0) {
        return Math.min(1, profit / gross);
    }
    if (profit > 0) return 1;
    return Math.max(0, 1 - feeP);
}

/**
 * Uncapped clawback for one adjustment (before per-sale cap).
 * @param {{ amount?: number, linked_sold_item_id?: number|null }} adjustment
 * @param {object|null} soldItem
 * @param {{ fee_percent: number, revenue_interpreted_as_net: boolean }} promo
 */
function uncappedClientClawback(adjustment, soldItem, promo) {
    const refundGross = Math.abs(Number(adjustment.amount) || 0);
    if (refundGross <= 0) return 0;
    const ratio = clientShareRatioForSold(soldItem, promo);
    return roundMoney(refundGross * ratio);
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {Array<object>} [allSold]
 */
function buildClawbackContext(db, userId, allSold) {
    const sold =
        allSold ||
        parseResults(db.exec('SELECT * FROM sold_items WHERE user_id = ?', [userId]));
    const promo = computeMonthlyFreeProcessing(sold);
    const soldById = Object.create(null);
    for (const row of sold) {
        soldById[String(row.id)] = row;
    }
    return { sold, soldById, promo };
}

/**
 * Batch clawback with per sold_item_id cap at profit.
 * @param {Array<object>} adjustments
 * @param {{ soldById: Record<string, object>, promo: object }} context
 * @returns {Map<number|string, number>} adjustment id → client_clawback
 */
function clientClawbackMapForAdjustments(adjustments, context) {
    const { soldById, promo } = context;
    const bySoldId = new Map();
    const sorted = [...(adjustments || [])].sort((a, b) => {
        const da = String(a.refund_date || a.created_at || '');
        const db_ = String(b.refund_date || b.created_at || '');
        const c = da.localeCompare(db_);
        return c !== 0 ? c : (Number(a.id) || 0) - (Number(b.id) || 0);
    });

    const out = new Map();
    for (const adj of sorted) {
        const sid =
            adj.linked_sold_item_id != null && adj.linked_sold_item_id !== ''
                ? String(adj.linked_sold_item_id)
                : null;
        const sold = sid ? soldById[sid] || null : null;
        let claw = uncappedClientClawback(adj, sold, promo);

        if (sid && sold) {
            const profitCap = Math.max(0, Number(sold.profit) || 0);
            const prev = bySoldId.get(sid) || 0;
            const room = Math.max(0, profitCap - prev);
            claw = roundMoney(Math.min(claw, room));
            bySoldId.set(sid, roundMoney(prev + claw));
        }

        out.set(adj.id, claw);
    }
    return out;
}

/**
 * @param {{ amount?: number, linked_sold_item_id?: number|null }} adjustment
 * @param {object|null} soldItem
 * @param {{ fee_percent: number, revenue_interpreted_as_net: boolean }} promo
 */
function clientClawbackForAdjustment(adjustment, soldItem, promo) {
    return uncappedClientClawback(adjustment, soldItem, promo);
}

/**
 * @param {object} adjustment
 * @param {{ soldById: Record<string, object>, promo: object }} context
 * @param {Map<number|string, number>} [clawbackMap]
 */
function clientClawbackFromContext(adjustment, context, clawbackMap) {
    if (clawbackMap && clawbackMap.has(adjustment.id)) {
        return clawbackMap.get(adjustment.id);
    }
    const sid =
        adjustment.linked_sold_item_id != null && adjustment.linked_sold_item_id !== ''
            ? String(adjustment.linked_sold_item_id)
            : null;
    const sold = sid ? context.soldById[sid] || null : null;
    return clientClawbackForAdjustment(adjustment, sold, context.promo);
}

module.exports = {
    buildClawbackContext,
    clientShareRatioForSold,
    uncappedClientClawback,
    clientClawbackForAdjustment,
    clientClawbackMapForAdjustments,
    clientClawbackFromContext,
    roundMoney,
};
