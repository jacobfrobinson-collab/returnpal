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

// GET /api/received
router.get('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const items = parseResults(
            db.exec('SELECT * FROM received_items WHERE user_id = ? ORDER BY date_received DESC', [req.user.id])
        );
        const total = items.length;
        res.json({ items, total });
    } catch (err) {
        console.error('Get received error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

const RECEIVED_STATUSES = ['Processing', 'Processed', 'Quality Check', 'Rejected'];

// GET /api/received/:id – single item (for item detail page)
router.get('/:id', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const items = parseResults(
            db.exec('SELECT * FROM received_items WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
        );
        if (items.length === 0) {
            return res.status(404).json({ error: 'Item not found' });
        }
        res.json({ item: items[0] });
    } catch (err) {
        console.error('Get received item error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/received (admin can pass user_id to record on behalf of client)
router.post('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const { reference, items_description, quantity, notes, user_id } = req.body;

        const ref = (reference != null ? String(reference).trim() : '');
        const desc = (items_description != null ? String(items_description).trim() : '');
        if (!ref || !desc) {
            return res.status(400).json({ error: 'Reference and items description are required' });
        }

        let targetUserId = user_id != null ? parseInt(user_id, 10) : req.user.id;
        if (targetUserId !== req.user.id && !req.user.is_admin) {
            return res.status(403).json({ error: 'Only admins can record received items for another user' });
        }
        if (isNaN(targetUserId)) targetUserId = req.user.id;

        const qty = Math.max(1, parseInt(quantity, 10) || 1);

        db.run(
            'INSERT INTO received_items (user_id, reference, items_description, quantity, notes) VALUES (?, ?, ?, ?, ?)',
            [targetUserId, ref.slice(0, 255), desc.slice(0, 1000), qty, (notes != null ? String(notes).slice(0, 2000) : '')]
        );
        saveDb();

        const result = db.exec('SELECT last_insert_rowid() as id');
        const id = result[0].values[0][0];

        const msg = 'Package received: ' + ref + (desc ? ' – ' + desc.slice(0, 80) : '');
        await pushActivity(targetUserId, 'package_received', msg, '/dashboard/received.html');

        res.status(201).json({ message: 'Received item recorded', id });
    } catch (err) {
        console.error('Create received error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/received/:id/status (owner or admin)
router.put('/:id/status', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const { status } = req.body;
        if (!status || !RECEIVED_STATUSES.includes(status)) {
            return res.status(400).json({ error: 'Invalid status. Allowed: ' + RECEIVED_STATUSES.join(', ') });
        }

        const existing = parseResults(
            db.exec('SELECT id, user_id, reference FROM received_items WHERE id = ?', [req.params.id])
        );
        if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
        const item = existing[0];
        if (item.user_id !== req.user.id && !req.user.is_admin) {
            return res.status(403).json({ error: 'Not authorized to update this item' });
        }

        db.run('UPDATE received_items SET status = ? WHERE id = ?', [status, req.params.id]);
        saveDb();

        const msg = 'Item ' + (item.reference || '') + ' status updated to ' + (status || '');
        await pushActivity(item.user_id, 'item_processed', msg, '/dashboard/received.html');

        res.json({ message: 'Status updated' });
    } catch (err) {
        console.error('Update received status error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
