require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
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
app.use('/api/admin', require('./routes/admin'));
app.use('/api/reimbursement', require('./routes/reimbursement'));

// ─── Health Check ────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── SPA Fallback (serve index.html for non-API routes) ─────
app.get('/{*splat}', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'API endpoint not found' });
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
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

start();
