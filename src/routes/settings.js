const express = require('express');
const { getDb, saveDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const {
    parseClientPreferences,
    mergeClientPreferencesFromClient,
} = require('../utils/clientPreferences');
const { prefsFromUserRow } = require('../utils/emailPreferences');

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
            db.exec(
                `SELECT vat_registered, discord_webhook, COALESCE(legacy_client_id, '') AS legacy_client_id,
                        COALESCE(weekly_digest_email, 1) AS weekly_digest_email,
                        COALESCE(client_preferences, '') AS client_preferences
                 FROM users WHERE id = ?`,
                [req.user.id]
            )
        );

        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const prefs = prefsFromUserRow(users[0]);
        res.json({
            settings: {
                vat_registered: !!users[0].vat_registered,
                discord_webhook: users[0].discord_webhook || '',
                legacy_client_id: users[0].legacy_client_id || '',
                weekly_digest_email: users[0].weekly_digest_email,
                preferences: prefs,
            },
        });
    } catch (err) {
        console.error('Get settings error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/settings/preferences — billing, prep, VAT number, email toggles
router.put('/preferences', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const cur = parseResults(
            db.exec('SELECT client_preferences FROM users WHERE id = ?', [req.user.id])
        );
        const merged = mergeClientPreferencesFromClient(cur[0]?.client_preferences, req.body);
        const weeklyDigestCol = merged.email_digest === 'weekly' ? 1 : 0;
        db.run(
            "UPDATE users SET client_preferences = ?, weekly_digest_email = ?, updated_at = datetime('now') WHERE id = ?",
            [JSON.stringify(merged), weeklyDigestCol, req.user.id]
        );
        saveDb();
        res.json({ message: 'Preferences saved', preferences: merged });
    } catch (err) {
        console.error('Update preferences error:', err);
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

// PUT /api/settings/weekly-digest
router.put('/weekly-digest', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const on = req.body.weekly_digest_email !== false && req.body.weekly_digest_email !== 0 && req.body.weekly_digest_email !== '0';
        db.run("UPDATE users SET weekly_digest_email = ?, updated_at = datetime('now') WHERE id = ?", [on ? 1 : 0, req.user.id]);
        saveDb();
        res.json({ message: 'Preference saved', weekly_digest_email: on ? 1 : 0 });
    } catch (err) {
        console.error('Weekly digest setting error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
