const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb, saveDb, pushActivity } = require('../database');
const { authMiddleware, requireAdmin, generateToken } = require('../middleware/auth');
const { adminRateLimitMiddleware } = require('../middleware/adminRateLimit');
const { coerceIsAdmin } = require('../utils/coerceIsAdmin');
const { computeMonthlyFreeProcessing } = require('../utils/monthlyFreeProcessing');
const {
    runBulkImport,
    runBulkImportMulti,
    buildTemplateBuffer,
    previewBulkImport,
    applyImportRowForKind,
    rowWithoutClientSpecifier,
    KINDS: BULK_IMPORT_KINDS,
} = require('../utils/adminBulkImport');
const { createBulkImportJob, addBulkImportEntries, listBulkImportJobs, rollbackBulkImportJob } = require('../utils/bulkImportJob');
const { listPendingImportGroups, applyPendingRowsToUser } = require('../utils/bulkImportPending');
const { logAdminAudit, listAdminAudit } = require('../utils/adminAudit');
const { buildInvoiceMonthSourcesPayload } = require('../utils/invoiceMonthDebug');
const { sortSoldItemsByDateDesc } = require('../utils/sortSoldItemsByDateDesc');
const { normalizeSoldDateForDb } = require('../utils/adminBulkImport');
const { mapSoldItemDatesForApi } = require('../utils/soldDateDisplayRepair');
const { findLinkedSoldItemId } = require('../utils/returnAdjustmentSoldLink');

const router = express.Router();

const bulkSpreadsheetUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 32 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const name = (file.originalname || '').toLowerCase();
        cb(null, /\.(xlsx|xls|csv)$/.test(name));
    }
});

const ebayRefundsUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 32 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const name = (file.originalname || '').toLowerCase();
        cb(null, /\.(xlsx|xls|csv)$/.test(name));
    }
});

const {
    convertEbayRefundsBuffers,
    convertEbayRefundsForReview,
    reviewedRowsToCsvBuffer,
} = require('../../scripts/convert-ebay-refunds-to-returnpal');
const { resolveUserIdFromClientSpecifier, lookupUserBrief } = require('../utils/adminBulkImport');

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
router.use(adminRateLimitMiddleware);

// GET /api/admin/users – list all clients
router.get('/users', async (req, res) => {
    try {
        const db = await getDb();
        const rows = parseResults(
            db.exec(
                `SELECT id, email, full_name, company_name, created_at, COALESCE(is_admin, 0) AS is_admin,
                        COALESCE(legacy_client_id, '') AS legacy_client_id,
                        COALESCE(account_status, 'approved') AS account_status,
                        (SELECT COUNT(*) FROM client_delegate_access cda WHERE cda.hub_user_id = users.id) AS linked_clients_count,
                        (SELECT COUNT(*) FROM client_delegate_access cda2 WHERE cda2.client_user_id = users.id) AS delegate_hub_count
                 FROM users ORDER BY created_at DESC`
            )
        );
        res.json({ users: rows });
    } catch (err) {
        console.error('Admin list users error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/hub-accounts — prep-centre hub accounts and who they can view
router.get('/hub-accounts', async (req, res) => {
    try {
        const { listHubAccountsSummary, listLinkedClients } = require('../utils/clientDelegate');
        const db = await getDb();
        const hubs = listHubAccountsSummary(db);
        const out = hubs.map((h) => {
            const clients = listLinkedClients(db, h.hub_user_id);
            return {
                hub_user_id: h.hub_user_id,
                email: h.email,
                full_name: h.full_name,
                company_name: h.company_name,
                display_name: h.full_name || h.company_name || h.email,
                linked_clients_count: h.linked_clients_count,
                clients: clients.map((c) => ({
                    id: c.id,
                    client_code: 'RP' + c.id,
                    display_name: c.full_name || c.company_name || c.email,
                    email: c.email,
                })),
            };
        });
        res.json({ hubs: out });
    } catch (err) {
        console.error('Admin hub accounts error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/registrations/pending — self-service signups awaiting approval
router.get('/registrations/pending', async (req, res) => {
    try {
        const db = await getDb();
        const rows = parseResults(
            db.exec(
                `SELECT id, email, full_name, company_name, created_at, COALESCE(account_status, 'approved') AS account_status
                 FROM users
                 WHERE COALESCE(is_admin, 0) = 0 AND COALESCE(account_status, 'approved') = 'pending'
                 ORDER BY created_at ASC`
            )
        );
        res.json({ pending: rows, count: rows.length });
    } catch (err) {
        console.error('Admin pending registrations error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/users — create a client account (always approved; no public rate limit)
router.post('/users', async (req, res) => {
    try {
        const bcrypt = require('bcryptjs');
        const email = String(req.body.email || '')
            .trim()
            .toLowerCase();
        const password = String(req.body.password || '');
        const full_name = String(req.body.full_name || '').trim();
        const company_name = String(req.body.company_name || '').trim();
        if (!email || !password || password.length < 6) {
            return res.status(400).json({ error: 'Email and password (min 6 characters) are required' });
        }
        if (!full_name) return res.status(400).json({ error: 'Full name is required' });

        const db = await getDb();
        const existing = db.exec('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0 && existing[0].values.length > 0) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        const legacy = String(req.body.legacy_client_id || '').trim();
        db.run(
            `INSERT INTO users (email, password, full_name, company_name, legacy_client_id, account_status, is_admin)
             VALUES (?, ?, ?, ?, ?, 'approved', 0)`,
            [email, hashedPassword, full_name, company_name, legacy]
        );
        saveDb();
        const userId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
        logAdminAudit(db, req.user.id, 'create_user', { target_user_id: userId, email });
        res.status(201).json({
            message: 'Client account created',
            user: {
                id: userId,
                email,
                full_name,
                company_name,
                account_status: 'approved',
            },
        });
    } catch (err) {
        console.error('Admin create user error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/users/:id/approve-registration
router.post('/users/:id/approve-registration', async (req, res) => {
    try {
        const targetId = parseInt(req.params.id, 10);
        if (!Number.isFinite(targetId)) return res.status(400).json({ error: 'Invalid user id' });
        const db = await getDb();
        const rows = parseResults(
            db.exec('SELECT id, email, account_status FROM users WHERE id = ?', [targetId])
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        db.run(
            "UPDATE users SET account_status = 'approved', updated_at = datetime('now') WHERE id = ?",
            [targetId]
        );
        saveDb();
        pushActivity(
            targetId,
            'system',
            'Your ReturnPal account has been approved. You can now log in.',
            '/login.html'
        );
        logAdminAudit(db, req.user.id, 'approve_registration', { target_user_id: targetId, email: rows[0].email });
        res.json({ message: 'Registration approved', user_id: targetId });
    } catch (err) {
        console.error('Admin approve registration error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/users/:id/reject-registration — marks rejected (or delete with ?delete=1)
router.post('/users/:id/reject-registration', async (req, res) => {
    try {
        const targetId = parseInt(req.params.id, 10);
        if (!Number.isFinite(targetId)) return res.status(400).json({ error: 'Invalid user id' });
        const db = await getDb();
        const rows = parseResults(db.exec('SELECT id, email FROM users WHERE id = ?', [targetId]));
        if (!rows.length) return res.status(404).json({ error: 'User not found' });

        if (req.query.delete === '1' || req.body.delete === true) {
            db.run('DELETE FROM users WHERE id = ?', [targetId]);
            saveDb();
            logAdminAudit(db, req.user.id, 'reject_registration_delete', {
                target_user_id: targetId,
                email: rows[0].email,
            });
            return res.json({ message: 'Registration rejected and account removed', user_id: targetId });
        }

        db.run(
            "UPDATE users SET account_status = 'rejected', updated_at = datetime('now') WHERE id = ?",
            [targetId]
        );
        saveDb();
        logAdminAudit(db, req.user.id, 'reject_registration', { target_user_id: targetId, email: rows[0].email });
        res.json({ message: 'Registration rejected', user_id: targetId });
    } catch (err) {
        console.error('Admin reject registration error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/users/:id/invoice-month-sources — which DB rows contribute each YYYY-MM invoice month (debug)
router.get('/users/:id/invoice-month-sources', async (req, res) => {
    try {
        const targetId = parseInt(req.params.id, 10);
        if (isNaN(targetId)) return res.status(400).json({ error: 'Invalid user id' });

        const db = await getDb();
        const rows = parseResults(db.exec('SELECT id FROM users WHERE id = ?', [targetId]));
        if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

        const payload = buildInvoiceMonthSourcesPayload(db, targetId);
        logAdminAudit(db, req.user.id, 'invoice_month_sources', { target_user_id: targetId });
        res.json(payload);
    } catch (err) {
        console.error('Admin invoice month sources error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/admin/users/:id — update admin-editable user fields
router.put('/users/:id', async (req, res) => {
    try {
        const targetId = parseInt(req.params.id, 10);
        if (isNaN(targetId)) return res.status(400).json({ error: 'Invalid user id' });

        const db = await getDb();
        const rows = parseResults(
            db.exec('SELECT id, legacy_client_id FROM users WHERE id = ?', [targetId])
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });

        const current = rows[0];
        let legacyClientId = current.legacy_client_id != null ? String(current.legacy_client_id) : '';
        if (req.body.legacy_client_id !== undefined) {
            legacyClientId = String(req.body.legacy_client_id || '').trim().slice(0, 64);
        }

        db.run(
            "UPDATE users SET legacy_client_id = ?, updated_at = datetime('now') WHERE id = ?",
            [legacyClientId, targetId]
        );
        saveDb();

        logAdminAudit(db, req.user.id, 'update_user', { target_user_id: targetId, legacy_client_id: legacyClientId });

        res.json({ message: 'Client updated', user: { id: targetId, legacy_client_id: legacyClientId } });
    } catch (err) {
        console.error('Admin update user error:', err);
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

        logAdminAudit(db, req.user.id, 'delete_user', { target_user_id: targetId, email: target.email });

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

        let items = parseResults(
            db.exec('SELECT * FROM sold_items WHERE user_id = ? ORDER BY id DESC', [userId])
        );
        items = sortSoldItemsByDateDesc(items);
        items = items.map((row) => {
            const dates = mapSoldItemDatesForApi(row.sold_date, normalizeSoldDateForDb);
            return {
                ...row,
                sold_date_stored: dates.stored,
                sold_date: dates.iso || row.sold_date,
                sold_date_display: dates.iso || row.sold_date,
                sold_date_label: dates.label,
            };
        });
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
        const orderNumber = (req.body.order_number != null ? String(req.body.order_number) : '').trim().slice(0, 200);

        if (isNaN(userId) || !packageReference || !itemDescription) {
            return res.status(400).json({ error: 'user_id, package_reference, and item_description are required' });
        }

        const db = await getDb();
        const userCheck = db.exec('SELECT id FROM users WHERE id = ?', [userId]);
        if (!userCheck.length || !userCheck[0].values.length) {
            return res.status(400).json({ error: 'User not found' });
        }

        db.run(
            'INSERT INTO reimbursement_claims (user_id, package_reference, item_description, reimbursement_type, notes, order_number) VALUES (?, ?, ?, ?, ?, ?)',
            [userId, packageReference, itemDescription, reimbursementType, notes, orderNumber]
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

// PUT /api/admin/reimbursement-claims/:id — update text fields (admin)
router.put('/reimbursement-claims/:id', async (req, res) => {
    try {
        const claimId = parseInt(req.params.id, 10);
        if (isNaN(claimId)) return res.status(400).json({ error: 'Invalid id' });
        const db = await getDb();
        const rows = parseResults(db.exec('SELECT * FROM reimbursement_claims WHERE id = ?', [claimId]));
        if (!rows.length) return res.status(404).json({ error: 'Claim not found' });

        const { package_reference, item_description, reimbursement_type, notes, order_number } = req.body;
        const cur = rows[0];
        const pkg = package_reference !== undefined ? String(package_reference || '').trim() : cur.package_reference;
        const item = item_description !== undefined ? String(item_description || '').trim() : cur.item_description;
        const rtype = reimbursement_type !== undefined ? String(reimbursement_type || '').trim() : cur.reimbursement_type;
        const note = notes !== undefined ? String(notes || '').trim() : cur.notes;
        const orderUpd = Object.prototype.hasOwnProperty.call(req.body, 'order_number')
            ? String(order_number == null ? '' : order_number).trim().slice(0, 200)
            : null;

        if (!pkg || !item) {
            return res.status(400).json({ error: 'package_reference and item_description are required' });
        }

        const { enrichClaimRow, normalizeCaseStatus, buildCaseText } = require('../utils/reimbursementCase');
        const caseStatus =
            req.body.case_status !== undefined ? normalizeCaseStatus(req.body.case_status) : cur.case_status || 'draft';
        const expectedAmount =
            req.body.expected_amount !== undefined ? Number(req.body.expected_amount) || 0 : Number(cur.expected_amount) || 0;
        const recoveredAmount =
            req.body.recovered_amount !== undefined ? Number(req.body.recovered_amount) || 0 : Number(cur.recovered_amount) || 0;
        const scCase = req.body.seller_central_case_id !== undefined ? String(req.body.seller_central_case_id || '').trim() : cur.seller_central_case_id || '';
        let submittedAt = cur.submitted_at || '';
        let resolvedAt = cur.resolved_at || '';
        if (caseStatus === 'submitted' && !submittedAt) submittedAt = new Date().toISOString();
        if (['approved', 'partial', 'denied'].includes(caseStatus) && !resolvedAt) resolvedAt = new Date().toISOString();
        const caseText = buildCaseText({ ...cur, package_reference: pkg, item_description: item, reimbursement_type: rtype, notes: note });

        if (orderUpd !== null) {
            db.run(
                `UPDATE reimbursement_claims SET package_reference = ?, item_description = ?, reimbursement_type = ?, notes = ?, order_number = ?,
                 case_status = ?, seller_central_case_id = ?, expected_amount = ?, recovered_amount = ?, submitted_at = ?, resolved_at = ?, case_text = ?
                 WHERE id = ?`,
                [pkg, item, rtype, note, orderUpd, caseStatus, scCase, expectedAmount, recoveredAmount, submittedAt, resolvedAt, caseText, claimId]
            );
        } else {
            db.run(
                `UPDATE reimbursement_claims SET package_reference = ?, item_description = ?, reimbursement_type = ?, notes = ?,
                 case_status = ?, seller_central_case_id = ?, expected_amount = ?, recovered_amount = ?, submitted_at = ?, resolved_at = ?, case_text = ?
                 WHERE id = ?`,
                [pkg, item, rtype, note, caseStatus, scCase, expectedAmount, recoveredAmount, submittedAt, resolvedAt, caseText, claimId]
            );
        }
        saveDb();
        const updated = enrichClaimRow(parseResults(db.exec('SELECT * FROM reimbursement_claims WHERE id = ?', [claimId]))[0]);
        updated.photos = parseResults(db.exec('SELECT id, file_path FROM reimbursement_claim_photos WHERE claim_id = ?', [claimId]));
        res.json({ claim: updated });
    } catch (err) {
        console.error('Admin update reimbursement claim error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/admin/reimbursement-claims/:id — remove claim and stored photos (admin)
router.delete('/reimbursement-claims/:id', async (req, res) => {
    try {
        const claimId = parseInt(req.params.id, 10);
        if (isNaN(claimId)) return res.status(400).json({ error: 'Invalid id' });
        const db = await getDb();
        const rows = parseResults(db.exec('SELECT id FROM reimbursement_claims WHERE id = ?', [claimId]));
        if (!rows.length) return res.status(404).json({ error: 'Claim not found' });

        const dir = path.join(reimbursementUploadDir, String(claimId));
        if (fs.existsSync(dir)) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch (e) {
                console.error('Admin delete reimbursement: could not remove dir', dir, e);
            }
        }

        db.run('DELETE FROM reimbursement_claims WHERE id = ?', [claimId]);
        saveDb();
        res.json({ message: 'Reimbursement claim removed' });
    } catch (err) {
        console.error('Admin delete reimbursement claim error:', err);
        res.status(500).json({ error: 'Server error' });
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

        logAdminAudit(db, req.user.id, 'impersonate', { target_user_id: targetId, email: user.email });

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
        const onum = (req.body.order_number != null ? String(req.body.order_number) : '').trim().slice(0, 200);
        const refundDate = normalizeSoldDateForDb(req.body.refund_date) || '';
        const amount = parseFloat(req.body.amount);
        let linked = req.body.linked_sold_item_id != null ? parseInt(req.body.linked_sold_item_id, 10) : null;
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
        if (!Number.isFinite(linked)) {
            linked = findLinkedSoldItemId(db, userId, {
                orderNumber: onum,
                product,
                reference,
            });
        }
        if (!Number.isFinite(linked)) linked = null;

        db.run(
            `INSERT INTO return_adjustments (user_id, product, reference, amount, linked_sold_item_id, status, notes, order_number, refund_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, product, reference, amount, linked, status, notes, onum, refundDate]
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

// POST /api/admin/bulk-import-preview — multipart: kind, file, user_id (single), multi=1|0
router.post('/bulk-import-preview', bulkSpreadsheetUpload.single('file'), async (req, res) => {
    try {
        const kind = String(req.body.kind || '').trim();
        const multi = req.body.multi === '1' || req.body.multi === 'true' || req.body.multi === true;
        const uid = parseInt(req.body.user_id || req.body.userId || '0', 10);
        if (!BULK_IMPORT_KINDS.includes(kind)) {
            return res.status(400).json({ error: 'Invalid kind', kinds: BULK_IMPORT_KINDS });
        }
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ error: 'file is required (.xlsx, .xls, or .csv)' });
        }
        if (!multi && isNaN(uid)) {
            return res.status(400).json({ error: 'user_id is required for single-client preview' });
        }
        const db = await getDb();
        const preview = previewBulkImport(db, {
            kind,
            userId: multi ? 0 : uid,
            buffer: req.file.buffer,
            multi,
        });
        res.json({ ...preview, kind, multi });
    } catch (err) {
        console.error('Bulk preview error:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

// GET /api/admin/bulk-import-jobs?client_id=&limit=&include_rolled_back=0|1
router.get('/bulk-import-jobs', async (req, res) => {
    try {
        const db = await getDb();
        const cid = req.query.client_id != null ? parseInt(req.query.client_id, 10) : NaN;
        const includeRolled =
            req.query.include_rolled_back === '1' ||
            req.query.include_rolled_back === 'true' ||
            req.query.include_rolled_back === true;
        const jobs = listBulkImportJobs(db, {
            clientId: Number.isFinite(cid) ? cid : undefined,
            limit: req.query.limit,
            includeRolledBack: includeRolled,
        });
        res.json({ jobs });
    } catch (err) {
        console.error('List bulk jobs error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/bulk-import-pending — rows with no / unknown Client ID, waiting to apply to a client
router.get('/bulk-import-pending', async (req, res) => {
    try {
        const db = await getDb();
        const filter =
            req.query.limit != null && String(req.query.limit).trim() !== ''
                ? { limit: req.query.limit }
                : {};
        const groups = listPendingImportGroups(db, filter);
        res.json({ groups });
    } catch (err) {
        console.error('List pending bulk imports error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/bulk-import-pending/apply — body: { user_id, kind, legacy_key } (legacy_key "" = missing Client ID column)
router.post('/bulk-import-pending/apply', async (req, res) => {
    try {
        const userId = parseInt(req.body.user_id ?? req.body.userId, 10);
        const kind = String(req.body.kind || '').trim();
        const legacyKey = req.body.legacy_key != null ? String(req.body.legacy_key) : '';
        if (!Number.isFinite(userId) || userId < 1) {
            return res.status(400).json({ error: 'user_id is required' });
        }
        if (!BULK_IMPORT_KINDS.includes(kind)) {
            return res.status(400).json({ error: 'Invalid kind', kinds: BULK_IMPORT_KINDS });
        }
        const db = await getDb();
        const result = await applyPendingRowsToUser(db, {
            userId,
            kind,
            legacyKey,
            applyImportRow: (d, k, uid, fullRow) =>
                applyImportRowForKind(d, k, uid, rowWithoutClientSpecifier(fullRow)),
        });
        if (!result.ok) {
            return res.status(400).json({ error: result.error || 'Apply failed' });
        }
        let jobId = null;
        if (result.inserted && result.inserted.length) {
            jobId = createBulkImportJob(db, {
                adminUserId: req.user.id,
                kind,
                isMulti: false,
                originalFilename: `pending-apply:${kind}:${legacyKey === '' ? 'no-id' : legacyKey}`,
                targetUserId: userId,
                rowCount: result.pending_ids_touched || 0,
                importedCount: result.imported || 0,
                errorCount: (result.errors && result.errors.length) || 0,
            });
            addBulkImportEntries(db, jobId, result.inserted);
        }
        logAdminAudit(db, req.user.id, 'bulk_import_pending_apply', {
            user_id: userId,
            kind,
            legacy_key: legacyKey,
            imported: result.imported,
            errors: (result.errors && result.errors.length) || 0,
            job_id: jobId,
        });
        res.json({ ...result, job_id: jobId });
    } catch (err) {
        console.error('Apply pending bulk import error:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

// POST /api/admin/bulk-import-jobs/:id/rollback
router.post('/bulk-import-jobs/:id/rollback', async (req, res) => {
    try {
        const jobId = parseInt(req.params.id, 10);
        if (isNaN(jobId)) return res.status(400).json({ error: 'Invalid job id' });
        const db = await getDb();
        const result = rollbackBulkImportJob(db, jobId, req.user.id);
        if (!result.ok) {
            return res.status(400).json({ error: result.error || 'Rollback failed' });
        }
        logAdminAudit(db, req.user.id, 'bulk_import_rollback', { job_id: jobId, entries: result.entries_rolled });
        res.json(result);
    } catch (err) {
        console.error('Rollback bulk job error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/audit-log?limit=&offset=
router.get('/audit-log', async (req, res) => {
    try {
        const db = await getDb();
        const entries = listAdminAudit(db, { limit: req.query.limit, offset: req.query.offset });
        res.json({ entries });
    } catch (err) {
        console.error('Audit log error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/bulk-import-template/:kind — download example .xlsx (sold, received, pending, …)
router.get('/bulk-import-template/:kind', (req, res) => {
    try {
        const kind = String(req.params.kind || '').trim();
        const multi = String(req.query.multi || '').trim() === '1' || String(req.query.multi || '').toLowerCase() === 'true';
        const buf = buildTemplateBuffer(kind, { multi });
        if (!buf) {
            return res.status(400).json({ error: 'Unknown template type', kinds: BULK_IMPORT_KINDS });
        }
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        const suffix = multi ? '-multi-client' : '';
        res.setHeader('Content-Disposition', `attachment; filename="returnpal-import-${kind}${suffix}.xlsx"`);
        res.send(Buffer.from(buf));
    } catch (err) {
        console.error('Bulk template error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/users/:userId/bulk-import — multipart: kind, file (.xlsx / .xls / .csv)
router.post('/users/:userId/bulk-import', bulkSpreadsheetUpload.single('file'), async (req, res) => {
    try {
        const userId = parseInt(req.params.userId, 10);
        if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user id' });
        const kind = String(req.body.kind || '').trim();
        if (!BULK_IMPORT_KINDS.includes(kind)) {
            return res.status(400).json({ error: 'Invalid kind', kinds: BULK_IMPORT_KINDS });
        }
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ error: 'file is required (.xlsx, .xls, or .csv)' });
        }
        const db = await getDb();
        const ucheck = parseResults(db.exec('SELECT id FROM users WHERE id = ?', [userId]));
        if (!ucheck.length) return res.status(404).json({ error: 'User not found' });

        const filename = (req.file && req.file.originalname) || 'import';
        const { imported, errors, inserted, row_count } = await runBulkImport(db, kind, userId, req.file.buffer);
        const jobId = createBulkImportJob(db, {
            adminUserId: req.user.id,
            kind,
            isMulti: false,
            originalFilename: filename,
            targetUserId: userId,
            rowCount: row_count,
            importedCount: imported,
            errorCount: errors.length,
        });
        if (inserted.length) {
            addBulkImportEntries(db, jobId, inserted);
        }
        logAdminAudit(db, req.user.id, 'bulk_import', {
            job_id: jobId,
            kind,
            user_id: userId,
            imported,
            error_count: errors.length,
            filename,
        });
        res.json({ imported, errors, kind, user_id: userId, job_id: jobId, inserted_count: inserted.length });
    } catch (err) {
        console.error('Bulk import error:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

// POST /api/admin/ebay-refunds-import — eBay Refunds report CSV + optional orders map → return_adjustments (updates client payouts)
router.post(
    '/ebay-refunds-import',
    ebayRefundsUpload.fields([
        { name: 'refunds', maxCount: 1 },
        { name: 'orders_map', maxCount: 1 },
    ]),
    async (req, res) => {
        try {
            const refundsFile = req.files && req.files.refunds && req.files.refunds[0];
            if (!refundsFile || !refundsFile.buffer) {
                return res.status(400).json({ error: 'refunds file is required (.csv or .xlsx)' });
            }
            const ordersFile = req.files && req.files.orders_map && req.files.orders_map[0];
            const converted = convertEbayRefundsBuffers({
                refundsBuffer: refundsFile.buffer,
                ordersMapBuffer: ordersFile ? ordersFile.buffer : null,
                ordersMapName: ordersFile ? ordersFile.originalname : '',
            });
            const db = await getDb();
            const filename = refundsFile.originalname || 'ebay-refunds.csv';
            const { imported, errors, by_user, inserted, row_count, pending_rows_saved, pending_by_key } =
                await runBulkImportMulti(db, 'return_adjustment', converted.csvBuffer, {
                    adminUserId: req.user.id,
                    originalFilename: filename,
                    queueUnmatched: true,
                });
            let jobId = null;
            if (inserted.length) {
                jobId = createBulkImportJob(db, {
                    adminUserId: req.user.id,
                    kind: 'return_adjustment',
                    isMulti: true,
                    originalFilename: filename,
                    targetUserId: null,
                    rowCount: row_count,
                    importedCount: imported,
                    errorCount: errors.length,
                });
                addBulkImportEntries(db, jobId, inserted);
            }
            logAdminAudit(db, req.user.id, 'ebay_refunds_import', {
                job_id: jobId,
                imported,
                error_count: errors.length,
                convert: converted.stats,
            });
            res.json({
                imported,
                errors: errors.slice(0, 50),
                error_count: errors.length,
                by_user,
                job_id: jobId,
                convert: converted.stats,
                pending_rows_saved: pending_rows_saved || 0,
                pending_by_key: pending_by_key || {},
                message:
                    'Refunds applied to client balances and monthly payout statements (by refund date). ' +
                    'Clients see them under Sold Items → Refunds / Returns.',
            });
        } catch (err) {
            console.error('eBay refunds import error:', err);
            res.status(500).json({ error: err.message || 'Server error' });
        }
    }
);

// POST /api/admin/ebay-refunds-preview — parse files → rows for manual Client ID review
router.post(
    '/ebay-refunds-preview',
    ebayRefundsUpload.fields([
        { name: 'refunds', maxCount: 1 },
        { name: 'orders_map', maxCount: 1 },
    ]),
    async (req, res) => {
        try {
            const refundsFile = req.files && req.files.refunds && req.files.refunds[0];
            if (!refundsFile || !refundsFile.buffer) {
                return res.status(400).json({ error: 'refunds file is required' });
            }
            const ordersFile = req.files && req.files.orders_map && req.files.orders_map[0];
            const converted = convertEbayRefundsForReview({
                refundsBuffer: refundsFile.buffer,
                ordersMapBuffer: ordersFile ? ordersFile.buffer : null,
                ordersMapName: ordersFile ? ordersFile.originalname : '',
            });
            const db = await getDb();
            const reviewRows = (converted.rows || []).map((r, idx) => {
                const spec = String(r.clientId || '').trim();
                let resolve_ok = false;
                let resolve_error = spec ? '' : 'No Client ID — pick one below';
                let resolved_user_id = null;
                let resolved_label = '';
                let resolved_email = '';
                let legacy_client_id = '';
                if (spec) {
                    const res = resolveUserIdFromClientSpecifier(db, spec);
                    if (res.error) {
                        resolve_error = res.error;
                    } else {
                        resolve_ok = true;
                        resolved_user_id = res.userId;
                        const brief = lookupUserBrief(db, res.userId);
                        if (brief) {
                            resolved_label = brief.name || '';
                            resolved_email = brief.email || '';
                            legacy_client_id = brief.legacy_client_id || '';
                        }
                    }
                }
                return {
                    line: idx + 1,
                    client_id: spec,
                    client_source: r.clientSource || 'none',
                    order_number: r.orderNumber || '',
                    product: r.product || '',
                    custom_label: r.customLabel || '',
                    amount: r.amount,
                    refund_date: r.refundDate || '',
                    reference: r.reference || '',
                    notes: r.notes || '',
                    status: r.status || 'applied',
                    type: r.type || '',
                    resolve_ok,
                    resolve_error,
                    resolved_user_id,
                    resolved_label,
                    resolved_email,
                    legacy_client_id,
                };
            });
            const ready = reviewRows.filter((r) => r.resolve_ok).length;
            res.json({
                convert: converted.stats,
                orders_map_orders: converted.orderClientMapSize,
                rows: reviewRows,
                summary: {
                    total: reviewRows.length,
                    ready,
                    needs_client: reviewRows.length - ready,
                },
            });
        } catch (err) {
            console.error('eBay refunds preview error:', err);
            res.status(500).json({ error: err.message || 'Server error' });
        }
    }
);

// POST /api/admin/ebay-refunds-import-reviewed — import after admin edits Client IDs in review table
router.post('/ebay-refunds-import-reviewed', async (req, res) => {
    try {
        const bodyRows = req.body && Array.isArray(req.body.rows) ? req.body.rows : null;
        if (!bodyRows || !bodyRows.length) {
            return res.status(400).json({ error: 'rows array is required' });
        }
        if (bodyRows.length > 15000) {
            return res.status(400).json({ error: 'Too many rows (max 15000)' });
        }
        const queueUnmatched = !(req.body.queue_unmatched === false || req.body.queue_unmatched === '0');
        const csvBuffer = reviewedRowsToCsvBuffer(bodyRows);
        const db = await getDb();
        const filename = String(req.body.source_filename || 'ebay-refunds-reviewed.json').slice(0, 200);
        const { imported, errors, by_user, inserted, row_count, pending_rows_saved, pending_by_key } =
            await runBulkImportMulti(db, 'return_adjustment', csvBuffer, {
                adminUserId: req.user.id,
                originalFilename: filename,
                queueUnmatched,
            });
        let jobId = null;
        if (inserted.length) {
            jobId = createBulkImportJob(db, {
                adminUserId: req.user.id,
                kind: 'return_adjustment',
                isMulti: true,
                originalFilename: filename,
                targetUserId: null,
                rowCount: row_count,
                importedCount: imported,
                errorCount: errors.length,
            });
            addBulkImportEntries(db, jobId, inserted);
        }
        logAdminAudit(db, req.user.id, 'ebay_refunds_import_reviewed', {
            job_id: jobId,
            imported,
            error_count: errors.length,
            row_count: bodyRows.length,
        });
        res.json({
            imported,
            errors: errors.slice(0, 50),
            error_count: errors.length,
            by_user,
            job_id: jobId,
            pending_rows_saved: pending_rows_saved || 0,
            pending_by_key: pending_by_key || {},
            message:
                'Imported reviewed refunds. Client dashboards and payout months are updated from refund_date on each row.',
        });
    } catch (err) {
        console.error('eBay refunds import reviewed error:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

// POST /api/admin/bulk-import-multi — multipart: kind, file; each row must include Client ID or Old Client ID
router.post('/bulk-import-multi', bulkSpreadsheetUpload.single('file'), async (req, res) => {
    try {
        const kind = String(req.body.kind || '').trim();
        if (!BULK_IMPORT_KINDS.includes(kind)) {
            return res.status(400).json({ error: 'Invalid kind', kinds: BULK_IMPORT_KINDS });
        }
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ error: 'file is required (.xlsx, .xls, or .csv)' });
        }
        const db = await getDb();
        const filename = (req.file && req.file.originalname) || 'import';
        const queueUnmatched = !(req.body.queue_unmatched === '0' || req.body.queue_unmatched === false);
        const { imported, errors, by_user, inserted, row_count, pending_rows_saved, pending_by_key } =
            await runBulkImportMulti(db, kind, req.file.buffer, {
                adminUserId: req.user.id,
                originalFilename: filename,
                queueUnmatched,
            });
        let jobId = null;
        if (inserted.length) {
            jobId = createBulkImportJob(db, {
                adminUserId: req.user.id,
                kind,
                isMulti: true,
                originalFilename: filename,
                targetUserId: null,
                rowCount: row_count,
                importedCount: imported,
                errorCount: errors.length,
            });
            addBulkImportEntries(db, jobId, inserted);
        }
        logAdminAudit(db, req.user.id, 'bulk_import_multi', {
            job_id: jobId,
            kind,
            imported,
            error_count: errors.length,
            filename,
            pending_rows_saved: pending_rows_saved || 0,
        });
        res.json({
            imported,
            errors,
            kind,
            by_user,
            job_id: jobId,
            inserted_count: inserted.length,
            pending_rows_saved: pending_rows_saved || 0,
            pending_by_key: pending_by_key || {},
        });
    } catch (err) {
        console.error('Bulk import multi error:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

// PUT /api/admin/queries/:id/reply — reply to client query
router.put('/queries/:id/reply', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const reply = String(req.body.admin_reply || req.body.reply || '').trim();
        if (!reply || reply.length < 2) {
            return res.status(400).json({ error: 'Reply is required.' });
        }
        const db = await getDb();
        const rows = parseResults(db.exec('SELECT user_id, context_label FROM item_queries WHERE id = ?', [id]));
        if (!rows.length) return res.status(404).json({ error: 'Query not found' });
        db.run(
            "UPDATE item_queries SET admin_reply = ?, replied_at = datetime('now'), status = 'closed' WHERE id = ?",
            [reply, id]
        );
        saveDb();
        await pushActivity(
            rows[0].user_id,
            'info',
            'ReturnPal replied to your question' + (rows[0].context_label ? ': ' + String(rows[0].context_label).slice(0, 60) : '') + '.',
            '/dashboard/queries.html'
        );
        res.json({ message: 'Reply sent' });
    } catch (err) {
        console.error('Admin query reply error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/announcements
router.post('/announcements', async (req, res) => {
    try {
        const title = String(req.body.title || '').trim();
        const summary = String(req.body.summary || '').trim();
        const body = String(req.body.body || summary).trim();
        if (!title) return res.status(400).json({ error: 'Title is required' });
        const db = await getDb();
        db.run(
            'INSERT INTO announcements (title, summary, body, is_published, published_at) VALUES (?, ?, ?, 1, datetime(\'now\'))',
            [title, summary, body]
        );
        saveDb();
        const id = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
        res.status(201).json({ id, message: 'Announcement published' });
    } catch (err) {
        console.error('Admin create announcement error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/users/:id/delegate-hubs — hub accounts that can view this client
router.get('/users/:id/delegate-hubs', async (req, res) => {
    try {
        const { listHubsForClient } = require('../utils/clientDelegate');
        const db = await getDb();
        const clientId = parseInt(req.params.id, 10);
        if (!Number.isFinite(clientId)) return res.status(400).json({ error: 'Invalid user id' });
        const hubs = listHubsForClient(db, clientId);
        res.json({
            client_user_id: clientId,
            hub_user_ids: hubs.map((h) => h.id),
            hubs: hubs.map((h) => ({
                id: h.id,
                email: h.email,
                full_name: h.full_name,
                company_name: h.company_name,
                display_name: h.full_name || h.company_name || h.email,
            })),
        });
    } catch (err) {
        console.error('Get delegate hubs error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/admin/users/:id/delegate-hubs — set which hub accounts can view this client
router.put('/users/:id/delegate-hubs', async (req, res) => {
    try {
        const { setHubLinksForClient } = require('../utils/clientDelegate');
        const db = await getDb();
        const clientId = parseInt(req.params.id, 10);
        if (!Number.isFinite(clientId)) return res.status(400).json({ error: 'Invalid user id' });
        const hubUserIds = Array.isArray(req.body.hub_user_ids)
            ? req.body.hub_user_ids
            : Array.isArray(req.body.hub_ids)
              ? req.body.hub_ids
              : [];
        setHubLinksForClient(db, clientId, hubUserIds);
        saveDb();
        logAdminAudit(db, req.user.id, 'delegate_hubs_set', { client_user_id: clientId, hub_user_ids: hubUserIds });
        res.json({ message: 'Hub access updated', client_user_id: clientId, hub_user_ids: hubUserIds });
    } catch (err) {
        console.error('Set delegate hubs error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/users/:id/delegate-clients — clients a hub account can view
router.get('/users/:id/delegate-clients', async (req, res) => {
    try {
        const { listLinkedClients } = require('../utils/clientDelegate');
        const db = await getDb();
        const hubId = parseInt(req.params.id, 10);
        if (!Number.isFinite(hubId)) return res.status(400).json({ error: 'Invalid user id' });
        const clients = listLinkedClients(db, hubId);
        res.json({
            hub_user_id: hubId,
            client_user_ids: clients.map((c) => c.id),
            clients: clients.map((c) => ({
                id: c.id,
                email: c.email,
                full_name: c.full_name,
                company_name: c.company_name,
                display_name: c.full_name || c.company_name || c.email,
            })),
        });
    } catch (err) {
        console.error('Get delegate clients error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/admin/users/:id/delegate-clients — set which clients a hub account can view
router.put('/users/:id/delegate-clients', async (req, res) => {
    try {
        const { setClientLinksForHub } = require('../utils/clientDelegate');
        const db = await getDb();
        const hubId = parseInt(req.params.id, 10);
        if (!Number.isFinite(hubId)) return res.status(400).json({ error: 'Invalid user id' });
        const clientUserIds = Array.isArray(req.body.client_user_ids)
            ? req.body.client_user_ids
            : Array.isArray(req.body.client_ids)
              ? req.body.client_ids
              : [];
        setClientLinksForHub(db, hubId, clientUserIds);
        saveDb();
        logAdminAudit(db, req.user.id, 'delegate_clients_set', { hub_user_id: hubId, client_user_ids: clientUserIds });
        res.json({ message: 'Linked clients updated', hub_user_id: hubId, client_user_ids: clientUserIds });
    } catch (err) {
        console.error('Set delegate clients error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/partners — create partner API key (shown once)
router.post('/partners', async (req, res) => {
    try {
        const { hashApiKey } = require('../middleware/partnerAuth');
        const crypto = require('crypto');
        const name = String(req.body.name || '').trim();
        const userIds = Array.isArray(req.body.user_ids) ? req.body.user_ids.map((x) => parseInt(x, 10)).filter(Number.isFinite) : [];
        if (!name) return res.status(400).json({ error: 'Partner name is required' });
        const apiKey = 'rp_' + crypto.randomBytes(24).toString('hex');
        const db = await getDb();
        db.run('INSERT INTO partner_integrations (name, api_key_hash, is_active) VALUES (?, ?, 1)', [
            name,
            hashApiKey(apiKey),
        ]);
        const partnerId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
        for (const uid of userIds) {
            db.run('INSERT OR IGNORE INTO partner_client_access (partner_id, user_id) VALUES (?, ?)', [partnerId, uid]);
        }
        saveDb();
        res.status(201).json({
            partner_id: partnerId,
            name,
            api_key: apiKey,
            user_ids: userIds,
            message: 'Store the API key now — it cannot be retrieved again.',
        });
    } catch (err) {
        console.error('Create partner error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
