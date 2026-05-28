#!/usr/bin/env node
'use strict';

/**
 * Audit payout / returns for a client by legacy Client ID (e.g. BD).
 *
 * Run from repo root on Render:
 *   cd ~/project
 *   node scripts/check-client-legacy-id.js BD
 */

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { getDb } = require('../src/database');
const {
    getComputedMonthlyStatements,
    buildInvoicePeriodPayload,
    parsePeriodYm,
} = require('../src/utils/computedMonthlyStatements');

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

function findUsersByLegacyId(db, legacyId) {
    const spec = String(legacyId || '').trim();
    if (!spec) return [];
    return parseResults(
        db.exec(
            `SELECT id, email, full_name, company_name, COALESCE(legacy_client_id, '') AS legacy_client_id
             FROM users
             WHERE LOWER(TRIM(COALESCE(legacy_client_id, ''))) = LOWER(?)
                OR LOWER(COALESCE(legacy_client_id, '')) LIKE '%' || LOWER(?) || '%'
             ORDER BY id`,
            [spec, spec]
        )
    );
}

function auditUser(db, user) {
    const uid = user.id;
    console.log('\n====================================================');
    console.log(
        'User:',
        uid,
        '| legacy_client_id:',
        user.legacy_client_id,
        '|',
        user.email || user.full_name || user.company_name
    );

    const { invoices } = getComputedMonthlyStatements(db, uid);
    if (!invoices.length) {
        console.log('No statement periods found.');
        return;
    }

    const latest = invoices[0];
    const period = latest.period;
    const p = parsePeriodYm(period);
    if (!p) {
        console.log('Latest invoice period invalid:', period);
        return;
    }

    const detail = buildInvoicePeriodPayload(db, uid, p);
    const s = detail.summary;

    console.log('Latest period:', period);
    console.log('Sales (your share):', s.sales_profit);
    console.log('Returns & clawbacks:', s.refunds_and_returns);
    console.log('Processing fees (informational):', s.fees_deducted);
    console.log('Net payout estimate:', s.net_payout_estimate);

    const refundedSold = detail.statement_lines
        .filter((l) => l.kind === 'return' || (l.kind === 'sale' && Number(l.amount) < 0))
        .reduce((sum, l) => sum + Math.abs(Number(l.amount) || 0), 0);

    const adjustmentsInPeriod = detail.return_lines.reduce(
        (sum, r) => sum + (Number(r.amount) || 0),
        0
    );

    console.log('--- Components (this period) ---');
    console.log('Return lines in period (return_adjustments):', Math.round(adjustmentsInPeriod * 100) / 100);
    console.log('Refunded sold lines in period (from statement):', Math.round(refundedSold * 100) / 100);
    console.log(
        'Check sum ~= refunds_and_returns:',
        Math.round((adjustmentsInPeriod + refundedSold) * 100) / 100,
        '(may differ slightly if logic overlaps)'
    );

    const appliedAllTime = parseResults(
        db.exec(
            `SELECT COALESCE(SUM(amount), 0) AS v, COUNT(*) AS c
             FROM return_adjustments WHERE user_id = ? AND status = 'applied'`,
            [uid]
        )
    )[0];

    console.log('Applied return_adjustments (all-time):', appliedAllTime.v, '| count:', appliedAllTime.c);

    console.log('--- Top applied return_adjustments (all-time, largest first) ---');
    const topAdj = parseResults(
        db.exec(
            `SELECT id, product, amount, refund_date, order_number, reference, linked_sold_item_id
             FROM return_adjustments
             WHERE user_id = ? AND status = 'applied'
             ORDER BY amount DESC
             LIMIT 20`,
            [uid]
        )
    );
    for (const r of topAdj) {
        console.log(
            `#${r.id} £${Number(r.amount).toFixed(2)} | ${String(r.refund_date || '').slice(0, 10)} | order ${r.order_number || '—'} | linked sold #${r.linked_sold_item_id ?? '—'} | ${String(r.product || '').slice(0, 70)}`
        );
    }

    console.log('--- Possible duplicate adjustments (same order + amount) ---');
    const dups = parseResults(
        db.exec(
            `SELECT order_number, amount, COUNT(*) AS c, GROUP_CONCAT(id) AS ids
             FROM return_adjustments
             WHERE user_id = ? AND status = 'applied' AND TRIM(COALESCE(order_number,'')) <> ''
             GROUP BY order_number, ROUND(amount, 2)
             HAVING COUNT(*) > 1
             ORDER BY c DESC, amount DESC
             LIMIT 15`,
            [uid]
        )
    );
    if (!dups.length) console.log('(none found by order_number + amount)');
    else dups.forEach((d) => console.log(`order ${d.order_number} £${d.amount} x${d.c} ids=${d.ids}`));
}

async function main() {
    const legacyId = process.argv[2] || process.env.LEGACY_CLIENT_ID || 'BD';
    const db = await getDb();
    const users = findUsersByLegacyId(db, legacyId);

    if (!users.length) {
        console.log(`No users matched legacy_client_id "${legacyId}".`);
        console.log('Tip: check users.legacy_client_id in admin or DB for the exact code.');
        process.exit(1);
    }

    console.log(`Matched ${users.length} user(s) for legacy_client_id "${legacyId}":`);
    users.forEach((u) => {
        console.log(`  - id ${u.id} | ${u.legacy_client_id} | ${u.email || u.full_name}`);
    });

    for (const u of users) auditUser(db, u);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
