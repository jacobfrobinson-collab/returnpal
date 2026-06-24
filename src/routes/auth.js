const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { getDb, saveDb, pushActivity } = require('../database');
const { generateToken, authMiddleware } = require('../middleware/auth');
const { registerLimiter, loginLimiter } = require('../middleware/authRateLimit');
const { coerceIsAdmin } = require('../utils/coerceIsAdmin');
const { validateSignupRequest, getTurnstileSiteKey, isTurnstileRequired } = require('../utils/signupProtection');
const {
    isSignupApprovalRequired,
    defaultAccountStatusForSignup,
    getUserAccountStatus,
    PENDING_MESSAGE,
    REJECTED_MESSAGE,
} = require('../utils/accountApproval');
const { logClientAudit, logClientAuditForUser, clientRequestMeta } = require('../utils/clientAudit');
const {
    CURRENT_TERMS_VERSION,
    CURRENT_TERMS_EFFECTIVE,
    TERMS_URL,
    recordTermsAcceptance,
    enrichUserWithTerms,
} = require('../utils/termsOfService');

const router = express.Router();

function parseOneUserRow(result) {
    if (!result || !result.length || !result[0].values || !result[0].values.length) return null;
    const cols = result[0].columns;
    const row = result[0].values[0];
    const o = {};
    cols.forEach((c, i) => { o[c] = row[i]; });
    return o;
}

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

// GET /api/auth/register-config — public signup UI settings (Turnstile site key, etc.)
router.get('/register-config', (req, res) => {
    const siteKey = getTurnstileSiteKey();
    res.json({
        turnstile_site_key: siteKey,
        turnstile_required: isTurnstileRequired(),
        min_form_seconds: parseInt(process.env.SIGNUP_MIN_FORM_SECONDS || '3', 10),
        require_admin_approval: isSignupApprovalRequired(),
        terms_version: CURRENT_TERMS_VERSION,
        terms_effective: CURRENT_TERMS_EFFECTIVE,
        terms_url: TERMS_URL,
        register_rate_limit_max: parseInt(process.env.REGISTER_RATE_LIMIT_MAX || '1', 10),
        register_rate_limit_window_hours: Math.round(
            parseInt(process.env.REGISTER_RATE_LIMIT_WINDOW_MS || String(24 * 60 * 60 * 1000), 10) /
                (60 * 60 * 1000)
        ),
    });
});

// POST /api/auth/register
router.post(
    '/register',
    registerLimiter,
    [
        body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
        body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
        body('full_name').trim().notEmpty().withMessage('Full name is required'),
    ],
    async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const remoteIp = req.ip || req.headers['x-forwarded-for'] || '';
        const signupCheck = await validateSignupRequest(req.body, remoteIp);
        if (!signupCheck.ok) {
            return res.status(signupCheck.status || 400).json({ error: signupCheck.error });
        }

        const acceptTerms =
            req.body.accept_terms === true ||
            req.body.accept_terms === 'true' ||
            req.body.accept_terms === 1 ||
            req.body.accept_terms === '1';
        if (!acceptTerms) {
            return res.status(400).json({
                error: 'You must read and accept the Returns Recovery Terms of Service to create an account.',
                terms_url: TERMS_URL,
                terms_version: CURRENT_TERMS_VERSION,
            });
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
        const accountStatus = defaultAccountStatusForSignup();
        const termsAcceptedAt = new Date().toISOString();

        db.run(
            `INSERT INTO users (email, password, full_name, company_name, referred_by, account_status, terms_accepted_at, terms_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                email,
                hashedPassword,
                full_name,
                company_name || '',
                referredById,
                accountStatus,
                termsAcceptedAt,
                CURRENT_TERMS_VERSION,
            ]
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

        try {
            const { ensurePayoutVerificationCode } = require('../utils/payoutVerificationCode');
            ensurePayoutVerificationCode(db, userId);
            saveDb();
        } catch (e) {
            console.error('Register: payout verification code', e.message || e);
        }

        if (referredById) {
            pushActivity(
                referredById,
                'referral',
                `Someone signed up with your referral link (${email})`,
                '/dashboard/referrals.html'
            );
        }

        if (accountStatus === 'pending') {
            return res.status(201).json({
                message:
                    'Your registration has been received and is waiting for ReturnPal approval. You can log in after an administrator approves your account.',
                approval_required: true,
                approval_pending: true,
                user: {
                    id: userId,
                    email,
                    full_name,
                    company_name: company_name || '',
                    account_status: 'pending',
                    terms_accepted_at: termsAcceptedAt,
                    terms_version: CURRENT_TERMS_VERSION,
                    terms_acceptance_required: false,
                },
            });
        }

        const user = { id: userId, email };
        const token = generateToken(user);

        logClientAuditForUser(db, userId, {
            category: 'view',
            action: 'client_register_login',
            path: '/register',
            detail: clientRequestMeta(req),
        });

        res.status(201).json({
            message: 'Account created successfully',
            token,
            user: enrichUserWithTerms(
                {
                    id: userId,
                    email,
                    full_name,
                    company_name: company_name || '',
                    avatar_url: '',
                    account_status: 'approved',
                    terms_accepted_at: termsAcceptedAt,
                    terms_version: CURRENT_TERMS_VERSION,
                },
                false
            ),
        });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Server error' });
    }
}
);

// POST /api/auth/login
router.post('/login', loginLimiter, [
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
            `SELECT id, email, password, full_name, company_name, avatar_url, is_admin,
                    COALESCE(legacy_client_id, '') AS legacy_client_id,
                    COALESCE(account_status, 'approved') AS account_status,
                    terms_accepted_at, terms_version
             FROM users WHERE email = ?`,
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

        const isAdmin = coerceIsAdmin(user.is_admin);
        const accountStatus = user.account_status || 'approved';
        if (!isAdmin && accountStatus === 'pending') {
            return res.status(403).json({ error: PENDING_MESSAGE, approval_pending: true });
        }
        if (!isAdmin && accountStatus === 'rejected') {
            return res.status(403).json({ error: REJECTED_MESSAGE, approval_rejected: true });
        }

        const token = generateToken({ id: user.id, email: user.email, is_admin: isAdmin });

        const uid = parseInt(user.id, 10);
        if (!isAdmin) {
            logClientAuditForUser(db, uid, {
                category: 'view',
                action: 'client_login',
                path: '/login',
                detail: clientRequestMeta(req),
            });
        }
        const { countLinkedClients } = require('../utils/clientDelegate');
        const linkedClientsCount = countLinkedClients(db, uid);
        const userOut = enrichUserWithTerms(
            {
                id: Number.isFinite(uid) && uid > 0 ? uid : user.id,
                email: user.email,
                full_name: user.full_name,
                company_name: user.company_name,
                avatar_url: user.avatar_url,
                legacy_client_id: user.legacy_client_id || '',
                is_admin: isAdmin,
                is_hub_account: linkedClientsCount > 0,
                linked_clients_count: linkedClientsCount,
                account_status: accountStatus,
                terms_accepted_at: user.terms_accepted_at,
                terms_version: user.terms_version,
            },
            isAdmin
        );
        res.json({
            message: 'Login successful',
            token,
            user: userOut,
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
            `SELECT id, email, full_name, company_name, phone, vat_registered, discord_webhook, avatar_url, is_admin,
                    legacy_client_id, created_at, COALESCE(account_status, 'approved') AS account_status,
                    COALESCE(client_preferences, '') AS client_preferences,
                    terms_accepted_at, terms_version
             FROM users WHERE id = ?`,
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

        user.is_admin = coerceIsAdmin(user.is_admin);

        const { parseClientPreferences, isPrepSendbackEnabled } = require('../utils/clientPreferences');
        const prefs = parseClientPreferences(user.client_preferences);
        user.prep_sendback_enabled = isPrepSendbackEnabled(prefs);
        delete user.client_preferences;

        const { countLinkedClients } = require('../utils/clientDelegate');
        const linkedClientsCount = countLinkedClients(db, user.id);
        user.is_hub_account = linkedClientsCount > 0;
        user.linked_clients_count = linkedClientsCount;

        enrichUserWithTerms(user, user.is_admin);

        res.json({ user });
    } catch (err) {
        console.error('Get profile error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/auth/accept-terms — record acceptance of current Terms of Service (clients)
router.post('/accept-terms', authMiddleware, async (req, res) => {
    try {
        if (coerceIsAdmin(req.user.is_admin)) {
            return res.json({ message: 'Terms acceptance is not required for admin accounts.' });
        }
        const acceptTerms =
            req.body.accept_terms === true ||
            req.body.accept_terms === 'true' ||
            req.body.accept_terms === 1 ||
            req.body.accept_terms === '1';
        if (!acceptTerms) {
            return res.status(400).json({
                error: 'You must confirm that you accept the Terms of Service.',
                terms_url: TERMS_URL,
                terms_version: CURRENT_TERMS_VERSION,
            });
        }

        const db = await getDb();
        recordTermsAcceptance(db, req.user.id);
        saveDb();

        const result = db.exec(
            `SELECT id, email, full_name, company_name, phone, vat_registered, discord_webhook, avatar_url, is_admin,
                    legacy_client_id, created_at, COALESCE(account_status, 'approved') AS account_status,
                    terms_accepted_at, terms_version
             FROM users WHERE id = ?`,
            [req.user.id]
        );
        const user = parseOneUserRow(result);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        user.is_admin = coerceIsAdmin(user.is_admin);
        const { countLinkedClients } = require('../utils/clientDelegate');
        const linkedClientsCount = countLinkedClients(db, user.id);
        user.is_hub_account = linkedClientsCount > 0;
        user.linked_clients_count = linkedClientsCount;
        enrichUserWithTerms(user, false);

        logClientAuditForUser(db, req.user.id, {
            category: 'view',
            action: 'client_accept_terms',
            path: '/terms',
            detail: { version: CURRENT_TERMS_VERSION, ...clientRequestMeta(req) },
        });
        saveDb();

        res.json({
            message: 'Terms of Service accepted.',
            user,
        });
    } catch (err) {
        console.error('Accept terms error:', err);
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
            logClientAudit(db, req, {
                category: 'update',
                action: 'avatar_upload',
                path: '/api/auth/avatar',
                detail: { filename: req.file.originalname },
            });
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
        logClientAudit(db, req, {
            category: 'delete',
            action: 'avatar_remove',
            path: '/api/auth/avatar',
        });
        res.json({ avatar_url: '', message: 'Photo removed' });
    } catch (e) {
        console.error('Avatar delete error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/auth/profile — merge: only fields present in the body overwrite stored values
router.put('/profile', authMiddleware, [
    body('full_name').optional().trim().isLength({ max: 200 }).withMessage('Full name too long'),
    body('company_name').optional().trim().isLength({ max: 200 }).withMessage('Company name too long'),
    body('phone').optional().trim().isLength({ max: 50 }).withMessage('Phone too long'),
    body('legacy_client_id').optional().trim().isLength({ max: 64 }).withMessage('Legacy client ID too long'),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }
        const db = await getDb();
        const cur = parseOneUserRow(
            db.exec(
                'SELECT full_name, company_name, phone, legacy_client_id FROM users WHERE id = ?',
                [req.user.id]
            )
        );
        if (!cur) {
            return res.status(404).json({ error: 'User not found' });
        }

        let full_name = cur.full_name != null ? String(cur.full_name) : '';
        if (req.body.full_name !== undefined) full_name = String(req.body.full_name).trim();

        let company_name = cur.company_name != null ? String(cur.company_name) : '';
        if (req.body.company_name !== undefined) company_name = String(req.body.company_name).trim();

        let phone = cur.phone != null ? String(cur.phone) : '';
        if (req.body.phone !== undefined) phone = String(req.body.phone).trim();

        let legacy_client_id = cur.legacy_client_id != null ? String(cur.legacy_client_id) : '';
        if (req.body.legacy_client_id !== undefined) {
            legacy_client_id = String(req.body.legacy_client_id).trim().slice(0, 64);
        }

        db.run(
            "UPDATE users SET full_name = ?, company_name = ?, phone = ?, legacy_client_id = ?, updated_at = datetime('now') WHERE id = ?",
            [full_name, company_name, phone, legacy_client_id, req.user.id]
        );
        saveDb();
        logClientAudit(db, req, {
            category: 'update',
            action: 'profile_update',
            path: '/api/auth/profile',
            detail: { full_name, company_name, phone: phone ? '[set]' : '' },
        });
        res.json({ message: 'Profile updated successfully' });
    } catch (err) {
        console.error('Update profile error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/auth/forgot-password — always returns same message (no email enumeration)
router.post(
    '/forgot-password',
    loginLimiter,
    [body('email').isEmail().normalizeEmail().withMessage('Valid email required')],
    async (req, res) => {
        const generic = {
            message:
                'If an account exists for that email, we have sent a password reset link. Check your inbox and spam folder.',
        };
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ error: 'Enter a valid email address.' });
            }

            const db = await getDb();
            const email = req.body.email;
            const result = db.exec(
                'SELECT id, email, full_name FROM users WHERE email = ?',
                [email]
            );
            if (!result.length || !result[0].values.length) {
                return res.json(generic);
            }

            const cols = result[0].columns;
            const row = result[0].values[0];
            const user = {};
            cols.forEach((col, i) => {
                user[col] = row[i];
            });

            const {
                createResetToken,
                sendPasswordResetEmail,
                ensurePasswordResetSchema,
            } = require('../utils/passwordReset');
            ensurePasswordResetSchema(db);
            const { token, ttlHours } = createResetToken(db, user.id);
            saveDb();
            await sendPasswordResetEmail(db, user, token, ttlHours);

            return res.json(generic);
        } catch (err) {
            console.error('Forgot password error:', err);
            return res.json(generic);
        }
    }
);

// POST /api/auth/reset-password — consume token and set new password
router.post(
    '/reset-password',
    loginLimiter,
    [
        body('token').trim().notEmpty().withMessage('Reset token is required'),
        body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ error: errors.array()[0].msg || 'Invalid request' });
            }

            const db = await getDb();
            const { applyPasswordReset } = require('../utils/passwordReset');
            await applyPasswordReset(db, req.body.token, req.body.password);
            res.json({ message: 'Password updated. You can log in with your new password.' });
        } catch (err) {
            if (err.code === 'invalid_token') {
                return res.status(400).json({ error: err.message });
            }
            console.error('Reset password error:', err);
            res.status(500).json({ error: 'Server error' });
        }
    }
);

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
        logClientAudit(db, req, {
            category: 'update',
            action: 'password_change',
            path: '/api/auth/password',
        });
        res.json({ message: 'Password updated successfully' });
    } catch (err) {
        console.error('Password change error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
