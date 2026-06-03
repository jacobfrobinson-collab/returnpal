/**
 * Platform-wide sold-date audit: every client with sold_items.
 * Optional --csv compares DB dates to payout file order matches (same logic as repair script).
 *
 *   node scripts/audit-sold-dates-by-client.js
 *   node scripts/audit-sold-dates-by-client.js --csv "C:/path/Previous Year Payout.csv"
 */
'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const {
    parseSpreadsheetBuffer,
    normalizeSoldDateForDb,
    resolveUserIdFromClientSpecifier,
    lookupUserBrief,
} = require('../src/utils/adminBulkImport');

const DB_PATH = path.resolve(process.env.DB_PATH || './data/returnpal.db');

function arg(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
}

function parseResults(result) {
    if (!result || !result.length) return [];
    const cols = result[0].columns;
    return result[0].values.map((row) => {
        const o = {};
        cols.forEach((c, i) => {
            o[c] = row[i];
        });
        return o;
    });
}

function clientLabel(brief) {
    if (!brief) return '(unknown)';
    const leg = brief.legacy_client_id ? ` [${brief.legacy_client_id}]` : '';
    return `${brief.user_id}${leg} ${brief.name || brief.email}`;
}

function buildCsvMismatchIndex(db, csvPath) {
    const buf = fs.readFileSync(csvPath);
    const rows = parseSpreadsheetBuffer(buf);
    /** @type {Map<number, number>} */
    const mismatchByUser = new Map();

    for (const row of rows) {
        const clientSpec = row.client_id || row.clientId || '';
        const resolved = resolveUserIdFromClientSpecifier(db, clientSpec);
        const userId = resolved && resolved.userId;
        if (!userId) continue;
        const orderNumber = String(row.order_number || '').trim();
        const targetDate = normalizeSoldDateForDb(row.sold_date);
        if (!orderNumber || !targetDate) continue;

        const existing = parseResults(
            db.exec(
                'SELECT id, sold_date FROM sold_items WHERE user_id = ? AND order_number = ?',
                [userId, orderNumber]
            )
        );
        for (const si of existing) {
            const stored = String(si.sold_date || '').trim();
            if (stored && stored !== targetDate) {
                mismatchByUser.set(userId, (mismatchByUser.get(userId) || 0) + 1);
            }
        }
    }
    return { rows: rows.length, mismatchByUser };
}

async function main() {
    if (!fs.existsSync(DB_PATH)) {
        console.error('Database not found:', DB_PATH);
        process.exit(1);
    }

    const csvPath = arg('--csv');
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB_PATH));

    let csvIndex = null;
    if (csvPath) {
        if (!fs.existsSync(csvPath)) {
            console.error('CSV not found:', csvPath);
            process.exit(1);
        }
        csvIndex = buildCsvMismatchIndex(db, csvPath);
        console.log('Payout CSV:', csvPath, '| data rows:', csvIndex.rows);
    }

    const totals = parseResults(
        db.exec(
            `SELECT user_id, COUNT(*) AS n,
                    SUM(CASE WHEN sold_date >= '2025-01-01' AND sold_date < '2025-09-25' THEN 1 ELSE 0 END) AS early_2025,
                    SUM(CASE WHEN sold_date >= '2025-09-25' AND sold_date <= '2025-12-31' THEN 1 ELSE 0 END) AS payout_window_2025
             FROM sold_items
             GROUP BY user_id
             ORDER BY n DESC`
        )
    );

    const importCounts = parseResults(
        db.exec(
            `SELECT j.target_user_id AS user_id, COUNT(DISTINCT e.entity_id) AS imported_sold
             FROM bulk_import_job_entries e
             INNER JOIN bulk_import_jobs j ON j.id = e.job_id
             WHERE e.entity_table = 'sold_items' AND j.rolled_back_at IS NULL
             GROUP BY j.target_user_id`
        )
    );
    const importedByUser = new Map(importCounts.map((r) => [r.user_id, r.imported_sold]));

    console.log('Database:', DB_PATH);
    console.log('Clients with sold_items:', totals.length);
    console.log(
        '\nColumns: total | Jan–Aug 2025 stored | Sep–Dec 2025 stored | bulk-import sold rows | CSV≠DB (if --csv)'
    );
    console.log('—'.repeat(88));

    let platformCsvMismatch = 0;
    for (const row of totals) {
        const uid = row.user_id;
        const brief = lookupUserBrief(db, uid);
        const csvMismatch = csvIndex ? csvIndex.mismatchByUser.get(uid) || 0 : null;
        if (csvMismatch) platformCsvMismatch += csvMismatch;
        const parts = [
            clientLabel(brief).padEnd(42),
            String(row.n).padStart(5),
            String(row.early_2025).padStart(6),
            String(row.payout_window_2025).padStart(6),
            String(importedByUser.get(uid) || 0).padStart(8),
        ];
        if (csvIndex) parts.push(String(csvMismatch).padStart(8));
        console.log(parts.join(' | '));
    }

    if (csvIndex) {
        console.log('\nTotal sold_items where CSV calendar date ≠ DB (all clients):', platformCsvMismatch);
        if (platformCsvMismatch > 0) {
            console.log('Repair (dry run, all clients):');
            console.log('  npm run repair:sold-dates-from-csv -- --csv "' + csvPath.replace(/"/g, '\\"') + '"');
            console.log('Then --apply after backup.');
        }
    } else {
        console.log('\nTip: pass --csv with your payout file to see per-client CSV vs DB mismatches.');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
