'use strict';

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

function str(v) {
    if (v == null) return '';
    return String(v).trim();
}

function num(v, fallback = NaN) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const n = parseFloat(String(v || '').replace(/[£$,]/g, ''));
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Find an existing applied return_adjustment matching this refund (same client).
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {{ order_number?: string, amount?: unknown, refund_date?: string, reference?: string }} row
 * @returns {{ id: number } | null}
 */
function findReturnAdjustmentDuplicate(db, userId, row) {
    const uid = parseInt(userId, 10);
    if (!Number.isFinite(uid) || uid < 1) return null;

    const amount = num(row.amount, NaN);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    const onum = str(row.order_number).slice(0, 200);
    const { normalizeSoldDateForDb } = require('./adminBulkImport');
    const refundDate = normalizeSoldDateForDb(row.refund_date) || '';
    const reference = str(row.reference).slice(0, 64);

    if (onum) {
        const dupParams = [uid, onum, amount];
        let dupSql =
            `SELECT id FROM return_adjustments WHERE user_id = ? AND status = 'applied'
             AND order_number = ? AND ABS(amount - ?) < 0.02`;
        if (refundDate) {
            dupSql += " AND COALESCE(refund_date, '') = ?";
            dupParams.push(refundDate);
        }
        dupSql += ' LIMIT 1';
        const dup = parseResults(db.exec(dupSql, dupParams));
        if (dup.length) return { id: dup[0].id };
    }

    if (reference) {
        const dup = parseResults(
            db.exec(
                `SELECT id FROM return_adjustments WHERE user_id = ? AND status = 'applied'
                 AND TRIM(reference) = ? AND ABS(amount - ?) < 0.02
                 LIMIT 1`,
                [uid, reference, amount]
            )
        );
        if (dup.length) return { id: dup[0].id };
    }

    return null;
}

/**
 * @param {import('sql.js').Database} db
 * @param {(db: import('sql.js').Database, spec: string) => { userId?: number, error?: string }} resolveClient
 * @param {Array<Record<string, unknown>>} rows
 */
function enrichReturnAdjustmentReviewDuplicates(db, resolveClient, rows) {
    for (const row of rows || []) {
        row.already_imported = false;
        row.duplicate_adjustment_id = null;
        const spec = str(row.client_id);
        if (!spec) continue;
        const res = resolveClient(db, spec);
        if (res.error || res.userId == null) continue;
        const dup = findReturnAdjustmentDuplicate(db, res.userId, {
            order_number: row.order_number,
            amount: row.amount,
            refund_date: row.refund_date,
            reference: row.reference,
        });
        if (dup) {
            row.already_imported = true;
            row.duplicate_adjustment_id = dup.id;
        }
    }
    return rows;
}

module.exports = {
    findReturnAdjustmentDuplicate,
    enrichReturnAdjustmentReviewDuplicates,
};
