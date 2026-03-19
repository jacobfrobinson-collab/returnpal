const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb, saveDb, pushActivity } = require('../database');
const { authMiddleware, requireAdmin, generateToken } = require('../middleware/auth');

const router = express.Router();

const uploadsBaseDir = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, '../../uploads');
const reimbursementUploadDir = path.join(uploadsBaseDir, 'reimbursement');
const reimbursementMulter = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = /^image\/(jpeg|png|gif|webp)$/i.test(file.mimetype);
        cb(null, !!allowed);
    }
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

// All admin routes require auth + admin
router.use(authMiddleware);
router.use(requireAdmin);

// GET /api/admin/users – list all clients
router.get('/users', async (req, res) => {
    try {
        const db = await getDb();
        const rows = parseResults(
            db.exec(
                'SELECT id, email, full_name, company_name, created_at FROM users ORDER BY created_at DESC'
            )
        );
        res.json({ users: rows });
    } catch (err) {
        console.error('Admin list users error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/users/:id/packages
router.get('/users/:id/packages', async (req, res) => {
    try {
        const db = await getDb();
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user id' });

        const packages = parseResults(
            db.exec('SELECT * FROM packages WHERE user_id = ? ORDER BY date_added DESC', [userId])
        );
        for (const pkg of packages) {
            pkg.products = parseResults(
                db.exec('SELECT * FROM package_products WHERE package_id = ?', [pkg.id])
            );
            pkg.total_qty = (pkg.products || []).reduce((s, p) => s + (p.quantity || 0), 0);
        }
        res.json({ packages });
    } catch (err) {
        console.error('Admin get packages error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/users/:id/received
router.get('/users/:id/received', async (req, res) => {
    try {
        const db = await getDb();
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user id' });

        const items = parseResults(
            db.exec('SELECT * FROM received_items WHERE user_id = ? ORDER BY date_received DESC', [userId])
        );
        res.json({ items, total: items.length });
    } catch (err) {
        console.error('Admin get received error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/users/:id/sold
router.get('/users/:id/sold', async (req, res) => {
    try {
        const db = await getDb();
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user id' });

        const items = parseResults(
            db.exec('SELECT * FROM sold_items WHERE user_id = ? ORDER BY sold_date DESC', [userId])
        );
        const statsResult = parseResults(
            db.exec(
                'SELECT COALESCE(SUM(profit), 0) as total_earnings, COUNT(*) as items_sold, COALESCE(AVG(profit), 0) as avg_earnings, COALESCE(AVG(margin), 0) as avg_margin FROM sold_items WHERE user_id = ?',
                [userId]
            )
        );
        const stats = statsResult[0] || { total_earnings: 0, items_sold: 0, avg_earnings: 0, avg_margin: 0 };
        res.json({ items, stats, total: items.length });
    } catch (err) {
        console.error('Admin get sold error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/users/:id/pending
router.get('/users/:id/pending', async (req, res) => {
    try {
        const db = await getDb();
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user id' });

        const items = parseResults(
            db.exec('SELECT * FROM pending_items WHERE user_id = ? ORDER BY received_date DESC', [userId])
        );
        const statsResult = parseResults(
            db.exec(
                'SELECT COUNT(*) as pending_count, COALESCE(SUM(quantity), 0) as total_quantity, MIN(received_date) as oldest_date FROM pending_items WHERE user_id = ?',
                [userId]
            )
        );
        const stats = statsResult[0] || { pending_count: 0, total_quantity: 0, oldest_date: null };
        res.json({ items, stats, total: items.length });
    } catch (err) {
        console.error('Admin get pending error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/users/:id/notify – send a notification to the client (shows in their activity feed)
router.post('/users/:id/notify', async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user id' });
        const { message } = req.body;
        if (!message || typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ error: 'Message is required' });
        }
        const link = (req.body.link && typeof req.body.link === 'string') ? req.body.link : '';
        await pushActivity(userId, 'info', message.trim(), link);
        res.json({ message: 'Notification sent' });
    } catch (err) {
        console.error('Admin notify error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/users/:id/reimbursement-claims – list reimbursement claims for a client
router.get('/users/:id/reimbursement-claims', async (req, res) => {
    try {
        const db = await getDb();
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user id' });

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
        console.error('Admin get reimbursement claims error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/reimbursement-claims – create claim and upload photos (multipart)
router.post('/reimbursement-claims', reimbursementMulter.array('photos', 10), async (req, res) => {
    try {
        const userId = parseInt(req.body.user_id, 10);
        const packageReference = (req.body.package_reference || '').toString().trim();
        const itemDescription = (req.body.item_description || '').toString().trim();
        const reimbursementType = (req.body.reimbursement_type || '').toString().trim();
        const notes = (req.body.notes || '').toString().trim();

        if (isNaN(userId) || !packageReference || !itemDescription) {
            return res.status(400).json({ error: 'user_id, package_reference, and item_description are required' });
        }

        const db = await getDb();
        const userCheck = db.exec('SELECT id FROM users WHERE id = ?', [userId]);
        if (!userCheck.length || !userCheck[0].values.length) {
            return res.status(400).json({ error: 'User not found' });
        }

        db.run(
            'INSERT INTO reimbursement_claims (user_id, package_reference, item_description, reimbursement_type, notes) VALUES (?, ?, ?, ?, ?)',
            [userId, packageReference, itemDescription, reimbursementType, notes]
        );
        const claimIdResult = db.exec('SELECT last_insert_rowid() as id');
        const claimId = claimIdResult[0].values[0][0];

        const files = req.files || [];
        const dir = path.join(reimbursementUploadDir, String(claimId));
        if (files.length > 0) {
            if (!fs.existsSync(reimbursementUploadDir)) fs.mkdirSync(reimbursementUploadDir, { recursive: true });
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            for (let i = 0; i < files.length; i++) {
                const f = files[i];
                const ext = path.extname(f.originalname) || '.jpg';
                const safeName = `photo-${i + 1}${ext}`;
                const filePath = path.join(dir, safeName);
                fs.writeFileSync(filePath, f.buffer);
                const relativePath = `reimbursement/${claimId}/${safeName}`;
                db.run('INSERT INTO reimbursement_claim_photos (claim_id, file_path) VALUES (?, ?)', [claimId, relativePath]);
            }
        }
        saveDb();

        await pushActivity(
            userId,
            'info',
            `Reimbursement item added: ${itemDescription} (package ${packageReference}). View in Reimbursement claims.`,
            '/dashboard/reimbursement.html'
        );

        const claim = parseResults(db.exec('SELECT * FROM reimbursement_claims WHERE id = ?', [claimId]))[0];
        claim.photos = parseResults(db.exec('SELECT id, file_path FROM reimbursement_claim_photos WHERE claim_id = ?', [claimId]));
        res.status(201).json({ claim });
    } catch (err) {
        console.error('Admin create reimbursement claim error:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

// POST /api/admin/impersonate/:id – get short-lived token to view as that client
router.post('/impersonate/:id', async (req, res) => {
    try {
        const db = await getDb();
        const targetId = parseInt(req.params.id, 10);
        if (isNaN(targetId)) {
            return res.status(400).json({ error: 'Invalid user id' });
        }

        const result = db.exec(
            'SELECT id, email, full_name, company_name FROM users WHERE id = ?',
            [targetId]
        );
        if (!result.length || !result[0].values.length) {
            return res.status(404).json({ error: 'User not found' });
        }

        const row = result[0].values[0];
        const cols = result[0].columns;
        const user = {};
        cols.forEach((col, i) => { user[col] = row[i]; });

        const token = generateToken(
            { id: user.id, email: user.email, is_admin: false },
            '1h'
        );

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                full_name: user.full_name,
                company_name: user.company_name
            }
        });
    } catch (err) {
        console.error('Admin impersonate error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
