const express = require('express');
const { getDb, saveDb, pushActivity } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { getPayoutForecast } = require('../utils/payoutForecast');
const { getComputedMonthlyStatements, buildInvoicePeriodPayload, parsePeriodYm } = require('../utils/computedMonthlyStatements');
const { getRecoveryScorecard } = require('../utils/recoveryScorecard');
const { buildPackageJourney } = require('../utils/packageJourney');
const { parseClientPreferences, isPrepSendbackEnabled } = require('../utils/clientPreferences');
const { clientIsAdmin, redactOrderNumberForClientRow } = require('../utils/internalFields');
const {
    isDateSentEligible,
    earliestEligibleDateSentYmd,
    mapEnquiryRow,
} = require('../utils/lostItemEnquiry');
const { getClientActionItems } = require('../utils/clientActionItems');
const { getClientBenchmarks } = require('../utils/clientBenchmarks');
const { setClientPayoutNote } = require('../utils/payoutEvents');
const { ensurePayoutVerificationCode } = require('../utils/payoutVerificationCode');

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
        if (!detail) {
            return res.status(409).json({
                error:
                    'Statement period could not be built: sold dates are inconsistent for this month. Contact support.',
            });
        }
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

// GET /api/client/scorecard?period=YYYY-MM
router.get('/scorecard', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const period = String(req.query.period || '').trim() || undefined;
        res.json(getRecoveryScorecard(db, req.user.id, period));
    } catch (err) {
        console.error('Scorecard error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/client/package-journey?package_id= or reference=
router.get('/package-journey', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const uid = req.user.id;
        const packageId = parseInt(req.query.package_id, 10);
        const ref = String(req.query.reference || '').trim();
        let pkg = null;
        if (Number.isFinite(packageId)) {
            const rows = parseResults(
                db.exec('SELECT id, reference FROM packages WHERE id = ? AND user_id = ?', [packageId, uid])
            );
            pkg = rows[0] || null;
        } else if (ref) {
            const rows = parseResults(
                db.exec('SELECT id, reference FROM packages WHERE user_id = ? AND reference = ? LIMIT 1', [uid, ref])
            );
            pkg = rows[0] || null;
        } else {
            return res.status(400).json({ error: 'Provide package_id or reference' });
        }
        if (!pkg) return res.status(404).json({ error: 'Package not found' });
        res.json(buildPackageJourney(db, uid, pkg.id, pkg.reference));
    } catch (err) {
        console.error('Package journey error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/client/prep-sendback
router.get('/prep-sendback', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const rows = parseResults(
            db.exec(
                `SELECT * FROM prep_sendback_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
                [req.user.id]
            )
        );
        const prefsRow = parseResults(
            db.exec('SELECT client_preferences FROM users WHERE id = ?', [req.user.id])
        );
        const prefs = parseClientPreferences(prefsRow[0]?.client_preferences);
        res.json({
            enabled: isPrepSendbackEnabled(prefs),
            requests: rows,
            prep_address: prefs,
        });
    } catch (err) {
        console.error('Prep sendback list error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/client/prep-sendback
router.post('/prep-sendback', authMiddleware, async (req, res) => {
    try {
        const packageReference = String(req.body.package_reference || '').trim();
        const itemDescription = String(req.body.item_description || '').trim();
        const quantity = Math.max(1, parseInt(req.body.quantity, 10) || 1);
        const notes = String(req.body.notes || '').trim();
        if (!packageReference || !itemDescription) {
            return res.status(400).json({ error: 'Package reference and item description are required.' });
        }
        const db = await getDb();
        const prefsRow = parseResults(
            db.exec('SELECT client_preferences FROM users WHERE id = ?', [req.user.id])
        );
        const prefs = parseClientPreferences(prefsRow[0]?.client_preferences);
        if (!isPrepSendbackEnabled(prefs)) {
            return res.status(403).json({
                error: 'Prep send-back is not enabled for your account. Contact ReturnPal if you need this service.',
            });
        }
        if (!prefs.prep_name && !prefs.prep_address) {
            return res.status(400).json({
                error: 'Add your prep centre details in Settings before requesting a send-back.',
            });
        }
        db.run(
            `INSERT INTO prep_sendback_requests (user_id, package_reference, item_description, quantity, notes, status)
             VALUES (?, ?, ?, ?, ?, 'requested')`,
            [req.user.id, packageReference, itemDescription, quantity, notes]
        );
        saveDb();
        const id = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
        await pushActivity(
            req.user.id,
            'info',
            `Prep send-back requested: ${itemDescription} (${packageReference}, qty ${quantity}).`,
            '/dashboard/prep-sendback.html'
        );
        res.status(201).json({ id, message: 'Send-back request submitted. ReturnPal will queue shipment to your prep centre.' });
    } catch (err) {
        console.error('Prep sendback create error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/client/lost-items — missing / lost item enquiries
router.get('/lost-items', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const rows = parseResults(
            db.exec(
                `SELECT id, item_name, quantity, tracking_number, package_reference, notes, date_sent,
                        status, admin_outcome, admin_notes, linked_sold_item_id, created_at, updated_at, resolved_at
                 FROM lost_item_enquiries WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`,
                [req.user.id]
            )
        );
        res.json({
            enquiries: rows.map(mapEnquiryRow),
            earliest_eligible_date_sent: earliestEligibleDateSentYmd(),
        });
    } catch (err) {
        console.error('Lost items list error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/client/lost-items — submit missing / lost item enquiry
router.post('/lost-items', authMiddleware, async (req, res) => {
    try {
        const itemName = String(req.body.item_name || '').trim();
        const quantity = Math.max(1, parseInt(req.body.quantity, 10) || 1);
        const trackingNumber = String(req.body.tracking_number || '').trim().slice(0, 200);
        const packageReference = String(req.body.package_reference || '').trim().slice(0, 200);
        const notes = String(req.body.notes || '').trim().slice(0, 4000);
        const dateSentRaw = req.body.date_sent;

        if (!itemName) {
            return res.status(400).json({ error: 'Item name is required.' });
        }
        const eligibility = isDateSentEligible(dateSentRaw);
        if (!eligibility.ok) {
            return res.status(400).json({
                error: eligibility.error,
                earliest_eligible_date_sent: eligibility.earliest_eligible,
            });
        }

        const db = await getDb();
        db.run(
            `INSERT INTO lost_item_enquiries
             (user_id, item_name, quantity, tracking_number, package_reference, notes, date_sent, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [
                req.user.id,
                itemName,
                quantity,
                trackingNumber,
                packageReference,
                notes,
                eligibility.date_sent,
            ]
        );
        saveDb();
        const id = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];

        await pushActivity(
            req.user.id,
            'info',
            `Missing item enquiry submitted: ${itemName} (sent ${eligibility.date_sent}).`,
            '/dashboard/lost-items.html'
        );

        try {
            const { notifyAdminLostItemEnquiry } = require('../utils/adminQueryNotification');
            await notifyAdminLostItemEnquiry(db, {
                enquiryId: id,
                userId: req.user.id,
                itemName,
                quantity,
                trackingNumber,
                packageReference,
                notes,
                dateSent: eligibility.date_sent,
            });
        } catch (e) {
            console.error('[admin-lost-item-notify]', e.message || e);
        }

        res.status(201).json({
            id,
            message:
                'Enquiry submitted. ReturnPal will review whether we received, still hold, or sold this stock. You can only enquire about items sent at least 2 months ago.',
        });
    } catch (err) {
        console.error('Lost items create error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/client/payout-bank-details — verification code + Jotform link (auth only)
router.get('/payout-bank-details', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const info = ensurePayoutVerificationCode(db, req.user.id);
        if (!info) return res.status(404).json({ error: 'User not found' });
        saveDb();
        res.json(info);
    } catch (err) {
        console.error('Payout bank details error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/client/attention-items
router.get('/attention-items', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const items = getClientActionItems(db, req.user.id);
        res.json({ items });
    } catch (err) {
        console.error('Attention items error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/client/benchmarks?period=YYYY-MM
router.get('/benchmarks', authMiddleware, async (req, res) => {
    try {
        const period = String(req.query.period || '').trim();
        const db = await getDb();
        res.json(getClientBenchmarks(db, req.user.id, period || undefined));
    } catch (err) {
        console.error('Benchmarks error:', err);
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
