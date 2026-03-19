const express = require('express');
const { getDb, saveDb } = require('../database');
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

// GET /api/settings
router.get('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const users = parseResults(
            db.exec('SELECT vat_registered, discord_webhook FROM users WHERE id = ?', [req.user.id])
        );

        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ settings: users[0] });
    } catch (err) {
        console.error('Get settings error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/settings/vat
router.put('/vat', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const { vat_registered } = req.body;

        db.run(
            "UPDATE users SET vat_registered = ?, updated_at = datetime('now') WHERE id = ?",
            [vat_registered ? 1 : 0, req.user.id]
        );
        saveDb();

        res.json({ message: 'VAT setting updated', vat_registered: !!vat_registered });
    } catch (err) {
        console.error('Update VAT error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/settings/webhook
router.put('/webhook', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const { discord_webhook } = req.body;

        // Basic validation for Discord webhook URL
        if (discord_webhook && !discord_webhook.startsWith('https://discord.com/api/webhooks/')) {
            return res.status(400).json({ error: 'Invalid Discord webhook URL' });
        }

        db.run(
            "UPDATE users SET discord_webhook = ?, updated_at = datetime('now') WHERE id = ?",
            [discord_webhook || '', req.user.id]
        );
        saveDb();

        res.json({ message: 'Discord webhook saved' });
    } catch (err) {
        console.error('Update webhook error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
