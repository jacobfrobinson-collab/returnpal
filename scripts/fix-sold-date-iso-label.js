/**
 * Show (and optionally fix) sold_date for rows where DB ISO should display as calendar Y-M-D.
 * Usage:
 *   node scripts/fix-sold-date-iso-label.js --product "Game of Thrones"
 *   node scripts/fix-sold-date-iso-label.js --product "Game of Thrones" --set-iso 2026-02-05
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { normalizeSoldDateForDb } = require('../src/utils/adminBulkImport');
const { mapSoldItemDatesForApi } = require('../src/utils/soldDateDisplayRepair');

const DB_PATH = path.resolve(process.env.DB_PATH || './data/returnpal.db');

function arg(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
}

(async () => {
    const productQ = arg('--product');
    const setIso = arg('--set-iso');
    if (!productQ) {
        console.error('Usage: node scripts/fix-sold-date-iso-label.js --product "substring" [--set-iso YYYY-MM-DD]');
        process.exit(1);
    }
    if (!fs.existsSync(DB_PATH)) {
        console.error('No DB at', DB_PATH);
        process.exit(1);
    }
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB_PATH));
    const like = '%' + productQ.replace(/%/g, '') + '%';
    const stmt = db.prepare(
        'SELECT id, sold_date, product FROM sold_items WHERE product LIKE ? ORDER BY id DESC LIMIT 20'
    );
    stmt.bind([like]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    const res = rows.length
        ? [{ columns: ['id', 'sold_date', 'product'], values: rows.map((r) => [r.id, r.sold_date, r.product]) }]
        : [];
    if (!rows.length) {
        console.log('No rows matching product:', productQ);
        process.exit(0);
    }
    let changed = 0;
    for (const row of rows) {
        const id = row.id;
        const sold = row.sold_date;
        const product = row.product;
        const mapped = mapSoldItemDatesForApi(sold, normalizeSoldDateForDb);
        console.log('---');
        console.log('id:', id);
        console.log('product:', String(product).slice(0, 70));
        console.log('sold_date (DB):', sold);
        console.log('display label:', mapped.label || '(not ISO)');
        if (setIso && /^\d{4}-\d{2}-\d{2}$/.test(setIso)) {
            db.run('UPDATE sold_items SET sold_date = ? WHERE id = ?', [setIso, id]);
            const after = mapSoldItemDatesForApi(setIso, normalizeSoldDateForDb);
            console.log('UPDATED →', setIso, '→', after.label);
            changed++;
        }
    }
    if (changed > 0) {
        fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
        console.log('Saved', changed, 'row(s) to', DB_PATH);
    }
})();
