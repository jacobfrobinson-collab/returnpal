'use strict';

const { calendarYearMonthFromDbDate } = require('./soldDateCalendar');

const TIERS = [
    { min_active: 1, max_active: 5, reward_per_referral: 10, label: 'Tier 1' },
    { min_active: 6, max_active: 10, reward_per_referral: 15, label: 'Tier 2' },
    { min_active: 11, max_active: null, reward_per_referral: 20, label: 'Tier 3' },
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

function countPackagesForUser(db, userId) {
    const rows = parseResults(db.exec('SELECT COUNT(*) as c FROM packages WHERE user_id = ?', [userId]));
    return Number(rows[0]?.c) || 0;
}

function tierForActiveCount(n) {
    for (const t of TIERS) {
        if (n >= t.min_active && (t.max_active == null || n <= t.max_active)) return t;
    }
    return null;
}

function countActiveReferrals(db, referrerUserId) {
    const referred = parseResults(
        db.exec('SELECT id FROM users WHERE referred_by = ?', [referrerUserId])
    );
    return referred.filter((r) => countPackagesForUser(db, r.id) > 0).length;
}

function countActiveReferralsInPeriod(db, referrerUserId, periodYm) {
    const referred = parseResults(
        db.exec('SELECT id FROM users WHERE referred_by = ?', [referrerUserId])
    );
    return referred.filter((r) => referredUserActiveInPeriod(db, r.id, periodYm)).length;
}

function referredUserActiveInPeriod(db, referredUserId, periodYm) {
    const rows = parseResults(
        db.exec('SELECT date_added FROM packages WHERE user_id = ?', [referredUserId])
    );
    return rows.some((r) => calendarYearMonthFromDbDate(r.date_added) === periodYm);
}

/**
 * Create pending credits for each referred user who sent a package in periodYm.
 * @param {import('sql.js').Database} db
 * @param {number} referrerUserId
 * @param {string} periodYm
 * @returns {number} total newly accrued amount
 */
function accrueReferralCreditsForPeriod(db, referrerUserId, periodYm) {
    const referred = parseResults(
        db.exec('SELECT id FROM users WHERE referred_by = ?', [referrerUserId])
    );
    const activeInPeriod = referred.filter((r) => referredUserActiveInPeriod(db, r.id, periodYm));
    if (!activeInPeriod.length) return 0;

    const lifetimeActive = countActiveReferrals(db, referrerUserId);
    const tier = tierForActiveCount(lifetimeActive);
    const amountEach = tier ? Number(tier.reward_per_referral) || 0 : 10;

    let totalAccrued = 0;
    for (const r of activeInPeriod) {
        const existing = parseResults(
            db.exec(
                `SELECT id FROM referral_credits
                 WHERE referrer_user_id = ? AND referred_user_id = ? AND credit_period_ym = ?`,
                [referrerUserId, r.id, periodYm]
            )
        );
        if (existing.length) continue;
        db.run(
            `INSERT INTO referral_credits (referrer_user_id, referred_user_id, credit_period_ym, amount, status)
             VALUES (?, ?, ?, ?, 'pending')`,
            [referrerUserId, r.id, periodYm, amountEach]
        );
        totalAccrued += amountEach;
    }
    return Math.round(totalAccrued * 100) / 100;
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 */
function getPendingReferralCreditsTotal(db, userId) {
    const rows = parseResults(
        db.exec(
            `SELECT COALESCE(SUM(amount), 0) AS total FROM referral_credits
             WHERE referrer_user_id = ? AND status = 'pending'`,
            [userId]
        )
    );
    return Number(rows[0]?.total) || 0;
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {string} periodYm
 */
function getPendingReferralCreditsForPeriod(db, userId, periodYm) {
    accrueReferralCreditsForPeriod(db, userId, periodYm);
    const rows = parseResults(
        db.exec(
            `SELECT COALESCE(SUM(amount), 0) AS total FROM referral_credits
             WHERE referrer_user_id = ? AND status = 'pending' AND credit_period_ym = ?`,
            [userId, periodYm]
        )
    );
    return Number(rows[0]?.total) || 0;
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 */
function getReferralCreditsSummary(db, userId) {
    const pending = parseResults(
        db.exec(
            `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS c FROM referral_credits
             WHERE referrer_user_id = ? AND status = 'pending'`,
            [userId]
        )
    );
    const applied = parseResults(
        db.exec(
            `SELECT COALESCE(SUM(amount), 0) AS total FROM referral_credits
             WHERE referrer_user_id = ? AND status = 'applied'`,
            [userId]
        )
    );
    return {
        pending_credits: Number(pending[0]?.total) || 0,
        pending_count: pending[0]?.c || 0,
        applied_credits_total: Number(applied[0]?.total) || 0,
    };
}

/**
 * Apply pending credits for a statement period.
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {string} periodYm
 */
function applyPendingReferralCredits(db, userId, periodYm) {
    accrueReferralCreditsForPeriod(db, userId, periodYm);
    const pending = parseResults(
        db.exec(
            `SELECT id, amount FROM referral_credits
             WHERE referrer_user_id = ? AND status = 'pending' AND credit_period_ym = ?`,
            [userId, periodYm]
        )
    );
    if (!pending.length) return 0;
    let total = 0;
    for (const c of pending) {
        total += Number(c.amount) || 0;
        db.run(
            `UPDATE referral_credits SET status = 'applied', applied_period_ym = ? WHERE id = ?`,
            [periodYm, c.id]
        );
    }
    return Math.round(total * 100) / 100;
}

module.exports = {
    TIERS,
    tierForActiveCount,
    accrueReferralCreditsForPeriod,
    getPendingReferralCreditsTotal,
    getPendingReferralCreditsForPeriod,
    getReferralCreditsSummary,
    applyPendingReferralCredits,
    countActiveReferrals,
    countActiveReferralsInPeriod,
    referredUserActiveInPeriod,
};
