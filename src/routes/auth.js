const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { getDb, saveDb } = require('../database');
const { generateToken, authMiddleware } = require('../middleware/auth');

const router = express.Router();

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

        // Check if user exists
        const existing = db.exec('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0 && existing[0].values.length > 0) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        const hashedPassword = await bcrypt.hash(password, 12);

        db.run(
            'INSERT INTO users (email, password, full_name, company_name) VALUES (?, ?, ?, ?)',
            [email, hashedPassword, full_name, company_name || '']
        );
        saveDb();

        const result = db.exec('SELECT last_insert_rowid() as id');
        const userId = result[0].values[0][0];

        const user = { id: userId, email };
        const token = generateToken(user);

        res.status(201).json({
            message: 'Account created successfully',
            token,
            user: { id: userId, email, full_name, company_name: company_name || '' }
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

        res.json({
            message: 'Login successful',
            token,
            user: {
                id: user.id,
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

        res.json({ user });
    } catch (err) {
        console.error('Get profile error:', err);
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
