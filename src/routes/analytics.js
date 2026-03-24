const express = require('express');
const { getDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseResults(result) {
    if (!result || result.length === 0) return [];
    const cols = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        cols.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

// GET /api/analytics – recovery rate, avg per item, recovered over time (last 12 months)
router.get('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const userId = req.user.id;

        const totals = parseResults(
            db.exec(
                `SELECT 
                    COALESCE(SUM(total_revenue), 0) as total_recovered,
                    COUNT(*) as item_count,
                    COALESCE(AVG(total_revenue), 0) as avg_per_item
                FROM sold_items WHERE user_id = ? AND total_revenue > 0`,
                [userId]
            )
        );
        const totalRecovered = totals[0]?.total_recovered || 0;
        const itemCount = totals[0]?.item_count || 0;
        const avgRecoveryPerItem = totals[0]?.avg_per_item || 0;

        const byMonth = parseResults(
            db.exec(
                `SELECT 
                    strftime('%Y', sold_date) as yr,
                    strftime('%m', sold_date) as mo,
                    COALESCE(SUM(total_revenue), 0) as value
                FROM sold_items WHERE user_id = ? 
                GROUP BY yr, mo 
                ORDER BY yr, mo`,
                [userId]
            )
        );

        const recoveredOverTime = byMonth.map(row => ({
            month: MONTHS[parseInt(row.mo, 10) - 1] + ' ' + row.yr,
            value: Number(row.value) || 0
        }));

        const receivedCount = parseResults(
            db.exec('SELECT COUNT(*) as c FROM received_items WHERE user_id = ?', [userId])
        );
        const totalReceived = receivedCount[0]?.c || 0;
        const recoveryRate = totalReceived > 0 ? itemCount / totalReceived : 0;

        const sellThroughRate = totalReceived > 0 ? itemCount / totalReceived : 0;

        const avgSale = parseResults(
            db.exec(
                `SELECT COALESCE(AVG(CASE WHEN total_revenue > 0 THEN total_revenue ELSE unit_price * quantity END), 0) as a
                 FROM sold_items WHERE user_id = ? AND (status IS NULL OR status != 'Refunded')`,
                [userId]
            )
        );
        const averageSalePrice = Number(avgSale[0]?.a) || 0;

        const soldTotal = parseResults(
            db.exec('SELECT COUNT(*) as c FROM sold_items WHERE user_id = ?', [userId])
        );
        const soldN = soldTotal[0]?.c || 0;
        const refundedN = parseResults(
            db.exec(`SELECT COUNT(*) as c FROM sold_items WHERE user_id = ? AND status = 'Refunded'`, [userId])
        )[0]?.c || 0;
        const adjN = parseResults(
            db.exec(`SELECT COUNT(*) as c FROM return_adjustments WHERE user_id = ? AND status = 'applied'`, [userId])
        )[0]?.c || 0;
        const returnRate = soldN > 0 ? (refundedN + adjN) / soldN : 0;

        const topProducts = parseResults(
            db.exec(
                `SELECT product as name, COUNT(*) as units_sold, COALESCE(SUM(profit), 0) as profit_sum, COALESCE(AVG(total_revenue), 0) as avg_revenue
                 FROM sold_items WHERE user_id = ? AND (status IS NULL OR status != 'Refunded') AND total_revenue >= 0
                 GROUP BY product ORDER BY profit_sum DESC LIMIT 8`,
                [userId]
            )
        );
        const top_categories = topProducts.map((r) => ({
            name: r.name,
            units_sold: r.units_sold,
            profit_sum: Number(r.profit_sum) || 0,
            avg_sale_price: Number(r.avg_revenue) || 0
        }));

        res.json({
            recoveryRate,
            avgRecoveryPerItem,
            recoveredOverTime,
            sellThroughRate,
            averageSalePrice,
            returnRate,
            top_categories,
            counts: { items_received: totalReceived, items_sold: soldN, items_refunded: refundedN, return_adjustments: adjN }
        });
    } catch (err) {
        console.error('Analytics error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
