const express = require('express');
const { getDb, saveDb, pushActivity } = require('../database');
const { authMiddleware } = require('../middleware/auth');

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

function lookupPackageByRef(db, userId, reference) {
    const ref = String(reference || '').trim();
    if (!ref) return null;
    const rows = parseResults(
        db.exec('SELECT id, reference, status, notes, date_added FROM packages WHERE user_id = ? AND reference = ? LIMIT 1', [userId, ref])
    );
    return rows[0] || null;
}

function packageProductUnits(db, packageId) {
    if (!packageId) return 0;
    const sums = parseResults(
        db.exec('SELECT COALESCE(SUM(quantity), 0) as s FROM package_products WHERE package_id = ?', [packageId])
    );
    return Number(sums[0]?.s) || 0;
}

/**
 * Group flat received_items by parcel reference. Total units prefer declared package_products
 * totals; progress uses per-line status and quantities.
 */
function buildPackages(db, userId, items) {
    const byRef = new Map();
    for (const row of items) {
        const ref = String(row.reference || '').trim();
        const key = ref || `__id_${row.id}`;
        if (!byRef.has(key)) byRef.set(key, []);
        byRef.get(key).push(row);
    }
    const out = [];
    for (const [, rows] of byRef) {
        const ref = String(rows[0].reference || '').trim();
        const pkg = ref ? lookupPackageByRef(db, userId, ref) : null;
        const productUnits = pkg ? packageProductUnits(db, pkg.id) : 0;
        const receivedSum = rows.reduce((a, r) => a + (Number(r.quantity) || 0), 0);
        let totalUnits = Math.max(productUnits, receivedSum);
        if (totalUnits < 1) totalUnits = 1;

        const processedUnits = rows
            .filter(r => r.status === 'Processed')
            .reduce((a, r) => a + (Number(r.quantity) || 0), 0);
        const rejectedUnits = rows
            .filter(r => r.status === 'Rejected')
            .reduce((a, r) => a + (Number(r.quantity) || 0), 0);
        const pendingUnits = Math.max(0, totalUnits - processedUnits - rejectedUnits);

        const dates = rows.map(r => new Date(r.date_received || 0).getTime());
        const maxTs = dates.length ? Math.max.apply(null, dates) : 0;
        const dateReceived = maxTs ? new Date(maxTs).toISOString() : rows[0].date_received;

        const deliveryStatus = pkg ? pkg.status : 'Received';

        const notesAgg = [...new Set(rows.map(r => (r.notes || '').trim()).filter(Boolean))].join(' · ') || '';

        out.push({
            reference: ref || '(no reference)',
            package_id: pkg ? pkg.id : null,
            delivery_status: deliveryStatus,
            date_received: dateReceived,
            total_units: totalUnits,
            processed_units: processedUnits,
            pending_units: pendingUnits,
            rejected_units: rejectedUnits,
            notes: notesAgg,
            items: rows.map(r => ({
                id: r.id,
                items_description: r.items_description,
                quantity: r.quantity,
                status: r.status,
                sku: r.sku || '',
                notes: r.notes || '',
                date_received: r.date_received
            }))
        });
    }
    out.sort((a, b) => new Date(b.date_received || 0) - new Date(a.date_received || 0));
    return out;
}

// GET /api/received
router.get('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const items = parseResults(
            db.exec('SELECT * FROM received_items WHERE user_id = ? ORDER BY date_received DESC', [req.user.id])
        );
        const packages = buildPackages(db, req.user.id, items);
        res.json({
            items,
            packages,
            total: packages.length,
            items_total: items.length
        });
    } catch (err) {
        console.error('Get received error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

const RECEIVED_STATUSES = ['Processing', 'Processed', 'Quality Check', 'Rejected'];

// GET /api/received/:id – single item (for item detail page)
router.get('/:id', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const items = parseResults(
            db.exec('SELECT * FROM received_items WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
        );
        if (items.length === 0) {
            return res.status(404).json({ error: 'Item not found' });
        }
        res.json({ item: items[0] });
    } catch (err) {
        console.error('Get received item error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/received (admin can pass user_id to record on behalf of client)
router.post('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const { reference, items_description, quantity, notes, user_id } = req.body;

        const ref = (reference != null ? String(reference).trim() : '');
        const desc = (items_description != null ? String(items_description).trim() : '');
        if (!ref || !desc) {
            return res.status(400).json({ error: 'Reference and items description are required' });
        }

        let targetUserId = user_id != null ? parseInt(user_id, 10) : req.user.id;
        if (targetUserId !== req.user.id && !req.user.is_admin) {
            return res.status(403).json({ error: 'Only admins can record received items for another user' });
        }
        if (isNaN(targetUserId)) targetUserId = req.user.id;

        const qty = Math.max(1, parseInt(quantity, 10) || 1);

        const pkgMatch = parseResults(
            db.exec('SELECT id FROM packages WHERE user_id = ? AND reference = ? LIMIT 1', [targetUserId, ref.slice(0, 255)])
        );
        const packageId = pkgMatch[0] ? pkgMatch[0].id : null;

        db.run(
            'INSERT INTO received_items (user_id, package_id, reference, items_description, quantity, notes) VALUES (?, ?, ?, ?, ?, ?)',
            [targetUserId, packageId, ref.slice(0, 255), desc.slice(0, 1000), qty, (notes != null ? String(notes).slice(0, 2000) : '')]
        );
        saveDb();

        const result = db.exec('SELECT last_insert_rowid() as id');
        const id = result[0].values[0][0];

        const msg = 'Package received: ' + ref + (desc ? ' – ' + desc.slice(0, 80) : '');
        await pushActivity(targetUserId, 'package_received', msg, '/dashboard/received.html');

        res.status(201).json({ message: 'Received item recorded', id });
    } catch (err) {
        console.error('Create received error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/received/:id/status (owner or admin)
router.put('/:id/status', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const { status } = req.body;
        if (!status || !RECEIVED_STATUSES.includes(status)) {
            return res.status(400).json({ error: 'Invalid status. Allowed: ' + RECEIVED_STATUSES.join(', ') });
        }

        const existing = parseResults(
            db.exec('SELECT id, user_id, reference FROM received_items WHERE id = ?', [req.params.id])
        );
        if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });
        const item = existing[0];
        if (item.user_id !== req.user.id && !req.user.is_admin) {
            return res.status(403).json({ error: 'Not authorized to update this item' });
        }

        db.run('UPDATE received_items SET status = ? WHERE id = ?', [status, req.params.id]);
        saveDb();

        const msg = 'Item ' + (item.reference || '') + ' status updated to ' + (status || '');
        await pushActivity(item.user_id, 'item_processed', msg, '/dashboard/received.html');

        res.json({ message: 'Status updated' });
    } catch (err) {
        console.error('Update received status error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
