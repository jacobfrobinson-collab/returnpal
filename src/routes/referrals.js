const express = require('express');
const { getDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const TIERS = [
    { min_active: 1, max_active: 5, reward_per_referral: 10, label: 'Tier 1' },
    { min_active: 6, max_active: 10, reward_per_referral: 15, label: 'Tier 2' },
    { min_active: 11, max_active: null, reward_per_referral: 20, label: 'Tier 3' }
];

function parseResults(result) {
    if (!result || result.length === 0) return [];
    const cols = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        cols.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

function countPackagesForUser(db, userId) {
    const rows = parseResults(
        db.exec('SELECT COUNT(*) as c FROM packages WHERE user_id = ?', [userId])
    );
    if (!rows.length) return 0;
    const c = rows[0].c;
    return typeof c === 'number' ? c : parseInt(c, 10) || 0;
}

// GET /api/referrals – referral link, tiers, and referred users
router.get('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const baseUrl = process.env.FRONTEND_URL || (req.protocol + '://' + req.get('host'));
        const referralCode = 'RP' + req.user.id;
        // /register.html redirects to login with ?ref= & openRegister=1 (see server.js)
        const referralLink = baseUrl.replace(/\/$/, '') + '/register.html?ref=' + encodeURIComponent(referralCode);

        const referredRows = parseResults(
            db.exec(
                'SELECT id, email, full_name, created_at FROM users WHERE referred_by = ? ORDER BY created_at DESC',
                [req.user.id]
            )
        );

        const referrals = referredRows.map((row) => {
            const uid = row.id;
            const pkgCount = countPackagesForUser(db, uid);
            const status = pkgCount > 0 ? 'Active' : 'Signed up';
            return {
                id: uid,
                email: row.email,
                referred_at: row.created_at,
                status,
                earned: null
            };
        });

        const activeCount = referrals.filter(r => r.status === 'Active').length;

        /** Which reward band applies given number of active referrals (1–5, 6–10, 11+). None if zero actives. */
        function tierForActiveCount(n) {
            for (const t of TIERS) {
                if (n >= t.min_active && (t.max_active == null || n <= t.max_active)) return t;
            }
            return null;
        }

        const currentTier = tierForActiveCount(activeCount);
        const rewardEach = currentTier ? Number(currentTier.reward_per_referral) || 0 : 0;
        referrals.forEach((r) => {
            r.earned = r.status === 'Active' ? rewardEach : 0;
        });

        const total_earned = referrals.reduce((s, r) => s + (Number(r.earned) || 0), 0);

        let nextTier = null;
        let activeRequired = 0;
        if (activeCount === 0) {
            nextTier = TIERS[0];
            activeRequired = 1;
        } else if (currentTier) {
            const idx = TIERS.indexOf(currentTier);
            if (idx >= 0 && idx < TIERS.length - 1) {
                nextTier = TIERS[idx + 1];
                activeRequired = Math.max(0, nextTier.min_active - activeCount);
            }
        }

        const nextTierWithRequired = nextTier
            ? { ...nextTier, active_required: activeRequired }
            : null;

        res.json({
            referral_code: referralCode,
            referral_link: referralLink,
            referrals,
            total_earned,
            active_count: activeCount,
            tiers: TIERS,
            current_tier: currentTier,
            next_tier: nextTierWithRequired
        });
    } catch (err) {
        console.error('Get referrals error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
