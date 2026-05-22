const express = require('express');
const { getDb } = require('../database');
const { partnerAuthMiddleware, partnerCanAccessUser } = require('../middleware/partnerAuth');
const { getPartnerClientStatus } = require('../utils/partnerClientStatus');

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

router.use(partnerAuthMiddleware);

// GET /api/partner/v1/clients
router.get('/v1/clients', async (req, res) => {
    try {
        const db = await getDb();
        const rows = parseResults(
            db.exec(
                `SELECT u.id, u.email, u.full_name, u.company_name
                 FROM partner_client_access pca
                 JOIN users u ON u.id = pca.user_id
                 WHERE pca.partner_id = ?
                 ORDER BY u.full_name, u.email`,
                [req.partner.id]
            )
        );
        res.json({
            partner: req.partner.name,
            clients: rows.map((r) => ({
                id: r.id,
                client_code: 'RP' + r.id,
                name: r.full_name || r.company_name || r.email,
                email: r.email,
            })),
        });
    } catch (err) {
        console.error('Partner list clients error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/partner/v1/clients/:userId/status — embed + API payload
router.get('/v1/clients/:userId/status', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId, 10);
        if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Invalid client id' });
        const db = await getDb();
        if (!partnerCanAccessUser(db, req.partner.id, userId)) {
            return res.status(403).json({ error: 'This partner is not linked to that client.' });
        }
        const status = getPartnerClientStatus(db, userId);
        if (!status) return res.status(404).json({ error: 'Client not found' });
        res.json({ partner: req.partner.name, status });
    } catch (err) {
        console.error('Partner client status error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
