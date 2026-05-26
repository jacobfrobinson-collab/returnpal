const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { normalizeSoldDateForDb } = require('../src/utils/adminBulkImport');
const { mapSoldItemDatesForApi } = require('../src/utils/soldDateDisplayRepair');

const DB_PATH = path.resolve(process.env.DB_PATH || './data/returnpal.db');

(async () => {
    if (!fs.existsSync(DB_PATH)) {
        console.error('No DB at', DB_PATH);
        process.exit(1);
    }
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB_PATH));
    const q = `SELECT id, sold_date, product FROM sold_items
               WHERE product LIKE '%Game of Thrones%' OR product LIKE '%Thrones%' LIMIT 10`;
    const res = db.exec(q);
    if (!res.length) {
        console.log('No Game of Thrones rows');
        const sample = db.exec('SELECT id, sold_date, product FROM sold_items ORDER BY id DESC LIMIT 5');
        console.log('Latest 5:', JSON.stringify(sample, null, 2));
        return;
    }
    for (const row of res[0].values) {
        const id = row[0];
        const sold = row[1];
        const product = row[2];
        const mapped = mapSoldItemDatesForApi(sold, normalizeSoldDateForDb);
        console.log({
            id,
            db_sold_date: sold,
            mapped_iso: mapped.iso,
            mapped_label: mapped.label,
            product: String(product).slice(0, 50),
        });
    }
})();
