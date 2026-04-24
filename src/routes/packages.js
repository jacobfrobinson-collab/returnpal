const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb, saveDb, pushActivity } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Helper to parse sql.js results into array of objects
function parseResults(result) {
    if (!result || result.length === 0) return [];
    const cols = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        cols.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

// GET /api/packages - List all packages for user
router.get('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const packages = parseResults(
            db.exec('SELECT * FROM packages WHERE user_id = ? ORDER BY date_added DESC', [req.user.id])
        );

        // Get products for each package
        for (const pkg of packages) {
            pkg.products = parseResults(
                db.exec('SELECT * FROM package_products WHERE package_id = ?', [pkg.id])
            );
            pkg.total_qty = pkg.products.reduce((sum, p) => sum + p.quantity, 0);
        }

        const inTransitCount = packages.filter(p => p.status === 'In Transit').length;

        res.json({ packages, in_transit_count: inTransitCount, total: packages.length });
    } catch (err) {
        console.error('Get packages error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/packages/:id
router.get('/:id', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const packages = parseResults(
            db.exec('SELECT * FROM packages WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
        );

        if (packages.length === 0) {
            return res.status(404).json({ error: 'Package not found' });
        }

        const pkg = packages[0];
        pkg.products = parseResults(
            db.exec('SELECT * FROM package_products WHERE package_id = ?', [pkg.id])
        );
        pkg.total_qty = pkg.products.reduce((sum, p) => sum + p.quantity, 0);

        res.json({ package: pkg });
    } catch (err) {
        console.error('Get package error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/packages - Create new package (admin can pass user_id)
router.post('/', authMiddleware, [
    body('reference').trim().notEmpty().withMessage('Reference is required'),
    body('products').isArray({ min: 1 }).withMessage('At least one product is required'),
    body('products.*.product_name').trim().notEmpty().withMessage('Product name is required'),
    body('products.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const db = await getDb();
        const { reference, products, notes, user_id } = req.body;

        let targetUserId = user_id != null ? parseInt(user_id, 10) : req.user.id;
        if (targetUserId !== req.user.id && !req.user.is_admin) {
            return res.status(403).json({ error: 'Only admins can create packages for another user' });
        }
        if (isNaN(targetUserId)) targetUserId = req.user.id;

        db.run(
            'INSERT INTO packages (user_id, reference, notes) VALUES (?, ?, ?)',
            [targetUserId, reference, notes || '']
        );

        const pkgResult = db.exec('SELECT last_insert_rowid() as id');
        const packageId = pkgResult[0].values[0][0];

        for (const product of products) {
            const asin = (product.asin != null ? String(product.asin).trim() : '').slice(0, 100);
            const costNum = Number(product.cost_of_goods);
            const cost = isNaN(costNum) ? 0 : costNum;
            db.run(
                'INSERT INTO package_products (package_id, product_name, quantity, condition, asin, cost_of_goods) VALUES (?, ?, ?, ?, ?, ?)',
                [packageId, product.product_name, product.quantity, product.condition || 'New', asin, cost]
            );
        }

        saveDb();

        res.status(201).json({
            message: 'Package created successfully',
            package_id: packageId
        });
    } catch (err) {
        console.error('Create package error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

const PACKAGE_STATUSES = ['In Transit', 'Delivered', 'Processing', 'Processed', 'Cancelled'];
const PRODUCT_CONDITIONS = ['New', 'Used', 'Return', 'Return Review'];

// PUT /api/packages/:id - Update package (owner or admin)
router.put('/:id', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const { reference, products, notes, status } = req.body;

        const existing = parseResults(
            db.exec('SELECT id, user_id, reference FROM packages WHERE id = ?', [req.params.id])
        );
        if (existing.length === 0) return res.status(404).json({ error: 'Package not found' });
        const pkg = existing[0];
        if (pkg.user_id !== req.user.id && !req.user.is_admin) {
            return res.status(403).json({ error: 'Not authorized to update this package' });
        }

        if (status && !PACKAGE_STATUSES.includes(status)) {
            return res.status(400).json({ error: 'Invalid status. Allowed: ' + PACKAGE_STATUSES.join(', ') });
        }

        const updates = [];
        const params = [];
        if (reference !== undefined && reference !== null) { updates.push('reference = ?'); params.push(String(reference).trim() || pkg.reference); }
        if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
        if (status) { updates.push('status = ?'); params.push(status); }
        updates.push("updated_at = datetime('now')");
        params.push(req.params.id);

        db.run(`UPDATE packages SET ${updates.join(', ')} WHERE id = ?`, params);

        if (status === 'Delivered') {
            const msg = 'Package ' + (pkg.reference || '') + ' marked as delivered';
            await pushActivity(pkg.user_id, 'package_delivered', msg, '/dashboard/packages.html');
        }

        if (products && Array.isArray(products)) {
            for (const product of products) {
                const name = (product.product_name != null ? String(product.product_name).trim() : '');
                const qty = Math.max(1, parseInt(product.quantity, 10) || 1);
                const cond = PRODUCT_CONDITIONS.includes(product.condition) ? product.condition : 'New';
                if (!name) {
                    return res.status(400).json({ error: 'Each product must have a name' });
                }
            }
            db.run('DELETE FROM package_products WHERE package_id = ?', [req.params.id]);
            for (const product of products) {
                const name = (product.product_name != null ? String(product.product_name).trim() : '').slice(0, 500);
                const qty = Math.max(1, parseInt(product.quantity, 10) || 1);
                const cond = PRODUCT_CONDITIONS.includes(product.condition) ? product.condition : 'New';
                const asin = (product.asin != null ? String(product.asin).trim() : '').slice(0, 100);
                const costNum = Number(product.cost_of_goods);
                const cost = isNaN(costNum) ? 0 : costNum;
                db.run(
                    'INSERT INTO package_products (package_id, product_name, quantity, condition, asin, cost_of_goods) VALUES (?, ?, ?, ?, ?, ?)',
                    [req.params.id, name, qty, cond, asin, cost]
                );
            }
        }

        saveDb();
        res.json({ message: 'Package updated successfully' });
    } catch (err) {
        console.error('Update package error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/packages/:id
router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();

        const existing = parseResults(
            db.exec('SELECT id, user_id FROM packages WHERE id = ?', [req.params.id])
        );
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Package not found' });
        }
        const pkg = existing[0];
        if (pkg.user_id !== req.user.id && !req.user.is_admin) {
            return res.status(403).json({ error: 'Not authorized to delete this package' });
        }

        db.run('DELETE FROM package_products WHERE package_id = ?', [req.params.id]);
        db.run('DELETE FROM packages WHERE id = ?', [req.params.id]);
        saveDb();

        res.json({ message: 'Package deleted successfully' });
    } catch (err) {
        console.error('Delete package error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
