const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.resolve(process.env.DB_PATH || './data/returnpal.db');
const DB_DIR = path.dirname(DB_PATH);

let db = null;

async function getDb() {
    if (db) return db;

    // Ensure data directory exists
    if (!fs.existsSync(DB_DIR)) {
        fs.mkdirSync(DB_DIR, { recursive: true });
    }

    const SQL = await initSqlJs();

    // Load existing database or create new one
    if (fs.existsSync(DB_PATH)) {
        const buffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }

    // Enable WAL mode equivalent and foreign keys
    db.run('PRAGMA foreign_keys = ON;');

    // Create tables
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            full_name TEXT NOT NULL,
            company_name TEXT DEFAULT '',
            phone TEXT DEFAULT '',
            vat_registered INTEGER DEFAULT 0,
            discord_webhook TEXT DEFAULT '',
            avatar_url TEXT DEFAULT '',
            is_admin INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `);

    // Migration: add is_admin to existing databases
    try {
        db.run('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
    } catch (e) {
        // Column already exists
    }

    // Migration: who referred this user (nullable — points to users.id)
    try {
        db.run('ALTER TABLE users ADD COLUMN referred_by INTEGER');
    } catch (e) {
        // Column already exists
    }
    try {
        db.run('CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by)');
    } catch (e) {
        // ignore
    }

    db.run(`
        CREATE TABLE IF NOT EXISTS packages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            reference TEXT NOT NULL,
            status TEXT DEFAULT 'In Transit' CHECK(status IN ('In Transit', 'Delivered', 'Processing', 'Processed', 'Cancelled')),
            notes TEXT DEFAULT '',
            date_added TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS package_products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            package_id INTEGER NOT NULL,
            product_name TEXT NOT NULL,
            quantity INTEGER DEFAULT 1,
            condition TEXT DEFAULT 'New' CHECK(condition IN ('New', 'Used', 'Return', 'Return Review')),
            asin TEXT DEFAULT '',
            cost_of_goods REAL DEFAULT 0,
            FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE CASCADE
        )
    `);

    // Migration: add ASIN and cost_of_goods to existing package_products tables
    try {
        db.run('ALTER TABLE package_products ADD COLUMN asin TEXT DEFAULT \'\'');
    } catch (e) {
        // Column already exists
    }
    try {
        db.run('ALTER TABLE package_products ADD COLUMN cost_of_goods REAL DEFAULT 0');
    } catch (e) {
        // Column already exists
    }

    db.run(`
        CREATE TABLE IF NOT EXISTS received_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            reference TEXT NOT NULL,
            items_description TEXT NOT NULL,
            quantity INTEGER DEFAULT 1,
            status TEXT DEFAULT 'Processing' CHECK(status IN ('Processing', 'Processed', 'Quality Check', 'Rejected')),
            notes TEXT DEFAULT '',
            date_received TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS sold_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            reference TEXT NOT NULL,
            product TEXT NOT NULL,
            quantity INTEGER DEFAULT 1,
            unit_price REAL DEFAULT 0,
            total_revenue REAL DEFAULT 0,
            profit REAL DEFAULT 0,
            margin REAL DEFAULT 0,
            sold_date TEXT DEFAULT (datetime('now')),
            status TEXT DEFAULT 'Completed' CHECK(status IN ('Completed', 'Pending', 'Refunded')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS pending_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            reference TEXT NOT NULL,
            product TEXT NOT NULL,
            quantity INTEGER DEFAULT 1,
            received_date TEXT DEFAULT (datetime('now')),
            current_stage TEXT DEFAULT 'Initial Inspection' CHECK(current_stage IN ('Initial Inspection', 'Quality Check', 'Return Verification', 'Listing', 'Ready for Sale')),
            est_completion TEXT,
            notes TEXT DEFAULT '',
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            invoice_number TEXT UNIQUE NOT NULL,
            customer_name TEXT NOT NULL,
            date_issued TEXT DEFAULT (datetime('now')),
            due_date TEXT,
            amount REAL DEFAULT 0,
            items_count INTEGER DEFAULT 0,
            status TEXT DEFAULT 'Pending' CHECK(status IN ('Paid', 'Pending', 'Overdue', 'Cancelled')),
            pdf_path TEXT DEFAULT '',
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS contact_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            subject TEXT NOT NULL,
            message TEXT NOT NULL,
            read INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS activities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            message TEXT NOT NULL,
            link TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS reimbursement_claims (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            package_reference TEXT NOT NULL,
            item_description TEXT NOT NULL,
            reimbursement_type TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS reimbursement_claim_photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            claim_id INTEGER NOT NULL,
            file_path TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (claim_id) REFERENCES reimbursement_claims(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS return_adjustments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            product TEXT NOT NULL,
            reference TEXT DEFAULT '',
            amount REAL NOT NULL,
            linked_sold_item_id INTEGER,
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending','applied')),
            notes TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS item_queries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            context_type TEXT NOT NULL,
            context_id INTEGER,
            context_label TEXT DEFAULT '',
            message TEXT NOT NULL,
            status TEXT DEFAULT 'open' CHECK(status IN ('open','closed')),
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    try {
        db.run("ALTER TABLE received_items ADD COLUMN sku TEXT DEFAULT ''");
    } catch (e) {
        // Column already exists
    }

    try {
        db.run('ALTER TABLE received_items ADD COLUMN package_id INTEGER');
    } catch (e) {
        // Column already exists
    }
    try {
        db.run(
            `UPDATE received_items SET package_id = (
                SELECT p.id FROM packages p
                WHERE p.user_id = received_items.user_id AND p.reference = received_items.reference
                LIMIT 1
            ) WHERE package_id IS NULL`
        );
    } catch (e) {
        // ignore migration errors on empty DB
    }

    // Create indexes
    db.run('CREATE INDEX IF NOT EXISTS idx_packages_user ON packages(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_received_user ON received_items(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_received_package ON received_items(package_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_sold_user ON sold_items(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_pending_user ON pending_items(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_activities_user ON activities(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_reimbursement_claims_user ON reimbursement_claims(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_reimbursement_claim_photos_claim ON reimbursement_claim_photos(claim_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_return_adjustments_user ON return_adjustments(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_item_queries_user ON item_queries(user_id)');

    // Save to disk
    saveDb();

    return db;
}

async function pushActivity(userId, type, message, link) {
    try {
        const database = await getDb();
        database.run(
            'INSERT INTO activities (user_id, type, message, link) VALUES (?, ?, ?, ?)',
            [userId, type || 'info', message || '', link || '']
        );
        saveDb();
    } catch (e) {
        console.error('pushActivity error:', e);
    }
}

function saveDb() {
    if (db) {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(DB_PATH, buffer);
    }
}

// Auto-save periodically
setInterval(saveDb, 30000);

// Save on exit
process.on('exit', saveDb);
process.on('SIGINT', () => { saveDb(); process.exit(); });
process.on('SIGTERM', () => { saveDb(); process.exit(); });

module.exports = { getDb, saveDb, pushActivity };
