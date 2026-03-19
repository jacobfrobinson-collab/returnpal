const express = require('express');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const TIERS = [
    { min_active: 1, max_active: 5, reward_per_referral: 10, label: 'Tier 1' },
    { min_active: 6, max_active: 10, reward_per_referral: 15, label: 'Tier 2' },
    { min_active: 11, max_active: null, reward_per_referral: 20, label: 'Tier 3' }
];

// GET /api/referrals – referral link, tiers, and list (empty until referrals feature is fully implemented)
router.get('/', authMiddleware, (req, res) => {
    try {
        const baseUrl = process.env.FRONTEND_URL || (req.protocol + '://' + req.get('host'));
        const referralCode = 'RP' + req.user.id;
        const referralLink = baseUrl.replace(/\/$/, '') + '/register.html?ref=' + encodeURIComponent(referralCode);

        const referrals = [];
        const activeCount = referrals.filter(r => r.status === 'Active').length;
        const total_earned = referrals.reduce((s, r) => s + (Number(r.earned) || 0), 0);

        let currentTier = TIERS[0];
        let nextTier = TIERS[1] || null;
        for (let i = 0; i < TIERS.length; i++) {
            const t = TIERS[i];
            if (activeCount >= t.min_active && (t.max_active == null || activeCount <= t.max_active)) {
                currentTier = t;
                nextTier = TIERS[i + 1] || null;
                break;
            }
        }
        const activeRequired = nextTier ? Math.max(0, (nextTier.min_active || 0) - activeCount) : 0;
        const nextTierWithRequired = nextTier ? { ...nextTier, active_required: activeRequired } : null;

        res.json({
            referral_code: referralCode,
            referral_link: referralLink,
            referrals,
            total_earned,
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
