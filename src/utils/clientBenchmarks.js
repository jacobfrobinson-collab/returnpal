'use strict';

const { getRecoveredBreakdown } = require('./clientRecoveryMetrics');
const { maxInvoicablePeriodYm, parsePeriodYm } = require('./computedMonthlyStatements');

const MIN_COHORT = Number(process.env.BENCHMARK_MIN_COHORT) || 5;

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

function previousYearPeriodYm(ym) {
    const parts = String(ym).split('-').map(Number);
    return parts[0] - 1 + '-' + String(parts[1]).padStart(2, '0');
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {string} periodYm
 */
function getRollup(db, userId, periodYm) {
    const rows = parseResults(
        db.exec(
            'SELECT recovered, packages_count, sold_count FROM benchmark_monthly_rollups WHERE user_id = ? AND period_ym = ?',
            [userId, periodYm]
        )
    );
    if (rows.length) return rows[0];
    return getRecoveredBreakdown(db, userId, { periodYm });
}

/**
 * @param {import('sql.js').Database} db
 * @param {string} periodYm
 */
function getCohortStats(db, periodYm) {
    const rows = parseResults(
        db.exec(
            `SELECT recovered FROM benchmark_monthly_rollups WHERE period_ym = ? AND recovered > 0`,
            [periodYm]
        )
    );
    const values = rows.map((r) => Number(r.recovered) || 0).filter((v) => v > 0);
    if (values.length < MIN_COHORT) {
        return { cohort_size: values.length, median: null, sufficient: false };
    }
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    return { cohort_size: values.length, median, sufficient: true };
}

function pctChange(current, baseline) {
    if (!baseline || baseline <= 0) return current > 0 ? 100 : 0;
    return Math.round(((current - baseline) / baseline) * 1000) / 10;
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {string} [periodYm]
 */
function getClientBenchmarks(db, userId, periodYm) {
    const period = periodYm || maxInvoicablePeriodYm();
    const p = parsePeriodYm(period);
    if (!p) return { error: 'Invalid period' };

    const current = getRollup(db, userId, period);
    const recovered = Number(current.recovered ?? current.total_recovered) || 0;

    const lastYearYm = previousYearPeriodYm(period);
    const lastYear = getRollup(db, userId, lastYearYm);
    const lastYearRecovered = Number(lastYear.recovered ?? lastYear.total_recovered) || 0;

    const cohort = getCohortStats(db, period);
    let vs_cohort_pct = null;
    if (cohort.sufficient && cohort.median > 0) {
        vs_cohort_pct = pctChange(recovered, cohort.median);
    }

    return {
        period,
        recovered,
        vs_last_year_pct: pctChange(recovered, lastYearRecovered),
        last_year_period: lastYearYm,
        last_year_recovered: lastYearRecovered,
        vs_cohort_pct,
        cohort_size: cohort.cohort_size,
        cohort_sufficient: cohort.sufficient,
        disclaimer: cohort.sufficient
            ? 'Compared to anonymized sellers with activity in the same month.'
            : 'Cohort comparison available when enough sellers have data for this month.',
    };
}

/**
 * Upsert monthly rollups for all users (job).
 * @param {import('sql.js').Database} db
 * @param {string} [periodYm]
 */
function runBenchmarkRollup(db, periodYm) {
    const period = periodYm || maxInvoicablePeriodYm();
    const users = parseResults(
        db.exec('SELECT id FROM users WHERE is_admin = 0 OR is_admin IS NULL')
    );
    for (const u of users) {
        const uid = u.id;
        const breakdown = getRecoveredBreakdown(db, uid, { periodYm: period });
        const pkgRows = parseResults(
            db.exec(
                `SELECT COUNT(*) AS c FROM packages WHERE user_id = ? AND date_added LIKE ?`,
                [uid, period + '%']
            )
        );
        const soldRows = parseResults(
            db.exec(
                `SELECT COUNT(*) AS c FROM sold_items WHERE user_id = ? AND sold_date LIKE ?`,
                [uid, period + '%']
            )
        );
        const existing = parseResults(
            db.exec(
                'SELECT id FROM benchmark_monthly_rollups WHERE user_id = ? AND period_ym = ?',
                [uid, period]
            )
        );
        if (existing.length) {
            db.run(
                `UPDATE benchmark_monthly_rollups SET recovered = ?, packages_count = ?, sold_count = ? WHERE user_id = ? AND period_ym = ?`,
                [breakdown.total_recovered, pkgRows[0]?.c || 0, soldRows[0]?.c || 0, uid, period]
            );
        } else {
            db.run(
                `INSERT INTO benchmark_monthly_rollups (user_id, period_ym, recovered, packages_count, sold_count) VALUES (?, ?, ?, ?, ?)`,
                [uid, period, breakdown.total_recovered, pkgRows[0]?.c || 0, soldRows[0]?.c || 0]
            );
        }
    }
}

module.exports = { getClientBenchmarks, runBenchmarkRollup, MIN_COHORT };
