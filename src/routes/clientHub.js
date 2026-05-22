const express = require('express');
const { getDb } = require('../database');
const { authMiddleware, generateToken } = require('../middleware/auth');
const {
    hubCanAccessClient,
    countLinkedClients,
    listLinkedClients,
    getHubOverview,
} = require('../utils/clientDelegate');

const router = express.Router();

function parseUserRow(result) {
    if (!result.length || !result[0].values.length) return null;
    const row = result[0].values[0];
    const cols = result[0].columns;
    const user = {};
    cols.forEach((col, i) => {
        user[col] = row[i];
    });
    return user;
}

// GET /api/client/hub — am I a hub account? linked client count
router.get('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const count = countLinkedClients(db, req.user.id);
        res.json({
            is_hub_account: count > 0,
            linked_clients_count: count,
        });
    } catch (err) {
        console.error('Hub meta error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/client/hub/clients — list linked clients (basic)
router.get('/clients', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const clients = listLinkedClients(db, req.user.id);
        res.json({
            clients: clients.map((c) => ({
                id: c.id,
                client_code: 'RP' + c.id,
                email: c.email,
                full_name: c.full_name,
                company_name: c.company_name,
                legacy_client_id: c.legacy_client_id || '',
                display_name: c.full_name || c.company_name || c.email,
            })),
        });
    } catch (err) {
        console.error('Hub clients list error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/client/hub/overview — aggregated stats per linked client
router.get('/overview', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        res.json(getHubOverview(db, req.user.id));
    } catch (err) {
        console.error('Hub overview error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/client/hub/view-as/:clientUserId — short-lived token to open client dashboard
router.post('/view-as/:clientUserId', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const hubId = req.user.id;
        const clientId = parseInt(req.params.clientUserId, 10);
        if (!Number.isFinite(clientId)) {
            return res.status(400).json({ error: 'Invalid client id' });
        }
        if (!hubCanAccessClient(db, hubId, clientId)) {
            return res.status(403).json({ error: 'You do not have access to that client account.' });
        }

        const user = parseUserRow(
            db.exec(
                'SELECT id, email, full_name, company_name FROM users WHERE id = ?',
                [clientId]
            )
        );
        if (!user) {
            return res.status(404).json({ error: 'Client not found' });
        }

        const token = generateToken(
            { id: user.id, email: user.email, is_admin: false, delegate_hub_id: hubId },
            '4h'
        );

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                full_name: user.full_name,
                company_name: user.company_name,
            },
            hub_user_id: hubId,
        });
    } catch (err) {
        console.error('Hub view-as error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
