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

        res.json({
            recoveryRate,
            avgRecoveryPerItem,
            recoveredOverTime
        });
    } catch (err) {
        console.error('Analytics error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
