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
const { mapSoldItemDatesForApi, resolveSoldDateIsoForDisplay } = require('../src/utils/soldDateDisplayRepair');

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
            const m = mapSoldItemDatesForApi(matched[0].sold_date, normalizeSoldDateForDb);
            if (String(matched[0].sold_date) === '2026-11-01' && m.label !== 'January 11th 2026') {
                console.log('\n>>> Deploy latest code from GitHub (jan-day repair). After deploy, 2026-11-01 → January 11th 2026.');
            } else if (m.label === 'January 11th 2026') {
                console.log('\n>>> Display repair OK for 11 Jan (DB still 2026-11-01). Hard-refresh Sold Items after deploy.');
            }
        }

        console.log('\n--- After deploy + refresh, under the sold table:');
        console.log('    "Sold dates: iso-calendar-jan-day-2026-05g — 2026-11-01 in DB shows as January 11th 2026"');
    });
}

function printRow(r) {
    const m = mapSoldItemDatesForApi(r.sold_date, normalizeSoldDateForDb);
    const rawIso = normalizeSoldDateForDb(r.sold_date) || String(r.sold_date || '').trim();
    console.log('id:', r.id);
    console.log('  product:', String(r.product || '').slice(0, 70));
    console.log('  sold_date in DB:', r.sold_date);
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawIso) && resolveSoldDateIsoForDisplay(rawIso) !== rawIso) {
        console.log('  display ISO (repaired):', resolveSoldDateIsoForDisplay(rawIso));
    }
    console.log('  site should show:', m.label || '(not a recognised ISO date)');
    console.log('');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
