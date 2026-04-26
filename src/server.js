require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { getDb } = require('./database');

const UPLOAD_DIR = process.env.UPLOAD_DIR
    ? path.resolve(process.env.UPLOAD_DIR)
    : path.join(__dirname, '../uploads');

// Prevent silent crashes
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────
app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Privacy & Terms (before static so they always load) ─────
app.get('/privacy.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/privacy.html'));
});
app.get('/terms.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/terms.html'));
});
// Backward-compat redirect for stale dashboard links
app.get('/dashboard/login.html', (req, res) => {
    res.redirect(302, '/login.html');
});
app.get('/dashboard/reimbursement.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.sendFile(path.join(__dirname, '../public/dashboard/reimbursement.html'));
});
// Without .html, static may 404 and SPA fallback would serve marketing index.html (looks like "bounce to home")
app.get('/dashboard/reimbursement', (req, res) => {
    res.redirect(302, '/dashboard/reimbursement.html');
});
// Marketing site has no register.html; SPA fallback was serving index.html and dropping ?ref=
app.get('/register.html', (req, res) => {
    const ref = req.query.ref;
    const params = new URLSearchParams();
    if (ref != null && String(ref).trim() !== '') params.set('ref', String(ref).trim());
    params.set('openRegister', '1');
    res.redirect(302, '/login.html?' + params.toString());
});
// Ensure dashboard HTML is never replaced by SPA index (defensive)
app.get(/^\/dashboard\/[^/]+\.html$/, (req, res, next) => {
    if (req.path.includes('..')) return next();
    const rel = req.path.replace(/^\/+/, '');
    const full = path.resolve(path.join(__dirname, '../public', rel));
    const pub = path.resolve(path.join(__dirname, '../public'));
    if (!full.startsWith(pub + path.sep) && full !== pub) return next();
    if (!fs.existsSync(full)) return next();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.sendFile(full);
});

// Admin UI: /admin and /admin.html would otherwise miss static and hit SPA → marketing home
app.get('/admin.html', (req, res) => {
    res.redirect(302, '/admin/index.html');
});
app.get(['/admin', '/admin/'], (req, res) => {
    res.redirect(302, '/admin/index.html');
});
app.get(/^\/admin\/[^/]+\.html$/, (req, res, next) => {
    if (req.path.includes('..')) return next();
    const rel = req.path.replace(/^\/+/, '');
    const full = path.resolve(path.join(__dirname, '../public', rel));
    const pub = path.resolve(path.join(__dirname, '../public'));
    if (!full.startsWith(pub + path.sep) && full !== pub) return next();
    if (!fs.existsSync(full)) return next();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.sendFile(full);
});

// ─── Static Files (serve frontend) ──────────────────────────
// Serve the main frontend
app.use(express.static(path.join(__dirname, '../public')));
// Serve uploaded files
app.use('/uploads', express.static(UPLOAD_DIR));

// ─── API Routes ──────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/packages', require('./routes/packages'));
app.use('/api/received', require('./routes/received'));
app.use('/api/sold', require('./routes/sold'));
app.use('/api/pending', require('./routes/pending'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/contact', require('./routes/contact'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/activity', require('./routes/activity'));
app.use('/api/referrals', require('./routes/referrals'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/balance', require('./routes/balance'));
app.use('/api/queries', require('./routes/queries'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/reimbursement', require('./routes/reimbursement'));
// ─── Health Check ────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Old Wanted marketplace URLs → home (feature removed)
app.get(/^\/wanted(\/.*)?$/i, (req, res) => {
    res.redirect(302, '/');
});

// ─── SPA Fallback (serve index.html for non-API routes) ─────
app.get('/{*splat}', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'API endpoint not found' });
    }
    // Do not serve marketing SPA for admin paths (static missed → send to admin login)
    if (req.path.startsWith('/admin')) {
        return res.redirect(302, '/admin/login.html');
    }
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── Error Handler ───────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid JSON' });
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large (max 10MB)' });
    }
    res.status(500).json({ error: 'Internal server error' });
});

// ─── Start Server ────────────────────────────────────────────
async function start() {
    try {
        // Initialize database
        await getDb();
        console.log('Database initialized');

        app.listen(PORT, () => {
            console.log(`\n  ReturnPal Backend Server`);
            console.log(`  ────────────────────────`);
            console.log(`  Local:   http://localhost:${PORT}`);
            console.log(`  API:     http://localhost:${PORT}/api`);
            console.log(`  Health:  http://localhost:${PORT}/api/health\n`);
        });

        try {
            const { startWeeklyDigestScheduler } = require('./jobs/weeklyDigest');
            startWeeklyDigestScheduler();
        } catch (e) {
            console.warn('Weekly digest scheduler:', e && e.message);
        }
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

start();
