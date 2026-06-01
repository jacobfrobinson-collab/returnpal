const express = require('express');
const { getDb, saveDb, pushActivity } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { buildInventorySummaryPayload } = require('../utils/inventorySummary');
const {
    rebuildRefundInsightsCache,
    getRefundInsightsFromCache,
    cacheIsStale
} = require('../utils/refundInsights');

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
        const payload = buildInventorySummaryPayload(db, req.user.id);
        res.json(payload);
    } catch (err) {
        console.error('Inventory summary error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/inventory/refund-insights — admin / global cache (not used on client inventory hub)
router.get('/refund-insights', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        let rebuilt = false;
        if (cacheIsStale(db, 6)) {
            rebuildRefundInsightsCache(db);
            await saveDb(db);
            rebuilt = true;
        }
        const data = getRefundInsightsFromCache(db, 5);
        res.json({ ...data, cache_refreshed: rebuilt });
    } catch (err) {
        console.error('Inventory refund insights error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/inventory/import — bulk intake lines from client CSV (parsed in browser)
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

            const pkgMatch = parseResults(
                db.exec('SELECT id FROM packages WHERE user_id = ? AND reference = ? LIMIT 1', [userId, reference])
            );
            const packageId = pkgMatch[0] ? pkgMatch[0].id : null;

            db.run(
                `INSERT INTO received_items (user_id, package_id, reference, items_description, quantity, status, notes, sku)
                 VALUES (?, ?, ?, ?, ?, 'Processing', ?, ?)`,
                [userId, packageId, reference, desc, qty, notes, sku]
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
