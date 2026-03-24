/**
 * "Each month your most expensive item is processed free; you keep 100%."
 * We rank by gross sale value for the month, then treat the normal client fee as waived on that line.
 *
 * Env:
 *   RETURNPAL_CLIENT_FEE_PERCENT — default 0.15 (15%)
 *   RETURNPAL_SOLD_REVENUE_IS_NET — if "true", total_revenue (or unit×qty) is interpreted as
 *     what the client sees after fee; gross is derived as net / (1 - fee).
 */

const DEFAULT_FEE = 0.15;

function parseFeePercent() {
    const v = parseFloat(process.env.RETURNPAL_CLIENT_FEE_PERCENT);
    if (Number.isFinite(v) && v > 0 && v < 1) return v;
    return DEFAULT_FEE;
}

function revenueIsNet() {
    return String(process.env.RETURNPAL_SOLD_REVENUE_IS_NET || '').toLowerCase() === 'true';
}

function monthKey(soldDate) {
    if (!soldDate) return null;
    const s = String(soldDate);
    if (s.length < 7) return null;
    return s.slice(0, 7);
}

/** Resale-style sales only; reimbursement / not recoverable excluded when route is present */
function isEligibleForPromo(row) {
    const tr = Number(row.total_revenue) || 0;
    const up = Number(row.unit_price) || 0;
    const qty = Number(row.quantity) || 1;
    const gross = tr > 0 ? tr : up * qty;
    if (gross <= 0) return false;
    const route = String(row.recovery_route || 'Resale').trim();
    if (/reimbursement/i.test(route)) return false;
    if (/not recoverable/i.test(route)) return false;
    return true;
}

function grossSale(row, feePercent, netMode) {
    const qty = Number(row.quantity) || 1;
    const tr = Number(row.total_revenue) || 0;
    const up = Number(row.unit_price) || 0;
    let gross = tr > 0 ? tr : up * qty;
    if (netMode && gross > 0) {
        const d = 1 - feePercent;
        if (d > 0) gross = gross / d;
    }
    return gross;
}

/**
 * @param {Array<object>} items - sold_items rows (same user)
 * @returns {{ fee_percent: number, revenue_interpreted_as_net: boolean, months: Array, winner_by_item_id: Record<string, object> }}
 */
function computeMonthlyFreeProcessing(items) {
    const feePercent = parseFeePercent();
    const netMode = revenueIsNet();
    const monthsMap = new Map();

    for (const row of items || []) {
        if (!isEligibleForPromo(row)) continue;
        const ym = monthKey(row.sold_date);
        if (!ym) continue;
        const gross = grossSale(row, feePercent, netMode);
        const id = row.id;
        if (id == null) continue;

        if (!monthsMap.has(ym)) monthsMap.set(ym, []);
        monthsMap.get(ym).push({ row, gross, id });
    }

    const months = [];
    const winnerByItemId = {};

    const sortedYm = Array.from(monthsMap.keys()).sort();

    for (const ym of sortedYm) {
        const candidates = monthsMap.get(ym);
        candidates.sort((a, b) => {
            if (b.gross !== a.gross) return b.gross - a.gross;
            return Number(a.id) - Number(b.id);
        });
        const best = candidates[0];
        if (!best) continue;

        const r = best.row;
        const gross = best.gross;
        const feeWouldCharge = gross * feePercent;

        const entry = {
            year_month: ym,
            sold_item_id: best.id,
            reference: r.reference,
            product: r.product,
            sold_date: r.sold_date,
            gross_sale: Math.round(gross * 100) / 100,
            fee_percent: feePercent,
            fee_normally_charged: Math.round(feeWouldCharge * 100) / 100,
            note: 'Highest-value eligible sale this calendar month — processing fee waived; you keep 100% of this sale.'
        };
        months.push(entry);
        winnerByItemId[String(best.id)] = { year_month: ym, ...entry };
    }

    return {
        fee_percent: feePercent,
        revenue_interpreted_as_net: netMode,
        months,
        winner_by_item_id: winnerByItemId
    };
}

/** Sum of processing fees for one calendar month (YYYY-MM), after waiving the monthly free-processing winner. */
function feesDeductedForCalendarMonth(allUserSoldItems, yearMonth) {
    if (!yearMonth || String(yearMonth).length < 7) return 0;
    const ym = String(yearMonth).slice(0, 7);
    const promo = computeMonthlyFreeProcessing(allUserSoldItems || []);
    const feeP = promo.fee_percent;
    const netMode = promo.revenue_interpreted_as_net;
    const winners = promo.winner_by_item_id || {};
    let total = 0;
    for (const row of allUserSoldItems || []) {
        if (monthKey(row.sold_date) !== ym) continue;
        if (!isEligibleForPromo(row)) continue;
        if (winners[String(row.id)]) continue;
        const g = grossSale(row, feeP, netMode);
        total += g * feeP;
    }
    return Math.round(total * 100) / 100;
}

module.exports = {
    computeMonthlyFreeProcessing,
    feesDeductedForCalendarMonth,
    grossSale,
    isEligibleForPromo,
    monthKey
};
