const { getDb, saveDb } = require('../database');
const { runBenchmarkRollup } = require('../utils/clientBenchmarks');
const { maxInvoicablePeriodYm } = require('../utils/computedMonthlyStatements');
const { refreshLoyaltyTier } = require('../utils/loyaltyTiers');

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

async function runBenchmarkRollupOnce() {
    const db = await getDb();
    const period = maxInvoicablePeriodYm();
    runBenchmarkRollup(db, period);

    const users = parseResults(
        db.exec('SELECT id FROM users WHERE COALESCE(is_admin, 0) = 0')
    );
    for (const u of users) {
        try {
            refreshLoyaltyTier(db, u.id);
        } catch (e) {
            console.error('[benchmark-rollup] loyalty', u.id, e.message || e);
        }
    }
    saveDb();
    console.log('[benchmark-rollup] completed for period', period);
}

function startBenchmarkRollupScheduler() {
    let cron;
    try {
        cron = require('node-cron');
    } catch (e) {
        return;
    }
    const expr = process.env.BENCHMARK_ROLLUP_CRON || '0 3 2 * *';
    cron.schedule(
        expr,
        () => runBenchmarkRollupOnce().catch((err) => console.error('[benchmark-rollup]', err)),
        { timezone: process.env.WEEKLY_DIGEST_TZ || 'Europe/London' }
    );
    console.log('[benchmark-rollup] scheduler started:', expr);
}

module.exports = { startBenchmarkRollupScheduler, runBenchmarkRollupOnce };
