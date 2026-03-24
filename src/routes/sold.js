const express = require('express');
const { getDb, saveDb, pushActivity } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { computeMonthlyFreeProcessing } = require('../utils/monthlyFreeProcessing');

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

// GET /api/sold - List sold items with summary stats
router.get('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const items = parseResults(
            db.exec('SELECT * FROM sold_items WHERE user_id = ? ORDER BY sold_date DESC', [req.user.id])
        );

        // Compute stats
        const statsResult = parseResults(
            db.exec(
                `SELECT 
                    COALESCE(SUM(profit), 0) as total_earnings,
                    COUNT(*) as items_sold,
                    COALESCE(AVG(profit), 0) as avg_earnings,
                    COALESCE(AVG(margin), 0) as avg_margin
                FROM sold_items WHERE user_id = ?`,
                [req.user.id]
            )
        );

        const stats = statsResult.length > 0 ? statsResult[0] : {
            total_earnings: 0, items_sold: 0, avg_earnings: 0, avg_margin: 0
        };

        const promo = computeMonthlyFreeProcessing(items);
        const itemsWithPromo = items.map((row) => {
            const w = promo.winner_by_item_id[String(row.id)];
            return {
                ...row,
                is_monthly_free_processing: !!w,
                monthly_free_processing_month: w ? w.year_month : null
            };
        });

        res.json({
            items: itemsWithPromo,
            stats,
            total: items.length,
            monthly_free_processing: {
                fee_percent: promo.fee_percent,
                revenue_interpreted_as_net: promo.revenue_interpreted_as_net,
                months: promo.months
            }
        });
    } catch (err) {
        console.error('Get sold items error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/sold (admin can pass user_id to record sale for client)
router.post('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const { reference, product, quantity, unit_price, total_revenue, profit, margin, user_id } = req.body;

        let targetUserId = user_id != null ? parseInt(user_id, 10) : req.user.id;
        if (targetUserId !== req.user.id && !req.user.is_admin) {
            return res.status(403).json({ error: 'Only admins can record sales for another user' });
        }
        if (isNaN(targetUserId)) targetUserId = req.user.id;

        db.run(
            `INSERT INTO sold_items (user_id, reference, product, quantity, unit_price, total_revenue, profit, margin)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [targetUserId, reference, product, quantity || 1, unit_price || 0,
             total_revenue || 0, profit || 0, margin || 0]
        );
        saveDb();

        const result = db.exec('SELECT last_insert_rowid() as id');
        const id = result[0].values[0][0];

        const amount = total_revenue != null ? Number(total_revenue) : (unit_price != null ? Number(unit_price) * (quantity || 1) : 0);
        const msg = 'Item "' + (product || '') + '" sold for £' + amount.toFixed(2);
        await pushActivity(targetUserId, 'item_sold', msg, '/dashboard/sold-items.html');

        res.status(201).json({ message: 'Sold item recorded', id });
    } catch (err) {
        console.error('Create sold item error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
