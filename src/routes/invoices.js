const express = require('express');
const { getDb, saveDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { feesDeductedForCalendarMonth } = require('../utils/monthlyFreeProcessing');

const router = express.Router();

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function parseResults(result) {
    if (!result || result.length === 0) return [];
    const cols = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        cols.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

/** @param {string} periodYm "YYYY-MM" */
function parsePeriodYm(periodYm) {
    const parts = String(periodYm || '').split('-').map(Number);
    const y = parts[0];
    const m = parts[1];
    if (!y || !m || m < 1 || m > 12) return null;
    const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
    const monthEnd = new Date(y, m, 0);
    const monthEndStr =
        monthEnd.getFullYear() +
        '-' +
        String(monthEnd.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(monthEnd.getDate()).padStart(2, '0');
    return { y, m, monthStart, monthEndStr, periodYm: `${y}-${String(m).padStart(2, '0')}` };
}

/** Last day of the payout window for activity in calendar month m (1–12), year y — matches client dashboard. */
function payoutEndDate(y, m) {
    return new Date(y, m + 1, 0);
}

function payoutEndDateStr(y, m) {
    const d = payoutEndDate(y, m);
    return (
        d.getFullYear() +
        '-' +
        String(d.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(d.getDate()).padStart(2, '0')
    );
}

/**
 * Full invoice payload for one calendar month (sales by sold_date; returns by linked sale month or created_at).
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {{ y: number, m: number, monthStart: string, monthEndStr: string, periodYm: string }} p
 * @param {object[]|null} [allSoldCache] - all sold_items for user (reuses fees calc)
 */
function buildInvoicePeriodPayload(db, userId, p, allSoldCache = null) {
    const { y, m, monthStart, monthEndStr, periodYm } = p;

    const items = parseResults(
        db.exec(
            `SELECT id, product as description, quantity, unit_price, total_revenue, profit, status, sold_date, reference
             FROM sold_items
             WHERE user_id = ? AND date(sold_date) >= date(?) AND date(sold_date) <= date(?)
             ORDER BY sold_date`,
            [userId, monthStart, monthEndStr]
        )
    );

    const allSold =
        allSoldCache != null
            ? allSoldCache
            : parseResults(db.exec('SELECT * FROM sold_items WHERE user_id = ?', [userId]));
    const fees = feesDeductedForCalendarMonth(allSold, periodYm);

    const returnRows = parseResults(
        db.exec(
            `SELECT r.id, r.product, r.reference, r.amount, r.status, r.notes, r.created_at, r.linked_sold_item_id
             FROM return_adjustments r
             WHERE r.user_id = ?
               AND r.status = 'applied'
               AND (
                 (r.linked_sold_item_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM sold_items s
                    WHERE s.id = r.linked_sold_item_id AND s.user_id = r.user_id
                      AND date(s.sold_date) >= date(?) AND date(s.sold_date) <= date(?)
                 ))
                 OR (r.linked_sold_item_id IS NULL AND date(r.created_at) >= date(?) AND date(r.created_at) <= date(?))
               )
             ORDER BY r.created_at`,
            [userId, monthStart, monthEndStr, monthStart, monthEndStr]
        )
    );

    const line_items = items.map((i) => {
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

    const salesProfit = items.filter((i) => i.status !== 'Refunded').reduce((s, i) => s + (Number(i.profit) || 0), 0);
    const refundedProfit = items.filter((i) => i.status === 'Refunded').reduce((s, i) => s + (Number(i.profit) || 0), 0);
    const adjustmentsApplied = returnRows.filter((r) => r.status === 'applied').reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const subtotal = line_items.reduce((s, i) => s + (i.amount * i.quantity), 0);
    const net_after_returns = Math.round((salesProfit - refundedProfit - adjustmentsApplied) * 100) / 100;
    const total = Math.round((net_after_returns - fees) * 100) / 100;
    const vat_amount = 0;

    return {
        period: periodYm,
        period_label: MONTH_NAMES[m - 1] + ' ' + y,
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
        status: 'Paid',
        _items_count: items.length
    };
}

/** Distinct YYYY-MM values that have invoice-relevant activity (sales or applied returns). */
function listDistinctInvoiceMonths(db, userId) {
    const rows = parseResults(
        db.exec(
            `SELECT ym FROM (
                SELECT DISTINCT strftime('%Y-%m', sold_date) AS ym
                FROM sold_items
                WHERE user_id = ?
                  AND sold_date IS NOT NULL
                  AND length(trim(sold_date)) > 0
                  AND strftime('%Y-%m', sold_date) IS NOT NULL
                UNION
                SELECT DISTINCT strftime('%Y-%m', s.sold_date) AS ym
                FROM return_adjustments r
                JOIN sold_items s ON s.id = r.linked_sold_item_id AND s.user_id = r.user_id
                WHERE r.user_id = ? AND r.status = 'applied' AND r.linked_sold_item_id IS NOT NULL
                  AND s.sold_date IS NOT NULL AND length(trim(s.sold_date)) > 0
                UNION
                SELECT DISTINCT strftime('%Y-%m', r.created_at) AS ym
                FROM return_adjustments r
                WHERE r.user_id = ? AND r.status = 'applied' AND r.linked_sold_item_id IS NULL
            )
            WHERE ym IS NOT NULL AND length(ym) = 7
            ORDER BY ym DESC`,
            [userId, userId, userId]
        )
    );
    return rows.map((r) => r.ym).filter(Boolean);
}

// GET /api/invoices — computed monthly statements from sold_date (backdated sales appear in correct month)
router.get('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const userId = req.user.id;
        const allSold = parseResults(db.exec('SELECT * FROM sold_items WHERE user_id = ?', [userId]));
        const urow = parseResults(db.exec('SELECT full_name, company_name FROM users WHERE id = ?', [userId]));
        const customerName = (urow[0] && (urow[0].full_name || urow[0].company_name)) || 'Client';

        const months = listDistinctInvoiceMonths(db, userId);
        const maxMonths = 60;
        const slice = months.slice(0, maxMonths);

        const today = new Date();
        today.setHours(23, 59, 59, 999);

        const invoices = slice.map((ym) => {
            const p = parsePeriodYm(ym);
            if (!p) return null;
            const detail = buildInvoicePeriodPayload(db, userId, p, allSold);
            const payoutEnd = payoutEndDate(p.y, p.m);
            const status = today > payoutEnd ? 'Paid' : 'Pending';
            const dueStr = payoutEndDateStr(p.y, p.m);
            return {
                id: null,
                user_id: userId,
                invoice_number: `RP-${ym}`,
                customer_name: customerName,
                date_issued: p.monthStart,
                due_date: dueStr,
                amount: detail.total,
                items_count: detail._items_count,
                status,
                pdf_path: '',
                vat_amount: detail.vat_amount,
                period: ym,
                period_label: detail.period_label,
                net_payout_estimate: detail.summary.net_payout_estimate,
                source: 'computed'
            };
        }).filter(Boolean);

        res.json({ invoices, total: invoices.length, source: 'computed' });
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
        const db = await getDb();
        const payload = buildInvoicePeriodPayload(db, req.user.id, p);
        const payoutEnd = payoutEndDate(p.y, p.m);
        const today = new Date();
        today.setHours(23, 59, 59, 999);
        const invoiceStatus = today > payoutEnd ? 'Paid' : 'Pending';

        const { _items_count, ...rest } = payload;
        res.json({ ...rest, status: invoiceStatus });
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
