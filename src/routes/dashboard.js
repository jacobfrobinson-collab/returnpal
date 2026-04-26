const express = require('express');
const { getDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const ACTIVITY_ICONS = {
    package_received: 'ri-inbox-archive-line',
    package_delivered: 'ri-checkbox-circle-line',
    item_processed: 'ri-list-check',
    item_sold: 'ri-money-pound-circle-line',
    item_pending: 'ri-time-line',
    payout_sent: 'ri-bank-card-line',
    return_deducted: 'ri-refund-2-line',
    info: 'ri-circle-line'
};

function parseResults(result) {
    if (!result || result.length === 0) return [];
    const cols = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        cols.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

// GET /api/dashboard/stats
router.get('/stats', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const userId = req.user.id;

        const packagesInTransit = parseResults(
            db.exec("SELECT COUNT(*) as count FROM packages WHERE user_id = ? AND status = 'In Transit'", [userId])
        );

        const totalPackages = parseResults(
            db.exec('SELECT COUNT(*) as count FROM packages WHERE user_id = ?', [userId])
        );

        const totalReceived = parseResults(
            db.exec('SELECT COUNT(*) as count FROM received_items WHERE user_id = ?', [userId])
        );

        const totalSold = parseResults(
            db.exec('SELECT COUNT(*) as count FROM sold_items WHERE user_id = ?', [userId])
        );

        const totalPending = parseResults(
            db.exec('SELECT COUNT(*) as count FROM pending_items WHERE user_id = ?', [userId])
        );

        const totalEarnings = parseResults(
            db.exec('SELECT COALESCE(SUM(profit), 0) as total FROM sold_items WHERE user_id = ?', [userId])
        );

        const totalRecovered = parseResults(
            db.exec('SELECT COALESCE(SUM(total_revenue), 0) as total FROM sold_items WHERE user_id = ?', [userId])
        );

        const unpaidInvoices = parseResults(
            db.exec("SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM invoices WHERE user_id = ? AND status = 'Pending'", [userId])
        );

        res.json({
            packages_in_transit: packagesInTransit[0]?.count || 0,
            total_packages: totalPackages[0]?.count || 0,
            total_received: totalReceived[0]?.count || 0,
            total_sold: totalSold[0]?.count || 0,
            total_pending: totalPending[0]?.count || 0,
            total_earnings: totalEarnings[0]?.total || 0,
            total_recovered: totalRecovered[0]?.total || 0,
            unpaid_invoices_count: unpaidInvoices[0]?.count || 0,
            unpaid_invoices_total: unpaidInvoices[0]?.total || 0,
        });
    } catch (err) {
        console.error('Dashboard stats error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/dashboard/summary – overview with recent_activity, top_items, latest_payout
router.get('/summary', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const userId = req.user.id;

        const packagesInTransit = parseResults(
            db.exec("SELECT COUNT(*) as count FROM packages WHERE user_id = ? AND status = 'In Transit'", [userId])
        );
        const totalPackages = parseResults(db.exec('SELECT COUNT(*) as count FROM packages WHERE user_id = ?', [userId]));
        const totalReceived = parseResults(db.exec('SELECT COUNT(*) as count FROM received_items WHERE user_id = ?', [userId]));
        const totalSold = parseResults(db.exec('SELECT COUNT(*) as count FROM sold_items WHERE user_id = ?', [userId]));
        const totalRecovered = parseResults(db.exec('SELECT COALESCE(SUM(total_revenue), 0) as total FROM sold_items WHERE user_id = ?', [userId]));
        const totalPending = parseResults(db.exec('SELECT COUNT(*) as count FROM pending_items WHERE user_id = ?', [userId]));

        const activities = parseResults(
            db.exec(
                'SELECT type, message, link, created_at FROM activities WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
                [userId]
            )
        );
        const recent_activity = activities.map(a => ({
            message: a.message,
            timestamp: a.created_at,
            icon: ACTIVITY_ICONS[a.type] || ACTIVITY_ICONS.info,
            link: a.link || undefined
        }));

        const topItems = parseResults(
            db.exec(
                'SELECT id, product as name, total_revenue as value FROM sold_items WHERE user_id = ? ORDER BY total_revenue DESC LIMIT 5',
                [userId]
            )
        );
        const top_items = topItems.map(r => ({ id: r.id, name: r.name, value: r.value }));

        const latestPayout = parseResults(
            db.exec(
                "SELECT amount, status, date_issued as date FROM invoices WHERE user_id = ? AND status = 'Paid' ORDER BY date_issued DESC LIMIT 1",
                [userId]
            )
        );
        const latest_payout = latestPayout.length ? latestPayout[0] : null;

        const weekReceived = parseResults(
            db.exec(
                "SELECT COUNT(*) as c FROM received_items WHERE user_id = ? AND date_received >= datetime('now', '-7 days')",
                [userId]
            )
        );
        const weekSold = parseResults(
            db.exec(
                "SELECT COUNT(*) as c FROM sold_items WHERE user_id = ? AND sold_date >= date(datetime('now', '-7 days'))",
                [userId]
            )
        );
        const weekClaims = parseResults(
            db.exec(
                "SELECT COUNT(*) as c FROM reimbursement_claims WHERE user_id = ? AND created_at >= datetime('now', '-7 days')",
                [userId]
            )
        );
        const claimsEver = parseResults(
            db.exec('SELECT COUNT(*) as c FROM reimbursement_claims WHERE user_id = ?', [userId])
        );

        res.json({
            total_recovered: totalRecovered[0]?.total || 0,
            items_processing: totalPending[0]?.count || 0,
            items_sold: totalSold[0]?.count || 0,
            packages_sent: totalPackages[0]?.count || 0,
            recent_activity,
            top_items,
            latest_payout,
            week_received_count: weekReceived[0]?.c || 0,
            week_sold_count: weekSold[0]?.c || 0,
            week_claims_count: weekClaims[0]?.c || 0,
            reimbursement_claims_total: claimsEver[0]?.c || 0,
        });
    } catch (err) {
        console.error('Dashboard summary error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
