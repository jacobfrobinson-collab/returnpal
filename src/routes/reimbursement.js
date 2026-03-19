const express = require('express');
const { getDb } = require('../database');
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

router.use(authMiddleware);

// GET /api/reimbursement/claims – list current user's reimbursement claims with photos
router.get('/claims', async (req, res) => {
    try {
        const db = await getDb();
        const userId = req.user.id;
        const claims = parseResults(
            db.exec('SELECT * FROM reimbursement_claims WHERE user_id = ? ORDER BY created_at DESC', [userId])
        );
        for (const c of claims) {
            const photos = parseResults(
                db.exec('SELECT id, file_path, created_at FROM reimbursement_claim_photos WHERE claim_id = ? ORDER BY id', [c.id])
            );
            c.photos = photos;
        }
        res.json({ claims });
    } catch (err) {
        console.error('Reimbursement list error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
