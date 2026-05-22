const crypto = require('crypto');
const { getDb } = require('../database');

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

function hashApiKey(key) {
    return crypto.createHash('sha256').update(String(key)).digest('hex');
}

async function partnerAuthMiddleware(req, res, next) {
    const raw =
        req.headers['x-partner-key'] ||
        (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
            ? req.headers.authorization.split(' ')[1]
            : null);
    if (!raw) {
        return res.status(401).json({ error: 'Partner API key required (X-Partner-Key header).' });
    }
    try {
        const db = await getDb();
        const hash = hashApiKey(raw);
        const rows = parseResults(
            db.exec(
                'SELECT id, name, is_active FROM partner_integrations WHERE api_key_hash = ? LIMIT 1',
                [hash]
            )
        );
        if (!rows.length || !rows[0].is_active) {
            return res.status(401).json({ error: 'Invalid partner API key.' });
        }
        req.partner = { id: rows[0].id, name: rows[0].name };
        next();
    } catch (err) {
        console.error('Partner auth error:', err);
        res.status(500).json({ error: 'Server error' });
    }
}

function partnerCanAccessUser(db, partnerId, userId) {
    const rows = parseResults(
        db.exec(
            'SELECT 1 AS ok FROM partner_client_access WHERE partner_id = ? AND user_id = ? LIMIT 1',
            [partnerId, userId]
        )
    );
    return rows.length > 0;
}

module.exports = { partnerAuthMiddleware, hashApiKey, partnerCanAccessUser };
