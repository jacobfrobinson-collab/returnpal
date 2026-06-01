#!/usr/bin/env node
'use strict';

/**
 * List return_adjustments that have no linked sold_items row (often cancelled orders
 * imported as refunds without a matching sale). Use before/after cleanup.
 *
 *   node scripts/list-orphan-refunds.js
 *   node scripts/list-orphan-refunds.js --user-id 14
 *   node scripts/list-orphan-refunds.js --delete   # destructive: removes listed rows
 */

const path = require('path');
const initSqlJs = require('sql.js');
const fs = require('fs');

const DB_PATH = path.resolve(process.env.DB_PATH || './data/returnpal.db');

function parseArgs(argv) {
    const out = { userId: null, delete: false };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--delete') out.delete = true;
        else if (argv[i] === '--user-id' && argv[i + 1]) out.userId = parseInt(argv[++i], 10);
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv);
    if (!fs.existsSync(DB_PATH)) {
        console.error('Database not found:', DB_PATH);
        process.exit(1);
    }
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB_PATH));
    db.run('PRAGMA foreign_keys = ON;');

    let sql = `
        SELECT r.id, r.user_id, r.order_number, r.product, r.amount, r.refund_date, r.status, r.created_at
        FROM return_adjustments r
        LEFT JOIN sold_items s ON s.id = r.linked_sold_item_id AND s.user_id = r.user_id
        WHERE r.status = 'applied' AND (r.linked_sold_item_id IS NULL OR s.id IS NULL)
    `;
    const params = [];
    if (Number.isFinite(args.userId)) {
        sql += ' AND r.user_id = ?';
        params.push(args.userId);
    }
    sql += ' ORDER BY r.user_id, r.id';

    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
        const o = stmt.getAsObject();
        rows.push({
            id: o.id,
            user_id: o.user_id,
            order_number: o.order_number,
            product: String(o.product || '').slice(0, 80),
            amount: o.amount,
            refund_date: o.refund_date,
            created_at: o.created_at,
        });
    }
    stmt.free();

    console.log('Orphan applied return_adjustments (no valid linked sale):', rows.length);
    if (!rows.length) {
        process.exit(0);
    }
    let total = 0;
    for (const r of rows) {
        total += Number(r.amount) || 0;
        console.log(
            `#${r.id} user ${r.user_id} order ${r.order_number || '—'} £${Number(r.amount).toFixed(2)} ` +
                `${String(r.refund_date || '').slice(0, 10)} | ${r.product}`
        );
    }
    console.log('Total amount (would affect payout if left applied): £' + total.toFixed(2));
    console.log('\nUndo via Admin → Recent spreadsheet imports, or re-run with --delete (writes DB).');

    if (args.delete) {
        const ids = rows.map((r) => r.id);
        for (const id of ids) {
            db.run('DELETE FROM return_adjustments WHERE id = ?', [id]);
        }
        fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
        console.log('Deleted', ids.length, 'row(s). Restart the app if it caches the DB in memory.');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
