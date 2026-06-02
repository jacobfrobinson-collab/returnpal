const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb, saveDb, pushActivity } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { clientIsAdmin, redactOrderNumberForClientRow, redactOrderNumberForClientRows } = require('../utils/internalFields');
const { enrichClaimRow, buildCaseText, normalizeCaseStatus, CASE_STATUSES } = require('../utils/reimbursementCase');
const { isClientReimbursementEnabled } = require('../utils/clientReimbursementFeature');
const { saveReimbursementClaimPhotos } = require('../utils/reimbursementPhotos');
const {
    resolveReimbursementPhotoAbsPath,
    mimeForPhotoPath,
    safeDownloadFilename,
} = require('../utils/reimbursementPhotoFile');

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

router.use((req, res, next) => {
    if (isClientReimbursementEnabled()) return next();
    return res.status(503).json({
        error: 'Reimbursement claims are not available in the dashboard yet. Check back soon.',
        code: 'reimbursement_coming_soon',
    });
});

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
            c.photos = photos.map((p) => ({
                ...p,
                file_url: `/api/reimbursement/claims/${c.id}/photos/${p.id}/file`,
                download_url: `/api/reimbursement/claims/${c.id}/photos/${p.id}/file?download=1`,
            }));
            Object.assign(c, enrichClaimRow(c));
        }
        const out = clientIsAdmin(req) ? claims : redactOrderNumberForClientRows(claims);
        res.json({ claims: out, case_statuses: CASE_STATUSES });
    } catch (err) {
        console.error('Reimbursement list error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/reimbursement/claims/:claimId/photos/:photoId/file — authenticated view or download
router.get('/claims/:claimId/photos/:photoId/file', async (req, res) => {
    try {
        const claimId = parseInt(req.params.claimId, 10);
        const photoId = parseInt(req.params.photoId, 10);
        if (isNaN(claimId) || isNaN(photoId)) {
            return res.status(400).json({ error: 'Invalid id' });
        }
        const db = await getDb();
        const claims = parseResults(
            db.exec('SELECT id FROM reimbursement_claims WHERE id = ? AND user_id = ?', [claimId, req.user.id])
        );
        if (!claims.length) return res.status(404).json({ error: 'Claim not found' });

        const photos = parseResults(
            db.exec(
                'SELECT id, file_path FROM reimbursement_claim_photos WHERE id = ? AND claim_id = ?',
                [photoId, claimId]
            )
        );
        if (!photos.length) return res.status(404).json({ error: 'Photo not found' });

        const abs = resolveReimbursementPhotoAbsPath(uploadsBaseDir, photos[0].file_path);
        if (!abs) return res.status(404).json({ error: 'Photo file not found on server' });

        const asDownload = req.query.download === '1' || req.query.download === 'true';
        const mime = mimeForPhotoPath(abs);
        const filename = safeDownloadFilename(abs, `claim-${claimId}-photo-${photoId}.jpg`);
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'private, max-age=3600');
        if (asDownload) {
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        } else {
            res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        }
        res.sendFile(abs);
    } catch (err) {
        console.error('Reimbursement photo file error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/reimbursement/claims/:id/case-pack
router.get('/claims/:id/case-pack', async (req, res) => {
    try {
        const claimId = parseInt(req.params.id, 10);
        const db = await getDb();
        const rows = parseResults(
            db.exec('SELECT * FROM reimbursement_claims WHERE id = ? AND user_id = ?', [claimId, req.user.id])
        );
        if (!rows.length) return res.status(404).json({ error: 'Claim not found' });
        const claim = enrichClaimRow(rows[0]);
        claim.photos = parseResults(
            db.exec('SELECT id, file_path, created_at FROM reimbursement_claim_photos WHERE claim_id = ? ORDER BY id', [claimId])
        );
        claim.photo_urls = claim.photos.map((p) => '/uploads/' + p.file_path);
        res.json({ claim });
    } catch (err) {
        console.error('Case pack error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PATCH /api/reimbursement/claims/:id — client updates (mark submitted, case id)
router.patch('/claims/:id', async (req, res) => {
    try {
        const claimId = parseInt(req.params.id, 10);
        const db = await getDb();
        const rows = parseResults(
            db.exec('SELECT * FROM reimbursement_claims WHERE id = ? AND user_id = ?', [claimId, req.user.id])
        );
        if (!rows.length) return res.status(404).json({ error: 'Claim not found' });
        const cur = rows[0];
        let status = cur.case_status || 'draft';
        if (req.body.case_status !== undefined) {
            const next = normalizeCaseStatus(req.body.case_status);
            if (!['submitted', 'ready'].includes(next) && next !== status) {
                return res.status(400).json({ error: 'Clients can only mark claims as ready or submitted.' });
            }
            status = next;
        }
        const scId =
            req.body.seller_central_case_id !== undefined
                ? String(req.body.seller_central_case_id || '').trim().slice(0, 120)
                : cur.seller_central_case_id || '';
        let submittedAt = cur.submitted_at || '';
        if (status === 'submitted' && !submittedAt) submittedAt = new Date().toISOString();
        db.run(
            `UPDATE reimbursement_claims SET case_status = ?, seller_central_case_id = ?, submitted_at = ?, case_text = ? WHERE id = ?`,
            [status, scId, submittedAt, buildCaseText({ ...cur, case_status: status }), claimId]
        );
        saveDb();
        const updated = enrichClaimRow(
            parseResults(db.exec('SELECT * FROM reimbursement_claims WHERE id = ?', [claimId]))[0]
        );
        res.json({ claim: updated, message: 'Claim updated' });
    } catch (err) {
        console.error('Patch claim error:', err);
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
        const caseText = buildCaseText({
            package_reference: packageReference,
            item_description: itemDescription,
            reimbursement_type: reimbursementType,
            notes,
            order_number: orderNumber,
        });
        db.run(
            `INSERT INTO reimbursement_claims (user_id, package_reference, item_description, reimbursement_type, notes, order_number, case_status, case_text)
             VALUES (?, ?, ?, ?, ?, ?, 'ready', ?)`,
            [userId, packageReference, itemDescription, reimbursementType, notes, orderNumber, caseText]
        );
        const claimId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];

        saveReimbursementClaimPhotos(db, claimId, req.files || [], uploadsBaseDir);
        saveDb();

        await pushActivity(
            userId,
            'info',
            `Reimbursement claim submitted: ${itemDescription} (${packageReference}).`,
            '/dashboard/reimbursement.html'
        );

        const claim = enrichClaimRow(
            parseResults(db.exec('SELECT * FROM reimbursement_claims WHERE id = ?', [claimId]))[0]
        );
        claim.photos = parseResults(db.exec('SELECT id, file_path FROM reimbursement_claim_photos WHERE claim_id = ?', [claimId]));
        res.status(201).json({ claim, message: 'Claim submitted. Use the case cockpit to file in Seller Central.' });
    } catch (err) {
        console.error('Client create reimbursement claim error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
