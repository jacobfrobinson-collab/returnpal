const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb, saveDb, pushActivity } = require('../database');
const { authMiddleware, requireAdmin, generateToken } = require('../middleware/auth');
const { coerceIsAdmin } = require('../utils/coerceIsAdmin');
const { computeMonthlyFreeProcessing } = require('../utils/monthlyFreeProcessing');

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
                `SELECT id, email, full_name, company_name, created_at, COALESCE(is_admin, 0) AS is_admin,
                        COALESCE(legacy_client_id, '') AS legacy_client_id
                 FROM users ORDER BY created_at DESC`
            )
        );
        res.json({ users: rows });
    } catch (err) {
        console.error('Admin list users error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

function unlinkAvatarFile(avatarUrl) {
    if (!avatarUrl || typeof avatarUrl !== 'string') return;
    if (!avatarUrl.startsWith('/uploads/')) return;
    const rel = avatarUrl.replace(/^\/uploads\/?/, '').replace(/^\/+/, '');
    if (!rel.startsWith('avatars/')) return;
    const full = path.join(uploadsBaseDir, rel);
    const resolved = path.resolve(full);
    const rootResolved = path.resolve(uploadsBaseDir);
    if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) return;
    fs.unlink(resolved, () => {});
}

// DELETE /api/admin/users/:id — remove client account and related data (cannot delete self or admins)
router.delete('/users/:id', async (req, res) => {
    try {
        const targetId = parseInt(req.params.id, 10);
        if (isNaN(targetId)) return res.status(400).json({ error: 'Invalid user id' });
        if (targetId === req.user.id) {
            return res.status(400).json({ error: 'You cannot delete your own account from here' });
        }

        const db = await getDb();
        const urows = parseResults(
            db.exec('SELECT id, email, is_admin, avatar_url FROM users WHERE id = ?', [targetId])
        );
        if (!urows.length) return res.status(404).json({ error: 'User not found' });
        const target = urows[0];
        if (coerceIsAdmin(target.is_admin)) {
            return res.status(400).json({ error: 'Cannot delete an admin account' });
        }

        const claims = parseResults(db.exec('SELECT id FROM reimbursement_claims WHERE user_id = ?', [targetId]));
        for (const c of claims) {
            const dir = path.join(reimbursementUploadDir, String(c.id));
            if (fs.existsSync(dir)) {
                try {
                    fs.rmSync(dir, { recursive: true, force: true });
                } catch (e) {
                    console.error('Admin delete user: could not remove reimbursement dir', dir, e);
                }
            }
        }

        unlinkAvatarFile(target.avatar_url);

        db.run('UPDATE users SET referred_by = NULL WHERE referred_by = ?', [targetId]);
        db.run('DELETE FROM users WHERE id = ?', [targetId]);
        saveDb();

        res.json({ message: 'Account deleted' });
    } catch (err) {
        console.error('Admin delete user error:', err);
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

// GET /api/admin/queries — open client item queries
router.get('/queries', async (req, res) => {
    try {
        const db = await getDb();
        const rows = parseResults(
            db.exec(
                `SELECT q.id, q.user_id, q.context_type, q.context_id, q.context_label, q.message, q.status, q.created_at,
                        u.email, u.full_name
                 FROM item_queries q
                 JOIN users u ON u.id = q.user_id
                 WHERE q.status = 'open'
                 ORDER BY q.created_at DESC`
            )
        );
        res.json({ queries: rows });
    } catch (err) {
        console.error('Admin list queries error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/users/:id/return-adjustments — record buyer return / clawback (reduces client balance when applied)
router.post('/users/:id/return-adjustments', async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user id' });
        const product = (req.body.product || '').toString().trim();
        const reference = (req.body.reference || '').toString().trim();
        const amount = parseFloat(req.body.amount);
        const linked = req.body.linked_sold_item_id != null ? parseInt(req.body.linked_sold_item_id, 10) : null;
        const notes = (req.body.notes || '').toString().trim();
        const status = req.body.status === 'pending' ? 'pending' : 'applied';
        if (!product || !Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ error: 'product and a positive amount are required' });
        }

        const db = await getDb();
        const ucheck = db.exec('SELECT id FROM users WHERE id = ?', [userId]);
        if (!ucheck.length || !ucheck[0].values.length) {
            return res.status(404).json({ error: 'User not found' });
        }

        db.run(
            `INSERT INTO return_adjustments (user_id, product, reference, amount, linked_sold_item_id, status, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [userId, product, reference, amount, Number.isFinite(linked) ? linked : null, status, notes]
        );
        saveDb();
        const rid = db.exec('SELECT last_insert_rowid() as id');
        const id = rid[0].values[0][0];

        if (status === 'applied') {
            await pushActivity(
                userId,
                'return_deducted',
                `Return / refund deducted: ${product} −£${amount.toFixed(2)}`,
                '/dashboard/index.html'
            );
        }

        res.status(201).json({ id, status, message: 'Return adjustment recorded' });
    } catch (err) {
        console.error('Admin return-adjustment error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PATCH /api/admin/return-adjustments/:id — set status pending | applied
router.patch('/return-adjustments/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const status = req.body.status === 'pending' ? 'pending' : req.body.status === 'applied' ? 'applied' : null;
        if (!status) return res.status(400).json({ error: 'status must be pending or applied' });

        const db = await getDb();
        const prev = parseResults(db.exec('SELECT * FROM return_adjustments WHERE id = ?', [id]));
        if (!prev.length) return res.status(404).json({ error: 'Not found' });
        const row = prev[0];

        db.run('UPDATE return_adjustments SET status = ? WHERE id = ?', [status, id]);
        saveDb();

        if (status === 'applied' && row.status !== 'applied') {
            const amt = Number(row.amount) || 0;
            await pushActivity(
                row.user_id,
                'return_deducted',
                `Return / refund deducted: ${row.product || 'Item'} −£${amt.toFixed(2)}`,
                '/dashboard/index.html'
            );
        }

        res.json({ message: 'Updated' });
    } catch (err) {
        console.error('Admin patch return-adjustment error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/insights — profit, return rate, liabilities per client
router.get('/insights', async (req, res) => {
    try {
        const db = await getDb();
        const clients = parseResults(
            db.exec(
                `SELECT id, email, full_name, company_name FROM users WHERE COALESCE(is_admin, 0) = 0 ORDER BY id`
            )
        );
        const rows = [];
        for (const c of clients) {
            const uid = c.id;
            const soldP = parseResults(
                db.exec(
                    `SELECT COALESCE(SUM(profit), 0) as p, COUNT(*) as n FROM sold_items WHERE user_id = ?`,
                    [uid]
                )
            )[0] || { p: 0, n: 0 };
            const refC = parseResults(
                db.exec(
                    `SELECT COUNT(*) as c FROM sold_items WHERE user_id = ? AND status = 'Refunded'`,
                    [uid]
                )
            )[0] || { c: 0 };
            const recv = parseResults(
                db.exec(`SELECT COUNT(*) as c FROM received_items WHERE user_id = ?`, [uid])
            )[0] || { c: 0 };
            const pendAdj = parseResults(
                db.exec(
                    `SELECT COALESCE(SUM(amount), 0) as s FROM return_adjustments WHERE user_id = ? AND status = 'pending'`,
                    [uid]
                )
            )[0] || { s: 0 };
            const adjN = parseResults(
                db.exec(`SELECT COUNT(*) as c FROM return_adjustments WHERE user_id = ? AND status = 'applied'`, [uid])
            )[0] || { c: 0 };
            const soldN = Number(soldP.n) || 0;
            const returnRate = soldN > 0 ? (Number(refC.c) + Number(adjN.c)) / soldN : 0;
            const pendingLiab = Number(pendAdj.s) || 0;
            rows.push({
                user_id: uid,
                email: c.email,
                full_name: c.full_name,
                company_name: c.company_name,
                total_client_profit: Math.round((Number(soldP.p) || 0) * 100) / 100,
                items_sold: soldN,
                refunded_items_count: Number(refC.c) || 0,
                return_adjustments_applied: Number(adjN.c) || 0,
                return_rate: Math.round(returnRate * 1000) / 1000,
                items_received: Number(recv.c) || 0,
                pending_return_liability: Math.round(pendingLiab * 100) / 100,
                risk_flag: returnRate > 0.2 || pendingLiab > 300
            });
        }
        const totalLiability = rows.reduce((s, r) => s + (r.pending_return_liability || 0), 0);
        res.json({
            clients: rows,
            total_pending_return_liability: Math.round(totalLiability * 100) / 100
        });
    } catch (err) {
        console.error('Admin insights error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/monthly-free-processing?year_month=2026-03 — clients whose highest eligible sale that month is fee-waived
router.get('/monthly-free-processing', async (req, res) => {
    try {
        const ym = String(req.query.year_month || new Date().toISOString().slice(0, 7)).trim();
        if (!/^\d{4}-\d{2}$/.test(ym)) {
            return res.status(400).json({ error: 'Invalid year_month (use YYYY-MM)' });
        }
        const db = await getDb();
        const users = parseResults(db.exec('SELECT id, email, full_name FROM users ORDER BY id'));
        const clients = [];
        for (const u of users) {
            const items = parseResults(db.exec('SELECT * FROM sold_items WHERE user_id = ?', [u.id]));
            if (!items.length) continue;
            const promo = computeMonthlyFreeProcessing(items);
            const month = promo.months.find((m) => m.year_month === ym);
            if (month) {
                clients.push({
                    user_id: u.id,
                    email: u.email,
                    full_name: u.full_name,
                    sold_item_id: month.sold_item_id,
                    reference: month.reference,
                    product: month.product,
                    sold_date: month.sold_date,
                    gross_sale: month.gross_sale,
                    fee_normally_charged: month.fee_normally_charged
                });
            }
        }
        const sample = computeMonthlyFreeProcessing([]);
        res.json({
            year_month: ym,
            fee_percent: sample.fee_percent,
            revenue_interpreted_as_net: sample.revenue_interpreted_as_net,
            clients
        });
    } catch (err) {
        console.error('Admin monthly-free-processing error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
