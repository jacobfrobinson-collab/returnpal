const express = require('express');
const { getDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

function parseResults(result) {
    if (!result || result.length === 0) return [];
    const cols = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        cols.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

// GET /api/reports/roi?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/roi', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const userId = req.user.id;
        let from = req.query.from;
        let to = req.query.to;
        const now = new Date();
        if (!to) to = now.toISOString().slice(0, 10);
        if (!from) {
            const start = new Date(now);
            start.setDate(1);
            from = start.toISOString().slice(0, 10);
        }

        const items = parseResults(
            db.exec(
                `SELECT product, total_revenue, profit, quantity FROM sold_items 
                 WHERE user_id = ? AND date(sold_date) >= date(?) AND date(sold_date) <= date(?) 
                 ORDER BY total_revenue DESC`,
                [userId, from, to]
            )
        );

        const recovered = items.reduce((s, i) => s + (Number(i.total_revenue) || 0), 0);
        const you_kept = items.reduce((s, i) => s + (Number(i.profit) || 0), 0);
        const fees = Math.max(0, recovered - you_kept);
        // Cost value sent: sum of cost_of_goods from packages in the same period
        const pkgAgg = parseResults(
            db.exec(
                `SELECT 
                    COALESCE(SUM(pp.cost_of_goods * pp.quantity), 0) AS total_cost,
                    COUNT(DISTINCT pp.id) AS distinct_items
                 FROM packages p
                 JOIN package_products pp ON pp.package_id = p.id
                 WHERE p.user_id = ? 
                   AND date(p.date_added) >= date(?) 
                   AND date(p.date_added) <= date(?)`,
                [userId, from, to]
            )
        )[0] || { total_cost: 0, distinct_items: 0 };

        const cost_value_sent = Number(pkgAgg.total_cost) || 0;
        const distinct_items = Number(pkgAgg.distinct_items) || 0;

        const top_items = items.slice(0, 10).map(i => ({
            name: i.product,
            recovered: Number(i.total_revenue) || 0,
            you_kept: Number(i.profit) || 0
        }));

        const noRecovery = parseResults(
            db.exec(
                `SELECT product FROM sold_items 
                 WHERE user_id = ? AND date(sold_date) >= date(?) AND date(sold_date) <= date(?) 
                 AND (COALESCE(profit, 0) = 0 OR COALESCE(total_revenue, 0) = 0)`,
                [userId, from, to]
            )
        );
        const no_recovery_items = noRecovery.map(i => ({
            name: i.product,
            reason: 'No recovery',
            note: 'No charge'
        }));

        const recovery_rate_pct = cost_value_sent > 0 ? (recovered / cost_value_sent) * 100 : 0;
        // Est. time saved: 20 minutes per distinct item sent
        const estimated_hours_saved = distinct_items > 0 ? Math.round(distinct_items * (20 / 60) * 10) / 10 : 0;

        res.json({
            period_start: from,
            period_end: to,
            cost_value_sent,
            recovered,
            you_kept,
            fees,
            estimated_hours_saved,
            recovery_rate_pct,
            category_avg_pct: recovery_rate_pct,
            top_items,
            no_recovery_items
        });
    } catch (err) {
        console.error('ROI report error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
