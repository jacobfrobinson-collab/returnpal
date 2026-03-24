const express = require('express');
const { getDb, saveDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { feesDeductedForCalendarMonth } = require('../utils/monthlyFreeProcessing');

const router = express.Router();

function parseResults(result) {
    if (!result || result.length === 0) return [];
    const cols = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        cols.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

// GET /api/invoices
router.get('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const invoices = parseResults(
            db.exec('SELECT * FROM invoices WHERE user_id = ? ORDER BY date_issued DESC', [req.user.id])
        );

        res.json({ invoices, total: invoices.length });
    } catch (err) {
        console.error('Get invoices error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/invoices/period/:period (e.g. 2026-02) – line items for invoice download by month
router.get('/period/:period', authMiddleware, async (req, res) => {
    try {
        const [y, m] = (req.params.period || '').split('-').map(Number);
        if (!y || !m || m < 1 || m > 12) {
            return res.status(400).json({ error: 'Invalid period; use YYYY-MM' });
        }
        const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
        const monthEnd = new Date(y, m, 0);
        const monthEndStr = monthEnd.getFullYear() + '-' + String(monthEnd.getMonth() + 1).padStart(2, '0') + '-' + String(monthEnd.getDate()).padStart(2, '0');

        const db = await getDb();
        const periodYm = y + '-' + String(m).padStart(2, '0');

        const items = parseResults(
            db.exec(
                `SELECT id, product as description, quantity, unit_price, total_revenue, profit, status, sold_date, reference
                 FROM sold_items 
                 WHERE user_id = ? AND date(sold_date) >= date(?) AND date(sold_date) <= date(?) 
                 ORDER BY sold_date`,
                [req.user.id, monthStart, monthEndStr]
            )
        );

        const allSold = parseResults(db.exec('SELECT * FROM sold_items WHERE user_id = ?', [req.user.id]));
        const fees = feesDeductedForCalendarMonth(allSold, periodYm);

        const returnRows = parseResults(
            db.exec(
                `SELECT id, product, reference, amount, status, notes, created_at, linked_sold_item_id
                 FROM return_adjustments 
                 WHERE user_id = ? AND strftime('%Y-%m', created_at) = ?
                 ORDER BY created_at`,
                [req.user.id, periodYm]
            )
        );

        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const line_items = items.map(i => {
            const qty = Number(i.quantity) || 1;
            const profitPerUnit = (Number(i.profit) || 0) / qty;
            return {
                description: i.description,
                quantity: qty,
                unit_price: Number(i.unit_price) || 0,
                amount: profitPerUnit,
                status: i.status || 'Completed',
                sold_item_id: i.id,
                reference: i.reference || ''
            };
        });

        const statement_lines = [];
        items.forEach((i) => {
            const qty = Number(i.quantity) || 1;
            const lineProfit = Number(i.profit) || 0;
            const isRefunded = i.status === 'Refunded';
            statement_lines.push({
                kind: isRefunded ? 'return' : 'sale',
                label: (i.description || 'Item') + (isRefunded ? ' → Returned (refund)' : ' → Sold'),
                reference: i.reference || '',
                amount: isRefunded ? -Math.abs(lineProfit) : lineProfit,
                date: i.sold_date
            });
        });
        returnRows.forEach((r) => {
            const amt = Number(r.amount) || 0;
            statement_lines.push({
                kind: 'return_adjustment',
                label: (r.product || 'Item') + ' → Return / clawback' + (r.status === 'pending' ? ' (pending)' : ''),
                reference: r.reference || '',
                amount: -Math.abs(amt),
                date: r.created_at,
                status: r.status
            });
        });
        statement_lines.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

        const salesProfit = items
            .filter((i) => i.status !== 'Refunded')
            .reduce((s, i) => s + (Number(i.profit) || 0), 0);
        const refundedProfit = items
            .filter((i) => i.status === 'Refunded')
            .reduce((s, i) => s + (Number(i.profit) || 0), 0);
        const adjustmentsApplied = returnRows
            .filter((r) => r.status === 'applied')
            .reduce((s, r) => s + (Number(r.amount) || 0), 0);
        const subtotal = line_items.reduce((s, i) => s + (i.amount * i.quantity), 0);
        const net_after_returns = Math.round((salesProfit - refundedProfit - adjustmentsApplied) * 100) / 100;
        const total = Math.round((net_after_returns - fees) * 100) / 100;
        const vat_amount = 0;

        res.json({
            period: req.params.period,
            period_label: monthNames[m - 1] + ' ' + y,
            date_issued: monthStart,
            line_items,
            statement_lines,
            summary: {
                sales_profit: Math.round(salesProfit * 100) / 100,
                refunds_and_returns: Math.round((refundedProfit + adjustmentsApplied) * 100) / 100,
                fees_deducted: fees,
                net_payout_estimate: total
            },
            return_lines: returnRows,
            subtotal,
            fees,
            vat_amount,
            total,
            status: 'Paid'
        });
    } catch (err) {
        console.error('Get invoice by period error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/invoices/:id
router.get('/:id', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const invoices = parseResults(
            db.exec('SELECT * FROM invoices WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
        );

        if (invoices.length === 0) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

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

        // Auto-generate invoice number if not provided
        const invNumber = invoice_number || `INV-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;

        db.run(
            `INSERT INTO invoices (user_id, invoice_number, customer_name, due_date, amount, items_count, status)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [targetUserId, invNumber, customer_name, due_date || '',
             amount || 0, items_count || 0, status || 'Pending']
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
