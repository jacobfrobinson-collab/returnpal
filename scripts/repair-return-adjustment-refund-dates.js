#!/usr/bin/env node
'use strict';

/**
 * Fix refund_date values stored as sold-item YYYY-DD-MM (e.g. 2026-09-04 = 9 April 2026).
 *
 *   node scripts/repair-return-adjustment-refund-dates.js
 *   node scripts/repair-return-adjustment-refund-dates.js --dry-run
 */
const { getDb, saveDb } = require('../src/database');
const { resolveRefundDateCalendarIso } = require('../src/utils/returnAdjustmentDateDisplay');

function parseResults(result) {
    if (!result || !result.length) return [];
    const cols = result[0].columns;
    return result[0].values.map((row) => {
        const obj = {};
        cols.forEach((col, i) => {
            obj[col] = row[i];
        });
        return obj;
    });
}

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    const db = await getDb();
    const rows = parseResults(
        db.exec(
            `SELECT id, refund_date, product FROM return_adjustments
             WHERE refund_date IS NOT NULL AND length(trim(refund_date)) > 0`
        )
    );
    let updated = 0;
    for (const r of rows) {
        const raw = String(r.refund_date || '').trim();
        const fixed = resolveRefundDateCalendarIso(raw);
        if (!fixed || fixed === raw) continue;
        console.log(
            '#' + r.id + ':',
            raw,
            '→',
            fixed,
            '(' + String(r.product || '').slice(0, 50) + ')'
        );
        if (!dryRun) {
            db.run('UPDATE return_adjustments SET refund_date = ? WHERE id = ?', [fixed, r.id]);
        }
        updated++;
    }
    if (!dryRun && updated) saveDb();
    console.log((dryRun ? 'Would update ' : 'Updated ') + updated + ' row(s).');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
