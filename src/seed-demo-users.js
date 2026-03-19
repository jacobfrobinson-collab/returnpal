/**
 * Populate database with 12 random demo users + packages, received, sold, pending.
 * Run: node src/seed-demo-users.js
 * All users have password: demo123
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { getDb, saveDb } = require('./database');

const FIRST_NAMES = ['James', 'Emma', 'Oliver', 'Sophie', 'Noah', 'Isabella', 'George', 'Mia', 'Oscar', 'Lily', 'Arthur', 'Grace', 'Charlie', 'Freya', 'Leo'];
const LAST_NAMES = ['Smith', 'Jones', 'Taylor', 'Brown', 'Wilson', 'Davies', 'Evans', 'Thomas', 'Roberts', 'Walker', 'Wright', 'Clark', 'Lewis', 'James', 'Morgan'];
const COMPANY_PARTS = ['Trading', 'Resale', 'Electronics', 'Tech', 'Deals', 'Returns', 'Liquidation', 'Outlet', 'Clearance', 'Warehouse'];
const PRODUCTS = [
    'iPhone 15 Case', 'Samsung Galaxy S24 Case', 'AirPods Pro 2', 'USB-C Hub', 'Wireless Earbuds', 'Screen Protector Pack',
    'MacBook Air M1', 'iPad Pro 11"', 'Kindle Paperwhite', 'Fire TV Stick', 'Echo Dot', 'Bluetooth Speaker',
    'Phone Stand', 'Laptop Sleeve', 'Tablet Case', 'Cable Bundle', 'Power Bank', 'Webcam', 'Keyboard', 'Mouse',
    'Monitor Arm', 'Desk Lamp', 'HDMI Cable', 'Adapter Set', 'Charger 20W', 'Smart Watch Band'
];
const PACKAGE_STATUSES = ['In Transit', 'In Transit', 'Delivered', 'Delivered', 'Processing', 'Processed'];
const RECEIVED_STATUSES = ['Processing', 'Processed', 'Quality Check', 'Processed'];
const PENDING_STAGES = ['Initial Inspection', 'Quality Check', 'Listing', 'Ready for Sale', 'Return Verification'];
const CONDITIONS = ['New', 'New', 'Used', 'Return'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickMany(arr, n) {
    const out = [];
    const copy = [...arr];
    for (let i = 0; i < n && copy.length; i++) {
        out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
    }
    return out;
}
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
function dateOffset(daysAgo) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().slice(0, 10);
}

async function run() {
    const db = await getDb();
    const password = await bcrypt.hash('demo123', 12);

    console.log('Creating 12 demo users with random data...');

    const invoicePrefix = 'INV-DEMO-' + Date.now() + '-';
    let invoiceCounter = 0;

    for (let i = 0; i < 12; i++) {
        const firstName = pick(FIRST_NAMES);
        const lastName = pick(LAST_NAMES);
        const company = (firstName + ' ' + lastName).replace(/\s/g, '') + ' ' + pick(COMPANY_PARTS) + ' Ltd';
        const email = `demo${i + 1}@returnpal.com`;

        db.run(
            'INSERT OR IGNORE INTO users (email, password, full_name, company_name, phone) VALUES (?, ?, ?, ?, ?)',
            [email, password, `${firstName} ${lastName}`, company, '+44 7' + randInt(100, 999) + ' ' + randInt(100000, 999999)]
        );
        const userRows = db.exec('SELECT id FROM users WHERE email = ?', [email]);
        if (!userRows.length || !userRows[0].values.length) continue; // already existed, get id
        const userId = db.exec('SELECT id FROM users WHERE email = ?', [email])[0].values[0][0];

        // Packages (1–5 per user)
        const numPackages = randInt(1, 5);
        for (let p = 0; p < numPackages; p++) {
            const ref = 'TRACK-' + randInt(10000, 99999);
            const status = pick(PACKAGE_STATUSES);
            const date = dateOffset(randInt(1, 90));
            db.run(
                'INSERT INTO packages (user_id, reference, status, notes, date_added) VALUES (?, ?, ?, ?, ?)',
                [userId, ref, status, randInt(0, 3) === 0 ? 'Bulk return' : '', date]
            );
            const pkgId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
            const prods = pickMany(PRODUCTS, randInt(1, 3));
            for (const prod of prods) {
                db.run(
                    'INSERT INTO package_products (package_id, product_name, quantity, condition) VALUES (?, ?, ?, ?)',
                    [pkgId, prod, randInt(1, 4), pick(CONDITIONS)]
                );
            }
        }

        // Received (0–4 per user)
        const numReceived = randInt(0, 4);
        for (let r = 0; r < numReceived; r++) {
            const ref = 'RCV-' + String(userId).padStart(3, '0') + '-' + (r + 1);
            const items = pickMany(PRODUCTS, randInt(1, 3)).join(', ');
            const qty = randInt(1, 10);
            const status = pick(RECEIVED_STATUSES);
            const date = dateOffset(randInt(1, 60));
            db.run(
                'INSERT INTO received_items (user_id, reference, items_description, quantity, status, notes, date_received) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [userId, ref, items + ' (x' + qty + ')', qty, status, '', date]
            );
        }

        // Sold (0–6 per user)
        const numSold = randInt(0, 6);
        for (let s = 0; s < numSold; s++) {
            const product = pick(PRODUCTS);
            const qty = randInt(1, 3);
            const unitPrice = randInt(8, 120) + Math.random() * 0.99;
            const totalRev = Math.round(unitPrice * qty * 100) / 100;
            const margin = randInt(35, 85);
            const profit = Math.round(totalRev * (margin / 100) * 100) / 100;
            const date = dateOffset(randInt(1, 45));
            db.run(
                `INSERT INTO sold_items (user_id, reference, product, quantity, unit_price, total_revenue, profit, margin, sold_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, 'SOLD-' + (s + 1), product, qty, unitPrice, totalRev, profit, margin, date]
            );
        }

        // Pending (0–4 per user)
        const numPending = randInt(0, 4);
        for (let p = 0; p < numPending; p++) {
            const product = pick(PRODUCTS);
            const ref = 'PEND-' + (p + 1);
            const stage = pick(PENDING_STAGES);
            const recvDate = dateOffset(randInt(5, 30));
            const estDate = dateOffset(randInt(-10, 15));
            db.run(
                `INSERT INTO pending_items (user_id, reference, product, quantity, current_stage, est_completion, notes, received_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, ref, product, randInt(1, 5), stage, estDate, '', recvDate]
            );
        }

        // Invoices (0–2 per user, unique numbers)
        const numInvoices = randInt(0, 2);
        for (let inv = 0; inv < numInvoices; inv++) {
            const invNum = invoicePrefix + (invoiceCounter++);
            const amount = randInt(50, 800) + Math.random() * 0.99;
            const date = dateOffset(randInt(10, 60));
            const due = dateOffset(randInt(-30, 0));
            const status = pick(['Paid', 'Paid', 'Pending']);
            db.run(
                `INSERT OR IGNORE INTO invoices (user_id, invoice_number, customer_name, date_issued, due_date, amount, items_count, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, invNum, company, date, due, Math.round(amount * 100) / 100, randInt(1, 8), status]
            );
        }

        console.log('  Created user ' + (i + 1) + ': ' + email);
    }

    saveDb();
    console.log('\nDone! 12 demo users created. All passwords: demo123');
    console.log('Log in as admin (david@returnpal.com / demo123) and open Admin to see them.\n');
    process.exit(0);
}

run().catch(err => {
    console.error('Seed failed:', err);
    process.exit(1);
});
