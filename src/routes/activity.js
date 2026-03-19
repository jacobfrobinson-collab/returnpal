const express = require('express');
const { getDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const TYPE_ICONS = {
    package_received: 'ri-inbox-archive-line',
    package_delivered: 'ri-checkbox-circle-line',
    item_processed: 'ri-list-check',
    item_sold: 'ri-money-pound-circle-line',
    item_pending: 'ri-time-line',
    payout_sent: 'ri-bank-card-line',
    info: 'ri-circle-line'
};

function parseResults(result) {
    if (!result || result.length === 0) return [];
    const cols = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        cols.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

// GET /api/activity – activity feed for current user
router.get('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
        const rows = parseResults(
            db.exec(
                'SELECT id, type, message, link, created_at FROM activities WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
                [req.user.id, limit]
            )
        );
        const events = rows.map(r => ({
            message: r.message,
            timestamp: r.created_at,
            icon: TYPE_ICONS[r.type] || TYPE_ICONS.info,
            link: r.link || undefined,
            type: r.type
        }));
        res.json({ events });
    } catch (err) {
        console.error('Get activity error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
