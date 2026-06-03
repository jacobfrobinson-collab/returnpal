/**
 * Fix sold_items.sold_date for every client in a payout CSV (order_number match).
 * Use when a bulk import stored legacy-wire values as calendar
 * (e.g. DB 2025-06-12 shown as June 12th but sale was 2025-12-06).
 *
 * Default: all clients and all matching orders in the file (not Chi-only).
 *
 * Usage (dry run):
 *   node scripts/repair-sold-dates-from-payout-csv.js --csv "C:/path/Previous Year Payout.csv"
 *   node scripts/repair-sold-dates-from-payout-csv.js --csv payout.csv --job-id 38
 *   node scripts/repair-sold-dates-from-payout-csv.js --csv payout.csv --import-jobs-only
 *
 * Apply:
 *   node scripts/repair-sold-dates-from-payout-csv.js --csv payout.csv --apply
 *
 * Stop the app before --apply on production. Back up DB_PATH first.
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
const { mapSoldItemDatesForApi } = require('../src/utils/soldDateDisplayRepair');

const DB_PATH = path.resolve(process.env.DB_PATH || './data/returnpal.db');

function arg(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
}

function hasFlag(name) {
    return process.argv.includes(name);
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

function loadImportJobSoldIds(db) {
    return new Set(
        parseResults(
            db.exec(
                `SELECT e.entity_id
                 FROM bulk_import_job_entries e
                 INNER JOIN bulk_import_jobs j ON j.id = e.job_id
                 WHERE e.entity_table = 'sold_items'
                   AND j.rolled_back_at IS NULL`
            )
        ).map((r) => parseInt(r.entity_id, 10))
    );
}

function clientLabel(brief) {
    if (!brief) return '(unknown user)';
    const leg = brief.legacy_client_id ? ` legacy=${brief.legacy_client_id}` : '';
    const name = brief.name ? ` ${brief.name}` : '';
    return `user ${brief.user_id}${name} <${brief.email}>${leg}`;
}

async function main() {
    const csvPath = arg('--csv');
    const apply = hasFlag('--apply');
    const jobId = parseInt(arg('--job-id'), 10);
    const importJobsOnly = hasFlag('--import-jobs-only');

    if (!csvPath || !fs.existsSync(csvPath)) {
        console.error('Provide --csv path to payout import file (Client ID,sold_date,order_number,...).');
        process.exit(1);
    }
    if (!fs.existsSync(DB_PATH)) {
        console.error('Database not found:', DB_PATH);
        process.exit(1);
    }

    const buf = fs.readFileSync(csvPath);
    const rows = parseSpreadsheetBuffer(buf);
    if (!rows.length) {
        console.error('No data rows in CSV.');
        process.exit(1);
    }

    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB_PATH));

    let jobEntityIds = null;
    if (Number.isFinite(jobId)) {
        jobEntityIds = new Set(
            parseResults(
                db.exec(
                    'SELECT entity_id FROM bulk_import_job_entries WHERE job_id = ? AND entity_table = ?',
                    [jobId, 'sold_items']
                )
            ).map((r) => parseInt(r.entity_id, 10))
        );
        console.log('Scope: bulk import job', jobId, '→', jobEntityIds.size, 'sold_items');
    } else if (importJobsOnly) {
        jobEntityIds = loadImportJobSoldIds(db);
        console.log('Scope: all non-rolled-back sold bulk imports →', jobEntityIds.size, 'sold_items');
    } else {
        console.log('Scope: all clients — every order_number in CSV that exists in sold_items');
    }

    let wouldUpdate = 0;
    let matched = 0;
    let skipped = 0;
    const samples = [];
    /** @type {Map<number, { matched: number, updates: number, brief: object|null }>} */
    const byUser = new Map();

    function bumpUser(userId, field) {
        let u = byUser.get(userId);
        if (!u) {
            u = { matched: 0, updates: 0, brief: lookupUserBrief(db, userId) };
            byUser.set(userId, u);
        }
        u[field]++;
    }

    for (const row of rows) {
        const clientSpec = row.client_id || row.clientId || '';
        const resolved = resolveUserIdFromClientSpecifier(db, clientSpec);
        const userId = resolved && resolved.userId;
        if (!userId) {
            skipped++;
            continue;
        }
        const orderNumber = String(row.order_number || '').trim();
        const targetDate = normalizeSoldDateForDb(row.sold_date);
        if (!orderNumber || !targetDate) {
            skipped++;
            continue;
        }

        const existing = parseResults(
            db.exec(
                'SELECT id, sold_date, product FROM sold_items WHERE user_id = ? AND order_number = ?',
                [userId, orderNumber]
            )
        );
        if (!existing.length) {
            skipped++;
            continue;
        }

        for (const si of existing) {
            if (jobEntityIds && !jobEntityIds.has(parseInt(si.id, 10))) continue;
            matched++;
            bumpUser(userId, 'matched');
            const stored = String(si.sold_date || '').trim();
            if (stored === targetDate) continue;

            const before = mapSoldItemDatesForApi(stored, normalizeSoldDateForDb);
            const after = mapSoldItemDatesForApi(targetDate, normalizeSoldDateForDb);
            wouldUpdate++;
            bumpUser(userId, 'updates');
            if (samples.length < 20) {
                samples.push({
                    userId,
                    id: si.id,
                    order: orderNumber,
                    stored,
                    targetDate,
                    labelBefore: before.label,
                    labelAfter: after.label,
                    product: String(si.product || '').slice(0, 50),
                });
            }
            if (apply) {
                db.run('UPDATE sold_items SET sold_date = ? WHERE id = ?', [targetDate, si.id]);
            }
        }
    }

    console.log('\nCSV rows:', rows.length);
    console.log('Matched sold_items:', matched);
    console.log('Would update:', wouldUpdate, apply ? '(applied)' : '(dry run — use --apply)');
    console.log('Skipped (no client / order / row):', skipped);

    const clientRows = [...byUser.entries()]
        .filter(([, v]) => v.updates > 0 || v.matched > 0)
        .sort((a, b) => b[1].updates - a[1].updates);
    if (clientRows.length) {
        console.log('\nPer client:');
        for (const [, v] of clientRows) {
            console.log(
                ' ',
                clientLabel(v.brief),
                '| matched',
                v.matched,
                '| would update',
                v.updates
            );
        }
    }

    if (samples.length) {
        console.log('\nSample fixes:');
        for (const s of samples) {
            console.log(
                '  user',
                s.userId,
                'id',
                s.id,
                s.order,
                '|',
                s.stored,
                '→',
                s.targetDate,
                '|',
                s.labelBefore,
                '→',
                s.labelAfter,
                '|',
                s.product
            );
        }
    }

    if (apply && wouldUpdate > 0) {
        fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
        console.log('\nApplied', wouldUpdate, 'update(s) across', clientRows.filter(([, v]) => v.updates > 0).length, 'client(s).');
        console.log('Restart app; hard-refresh sold lists and invoice pages (Ctrl+F5) — no per-client script needed.');
    } else if (!apply && wouldUpdate > 0) {
        console.log('\nRe-run with --apply after backup to write changes for all clients above.');
    } else if (wouldUpdate === 0) {
        console.log('\nNo mismatches between CSV and DB for this scope.');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
