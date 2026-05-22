/**
 * Print sold_date values and what the site should display (no DevTools needed).
 * Usage: node scripts/diagnose-sold-dates.js
 *        node scripts/diagnose-sold-dates.js --fix-got
 *        node scripts/diagnose-sold-dates.js --search "Thrones"
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { normalizeSoldDateForDb } = require('../src/utils/adminBulkImport');
const { mapSoldItemDatesForApi } = require('../src/utils/soldDateDisplayRepair');

const DB_PATH = path.resolve(process.env.DB_PATH || './data/returnpal.db');
const fixGot = process.argv.includes('--fix-got');
const searchArg = process.argv.indexOf('--search');
const search =
    searchArg >= 0 && process.argv[searchArg + 1]
        ? process.argv[searchArg + 1]
        : 'Game of Thrones';

function main() {
    if (!fs.existsSync(DB_PATH)) {
        console.log('Database not found at:', DB_PATH);
        console.log('Set DB_PATH if your database is elsewhere.');
        process.exit(1);
    }
    return initSqlJs().then((SQL) => {
        const db = new SQL.Database(fs.readFileSync(DB_PATH));
        const stmt = db.prepare(
            'SELECT id, sold_date, product FROM sold_items ORDER BY id DESC LIMIT 500'
        );
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();

        if (!rows.length) {
            console.log('No sold items in database.');
            return;
        }

        console.log('Database:', DB_PATH);
        console.log('Rows:', rows.length, '(newest first, max 500)\n');

        const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const matched = rows.filter((r) => re.test(String(r.product || '')));
        if (matched.length) {
            console.log('=== Matching "' + search + '" ===');
            matched.forEach(printRow);
        } else {
            console.log('(No product matching "' + search + '" in this database.)\n');
        }

        const nov1 = rows.filter((r) => {
            const m = mapSoldItemDatesForApi(r.sold_date, normalizeSoldDateForDb);
            return m.label === 'November 1st 2026';
        });
        if (nov1.length) {
            console.log('=== All rows that display as "November 1st 2026" (' + nov1.length + ') ===');
            nov1.slice(0, 20).forEach(printRow);
            if (nov1.length > 20) console.log('... and', nov1.length - 20, 'more\n');
        }

        console.log('=== Sample (first 10) ===');
        rows.slice(0, 10).forEach(printRow);

        if (fixGot && matched.length) {
            let n = 0;
            matched.forEach((r) => {
                db.run('UPDATE sold_items SET sold_date = ? WHERE id = ?', ['2026-02-05', r.id]);
                n++;
            });
            fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
            console.log('\nUpdated', n, 'row(s) to sold_date = 2026-02-05');
            console.log('Restart the server, then hard-refresh Sold Items (Ctrl+Shift+R).');
        } else if (matched.length) {
            const raw = String(matched[0].sold_date || '');
            const m = mapSoldItemDatesForApi(raw, normalizeSoldDateForDb);
            if (m.label === 'November 1st 2026' || raw === '2026-11-01') {
                console.log('\n>>> Your database has NOVEMBER stored, not February.');
                console.log('>>> To fix Game of Thrones (and matching titles) to 5 Feb 2026, run:');
                console.log('    npm run fix:sold-dates-got');
            } else if (raw === '2026-02-05' || m.label === 'February 5th 2026') {
                console.log('\n>>> Database is correct (February). Restart server + hard refresh the Sold Items page.');
            }
        }

        console.log('\n--- After refresh, under the sold table you should see green text:');
        console.log('    "Sold dates: ISO calendar (iso-calendar-2026-05f)"');
        console.log('If you do NOT see that line, the server is still serving an old sold-items.html.');
    });
}

function printRow(r) {
    const m = mapSoldItemDatesForApi(r.sold_date, normalizeSoldDateForDb);
    console.log('id:', r.id);
    console.log('  product:', String(r.product || '').slice(0, 70));
    console.log('  sold_date in DB:', r.sold_date);
    console.log('  site should show:', m.label || '(not a recognised ISO date)');
    console.log('');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
