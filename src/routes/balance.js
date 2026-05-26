const express = require('express');
const { getDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { feesDeductedForCalendarMonth } = require('../utils/monthlyFreeProcessing');
const { getInvoiceCapTz } = require('../utils/computedMonthlyStatements');
const { calendarYearMonthFromDbDate } = require('../utils/soldDateCalendar');
const { effectiveDateForReturnAdjustment } = require('../utils/returnAdjustmentDates');

const router = express.Router();

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

/** Current calendar YYYY-MM in the business timezone (same default as invoice cap). */
function calendarYearMonthNowInTz(tz) {
    const d = new Date();
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit'
        })
            .format(d)
            .slice(0, 7);
    } catch {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    }
}

// GET /api/balance/summary — live balance, payout forecast, MTD breakdown
router.get('/summary', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const userId = req.user.id;
        const tz = getInvoiceCapTz();
        const ym = calendarYearMonthNowInTz(tz);

        const allSold = parseResults(
            db.exec('SELECT * FROM sold_items WHERE user_id = ? ORDER BY sold_date DESC', [userId])
        );

        let sales_this_month = 0;
        let refunds_from_sales_mtd = 0;
        for (const row of allSold) {
            const cm = calendarYearMonthFromDbDate(row.sold_date);
            if (cm !== ym) continue;
            const p = Number(row.profit) || 0;
            if (row.status === 'Refunded') refunds_from_sales_mtd += p;
            else sales_this_month += p;
        }

        const appliedAdj = parseResults(
            db.exec(
                `SELECT amount, created_at, refund_date FROM return_adjustments 
                 WHERE user_id = ? AND status = 'applied'`,
                [userId]
            )
        );
        let returns_from_adjustments_mtd = 0;
        for (const r of appliedAdj) {
            if (calendarYearMonthFromDbDate(effectiveDateForReturnAdjustment(r)) === ym) {
                returns_from_adjustments_mtd += Number(r.amount) || 0;
            }
        }

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

        // sold_items.profit / earnings are already the client's share (fee taken before import);
        // same rule as computedMonthlyStatements — do not subtract fees_deducted again.
        const current_balance = Math.round((sales_this_month - returns_this_month) * 100) / 100;
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
            fee_model_note:
                'Line earnings already include ReturnPal processing fees (except the one monthly free-processing sale). fees_deducted in breakdown is informational only.'
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
