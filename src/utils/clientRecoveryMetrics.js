'use strict';

/**
 * Unified recovery metrics: sold profit + reimbursement recovered amounts.
 */

const MILESTONE_THRESHOLDS = [
    { id: '10k', label: '£10k recovered', amount: 10000 },
    { id: '50k', label: '£50k recovered', amount: 50000 },
    { id: '100k', label: '£100k recovered', amount: 100000 },
];

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

function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {{ sinceYmd?: string, untilYmd?: string, periodYm?: string }} [opts]
 */
function getRecoveredBreakdown(db, userId, opts = {}) {
    let soldSql = 'SELECT COALESCE(SUM(profit), 0) AS profit FROM sold_items WHERE user_id = ?';
    let reimbSql =
        'SELECT COALESCE(SUM(recovered_amount), 0) AS total FROM reimbursement_claims WHERE user_id = ?';
    const soldParams = [userId];
    const reimbParams = [userId];

    if (opts.periodYm) {
        const ym = String(opts.periodYm);
        soldSql += ' AND sold_date LIKE ?';
        soldParams.push(ym + '%');
        reimbSql += ' AND (created_at LIKE ? OR submitted_at LIKE ? OR resolved_at LIKE ?)';
        reimbParams.push(ym + '%', ym + '%', ym + '%');
    } else if (opts.sinceYmd) {
        soldSql += ' AND sold_date >= ?';
        soldParams.push(String(opts.sinceYmd).slice(0, 10));
        reimbSql += ' AND (created_at >= ? OR submitted_at >= ? OR resolved_at >= ?)';
        const s = String(opts.sinceYmd).slice(0, 10) + ' 00:00:00';
        reimbParams.push(s, s, s);
        if (opts.untilYmd) {
            soldSql += ' AND sold_date <= ?';
            soldParams.push(String(opts.untilYmd).slice(0, 10));
            reimbSql += ' AND (created_at <= ? OR submitted_at <= ? OR resolved_at <= ?)';
            const e = String(opts.untilYmd).slice(0, 10) + ' 23:59:59';
            reimbParams.push(e, e, e);
        }
    }

    const soldRows = parseResults(db.exec(soldSql, soldParams));
    const reimbRows = parseResults(db.exec(reimbSql, reimbParams));
    const resale_profit = round2(soldRows[0]?.profit);
    const reimbursement_recovered = round2(reimbRows[0]?.total);
    return {
        resale_profit,
        reimbursement_recovered,
        total_recovered: round2(resale_profit + reimbursement_recovered),
    };
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 */
function getLifetimeRecovered(db, userId) {
    return getRecoveredBreakdown(db, userId).total_recovered;
}

/**
 * Percent change in last 30 days vs prior 30 days.
 * @param {import('sql.js').Database} db
 * @param {number} userId
 */
function getLifetimeRecoveredDelta30d(db, userId) {
    const now = new Date();
    const endRecent = now.toISOString().slice(0, 10);
    const startRecent = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
    const endPrior = startRecent;
    const startPrior = new Date(now.getTime() - 60 * 86400000).toISOString().slice(0, 10);

    const recent = getRecoveredBreakdown(db, userId, { sinceYmd: startRecent, untilYmd: endRecent });
    const prior = getRecoveredBreakdown(db, userId, { sinceYmd: startPrior, untilYmd: endPrior });

    if (prior.total_recovered <= 0) {
        return recent.total_recovered > 0 ? 100 : 0;
    }
    return round2(((recent.total_recovered - prior.total_recovered) / prior.total_recovered) * 100);
}

/**
 * @param {number} lifetimeRecovered
 */
function getMilestones(lifetimeRecovered) {
    const total = Number(lifetimeRecovered) || 0;
    const earned = MILESTONE_THRESHOLDS.filter((m) => total >= m.amount);
    const next = MILESTONE_THRESHOLDS.find((m) => total < m.amount) || null;
    const progress_pct = next
        ? Math.min(100, Math.round((total / next.amount) * 1000) / 10)
        : 100;
    return {
        lifetime_recovered: total,
        earned: earned.map((m) => ({ id: m.id, label: m.label, amount: m.amount })),
        next: next ? { id: next.id, label: next.label, amount: next.amount, remaining: round2(next.amount - total) } : null,
        progress_pct,
    };
}

/**
 * Rolling 12-month recovered for loyalty tiers.
 * @param {import('sql.js').Database} db
 * @param {number} userId
 */
function getRolling12mRecovered(db, userId) {
    const since = new Date();
    since.setMonth(since.getMonth() - 12);
    return getRecoveredBreakdown(db, userId, { sinceYmd: since.toISOString().slice(0, 10) }).total_recovered;
}

module.exports = {
    MILESTONE_THRESHOLDS,
    getRecoveredBreakdown,
    getLifetimeRecovered,
    getLifetimeRecoveredDelta30d,
    getMilestones,
    getRolling12mRecovered,
};
