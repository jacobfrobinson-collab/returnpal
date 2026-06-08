'use strict';

/**
 * Value-based client share tiers (aligned with eBay payout import scripts).
 * Client keeps 75% / 80% / 85% of sale value → ReturnPal fee 25% / 20% / 15%.
 *
 * Env:
 *   EBAY_PAYOUT_TIERED_SINCE — YYYY-MM-DD; sales before this use flat legacy share
 *   EBAY_PAYOUT_LEGACY_CLIENT_SHARE — default 0.75 (25% fee) for pre-tiered sales
 */

function parseTieredSinceUtcMidnight() {
    const raw = String(process.env.EBAY_PAYOUT_TIERED_SINCE || '2025-12-01').trim();
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return new Date(Date.UTC(2025, 11, 1));
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) {
        return new Date(Date.UTC(2025, 11, 1));
    }
    return new Date(Date.UTC(y, mo - 1, d));
}

function parseSoldDateLoose(soldDateStr) {
    const raw = String(soldDateStr || '').trim();
    if (!raw) return null;
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
        const y = parseInt(m[1], 10);
        const mo = parseInt(m[2], 10);
        const d = parseInt(m[3], 10);
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return new Date(Date.UTC(y, mo - 1, d));
    }
    const dt = new Date(raw);
    if (!Number.isNaN(dt.getTime())) {
        return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
    }
    return null;
}

function usesLegacyFlatClientShare(soldDateStr) {
    const d = parseSoldDateLoose(soldDateStr);
    if (!d) return false;
    return d.getTime() < parseTieredSinceUtcMidnight().getTime();
}

function legacyClientShareFraction() {
    const x = parseFloat(String(process.env.EBAY_PAYOUT_LEGACY_CLIENT_SHARE || '0.75'));
    return Number.isFinite(x) && x > 0 && x < 1 ? x : 0.75;
}

/** Tiered client share by sale/refund value (same bands as payout CSV import). */
function clientShareRateTiered(value) {
    const n = Number(value) || 0;
    if (n <= 50) return 0.75;
    if (n <= 150) return 0.8;
    return 0.85;
}

/**
 * @param {number} value — gross sale or adjusted net used for band lookup
 * @param {string} [soldDateStr]
 */
function clientShareRateForValue(value, soldDateStr) {
    if (usesLegacyFlatClientShare(soldDateStr)) return legacyClientShareFraction();
    return clientShareRateTiered(value);
}

function feePercentForValue(value, soldDateStr) {
    return Math.round((1 - clientShareRateForValue(value, soldDateStr)) * 10000) / 10000;
}

/** Human-readable tier bands for UI/docs. */
const FEE_TIERS = [
    { max_value: 50, client_share: 0.75, fee_percent: 0.25, label: 'Up to £50' },
    { min_value: 50.01, max_value: 150, client_share: 0.8, fee_percent: 0.2, label: '£50.01–£150' },
    { min_value: 150.01, client_share: 0.85, fee_percent: 0.15, label: 'Over £150' },
];

module.exports = {
    FEE_TIERS,
    clientShareRateTiered,
    clientShareRateForValue,
    feePercentForValue,
    usesLegacyFlatClientShare,
    legacyClientShareFraction,
};
