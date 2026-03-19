/**
 * Seed script - populates the database with demo data
 * Run: node src/seed.js
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { getDb, saveDb } = require('./database');

async function seed() {
    const db = await getDb();

    console.log('Seeding database...');

    // ─── Create demo user ────────────────────────────────────
    const password = await bcrypt.hash('demo123', 12);
    db.run(
        "INSERT OR IGNORE INTO users (email, password, full_name, company_name, phone) VALUES (?, ?, ?, ?, ?)",
        ['david@returnpal.com', password, 'David Miller', 'Miller Trading Ltd', '+44 7305 057852']
    );

    const userResult = db.exec("SELECT id FROM users WHERE email = 'david@returnpal.com'");
    const userId = userResult[0].values[0][0];

    // Make demo user an admin so you can use the admin dashboard
    db.run("UPDATE users SET is_admin = 1 WHERE email = 'david@returnpal.com'");
    saveDb();

    // ─── Packages Sent ───────────────────────────────────────
    const packages = [
        { ref: 'TRACK-11255', status: 'In Transit', notes: 'Has my note', date: '2026-02-01' },
        { ref: 'TRACK-11300', status: 'Delivered', notes: 'Arrived safely', date: '2026-01-28' },
        { ref: 'TRACK-11180', status: 'Processed', notes: '', date: '2026-01-20' },
        { ref: 'TRACK-11090', status: 'Processed', notes: 'Bulk shipment', date: '2026-01-15' },
    ];

    for (const pkg of packages) {
        db.run(
            "INSERT INTO packages (user_id, reference, status, notes, date_added) VALUES (?, ?, ?, ?, ?)",
            [userId, pkg.ref, pkg.status, pkg.notes, pkg.date]
        );
        const pkgId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];

        // Add products
        if (pkg.ref === 'TRACK-11255') {
            db.run("INSERT INTO package_products (package_id, product_name, quantity, condition) VALUES (?, ?, ?, ?)",
                [pkgId, 'iPhone Case', 1, 'New']);
            db.run("INSERT INTO package_products (package_id, product_name, quantity, condition) VALUES (?, ?, ?, ?)",
                [pkgId, 'Screen Protector', 1, 'Return']);
        } else if (pkg.ref === 'TRACK-11300') {
            db.run("INSERT INTO package_products (package_id, product_name, quantity, condition) VALUES (?, ?, ?, ?)",
                [pkgId, 'iPad Pro 11 inch', 2, 'Return']);
            db.run("INSERT INTO package_products (package_id, product_name, quantity, condition) VALUES (?, ?, ?, ?)",
                [pkgId, 'MacBook Air M1', 1, 'Used']);
        } else if (pkg.ref === 'TRACK-11180') {
            db.run("INSERT INTO package_products (package_id, product_name, quantity, condition) VALUES (?, ?, ?, ?)",
                [pkgId, 'AirPods Pro', 3, 'New']);
        } else {
            db.run("INSERT INTO package_products (package_id, product_name, quantity, condition) VALUES (?, ?, ?, ?)",
                [pkgId, 'Samsung Galaxy S24 Case', 10, 'New']);
            db.run("INSERT INTO package_products (package_id, product_name, quantity, condition) VALUES (?, ?, ?, ?)",
                [pkgId, 'USB-C Cables', 15, 'New']);
        }
    }

    // ─── Received Items ──────────────────────────────────────
    const received = [
        { ref: 'RCV-001', items: 'iPad Pro 11 inch (x2), MacBook Air M1 (x1)', qty: 3, status: 'Processed', date: '2026-02-01', notes: 'Quality check completed' },
        { ref: 'RCV-002', items: 'AirPods Pro (x3)', qty: 3, status: 'Processed', date: '2026-01-25', notes: 'All items in good condition' },
        { ref: 'RCV-003', items: 'Samsung Galaxy S24 Case (x10), USB-C Cables (x15)', qty: 25, status: 'Processing', date: '2026-01-20', notes: 'Sorting in progress' },
    ];

    for (const item of received) {
        db.run(
            "INSERT INTO received_items (user_id, reference, items_description, quantity, status, notes, date_received) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [userId, item.ref, item.items, item.qty, item.status, item.notes, item.date]
        );
    }

    // ─── Sold Items ──────────────────────────────────────────
    const sold = [
        { ref: 'SOLD-001', product: 'iPad Pro 11 inch', qty: 2, unit: 450, rev: 900, profit: 380, margin: 42, date: '2026-02-05' },
        { ref: 'SOLD-002', product: 'MacBook Air M1', qty: 1, unit: 750, rev: 750, profit: 310, margin: 41, date: '2026-02-03' },
        { ref: 'SOLD-003', product: 'AirPods Pro', qty: 3, unit: 160, rev: 480, profit: 195, margin: 41, date: '2026-01-30' },
    ];

    for (const item of sold) {
        db.run(
            `INSERT INTO sold_items (user_id, reference, product, quantity, unit_price, total_revenue, profit, margin, sold_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, item.ref, item.product, item.qty, item.unit, item.rev, item.profit, item.margin, item.date]
        );
    }

    // ─── Pending Items ───────────────────────────────────────
    const pending = [
        { ref: 'PEND-001', product: 'Samsung Galaxy S24 Case', qty: 5, stage: 'Quality Check', est: '2026-02-15', notes: 'Awaiting detailed inspection' },
        { ref: 'PEND-002', product: 'USB-C Cables', qty: 15, stage: 'Initial Inspection', est: '2026-02-12', notes: 'Sorting by length/type' },
        { ref: 'PEND-003', product: 'Samsung Galaxy S24 Case', qty: 5, stage: 'Return Verification', est: '2026-02-18', notes: 'Checking return reasons' },
    ];

    for (const item of pending) {
        db.run(
            `INSERT INTO pending_items (user_id, reference, product, quantity, current_stage, est_completion, notes, received_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, '2026-02-05')`,
            [userId, item.ref, item.product, item.qty, item.stage, item.est, item.notes]
        );
    }

    // ─── Invoices ────────────────────────────────────────────
    const invoices = [
        { num: 'INV-2026-001', customer: 'TechWholesale Inc.', date: '2026-02-05', due: '2026-03-05', amount: 900, items: 2, status: 'Paid' },
        { num: 'INV-2026-002', customer: 'GadgetResale Ltd.', date: '2026-02-03', due: '2026-03-03', amount: 750, items: 1, status: 'Paid' },
        { num: 'INV-2026-003', customer: 'AudioDirect UK', date: '2026-01-30', due: '2026-02-28', amount: 480, items: 3, status: 'Pending' },
        { num: 'INV-2026-004', customer: 'AccessoryHub', date: '2026-01-25', due: '2026-02-25', amount: 320, items: 8, status: 'Paid' },
    ];

    for (const inv of invoices) {
        db.run(
            `INSERT OR IGNORE INTO invoices (user_id, invoice_number, customer_name, date_issued, due_date, amount, items_count, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, inv.num, inv.customer, inv.date, inv.due, inv.amount, inv.items, inv.status]
        );
    }

    saveDb();
    console.log('Seed complete!');
    console.log('\n  Demo credentials:');
    console.log('  Email:    david@returnpal.com');
    console.log('  Password: demo123\n');
    process.exit(0);
}

seed().catch(err => {
    console.error('Seed failed:', err);
    process.exit(1);
});
