const express = require('express');
const { getDb, saveDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

function parseResults(result) {
    if (!result || !result.length) return [];
    const cols = result[0].columns;
    return result[0].values.map((row) => {
        const obj = {};
        cols.forEach((col, i) => {
            obj[col] = row[i];
        });
        return obj;
    });
}

// GET /api/announcements
router.get('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const rows = parseResults(
            db.exec(
                `SELECT id, title, summary, body, published_at
                 FROM announcements
                 WHERE is_published = 1
                 ORDER BY published_at DESC, id DESC
                 LIMIT 50`
            )
        );
        const readRows = parseResults(
            db.exec('SELECT announcement_id FROM announcement_reads WHERE user_id = ?', [req.user.id])
        );
        const readSet = new Set(readRows.map((r) => r.announcement_id));
        const announcements = rows.map((a) => ({
            id: a.id,
            title: a.title,
            summary: a.summary,
            body: a.body,
            date: String(a.published_at || '').slice(0, 10),
            read: readSet.has(a.id),
        }));
        const unread_count = announcements.filter((a) => !a.read).length;
        res.json({ announcements, unread_count });
    } catch (err) {
        console.error('List announcements error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/announcements/read — body: { ids: number[] } or mark all if empty
router.post('/read', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        let ids = req.body && Array.isArray(req.body.ids) ? req.body.ids.map((x) => parseInt(x, 10)).filter(Number.isFinite) : [];
        if (!ids.length) {
            const all = parseResults(db.exec('SELECT id FROM announcements WHERE is_published = 1'));
            ids = all.map((a) => a.id);
        }
        for (const aid of ids) {
            db.run(
                `INSERT OR IGNORE INTO announcement_reads (user_id, announcement_id, read_at)
                 VALUES (?, ?, datetime('now'))`,
                [req.user.id, aid]
            );
        }
        saveDb();
        res.json({ message: 'Marked as read', count: ids.length });
    } catch (err) {
        console.error('Mark announcements read error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
