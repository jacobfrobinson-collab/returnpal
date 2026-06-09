/**
 * Package-first receive: queue packages awaiting check-in and create received_items
 * from declared package_products.
 */

const { pushActivity } = require('../database');

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

function sumQty(rows) {
    return rows.reduce((a, r) => a + (Number(r.quantity) || 0), 0);
}

function receivedRowsForPackage(db, userId, pkg) {
    const byId = parseResults(
        db.exec('SELECT id, items_description, quantity FROM received_items WHERE package_id = ?', [pkg.id])
    );
    if (byId.length) return byId;
    const ref = String(pkg.reference || '').trim();
    if (!ref) return [];
    return parseResults(
        db.exec('SELECT id, items_description, quantity FROM received_items WHERE user_id = ? AND reference = ?', [
            userId,
            ref,
        ])
    );
}

function receivedQtyForDescription(receivedRows, productName) {
    const key = String(productName || '').trim();
    return receivedRows
        .filter((r) => String(r.items_description || '').trim() === key)
        .reduce((a, r) => a + (Number(r.quantity) || 0), 0);
}

function buildPackageLines(db, pkg) {
    const products = parseResults(
        db.exec(
            'SELECT product_name, quantity, condition, asin, cost_of_goods FROM package_products WHERE package_id = ? ORDER BY id',
            [pkg.id]
        )
    );
    const receivedRows = receivedRowsForPackage(db, pkg.user_id, pkg);

    if (!products.length) {
        const desc =
            String(pkg.notes || '').trim() ||
            'Package contents';
        const receivedQty = sumQty(receivedRows);
        const declaredQty = 1;
        return {
            lines: [
                {
                    product_name: desc,
                    quantity: declaredQty,
                    received_quantity: receivedQty,
                    remaining_quantity: Math.max(0, declaredQty - receivedQty),
                    condition: 'Return',
                    asin: '',
                    cost_of_goods: 0,
                },
            ],
            declared_units: declaredQty,
            received_units: receivedQty,
        };
    }

    const lines = products.map((p) => {
        const name = String(p.product_name || '').trim();
        const qty = Math.max(1, Number(p.quantity) || 1);
        const receivedQty = receivedQtyForDescription(receivedRows, name);
        return {
            product_name: name,
            quantity: qty,
            received_quantity: receivedQty,
            remaining_quantity: Math.max(0, qty - receivedQty),
            condition: p.condition || 'New',
            asin: p.asin || '',
            cost_of_goods: Number(p.cost_of_goods) || 0,
        };
    });

    const declared_units = Math.max(1, sumQty(products));
    const received_units = sumQty(receivedRows);

    return { lines, declared_units, received_units };
}

function buildQueueItem(db, pkg) {
    const { lines, declared_units, received_units } = buildPackageLines(db, pkg);
    const remaining_units = Math.max(0, declared_units - received_units);
    const productsSummary = lines
        .map((l) => l.product_name + (l.quantity > 1 ? ' ×' + l.quantity : ''))
        .join(', ');

    return {
        package_id: pkg.id,
        reference: pkg.reference || '',
        status: pkg.status || '',
        order_number: pkg.order_number || '',
        date_added: pkg.date_added || '',
        declared_units,
        received_units,
        remaining_units,
        products_summary: productsSummary,
        lines,
    };
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {{ includeFullyReceived?: boolean }} [opts]
 */
function getReceiveQueue(db, userId, opts = {}) {
    const includeFullyReceived = !!opts.includeFullyReceived;
    const packages = parseResults(
        db.exec(
            `SELECT id, user_id, reference, status, notes, order_number, date_added
             FROM packages WHERE user_id = ? AND status != 'Cancelled'
             ORDER BY date_added DESC`,
            [userId]
        )
    );

    const queue = [];
    for (const pkg of packages) {
        const item = buildQueueItem(db, pkg);
        if (includeFullyReceived || item.remaining_units > 0) {
            queue.push(item);
        }
    }

    return {
        queue,
        count: queue.filter((q) => q.remaining_units > 0).length,
    };
}

async function markPackageDelivered(db, pkg) {
    if (pkg.status !== 'In Transit') return false;
    db.run(`UPDATE packages SET status = 'Delivered', updated_at = datetime('now') WHERE id = ?`, [pkg.id]);
    const msg = 'Package ' + (pkg.reference || '') + ' marked as delivered';
    await pushActivity(pkg.user_id, 'package_delivered', msg, '/dashboard/packages.html');
    try {
        const { sendPackageDeliveredEmail } = require('./sendTransactionalEmail');
        await sendPackageDeliveredEmail(db, pkg.user_id, pkg.id, pkg.reference);
    } catch (e) {
        console.error('[email] package delivered:', e.message || e);
    }
    return true;
}

async function insertReceivedLine(db, userId, pkg, line, orderNumber) {
    const desc = String(line.product_name || '').trim().slice(0, 1000);
    const qty = Math.max(1, Number(line.remaining_quantity) || 1);
    const ref = String(pkg.reference || '').trim().slice(0, 255);
    const onum = String(orderNumber || '').trim().slice(0, 200);

    db.run(
        'INSERT INTO received_items (user_id, package_id, reference, items_description, quantity, notes, order_number) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, pkg.id, ref, desc, qty, '', onum]
    );
    const id = parseResults(db.exec('SELECT last_insert_rowid() AS id'))[0].id;

    if (Number(line.cost_of_goods) > 0) {
        try {
            const { sendHighValueReceivedEmail } = require('./sendTransactionalEmail');
            await sendHighValueReceivedEmail(db, userId, id, desc, Number(line.cost_of_goods));
        } catch (e) {
            console.error('[high-value-received]', e.message || e);
        }
    }

    return id;
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {number[]} packageIds
 * @param {{ mark_delivered?: boolean }} [opts]
 */
async function receivePackagesFromDeclared(db, userId, packageIds, opts = {}) {
    const markDelivered = opts.mark_delivered !== false;
    const ids = [...new Set(packageIds.map((x) => parseInt(x, 10)).filter((id) => Number.isFinite(id) && id > 0))];

    let received_packages = 0;
    let received_lines = 0;
    let delivered_packages = 0;
    const skipped = [];
    const errors = [];

    for (const packageId of ids) {
        const pkgRows = parseResults(
            db.exec('SELECT * FROM packages WHERE id = ? AND user_id = ?', [packageId, userId])
        );
        if (!pkgRows.length) {
            errors.push({ package_id: packageId, error: 'Package not found for this client' });
            continue;
        }
        const pkg = pkgRows[0];
        if (pkg.status === 'Cancelled') {
            skipped.push({ package_id: packageId, reference: pkg.reference, reason: 'cancelled' });
            continue;
        }

        const { lines } = buildPackageLines(db, pkg);
        const toReceive = lines.filter((l) => l.remaining_quantity > 0);
        if (!toReceive.length) {
            skipped.push({ package_id: packageId, reference: pkg.reference, reason: 'already_received' });
            continue;
        }

        if (markDelivered && pkg.status === 'In Transit') {
            const did = await markPackageDelivered(db, pkg);
            if (did) delivered_packages += 1;
            pkg.status = 'Delivered';
        }

        const orderNumber = pkg.order_number || '';
        let firstReceivedId = null;
        for (const line of toReceive) {
            const receivedId = await insertReceivedLine(db, userId, pkg, line, orderNumber);
            if (firstReceivedId == null) firstReceivedId = receivedId;
            received_lines += 1;
        }

        const descPreview = toReceive.map((l) => l.product_name).join(', ');
        const msg =
            'Package received: ' +
            (pkg.reference || '') +
            (descPreview ? ' – ' + descPreview.slice(0, 80) : '');
        await pushActivity(userId, 'package_received', msg, '/dashboard/received.html');
        if (firstReceivedId != null) {
            try {
                const { sendPackageReceivedEmail } = require('./sendTransactionalEmail');
                await sendPackageReceivedEmail(
                    db,
                    userId,
                    firstReceivedId,
                    pkg.reference,
                    descPreview
                );
            } catch (e) {
                console.error('[email] package received:', e.message || e);
            }
        }
        received_packages += 1;
    }

    return {
        received_packages,
        received_lines,
        delivered_packages,
        skipped,
        errors,
    };
}

module.exports = {
    getReceiveQueue,
    receivePackagesFromDeclared,
    buildPackageLines,
    buildQueueItem,
};
