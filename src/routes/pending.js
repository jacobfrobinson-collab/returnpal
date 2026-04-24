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

// GET /api/pending
router.get('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const items = parseResults(
            db.exec('SELECT * FROM pending_items WHERE user_id = ? ORDER BY received_date DESC', [req.user.id])
        );

        const statsResult = parseResults(
            db.exec(
                `SELECT 
                    COUNT(*) as pending_count,
                    COALESCE(SUM(quantity), 0) as total_quantity,
                    MIN(received_date) as oldest_date
                FROM pending_items WHERE user_id = ?`,
                [req.user.id]
            )
        );

        const stats = statsResult.length > 0 ? statsResult[0] : {
            pending_count: 0, total_quantity: 0, oldest_date: null
        };

        res.json({ items, stats, total: items.length });
    } catch (err) {
        console.error('Get pending items error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/pending (admin can pass user_id)
router.post('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const { reference, product, quantity, current_stage, est_completion, notes, user_id } = req.body;

        let targetUserId = user_id != null ? parseInt(user_id, 10) : req.user.id;
        if (targetUserId !== req.user.id && !req.user.is_admin) {
            return res.status(403).json({ error: 'Only admins can add pending items for another user' });
        }
        if (isNaN(targetUserId)) targetUserId = req.user.id;

        db.run(
            `INSERT INTO pending_items (user_id, reference, product, quantity, current_stage, est_completion, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [targetUserId, reference, product, quantity || 1,
             current_stage || 'Initial Inspection', est_completion || '', notes || '']
        );
        saveDb();

        const result = db.exec('SELECT last_insert_rowid() as id');
        const id = result[0].values[0][0];

        const msg = 'Item added to pending: ' + (product || reference || '');
        await pushActivity(targetUserId, 'item_pending', msg, '/dashboard/item-pending.html');

        res.status(201).json({ message: 'Pending item recorded', id });
    } catch (err) {
        console.error('Create pending item error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

const PENDING_STAGES = ['Initial Inspection', 'Quality Check', 'Return Verification', 'Listing', 'Ready for Sale'];

function assertPendingAccess(db, req, id) {
    const rows = parseResults(db.exec('SELECT * FROM pending_items WHERE id = ?', [id]));
    if (!rows.length) return null;
    const row = rows[0];
    if (row.user_id !== req.user.id && !req.user.is_admin) return false;
    return row;
}

// GET /api/pending/:id – single item (for item detail page)
router.get('/:id', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const row = assertPendingAccess(db, req, req.params.id);
        if (row === null) return res.status(404).json({ error: 'Item not found' });
        if (row === false) return res.status(403).json({ error: 'Not authorized' });
        res.json({ item: row });
    } catch (err) {
        console.error('Get pending item error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/pending/:id/stage
router.put('/:id/stage', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const { current_stage, est_completion, notes } = req.body;
        if (current_stage && !PENDING_STAGES.includes(current_stage)) {
            return res.status(400).json({ error: 'Invalid stage. Allowed: ' + PENDING_STAGES.join(', ') });
        }

        const row = assertPendingAccess(db, req, req.params.id);
        if (row === null) return res.status(404).json({ error: 'Item not found' });
        if (row === false) return res.status(403).json({ error: 'Not authorized' });

        db.run(
            'UPDATE pending_items SET current_stage = ?, est_completion = ?, notes = ? WHERE id = ?',
            [current_stage, est_completion || '', notes || '', req.params.id]
        );
        saveDb();

        res.json({ message: 'Stage updated' });
    } catch (err) {
        console.error('Update pending stage error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/pending/:id — full update (owner or admin)
router.put('/:id', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const row = assertPendingAccess(db, req, req.params.id);
        if (row === null) return res.status(404).json({ error: 'Item not found' });
        if (row === false) return res.status(403).json({ error: 'Not authorized' });

        const { reference, product, quantity, current_stage, est_completion, notes } = req.body;
        const ref = reference !== undefined ? String(reference || '').trim() : row.reference;
        const prod = product !== undefined ? String(product || '').trim() : row.product;
        const qty = quantity != null ? Math.max(1, parseInt(quantity, 10) || 1) : row.quantity;
        const stage = current_stage != null && PENDING_STAGES.includes(current_stage) ? current_stage : row.current_stage;
        const est = est_completion !== undefined ? String(est_completion || '').trim() : row.est_completion;
        const note = notes !== undefined ? String(notes || '').trim() : row.notes;

        if (!prod) {
            return res.status(400).json({ error: 'Product is required' });
        }

        db.run(
            'UPDATE pending_items SET reference = ?, product = ?, quantity = ?, current_stage = ?, est_completion = ?, notes = ? WHERE id = ?',
            [ref, prod, qty, stage, est, note, req.params.id]
        );
        saveDb();
        res.json({ message: 'Pending item updated' });
    } catch (err) {
        console.error('Update pending item error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/pending/:id
router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();

        const row = assertPendingAccess(db, req, req.params.id);
        if (row === null) return res.status(404).json({ error: 'Item not found' });
        if (row === false) return res.status(403).json({ error: 'Not authorized' });

        db.run('DELETE FROM pending_items WHERE id = ?', [req.params.id]);
        saveDb();

        res.json({ message: 'Pending item removed' });
    } catch (err) {
        console.error('Delete pending item error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
