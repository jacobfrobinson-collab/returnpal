'use strict';

const { getRolling12mRecovered } = require('./clientRecoveryMetrics');

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

function silverRecoveredThreshold() {
    return Number(process.env.LOYALTY_SILVER_RECOVERED_GBP) || 5000;
}
function goldRecoveredThreshold() {
    return Number(process.env.LOYALTY_GOLD_RECOVERED_GBP) || 25000;
}
function silverPackagesThreshold() {
    return Number(process.env.LOYALTY_SILVER_PACKAGES) || 20;
}
function goldPackagesThreshold() {
    return Number(process.env.LOYALTY_GOLD_PACKAGES) || 80;
}

const TIER_META = {
    standard: { label: 'Standard', sla: '48h query SLA', perk: 'Standard processing' },
    silver: { label: 'Silver', sla: '24h query SLA', perk: 'Priority processing queue' },
    gold: { label: 'Gold', sla: '12h query SLA', perk: 'Priority processing + dedicated support' },
};

/**
 * @param {number} recovered12m
 * @param {number} packages12m
 */
function computeTierFromMetrics(recovered12m, packages12m) {
    const r = Number(recovered12m) || 0;
    const p = Number(packages12m) || 0;
    if (r >= goldRecoveredThreshold() || p >= goldPackagesThreshold()) return 'gold';
    if (r >= silverRecoveredThreshold() || p >= silverPackagesThreshold()) return 'silver';
    return 'standard';
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 */
function countPackages12m(db, userId) {
    const rows = parseResults(
        db.exec(
            `SELECT COUNT(*) AS c FROM packages WHERE user_id = ? AND date_added >= datetime('now', '-12 months')`,
            [userId]
        )
    );
    return Number(rows[0]?.c) || 0;
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 */
function refreshLoyaltyTier(db, userId) {
    const recovered = getRolling12mRecovered(db, userId);
    const packages = countPackages12m(db, userId);
    const tier = computeTierFromMetrics(recovered, packages);
    const existing = parseResults(
        db.exec('SELECT user_id FROM client_loyalty_tiers WHERE user_id = ?', [userId])
    );
    if (existing.length) {
        db.run(
            `UPDATE client_loyalty_tiers SET tier = ?, rolling_12m_recovered = ?, rolling_12m_packages = ?,
             updated_at = datetime('now') WHERE user_id = ?`,
            [tier, recovered, packages, userId]
        );
    } else {
        db.run(
            `INSERT INTO client_loyalty_tiers (user_id, tier, rolling_12m_recovered, rolling_12m_packages) VALUES (?, ?, ?, ?)`,
            [userId, tier, recovered, packages]
        );
    }
    return getLoyaltyTier(db, userId);
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 */
function getLoyaltyTier(db, userId) {
    const rows = parseResults(
        db.exec('SELECT * FROM client_loyalty_tiers WHERE user_id = ?', [userId])
    );
    let tier = rows[0]?.tier || 'standard';
    const meta = TIER_META[tier] || TIER_META.standard;
    return {
        tier,
        label: meta.label,
        sla: meta.sla,
        perk: meta.perk,
        rolling_12m_recovered: Number(rows[0]?.rolling_12m_recovered) || 0,
        rolling_12m_packages: Number(rows[0]?.rolling_12m_packages) || 0,
    };
}

module.exports = {
    TIER_META,
    computeTierFromMetrics,
    refreshLoyaltyTier,
    getLoyaltyTier,
};
