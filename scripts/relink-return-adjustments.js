#!/usr/bin/env node
/**
 * Fix all refund/return rows linked to the wrong sold item (every client).
 *
 * Re-runs linking with current rules (order + product on multi-line orders, token
 * title match) and clears links that are implausible (e.g. £151 refund on £3.51 sale).
 *
 * Usage (from project root, on the machine that holds returnpal.db):
 *
 *   npm run relink-refunds:dry          # preview changes, no DB write
 *   npm run relink-refunds              # fix wrong links; keep good existing links
 *
 *   --aggressive                        # also unlink when no new match (old behaviour)
 *
 *   node scripts/relink-return-adjustments.js --dry-run
 *   node scripts/relink-return-adjustments.js
 *   node scripts/relink-return-adjustments.js --user-id=42 --dry-run
 */

'use strict';

const { getDb, saveDb } = require('../src/database');
const {
    resolveRelinkedSoldItemId,
    isReturnAdjustmentLinkPlausible,
    getSoldItemById,
    parseResults,
} = require('../src/utils/returnAdjustmentSoldLink');

function parseArgs(argv) {
    let userId = null;
    let dryRun = false;
    let help = false;
    let aggressive = false;
    for (const a of argv.slice(2)) {
        if (a === '--help' || a === '-h') help = true;
        else if (a === '--dry-run') dryRun = true;
        else if (a === '--aggressive') aggressive = true;
        else if (a.startsWith('--user-id=')) userId = parseInt(a.split('=')[1], 10);
    }
    return { userId, dryRun, help, aggressive };
}

function resolveTargetId(db, row, aggressive) {
    const prev = row.linked_sold_item_id != null ? parseInt(row.linked_sold_item_id, 10) : null;
    const next = resolveRelinkedSoldItemId(db, row.user_id, row);
    if (aggressive) return next;
    if (prev === next) return prev;
    if (prev && !next) {
        const soldPrev = getSoldItemById(db, row.user_id, prev);
        if (isReturnAdjustmentLinkPlausible(row, soldPrev)) return prev;
    }
    return next;
}

function printHelp() {
    console.log(`Fix mis-linked return_adjustments for all clients (or one user).

  npm run relink-refunds:dry     Preview what would change
  npm run relink-refunds         Apply fixes (writes returnpal.db)

  node scripts/relink-return-adjustments.js [--dry-run] [--user-id=N]

Stop the API first if it shares the same database file.`);
}

async function main() {
    const { userId, dryRun, help, aggressive } = parseArgs(process.argv);
    if (help) {
        printHelp();
        return;
    }

    const db = await getDb();
    const params = [];
    let where = `status IN ('applied', 'pending')`;
    if (Number.isFinite(userId) && userId > 0) {
        where += ` AND user_id = ?`;
        params.push(userId);
    }

    const rows = parseResults(
        db.exec(
            `SELECT id, user_id, order_number, product, reference, amount, linked_sold_item_id
             FROM return_adjustments WHERE ${where} ORDER BY user_id, id`,
            params
        )
    );

    let changed = 0;
    let unlinked = 0;
    let relinked = 0;
    let newlyLinked = 0;

    for (const r of rows) {
        const prev = r.linked_sold_item_id != null ? parseInt(r.linked_sold_item_id, 10) : null;
        const nextId = resolveTargetId(db, r, aggressive);
        if (prev === nextId) continue;

        changed++;
        if (!prev && nextId) newlyLinked++;
        else if (prev && !nextId) unlinked++;
        else if (nextId && prev !== nextId) relinked++;

        const amt = Number(r.amount) || 0;
        console.log(
            `${dryRun ? '[dry-run] ' : ''}#${r.id} user=${r.user_id} £${amt.toFixed(2)}: sold #${prev ?? '—'} → #${nextId ?? '—'} | ${(r.product || '').slice(0, 70)}`
        );
        if (!dryRun) {
            db.run(`UPDATE return_adjustments SET linked_sold_item_id = ? WHERE id = ?`, [nextId, r.id]);
        }
    }

    if (!dryRun && changed) await saveDb(db);

    const scope = Number.isFinite(userId) && userId > 0 ? `user ${userId}` : 'all users';
    console.log('');
    console.log(
        `Done (${scope}). ${changed} of ${rows.length} refund rows ${dryRun ? 'would change' : 'updated'} (${relinked} moved, ${newlyLinked} newly linked, ${unlinked} unlinked).`
    );
    if (!aggressive && !dryRun) {
        console.log('Tip: use --aggressive only if you intend to clear links that cannot be re-matched.');
    }
    if (dryRun && changed) {
        console.log('Run without --dry-run (or: npm run relink-refunds) to apply.');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
