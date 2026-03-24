const express = require('express');
const { getDb, saveDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

function parseResults(result) {
    if (!result || !result.length) return [];
    const cols = result[0].columns;
    return result[0].values.map((row) => {
        const obj = {};
        cols.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

// POST /api/queries — client raises a query on an item/order
router.post('/', authMiddleware, async (req, res) => {
    try {
        const { context_type, context_id, context_label, message } = req.body;
        const msg = message != null ? String(message).trim() : '';
        if (!msg || msg.length < 5) {
            return res.status(400).json({ error: 'Please enter a message (at least 5 characters).' });
        }
        const ctx = String(context_type || 'general').slice(0, 40);
        const cid = context_id != null ? parseInt(context_id, 10) : null;
        const label = context_label != null ? String(context_label).slice(0, 500) : '';

        const db = await getDb();
        db.run(
            `INSERT INTO item_queries (user_id, context_type, context_id, context_label, message) VALUES (?, ?, ?, ?, ?)`,
            [req.user.id, ctx, Number.isFinite(cid) ? cid : null, label, msg]
        );
        saveDb();
        const rid = db.exec('SELECT last_insert_rowid() as id');
        const id = rid[0].values[0][0];
        res.status(201).json({ id, message: 'Query submitted. We will get back to you.' });
    } catch (err) {
        console.error('Create query error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/queries — my queries
router.get('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const rows = parseResults(
            db.exec(
                `SELECT id, context_type, context_id, context_label, message, status, created_at 
                 FROM item_queries WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
                [req.user.id]
            )
        );
        res.json({ queries: rows });
    } catch (err) {
        console.error('List queries error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
