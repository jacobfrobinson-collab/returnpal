/**
 * Insert a test sold row, run the same date mapping as GET /api/sold, assert label, remove row.
 * Usage: node scripts/test-sold-display-e2e.js
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { normalizeSoldDateForDb } = require('../src/utils/adminBulkImport');
const { mapSoldItemDatesForApi } = require('../src/utils/soldDateDisplayRepair');

require('../public/assets/js/soldDateIsoDisplay.js');

const DB_PATH = path.resolve(process.env.DB_PATH || './data/returnpal.db');
const PRODUCT = 'TEST-Game of Thrones: Season 1-3 2014 DVD Box Set New Sealed';
const SOLD_DATE = '2026-02-05';
const EXPECTED = 'February 5th 2026';

(async () => {
    if (!fs.existsSync(DB_PATH)) {
        console.error('Missing DB:', DB_PATH);
        process.exit(1);
    }
    const SQL = await initSqlJs();
    const buf = fs.readFileSync(DB_PATH);
    const db = new SQL.Database(buf);

    const users = db.exec('SELECT id FROM users LIMIT 1');
    if (!users.length || !users[0].values.length) {
        console.error('No users in DB');
        process.exit(1);
    }
    const userId = users[0].values[0][0];

    db.run(
        `INSERT INTO sold_items (user_id, reference, product, quantity, unit_price, total_revenue, profit, margin, sold_date)
         VALUES (?, 'TEST-GOT-DATE', ?, 1, 2.06, 2.06, 2.06, 0, ?)`,
        [userId, PRODUCT, SOLD_DATE]
    );
    const idRes = db.exec('SELECT last_insert_rowid()');
    const testId = idRes[0].values[0][0];

    const rowRes = db.exec('SELECT sold_date, product FROM sold_items WHERE id = ?', [testId]);
    const sold_date = rowRes[0].values[0][0];
    const dates = mapSoldItemDatesForApi(sold_date, normalizeSoldDateForDb);
    const apiRow = {
        sold_date_stored: dates.stored,
        sold_date: dates.iso || sold_date,
        sold_date_display: dates.iso || sold_date,
        sold_date_label: dates.label,
    };
    const uiLabel = global.RP_SOLD_ISO.labelForSoldItem(apiRow);

    db.run('DELETE FROM sold_items WHERE id = ?', [testId]);
    fs.writeFileSync(DB_PATH, Buffer.from(db.export()));

    const ok =
        dates.label === EXPECTED &&
        uiLabel === EXPECTED &&
        dates.iso === SOLD_DATE &&
        uiLabel !== 'November 1st 2026';

    console.log({
        db_sold_date: sold_date,
        mapped_iso: dates.iso,
        mapped_label: dates.label,
        ui_label: uiLabel,
        pass: ok,
    });

    if (!ok) {
        console.error('FAILED: expected', EXPECTED);
        process.exit(1);
    }
    console.log('test-sold-display-e2e: PASS');
})();
