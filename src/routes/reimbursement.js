const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb, saveDb, pushActivity } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { clientIsAdmin, redactOrderNumberForClientRow, redactOrderNumberForClientRows } = require('../utils/internalFields');

const router = express.Router();

const uploadsBaseDir = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, '../../uploads');
const reimbursementUploadDir = path.join(uploadsBaseDir, 'reimbursement');
const reimbursementMulter = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = /^image\/(jpeg|png|gif|webp)$/i.test(file.mimetype);
        cb(null, !!allowed);
    },
});

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

// GET /api/reimbursement/claims
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
        const out = clientIsAdmin(req) ? claims : redactOrderNumberForClientRows(claims);
        res.json({ claims: out });
    } catch (err) {
        console.error('Reimbursement list error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/reimbursement/claims — client submits claim with photos
router.post('/claims', reimbursementMulter.array('photos', 10), async (req, res) => {
    try {
        const userId = req.user.id;
        const packageReference = (req.body.package_reference || '').toString().trim();
        const itemDescription = (req.body.item_description || '').toString().trim();
        const reimbursementType = (req.body.reimbursement_type || 'Damaged Inventory').toString().trim();
        const notes = (req.body.notes || '').toString().trim();
        const orderNumber = (req.body.order_number != null ? String(req.body.order_number) : '').trim().slice(0, 200);

        if (!packageReference || !itemDescription) {
            return res.status(400).json({ error: 'Package reference and item description are required.' });
        }

        const db = await getDb();
        db.run(
            'INSERT INTO reimbursement_claims (user_id, package_reference, item_description, reimbursement_type, notes, order_number) VALUES (?, ?, ?, ?, ?, ?)',
            [userId, packageReference, itemDescription, reimbursementType, notes, orderNumber]
        );
        const claimId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];

        const files = req.files || [];
        const dir = path.join(reimbursementUploadDir, String(claimId));
        if (files.length > 0) {
            if (!fs.existsSync(reimbursementUploadDir)) fs.mkdirSync(reimbursementUploadDir, { recursive: true });
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            for (let i = 0; i < files.length; i++) {
                const f = files[i];
                const ext = path.extname(f.originalname) || '.jpg';
                const safeName = `photo-${i + 1}${ext}`;
                fs.writeFileSync(path.join(dir, safeName), f.buffer);
                const relativePath = `reimbursement/${claimId}/${safeName}`;
                db.run('INSERT INTO reimbursement_claim_photos (claim_id, file_path) VALUES (?, ?)', [claimId, relativePath]);
            }
        }
        saveDb();

        await pushActivity(
            userId,
            'info',
            `Reimbursement claim submitted: ${itemDescription} (${packageReference}).`,
            '/dashboard/reimbursement.html'
        );

        const claim = parseResults(db.exec('SELECT * FROM reimbursement_claims WHERE id = ?', [claimId]))[0];
        claim.photos = parseResults(db.exec('SELECT id, file_path FROM reimbursement_claim_photos WHERE claim_id = ?', [claimId]));
        res.status(201).json({ claim, message: 'Claim submitted. Our team will review it for Seller Central.' });
    } catch (err) {
        console.error('Client create reimbursement claim error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
