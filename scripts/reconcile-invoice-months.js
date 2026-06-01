/**
 * Compare sold_items counts by calendar month vs invoice statement sales count.
 *
 * Usage:
 *   node scripts/reconcile-invoice-months.js --user-id 14
 *   node scripts/reconcile-invoice-months.js --user-id 14 --month 2026-05
 *
 * Set DB_PATH to your database file. Read-only.
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { buildInvoiceMonthSourcesPayload } = require('../src/utils/invoiceMonthDebug');
const { buildInvoicePeriodPayload, parsePeriodYm } = require('../src/utils/computedMonthlyStatements');

const DB_PATH = path.resolve(process.env.DB_PATH || './data/returnpal.db');

function arg(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
}

async function main() {
    const userId = parseInt(arg('--user-id'), 10);
    const onlyMonth = arg('--month');

    if (!Number.isFinite(userId) || userId < 1) {
        console.error('Usage: node scripts/reconcile-invoice-months.js --user-id <id> [--month YYYY-MM]');
        process.exit(1);
    }

    if (!fs.existsSync(DB_PATH)) {
        console.error('Database not found:', DB_PATH);
        process.exit(1);
    }

    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB_PATH));

    const sources = buildInvoiceMonthSourcesPayload(db, userId);
    const months = onlyMonth ? [onlyMonth] : sources.distinct_months;

    console.log('Database:', DB_PATH);
    console.log('User:', userId);
    console.log('Months to check:', months.length, onlyMonth ? '(filtered)' : '');
    console.log('Unparseable sold/return dates:', sources.unparseable.length);
    console.log('');

    let mismatches = 0;

    for (const ym of months) {
        const bucket = sources.months[ym] || { sold_items: [] };
        const sourceSoldCount = bucket.sold_items.length;

        const p = parsePeriodYm(ym);
        if (!p) {
            console.log(ym, '— invalid period');
            mismatches++;
            continue;
        }

        const payload = buildInvoicePeriodPayload(db, userId, p);
        const invoiceSoldCount = payload ? payload._items_count || 0 : -1;

        let status = 'OK';
        if (payload === null) status = 'FAIL (period consistency — run migrate-sold-dates dry-run)';
        else if (sourceSoldCount !== invoiceSoldCount) status = 'MISMATCH';

        if (status !== 'OK') mismatches++;

        console.log(
            ym,
            '| sold_items (month sources):',
            sourceSoldCount,
            '| statement sales:',
            invoiceSoldCount,
            '|',
            status
        );
    }

    console.log('');
    if (mismatches) {
        console.log('Done with', mismatches, 'month(s) needing attention.');
        process.exit(1);
    }
    console.log('All checked months match.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
