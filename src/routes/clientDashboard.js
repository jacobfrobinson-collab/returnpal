const express = require('express');
const { getDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { getPayoutForecast } = require('../utils/payoutForecast');
const { getComputedMonthlyStatements, buildInvoicePeriodPayload, parsePeriodYm } = require('../utils/computedMonthlyStatements');
const { clientIsAdmin, redactOrderNumberForClientRow } = require('../utils/internalFields');

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

// GET /api/client/payout-forecast
router.get('/payout-forecast', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        res.json(getPayoutForecast(db, req.user.id));
    } catch (err) {
        console.error('Payout forecast error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/client/snapshot?period=YYYY-MM
router.get('/snapshot', authMiddleware, async (req, res) => {
    try {
        const period = String(req.query.period || '').trim();
        const p = parsePeriodYm(period);
        if (!p) return res.status(400).json({ error: 'Use period=YYYY-MM' });
        const db = await getDb();
        const detail = buildInvoicePeriodPayload(db, req.user.id, p);
        const soldCount = parseResults(
            db.exec(
                `SELECT COUNT(*) AS c FROM sold_items WHERE user_id = ? AND sold_date >= ? AND sold_date <= ?`,
                [req.user.id, p.monthStart, p.monthEndStr]
            )
        );
        const urow = parseResults(
            db.exec('SELECT full_name, company_name, vat_registered FROM users WHERE id = ?', [req.user.id])
        );
        const user = urow[0] || {};
        res.json({
            period: p.periodYm,
            period_label: detail.period_label,
            client_name: user.full_name || user.company_name || 'Client',
            vat_registered: !!user.vat_registered,
            items_sold: soldCount[0]?.c || detail._items_count,
            sales_profit: detail.summary.sales_profit,
            refunds_and_returns: detail.summary.refunds_and_returns,
            payout_amount: detail.total,
            due_date: detail.due_date,
            status: detail.status,
        });
    } catch (err) {
        console.error('Snapshot error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/client/search?q=
router.get('/search', authMiddleware, async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) return res.json({ results: [] });
        const db = await getDb();
        const uid = req.user.id;
        const like = '%' + q.replace(/%/g, '\\%').replace(/_/g, '\\_') + '%';
        const limit = 8;

        const packages = parseResults(
            db.exec(
                `SELECT id, reference, status, date_added FROM packages
                 WHERE user_id = ? AND (reference LIKE ? OR order_number LIKE ? OR notes LIKE ?)
                 ORDER BY id DESC LIMIT ?`,
                [uid, like, like, like, limit]
            )
        );
        const sold = parseResults(
            db.exec(
                `SELECT id, product, reference, sold_date, profit, order_number FROM sold_items
                 WHERE user_id = ? AND (product LIKE ? OR reference LIKE ? OR order_number LIKE ?)
                 ORDER BY id DESC LIMIT ?`,
                [uid, like, like, like, limit]
            )
        );
        const received = parseResults(
            db.exec(
                `SELECT id, description, reference, status, date_received FROM received_items
                 WHERE user_id = ? AND (description LIKE ? OR reference LIKE ? OR order_number LIKE ?)
                 ORDER BY id DESC LIMIT ?`,
                [uid, like, like, like, limit]
            )
        );
        const pending = parseResults(
            db.exec(
                `SELECT id, product, reference, current_stage, order_number FROM pending_items
                 WHERE user_id = ? AND (product LIKE ? OR reference LIKE ? OR order_number LIKE ? OR notes LIKE ?)
                 ORDER BY id DESC LIMIT ?`,
                [uid, like, like, like, like, limit]
            )
        );

        const soldOut = clientIsAdmin(req) ? sold : sold.map((r) => redactOrderNumberForClientRow(r));
        const pendingOut = clientIsAdmin(req) ? pending : pending.map((r) => redactOrderNumberForClientRow(r));

        const results = [];
        packages.forEach((r) => {
            results.push({
                type: 'package',
                id: r.id,
                title: r.reference,
                subtitle: r.status,
                href: '/dashboard/package-detail.html?id=' + r.id,
            });
        });
        soldOut.forEach((r) => {
            results.push({
                type: 'sold',
                id: r.id,
                title: String(r.product || '').slice(0, 80),
                subtitle: (r.sold_date || '') + (r.profit != null ? ' · £' + Number(r.profit).toFixed(2) : ''),
                href: '/dashboard/sold-items.html',
            });
        });
        received.forEach((r) => {
            results.push({
                type: 'received',
                id: r.id,
                title: String(r.description || r.reference || '').slice(0, 80),
                subtitle: r.status,
                href: '/dashboard/received.html',
            });
        });
        pendingOut.forEach((r) => {
            results.push({
                type: 'pending',
                id: r.id,
                title: String(r.product || r.reference || '').slice(0, 80),
                subtitle: r.current_stage || 'Pending',
                href: '/dashboard/item-pending.html',
            });
        });

        res.json({ query: q, results: results.slice(0, 24) });
    } catch (err) {
        console.error('Search error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/client/exports-hub — metadata for exports hub page
router.get('/exports-hub', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const { invoices, statement_period_cap_ym } = getComputedMonthlyStatements(db, req.user.id);
        res.json({
            statement_period_cap_ym,
            periods: invoices.map((i) => ({
                period: i.period,
                amount: i.amount,
                status: i.status,
                due_date: i.due_date,
            })),
        });
    } catch (err) {
        console.error('Exports hub error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
