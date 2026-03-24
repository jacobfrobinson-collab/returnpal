const express = require('express');
const { getDb, saveDb, pushActivity } = require('../database');
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

// POST /api/inventory/import — bulk intake lines from client CSV (parsed in browser)
// Body: { rows: [{ sku?, product, quantity?, reference? }, ...] }
router.post('/import', authMiddleware, async (req, res) => {
    try {
        const rows = req.body.rows;
        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(400).json({ error: 'Provide rows as a non-empty array' });
        }
        const db = await getDb();
        const userId = req.user.id;
        let imported = 0;
        const max = Math.min(rows.length, 500);
        const baseRef = 'CSV-' + Date.now();

        for (let i = 0; i < max; i++) {
            const raw = rows[i] || {};
            const sku = String(raw.sku || raw.SKU || '').trim().slice(0, 120);
            const product = String(raw.product || raw.Product || raw.product_name || raw.description || '').trim();
            const qty = Math.max(1, parseInt(raw.quantity || raw.Quantity || raw.qty || 1, 10) || 1);
            let reference = String(raw.reference || raw.Reference || raw.tracking || '').trim().slice(0, 200);
            if (!reference) reference = baseRef + '-' + (i + 1);
            if (!product) continue;

            const desc = sku ? `${product} [SKU: ${sku}]` : product;
            const notes = sku ? `csv_sku:${sku}` : 'csv_import';

            db.run(
                `INSERT INTO received_items (user_id, reference, items_description, quantity, status, notes, sku)
                 VALUES (?, ?, ?, ?, 'Processing', ?, ?)`,
                [userId, reference, desc, qty, notes, sku]
            );
            imported++;
        }

        saveDb();
        if (imported > 0) {
            await pushActivity(
                userId,
                'package_received',
                `Bulk inventory CSV: ${imported} intake line(s) added`,
                '/dashboard/received.html'
            );
        }

        res.json({
            imported,
            message: imported ? `${imported} line(s) added to received intake.` : 'No valid rows (need at least a product name per row).'
        });
    } catch (err) {
        console.error('Inventory import error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
