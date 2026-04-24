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
        const { reference, product, quantity, unit_price, total_revenue, profit, margin, user_id, sold_date, earnings } = req.body;

        let targetUserId = user_id != null ? parseInt(user_id, 10) : req.user.id;
        if (targetUserId !== req.user.id && !req.user.is_admin) {
            return res.status(403).json({ error: 'Only admins can record sales for another user' });
        }
        if (isNaN(targetUserId)) targetUserId = req.user.id;

        if (product == null || String(product).trim() === '') {
            return res.status(400).json({ error: 'Product is required' });
        }

        const qty = quantity || 1;
        const earningsNum = earnings !== undefined && earnings !== null && String(earnings).trim() !== '' ? Number(earnings) : NaN;
        let ref = reference != null ? String(reference).trim() : '';
        let u = unit_price != null ? Number(unit_price) : 0;
        let total = total_revenue != null ? Number(total_revenue) : 0;
        let p = profit != null ? Number(profit) : 0;
        let m = margin != null ? Number(margin) : 0;
        if (Number.isFinite(earningsNum)) {
            p = earningsNum;
            total = earningsNum;
            u = qty ? earningsNum / qty : 0;
            m = 0;
        }
        const soldDateStr =
            sold_date != null && String(sold_date).trim() !== '' ? String(sold_date).trim() : null;

        db.run(
            `INSERT INTO sold_items (user_id, reference, product, quantity, unit_price, total_revenue, profit, margin, sold_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
            [targetUserId, ref, product, qty, u || 0, total || 0, p || 0, m || 0, soldDateStr]
        );
        saveDb();

        const result = db.exec('SELECT last_insert_rowid() as id');
        const id = result[0].values[0][0];

        const amount =
            Number.isFinite(earningsNum)
                ? earningsNum
                : total_revenue != null
                  ? Number(total_revenue)
                  : unit_price != null
                    ? Number(unit_price) * (quantity || 1)
                    : 0;
        const msg = 'Item "' + (product || '') + '" sold for £' + amount.toFixed(2);
        await pushActivity(targetUserId, 'item_sold', msg, '/dashboard/sold-items.html');

        res.status(201).json({ message: 'Sold item recorded', id });
    } catch (err) {
        console.error('Create sold item error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

function canAccessSoldRow(db, req, id) {
    const rows = parseResults(db.exec('SELECT * FROM sold_items WHERE id = ?', [id]));
    if (!rows.length) return null;
    const row = rows[0];
    if (row.user_id !== req.user.id && !req.user.is_admin) return false;
    return row;
}

// PUT /api/sold/:id — owner or admin
router.put('/:id', authMiddleware, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const db = await getDb();
        const row = canAccessSoldRow(db, req, id);
        if (row === null) return res.status(404).json({ error: 'Not found' });
        if (row === false) return res.status(403).json({ error: 'Not authorized' });

        const { reference, product, quantity, unit_price, total_revenue, profit, margin, sold_date, earnings } = req.body;
        if (product != null && String(product).trim() === '') {
            return res.status(400).json({ error: 'Product cannot be empty' });
        }

        const qty = quantity != null ? Math.max(1, parseInt(quantity, 10) || 1) : row.quantity || 1;
        const earningsNum = earnings !== undefined && earnings !== null && String(earnings).trim() !== '' ? Number(earnings) : NaN;

        let ref = reference !== undefined ? String(reference || '').trim() : row.reference;
        let u;
        let total;
        let p;
        let m;
        if (Number.isFinite(earningsNum)) {
            p = earningsNum;
            total = earningsNum;
            u = qty ? earningsNum / qty : 0;
            m = 0;
        } else {
            u = unit_price != null ? Number(unit_price) : row.unit_price;
            total = total_revenue != null ? Number(total_revenue) : row.total_revenue;
            if (!total && u) total = u * qty;
            p = profit != null ? Number(profit) : row.profit;
            m = margin != null ? Number(margin) : row.margin;
        }

        const prod = product != null ? String(product).trim() : row.product;
        let soldDateVal;
        if (sold_date !== undefined) {
            soldDateVal =
                sold_date != null && String(sold_date).trim() !== '' ? String(sold_date).trim() : row.sold_date;
        } else {
            soldDateVal = row.sold_date;
        }

        db.run(
            `UPDATE sold_items SET reference = ?, product = ?, quantity = ?, unit_price = ?, total_revenue = ?, profit = ?, margin = ?, sold_date = ?
             WHERE id = ?`,
            [ref, prod, qty, u || 0, total || 0, p || 0, m || 0, soldDateVal, id]
        );
        saveDb();
        res.json({ message: 'Sold item updated' });
    } catch (err) {
        console.error('Update sold item error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/sold/:id — owner or admin
router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const db = await getDb();
        const row = canAccessSoldRow(db, req, id);
        if (row === null) return res.status(404).json({ error: 'Not found' });
        if (row === false) return res.status(403).json({ error: 'Not authorized' });

        db.run('DELETE FROM sold_items WHERE id = ?', [id]);
        saveDb();
        res.json({ message: 'Sold item removed' });
    } catch (err) {
        console.error('Delete sold item error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
