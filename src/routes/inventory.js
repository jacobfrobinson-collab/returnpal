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

// GET /api/inventory/summary
router.get('/summary', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const userId = req.user.id;

        const receivedCount = parseResults(
            db.exec('SELECT COUNT(*) as c FROM received_items WHERE user_id = ?', [userId])
        );
        const soldCount = parseResults(
            db.exec('SELECT COUNT(*) as c FROM sold_items WHERE user_id = ?', [userId])
        );
        const pendingCount = parseResults(
            db.exec('SELECT COUNT(*) as c FROM pending_items WHERE user_id = ?', [userId])
        );
        const recoveredSum = parseResults(
            db.exec('SELECT COALESCE(SUM(total_revenue), 0) as total FROM sold_items WHERE user_id = ?', [userId])
        );

        const pendingByStage = parseResults(
            db.exec(
                `SELECT current_stage, COUNT(*) as c FROM pending_items WHERE user_id = ? GROUP BY current_stage`,
                [userId]
            )
        );
        const stageMap = { 'Initial Inspection': 'inspection', 'Quality Check': 'inspection', 'Return Verification': 'inspection', 'Listing': 'listing', 'Ready for Sale': 'listed' };
        const stage_breakdown = { inspection: 0, listing: 0, listed: 0, sold: soldCount[0]?.c || 0, storage: 0 };
        pendingByStage.forEach(row => {
            const key = stageMap[row.current_stage] || 'storage';
            if (key in stage_breakdown) stage_breakdown[key] += row.c || 0;
            else stage_breakdown.storage += row.c || 0;
        });

        const items_received = receivedCount[0]?.c || 0;
        const items_processing = pendingCount[0]?.c || 0;
        const items_sold = soldCount[0]?.c || 0;
        const recovered_so_far = recoveredSum[0]?.total || 0;
        const awaiting_inspection = stage_breakdown.inspection || 0;
        const awaiting_listing = stage_breakdown.listing || 0;
        const estimated_resale_value = 0;
        const potential_remaining_value = estimated_resale_value;

        res.json({
            items_received,
            items_processing,
            items_sold,
            awaiting_inspection,
            awaiting_listing,
            estimated_resale_value,
            recovered_so_far,
            potential_remaining_value,
            stage_breakdown
        });
    } catch (err) {
        console.error('Inventory summary error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
