#!/usr/bin/env node
/**
 * Re-run sold-item linking for return_adjustments (fixes mis-linked multi-item orders).
 *
 * Usage:
 *   node scripts/relink-return-adjustments.js [--user-id=123] [--dry-run]
 */

const { getDb, saveDb } = require('../src/database');
const { findLinkedSoldItemId, parseResults } = require('../src/utils/returnAdjustmentSoldLink');

function parseArgs(argv) {
    let userId = null;
    let dryRun = false;
    for (const a of argv.slice(2)) {
        if (a === '--dry-run') dryRun = true;
        else if (a.startsWith('--user-id=')) userId = parseInt(a.split('=')[1], 10);
    }
    return { userId, dryRun };
}

async function main() {
    const { userId, dryRun } = parseArgs(process.argv);
    const db = await getDb();
    const params = [];
    let where = `status IN ('applied', 'pending')`;
    if (Number.isFinite(userId) && userId > 0) {
        where += ` AND user_id = ?`;
        params.push(userId);
    }
    const rows = parseResults(
        db.exec(
            `SELECT id, user_id, order_number, product, reference, linked_sold_item_id
             FROM return_adjustments WHERE ${where} ORDER BY id`,
            params
        )
    );
    let changed = 0;
    for (const r of rows) {
        const next = findLinkedSoldItemId(db, r.user_id, {
            orderNumber: r.order_number,
            product: r.product,
            reference: r.reference,
        });
        const prev = r.linked_sold_item_id != null ? parseInt(r.linked_sold_item_id, 10) : null;
        const nextId = next != null ? next : null;
        if (prev !== nextId) {
            changed++;
            console.log(
                `${dryRun ? '[dry-run] ' : ''}#${r.id} user=${r.user_id}: linked ${prev ?? 'null'} → ${nextId ?? 'null'} (${r.product?.slice(0, 60) || ''})`
            );
            if (!dryRun) {
                db.run(`UPDATE return_adjustments SET linked_sold_item_id = ? WHERE id = ?`, [nextId, r.id]);
            }
        }
    }
    if (!dryRun && changed) await saveDb(db);
    console.log(`Done. ${changed} of ${rows.length} adjustments would change linking.`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
