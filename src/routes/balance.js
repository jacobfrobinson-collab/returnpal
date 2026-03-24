const express = require('express');
const { getDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { feesDeductedForCalendarMonth } = require('../utils/monthlyFreeProcessing');

const router = express.Router();

function parseResults(result) {
    if (!result || !result.length) return [];
    const cols = result[0].columns;
    return result[0].values.map((row) => {
        const obj = {};
        cols.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

function currentYearMonth() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

// GET /api/balance/summary — live balance, payout forecast, MTD breakdown
router.get('/summary', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const userId = req.user.id;
        const ym = currentYearMonth();

        const allSold = parseResults(
            db.exec('SELECT * FROM sold_items WHERE user_id = ? ORDER BY sold_date DESC', [userId])
        );

        const salesMtd = parseResults(
            db.exec(
                `SELECT COALESCE(SUM(profit), 0) as total 
                 FROM sold_items 
                 WHERE user_id = ? AND strftime('%Y-%m', sold_date) = ? 
                 AND (status IS NULL OR status != 'Refunded')`,
                [userId, ym]
            )
        );
        const sales_this_month = Number(salesMtd[0]?.total) || 0;

        const refundedMtd = parseResults(
            db.exec(
                `SELECT COALESCE(SUM(profit), 0) as total, COUNT(*) as cnt
                 FROM sold_items 
                 WHERE user_id = ? AND strftime('%Y-%m', sold_date) = ? AND status = 'Refunded'`,
                [userId, ym]
            )
        );
        const refunds_from_sales_mtd = Number(refundedMtd[0]?.total) || 0;

        const adjApplied = parseResults(
            db.exec(
                `SELECT COALESCE(SUM(amount), 0) as total 
                 FROM return_adjustments 
                 WHERE user_id = ? AND status = 'applied' AND strftime('%Y-%m', created_at) = ?`,
                [userId, ym]
            )
        );
        const returns_from_adjustments_mtd = Number(adjApplied[0]?.total) || 0;

        const adjPending = parseResults(
            db.exec(
                `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as cnt
                 FROM return_adjustments WHERE user_id = ? AND status = 'pending'`,
                [userId]
            )
        );
        const pending_returns_amount = Number(adjPending[0]?.total) || 0;

        const fees_deducted = feesDeductedForCalendarMonth(allSold, ym);

        const returns_this_month = returns_from_adjustments_mtd + refunds_from_sales_mtd;

        const current_balance = Math.round((sales_this_month - fees_deducted - returns_this_month) * 100) / 100;
        const available_for_payout = Math.round((current_balance - pending_returns_amount) * 100) / 100;
        const estimated_if_no_more_returns = current_balance;
        const estimated_after_pending_returns = available_for_payout;

        res.json({
            year_month: ym,
            currency: 'GBP',
            current_balance,
            pending_returns: pending_returns_amount,
            pending_returns_count: Number(adjPending[0]?.cnt) || 0,
            available_for_payout,
            payout_forecast: {
                if_no_more_returns: estimated_if_no_more_returns,
                after_pending_returns: estimated_after_pending_returns
            },
            breakdown: {
                sales_this_month: Math.round(sales_this_month * 100) / 100,
                returns_this_month: Math.round(returns_this_month * 100) / 100,
                fees_deducted: Math.round(fees_deducted * 100) / 100
            },
            fee_model_note: 'Fees follow your monthly free-processing rule (highest eligible sale that month has no fee).'
        });
    } catch (err) {
        console.error('Balance summary error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/balance/ledger — recent +/− lines (sales vs returns)
router.get('/ledger', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const userId = req.user.id;
        const limit = Math.min(parseInt(req.query.limit, 10) || 40, 100);

        const sold = parseResults(
            db.exec(
                `SELECT id, reference, product, quantity, profit, sold_date as at, status 
                 FROM sold_items WHERE user_id = ? 
                 ORDER BY sold_date DESC LIMIT ?`,
                [userId, limit * 2]
            )
        );

        const adj = parseResults(
            db.exec(
                `SELECT id, reference, product, amount, status, created_at as at, linked_sold_item_id, notes
                 FROM return_adjustments WHERE user_id = ? 
                 ORDER BY created_at DESC LIMIT ?`,
                [userId, limit * 2]
            )
        );

        const lines = [];
        sold.forEach((r) => {
            const profit = Number(r.profit) || 0;
            const isRefunded = r.status === 'Refunded';
            lines.push({
                kind: isRefunded ? 'return' : 'sale',
                label: (r.product || 'Item') + (isRefunded ? ' — Returned' : ' — Sold'),
                reference: r.reference || '',
                amount: isRefunded ? -Math.abs(profit) : profit,
                at: r.at,
                sold_item_id: r.id
            });
        });
        adj.forEach((r) => {
            const amt = Number(r.amount) || 0;
            lines.push({
                kind: 'return_adjustment',
                label: (r.product || 'Item') + ' — Return / clawback' + (r.status === 'pending' ? ' (pending)' : ''),
                reference: r.reference || '',
                amount: -Math.abs(amt),
                at: r.at,
                status: r.status,
                linked_sold_item_id: r.linked_sold_item_id,
                notes: r.notes || ''
            });
        });

        lines.sort((a, b) => String(b.at).localeCompare(String(a.at)));
        res.json({ lines: lines.slice(0, limit) });
    } catch (err) {
        console.error('Balance ledger error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
