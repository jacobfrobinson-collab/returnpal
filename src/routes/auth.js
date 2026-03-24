const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { getDb, saveDb, pushActivity } = require('../database');
const { generateToken, authMiddleware } = require('../middleware/auth');

const router = express.Router();

const uploadRoot = process.env.UPLOAD_DIR
    ? path.resolve(process.env.UPLOAD_DIR)
    : path.join(__dirname, '../../uploads');

function unlinkAvatarIfOwned(avatarUrl) {
    if (!avatarUrl || typeof avatarUrl !== 'string') return;
    if (!avatarUrl.startsWith('/uploads/')) return;
    const rel = avatarUrl.replace(/^\/uploads\/?/, '').replace(/^\/+/, '');
    if (!rel.startsWith('avatars/')) return;
    const full = path.join(uploadRoot, rel);
    const resolved = path.resolve(full);
    const rootResolved = path.resolve(uploadRoot);
    if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) return;
    fs.unlink(resolved, () => {});
}

const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(uploadRoot, 'avatars');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
        const safe = allowed.includes(ext) ? ext : '.jpg';
        cb(null, `user-${req.user.id}-${Date.now()}${safe}`);
    }
});

const avatarUpload = multer({
    storage: avatarStorage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ok = /^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype);
        if (ok) cb(null, true);
        else cb(new Error('Only JPEG, PNG, WebP, or GIF images are allowed'));
    }
});

/** Parse referral code like RP12 → user id 12 */
function parseReferralCode(input) {
    if (input == null || input === '') return null;
    const s = String(input).trim();
    const m = s.match(/^RP(\d+)$/i);
    if (!m) return null;
    const id = parseInt(m[1], 10);
    return Number.isFinite(id) && id > 0 ? id : null;
}

// POST /api/auth/register
router.post('/register', [
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('full_name').trim().notEmpty().withMessage('Full name is required'),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const db = await getDb();
        const { email, password, full_name, company_name } = req.body;
        const rawRef = req.body.referral_code || req.body.ref;
        let referredById = null;
        const parsedRef = parseReferralCode(rawRef);
        if (parsedRef) {
            const refCheck = db.exec('SELECT id FROM users WHERE id = ?', [parsedRef]);
            if (refCheck.length > 0 && refCheck[0].values && refCheck[0].values.length > 0) {
                referredById = parsedRef;
            }
        }

        // Check if user exists
        const existing = db.exec('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0 && existing[0].values.length > 0) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        const hashedPassword = await bcrypt.hash(password, 12);

        db.run(
            'INSERT INTO users (email, password, full_name, company_name, referred_by) VALUES (?, ?, ?, ?, ?)',
            [email, hashedPassword, full_name, company_name || '', referredById]
        );
        saveDb();

        // Resolve new row id reliably (sql.js last_insert_rowid() can be unreliable across run/exec)
        let userId = null;
        let stmt = null;
        try {
            stmt = db.prepare('SELECT id FROM users WHERE email = ?');
            stmt.bind([email]);
            if (stmt.step()) {
                const row = stmt.getAsObject();
                userId = row.id;
            }
        } catch (e) {
            console.error('Register: prepare SELECT id failed', e);
        } finally {
            try {
                if (stmt && typeof stmt.free === 'function') stmt.free();
            } catch (e) { /* ignore */ }
        }
        if (userId == null || userId === undefined) {
            try {
                const fallback = db.exec('SELECT last_insert_rowid() as id');
                if (fallback.length && fallback[0].values && fallback[0].values[0]) {
                    userId = fallback[0].values[0][0];
                }
            } catch (e) {
                console.error('Register: last_insert_rowid fallback failed', e);
            }
        }

        userId = parseInt(userId, 10);
        if (!Number.isFinite(userId) || userId <= 0) {
            console.error('Register: invalid user id after insert', userId);
            return res.status(500).json({ error: 'Could not create account. Please try again.' });
        }

        if (referredById) {
            pushActivity(
                referredById,
                'referral',
                `Someone signed up with your referral link (${email})`,
                '/dashboard/referrals.html'
            );
        }

        const user = { id: userId, email };
        const token = generateToken(user);

        res.status(201).json({
            message: 'Account created successfully',
            token,
            user: { id: userId, email, full_name, company_name: company_name || '', avatar_url: '' }
        });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/auth/login
router.post('/login', [
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').notEmpty().withMessage('Password is required'),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const db = await getDb();
        const { email, password } = req.body;

        const result = db.exec(
            'SELECT id, email, password, full_name, company_name, avatar_url, is_admin FROM users WHERE email = ?',
            [email]
        );

        if (result.length === 0 || result[0].values.length === 0) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const row = result[0].values[0];
        const cols = result[0].columns;
        const user = {};
        cols.forEach((col, i) => { user[col] = row[i]; });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const isAdmin = !!(user.is_admin || user.is_admin === 1);
        const token = generateToken({ id: user.id, email: user.email, is_admin: isAdmin });

        const uid = parseInt(user.id, 10);
        res.json({
            message: 'Login successful',
            token,
            user: {
                id: Number.isFinite(uid) && uid > 0 ? uid : user.id,
                email: user.email,
                full_name: user.full_name,
                company_name: user.company_name,
                avatar_url: user.avatar_url,
                is_admin: isAdmin
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const result = db.exec(
            'SELECT id, email, full_name, company_name, phone, vat_registered, discord_webhook, avatar_url, is_admin, created_at FROM users WHERE id = ?',
            [req.user.id]
        );

        if (result.length === 0 || result[0].values.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const row = result[0].values[0];
        const cols = result[0].columns;
        const user = {};
        cols.forEach((col, i) => { user[col] = row[i]; });

        if (user.id != null) {
            const nid = parseInt(user.id, 10);
            if (Number.isFinite(nid) && nid > 0) user.id = nid;
        }

        res.json({ user });
    } catch (err) {
        console.error('Get profile error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/auth/avatar — multipart field "photo"
router.post('/avatar', authMiddleware, (req, res) => {
    avatarUpload.single('photo')(req, res, async (err) => {
        if (err) {
            const msg = err.message || 'Upload failed';
            return res.status(400).json({ error: msg });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        try {
            const db = await getDb();
            const prev = db.exec('SELECT avatar_url FROM users WHERE id = ?', [req.user.id]);
            let oldUrl = '';
            if (prev.length && prev[0].values && prev[0].values[0]) {
                oldUrl = prev[0].values[0][0] || '';
            }
            const publicPath = '/uploads/avatars/' + req.file.filename;
            db.run(
                "UPDATE users SET avatar_url = ?, updated_at = datetime('now') WHERE id = ?",
                [publicPath, req.user.id]
            );
            saveDb();
            unlinkAvatarIfOwned(oldUrl);
            res.json({ avatar_url: publicPath, message: 'Photo updated' });
        } catch (e) {
            console.error('Avatar save error:', e);
            fs.unlink(req.file.path, () => {});
            res.status(500).json({ error: 'Could not save photo' });
        }
    });
});

// DELETE /api/auth/avatar — clear stored photo
router.delete('/avatar', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const prev = db.exec('SELECT avatar_url FROM users WHERE id = ?', [req.user.id]);
        let oldUrl = '';
        if (prev.length && prev[0].values && prev[0].values[0]) {
            oldUrl = prev[0].values[0][0] || '';
        }
        db.run("UPDATE users SET avatar_url = '', updated_at = datetime('now') WHERE id = ?", [req.user.id]);
        saveDb();
        unlinkAvatarIfOwned(oldUrl);
        res.json({ avatar_url: '', message: 'Photo removed' });
    } catch (e) {
        console.error('Avatar delete error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/auth/profile
router.put('/profile', authMiddleware, [
    body('full_name').optional().trim().isLength({ max: 200 }).withMessage('Full name too long'),
    body('company_name').optional().trim().isLength({ max: 200 }).withMessage('Company name too long'),
    body('phone').optional().trim().isLength({ max: 50 }).withMessage('Phone too long'),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }
        const db = await getDb();
        const full_name = (req.body.full_name != null ? String(req.body.full_name).trim() : undefined);
        const company_name = (req.body.company_name != null ? String(req.body.company_name).trim() : '');
        const phone = (req.body.phone != null ? String(req.body.phone).trim() : '');

        db.run(
            "UPDATE users SET full_name = ?, company_name = ?, phone = ?, updated_at = datetime('now') WHERE id = ?",
            [full_name != null ? full_name : '', company_name, phone, req.user.id]
        );
        saveDb();

        res.json({ message: 'Profile updated successfully' });
    } catch (err) {
        console.error('Update profile error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/auth/password
router.put('/password', authMiddleware, [
    body('current_password').notEmpty(),
    body('new_password').isLength({ min: 6 }),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const db = await getDb();
        const { current_password, new_password } = req.body;

        const result = db.exec('SELECT password FROM users WHERE id = ?', [req.user.id]);
        if (!result.length || !result[0].values.length) {
            return res.status(404).json({ error: 'User not found' });
        }
        const currentHash = result[0].values[0][0];

        const valid = await bcrypt.compare(current_password, currentHash);
        if (!valid) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const newHash = await bcrypt.hash(new_password, 12);
        db.run("UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?", [newHash, req.user.id]);
        saveDb();

        res.json({ message: 'Password updated successfully' });
    } catch (err) {
        console.error('Password change error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
