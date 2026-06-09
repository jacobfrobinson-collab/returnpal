'use strict';

/**
 * Single source for client resale earnings (gross profit minus return clawbacks).
 * Used by Sold Items, Inventory, Invoices lifetime banner, and dashboard metrics.
 */

const {
    buildClawbackContext,
    clientClawbackMapForAdjustments,
    clientClawbackFromContext,
    roundMoney,
} = require('./returnAdjustmentClawback');

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

function loadAppliedReturnAdjustments(db, userId) {
    return parseResults(
        db.exec(
            `SELECT id, linked_sold_item_id, product, amount, order_number, refund_date, created_at, status
             FROM return_adjustments
             WHERE user_id = ? AND status = 'applied'
             ORDER BY COALESCE(NULLIF(refund_date, ''), created_at), id`,
            [userId]
        )
    );
}

function totalAppliedClawback(appliedReturns, clawbackContext) {
    const clawMap = clientClawbackMapForAdjustments(appliedReturns, clawbackContext);
    let total = 0;
    for (const r of appliedReturns) {
        total += clawMap.get(r.id) || clientClawbackFromContext(r, clawbackContext, clawMap);
    }
    return roundMoney(total);
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 */
function computeClientResaleNetEarnings(db, userId) {
    const statsResult = parseResults(
        db.exec(
            `SELECT COALESCE(SUM(profit), 0) AS gross_profit, COUNT(*) AS items_sold
             FROM sold_items WHERE user_id = ?`,
            [userId]
        )
    );
    const gross = Number(statsResult[0]?.gross_profit) || 0;
    const itemsSold = Number(statsResult[0]?.items_sold) || 0;

    const allSold = parseResults(db.exec('SELECT * FROM sold_items WHERE user_id = ?', [userId]));
    const appliedReturns = loadAppliedReturnAdjustments(db, userId);
    const clawbackContext = buildClawbackContext(db, userId, allSold);
    const returnsApplied = totalAppliedClawback(appliedReturns, clawbackContext);
    const net = roundMoney(gross - returnsApplied);

    return {
        gross_profit: roundMoney(gross),
        returns_applied: returnsApplied,
        net_earnings_after_returns: net,
        items_sold: itemsSold,
        avg_earnings_net: itemsSold > 0 ? roundMoney(net / itemsSold) : 0,
    };
}

module.exports = {
    computeClientResaleNetEarnings,
    loadAppliedReturnAdjustments,
    totalAppliedClawback,
};
