const express = require('express');
const { getDb, saveDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const {
    getComputedMonthlyStatements,
    buildInvoicePeriodPayload,
    parsePeriodYm,
    maxInvoicablePeriodYm
} = require('../utils/computedMonthlyStatements');

const router = express.Router();

function parseResults(result) {
    if (!result || !result.length) return [];
    const cols = result[0].columns;
    return result[0].values.map((row) => {
        const obj = {};
        cols.forEach((col, i) => {
            obj[col] = row[i];
        });
        return obj;
    });
}

// GET /api/invoices — computed monthly statements from sold_date (backdated sales appear in correct month)
router.get('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const body = getComputedMonthlyStatements(db, req.user.id);
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.json(body);
    } catch (err) {
        console.error('Get invoices error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/invoices/period/:period (e.g. 2026-02) – line items for invoice download by month
router.get('/period/:period', authMiddleware, async (req, res) => {
    try {
        const p = parsePeriodYm(req.params.period);
        if (!p) {
            return res.status(400).json({ error: 'Invalid period; use YYYY-MM' });
        }
        const capYm = maxInvoicablePeriodYm();
        if (p.periodYm > capYm) {
            return res.status(400).json({
                error: 'That statement period is in the future or is the current calendar month. Monthly statements only include completed months through the previous calendar month.'
            });
        }
        const db = await getDb();
        const payload = buildInvoicePeriodPayload(db, req.user.id, p);
        const { _items_count, ...rest } = payload;
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.json(rest);
    } catch (err) {
        console.error('Get invoice by period error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/invoices/:id — legacy rows in invoices table (manual / historical)
router.get('/:id', authMiddleware, async (req, res) => {
    try {
        if (req.params.id === 'period' || String(req.params.id).startsWith('period')) {
            return res.status(404).json({ error: 'Not found' });
        }
        const db = await getDb();
        const invoices = parseResults(
            db.exec('SELECT * FROM invoices WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
        );

        if (invoices.length === 0) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.json({ invoice: invoices[0] });
    } catch (err) {
        console.error('Get invoice error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/invoices
router.post('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const { invoice_number, customer_name, due_date, amount, items_count, status, user_id } = req.body;

        const targetUserId = user_id || req.user.id;

        const invNumber = invoice_number || `INV-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;

        db.run(
            `INSERT INTO invoices (user_id, invoice_number, customer_name, due_date, amount, items_count, status)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [targetUserId, invNumber, customer_name, due_date || '', amount || 0, items_count || 0, status || 'Pending']
        );
        saveDb();

        const result = db.exec('SELECT last_insert_rowid() as id');
        const id = result[0].values[0][0];

        res.status(201).json({ message: 'Invoice created', id, invoice_number: invNumber });
    } catch (err) {
        console.error('Create invoice error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/invoices/:id/status
router.put('/:id/status', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const { status } = req.body;

        const existing = parseResults(
            db.exec('SELECT id FROM invoices WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
        );
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

        db.run('UPDATE invoices SET status = ? WHERE id = ?', [status, req.params.id]);
        saveDb();

        res.json({ message: 'Invoice status updated' });
    } catch (err) {
        console.error('Update invoice status error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
