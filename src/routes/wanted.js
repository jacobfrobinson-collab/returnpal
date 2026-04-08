const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { body, validationResult } = require('express-validator');
const { getDb, saveDb } = require('../database');
const { authMiddleware, optionalAuth } = require('../middleware/auth');

const router = express.Router();

const uploadRoot = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, '../../uploads');
const wantedDir = path.join(uploadRoot, 'wanted');
if (!fs.existsSync(wantedDir)) {
    fs.mkdirSync(wantedDir, { recursive: true });
}

const imageStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, wantedDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
        const safe = allowed.includes(ext) ? ext : '.jpg';
        cb(null, `wanted-${Date.now()}-${Math.round(Math.random() * 1e9)}${safe}`);
    }
});

const upload = multer({
    storage: imageStorage,
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file || !file.originalname) return cb(null, true);
        const ok = /^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype);
        if (ok) cb(null, true);
        else cb(new Error('Only JPEG, PNG, WebP, or GIF images are allowed'));
    }
});

function parseResults(result) {
    if (!result || result.length === 0) return [];
    const cols = result[0].columns;
    return result[0].values.map((row) => {
        const obj = {};
        cols.forEach((col, i) => {
            obj[col] = row[i];
        });
        return obj;
    });
}

function buyerLabel(fullName) {
    if (!fullName || typeof fullName !== 'string') return 'Member';
    const first = fullName.trim().split(/\s+/)[0];
    return first ? first.slice(0, 40) : 'Member';
}

function mapListingRow(row, extras = {}) {
    const image_url = row.image_path ? `/uploads/wanted/${path.basename(row.image_path)}` : '';
    return {
        id: row.id,
        title: row.title,
        description: row.description,
        category: row.category || '',
        budget_min: row.budget_min,
        budget_max: row.budget_max,
        currency: row.currency || 'GBP',
        image_url,
        status: row.status,
        created_at: row.created_at,
        buyer_display: buyerLabel(row.full_name),
        response_count: row.response_count != null ? row.response_count : extras.response_count,
        viewer_is_owner: extras.viewer_is_owner === true
    };
}

// GET /api/wanted/mine — authenticated buyer's listings
router.get('/mine', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const stmt = db.prepare(`
            SELECT w.*, u.full_name,
            (SELECT COUNT(*) FROM wanted_responses r WHERE r.listing_id = w.id) AS response_count
            FROM wanted_listings w
            JOIN users u ON w.user_id = u.id
            WHERE w.user_id = ?
            ORDER BY w.created_at DESC
        `);
        stmt.bind([req.user.id]);
        const rows = [];
        while (stmt.step()) {
            rows.push(stmt.getAsObject());
        }
        stmt.free();
        const listings = rows.map((r) => mapListingRow(r, { viewer_is_owner: true }));
        res.json({ listings });
    } catch (err) {
        console.error('wanted mine error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/wanted — public feed
router.get('/', optionalAuth, async (req, res) => {
    try {
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const q = (req.query.q || '').toString().trim().slice(0, 120);
        const db = await getDb();

        let sql = `
            SELECT w.*, u.full_name,
            (SELECT COUNT(*) FROM wanted_responses r WHERE r.listing_id = w.id) AS response_count
            FROM wanted_listings w
            JOIN users u ON w.user_id = u.id
            WHERE w.status = 'open'
        `;
        const binds = [];
        if (q) {
            sql += ` AND (w.title LIKE ? OR w.description LIKE ? OR w.category LIKE ?)`;
            const like = `%${q.replace(/%/g, '')}%`;
            binds.push(like, like, like);
        }
        sql += ` ORDER BY w.created_at DESC LIMIT ? OFFSET ?`;
        binds.push(limit, offset);

        const stmt = db.prepare(sql);
        stmt.bind(binds);
        const rows = [];
        while (stmt.step()) {
            rows.push(stmt.getAsObject());
        }
        stmt.free();

        const listings = rows.map((r) =>
            mapListingRow(r, {
                viewer_is_owner: !!(req.user && Number(req.user.id) === Number(r.user_id))
            })
        );
        res.json({ listings, limit, offset });
    } catch (err) {
        console.error('wanted list error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/wanted/:id — public detail
router.get('/:id', optionalAuth, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id < 1) {
            return res.status(400).json({ error: 'Invalid id' });
        }
        const db = await getDb();
        const stmt = db.prepare(`
            SELECT w.*, u.full_name,
            (SELECT COUNT(*) FROM wanted_responses r WHERE r.listing_id = w.id) AS response_count
            FROM wanted_listings w
            JOIN users u ON w.user_id = u.id
            WHERE w.id = ?
        `);
        stmt.bind([id]);
        if (!stmt.step()) {
            stmt.free();
            return res.status(404).json({ error: 'Listing not found' });
        }
        const row = stmt.getAsObject();
        stmt.free();

        const listing = mapListingRow(row, {
            viewer_is_owner: !!(req.user && Number(req.user.id) === Number(row.user_id))
        });
        res.json({ listing });
    } catch (err) {
        console.error('wanted get error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/wanted — create listing (multipart: title, description, category, budget_min, budget_max, photo?)
router.post(
    '/',
    authMiddleware,
    upload.single('photo'),
    [
        body('title').trim().isLength({ min: 3, max: 200 }).withMessage('Title 3–200 characters'),
        body('description').trim().isLength({ min: 10, max: 8000 }).withMessage('Description 10–8000 characters'),
        body('category').optional().trim().isLength({ max: 120 }),
        body('budget_min').isFloat({ min: 0 }).withMessage('Budget min required'),
        body('budget_max').isFloat({ min: 0 }).withMessage('Budget max required')
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            const min = parseFloat(req.body.budget_min);
            const max = parseFloat(req.body.budget_max);
            if (min > max) {
                return res.status(400).json({ error: 'Budget min cannot exceed budget max' });
            }

            let imagePath = '';
            if (req.file) {
                imagePath = req.file.filename;
            }

            const db = await getDb();
            const category = (req.body.category || '').toString().slice(0, 120);
            db.run(
                `INSERT INTO wanted_listings (user_id, title, description, category, budget_min, budget_max, currency, image_path, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'GBP', ?, 'open')`,
                [
                    req.user.id,
                    req.body.title.trim(),
                    req.body.description.trim(),
                    category,
                    min,
                    max,
                    imagePath
                ]
            );
            saveDb();

            let newId = null;
            let stmt = null;
            try {
                stmt = db.prepare('SELECT id FROM wanted_listings WHERE user_id = ? ORDER BY id DESC LIMIT 1');
                stmt.bind([req.user.id]);
                if (stmt.step()) {
                    newId = stmt.getAsObject().id;
                }
            } finally {
                try {
                    if (stmt && typeof stmt.free === 'function') stmt.free();
                } catch (e) {
                    /* ignore */
                }
            }
            if (newId == null) {
                const fb = db.exec('SELECT last_insert_rowid() as id');
                if (fb.length && fb[0].values && fb[0].values[0]) {
                    newId = fb[0].values[0][0];
                }
            }

            res.status(201).json({
                id: newId,
                message: 'Listing created',
                image_url: imagePath ? `/uploads/wanted/${path.basename(imagePath)}` : ''
            });
        } catch (err) {
            console.error('wanted create error:', err);
            res.status(500).json({ error: 'Server error' });
        }
    }
);

// GET /api/wanted/:id/responses — buyer sees all; seller sees only own offer
router.get('/:id/responses', authMiddleware, async (req, res) => {
    try {
        const listingId = parseInt(req.params.id, 10);
        if (!Number.isFinite(listingId) || listingId < 1) {
            return res.status(400).json({ error: 'Invalid id' });
        }
        const db = await getDb();
        const lstmt = db.prepare('SELECT user_id, status FROM wanted_listings WHERE id = ?');
        lstmt.bind([listingId]);
        if (!lstmt.step()) {
            lstmt.free();
            return res.status(404).json({ error: 'Listing not found' });
        }
        const listing = lstmt.getAsObject();
        lstmt.free();

        const isBuyer = Number(listing.user_id) === Number(req.user.id);
        let sql;
        let binds;
        if (isBuyer) {
            sql = `
                SELECT r.*, u.full_name AS seller_name
                FROM wanted_responses r
                JOIN users u ON r.seller_id = u.id
                WHERE r.listing_id = ?
                ORDER BY r.created_at DESC
            `;
            binds = [listingId];
        } else {
            sql = `
                SELECT r.*, u.full_name AS seller_name
                FROM wanted_responses r
                JOIN users u ON r.seller_id = u.id
                WHERE r.listing_id = ? AND r.seller_id = ?
            `;
            binds = [listingId, req.user.id];
        }

        const stmt = db.prepare(sql);
        stmt.bind(binds);
        const rows = [];
        while (stmt.step()) {
            rows.push(stmt.getAsObject());
        }
        stmt.free();

        const responses = rows.map((r) => ({
            id: r.id,
            listing_id: r.listing_id,
            seller_id: r.seller_id,
            seller_display: buyerLabel(r.seller_name),
            description: r.description,
            price_offer: r.price_offer,
            image_url: r.image_path ? `/uploads/wanted/${path.basename(r.image_path)}` : '',
            status: r.status,
            created_at: r.created_at
        }));

        res.json({ responses, viewer_is_buyer: isBuyer });
    } catch (err) {
        console.error('wanted responses list error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/wanted/:id/responses — seller offer (multipart)
router.post(
    '/:id/responses',
    authMiddleware,
    upload.single('photo'),
    [
        body('description').trim().isLength({ min: 5, max: 4000 }).withMessage('Description 5–4000 characters'),
        body('price_offer').isFloat({ min: 0.01 }).withMessage('Valid price required')
    ],
    async (req, res) => {
        try {
            const listingId = parseInt(req.params.id, 10);
            if (!Number.isFinite(listingId) || listingId < 1) {
                return res.status(400).json({ error: 'Invalid id' });
            }

            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const db = await getDb();
            const lstmt = db.prepare('SELECT id, user_id, status FROM wanted_listings WHERE id = ?');
            lstmt.bind([listingId]);
            if (!lstmt.step()) {
                lstmt.free();
                return res.status(404).json({ error: 'Listing not found' });
            }
            const listing = lstmt.getAsObject();
            lstmt.free();

            if (listing.status !== 'open') {
                return res.status(400).json({ error: 'This listing is not accepting responses' });
            }
            if (Number(listing.user_id) === Number(req.user.id)) {
                return res.status(403).json({ error: 'You cannot respond to your own wanted post' });
            }

            let imagePath = '';
            if (req.file) {
                imagePath = req.file.filename;
            }

            const price = parseFloat(req.body.price_offer);
            try {
                db.run(
                    `INSERT INTO wanted_responses (listing_id, seller_id, description, price_offer, image_path, status)
                     VALUES (?, ?, ?, ?, ?, 'pending')`,
                    [listingId, req.user.id, req.body.description.trim(), price, imagePath]
                );
            } catch (insertErr) {
                const msg = String(insertErr.message || insertErr);
                if (msg.includes('UNIQUE') || msg.includes('constraint')) {
                    return res.status(409).json({ error: 'You already submitted an offer for this listing' });
                }
                throw insertErr;
            }
            saveDb();

            let rid = null;
            let stmt = null;
            try {
                stmt = db.prepare(
                    'SELECT id FROM wanted_responses WHERE listing_id = ? AND seller_id = ? ORDER BY id DESC LIMIT 1'
                );
                stmt.bind([listingId, req.user.id]);
                if (stmt.step()) {
                    rid = stmt.getAsObject().id;
                }
            } finally {
                try {
                    if (stmt && typeof stmt.free === 'function') stmt.free();
                } catch (e) {
                    /* ignore */
                }
            }

            res.status(201).json({
                id: rid,
                message: 'Offer submitted',
                image_url: imagePath ? `/uploads/wanted/${path.basename(imagePath)}` : ''
            });
        } catch (err) {
            console.error('wanted respond error:', err);
            res.status(500).json({ error: 'Server error' });
        }
    }
);

module.exports = router;
