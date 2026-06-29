/** Returns Recovery Terms of Service — version tracking for client acceptance. */

const { coerceIsAdmin } = require('./coerceIsAdmin');

const CURRENT_TERMS_VERSION = '1.0';
const CURRENT_PRICING_ACK_VERSION = '1.0';
const CURRENT_TERMS_EFFECTIVE = '2026-06-24';
const TERMS_URL = '/terms.html';

/**
 * @param {{
 *   terms_accepted_at?: string|null,
 *   terms_version?: string|null,
 *   pricing_ack_at?: string|null,
 *   pricing_ack_version?: string|null,
 * }} userRow
 */
function userNeedsTermsAcceptance(userRow) {
    if (!userRow) return true;
    const acceptedAt = userRow.terms_accepted_at != null ? String(userRow.terms_accepted_at).trim() : '';
    const version = userRow.terms_version != null ? String(userRow.terms_version).trim() : '';
    const pricingAt = userRow.pricing_ack_at != null ? String(userRow.pricing_ack_at).trim() : '';
    const pricingVersion =
        userRow.pricing_ack_version != null ? String(userRow.pricing_ack_version).trim() : '';
    if (!acceptedAt || !version || !pricingAt || !pricingVersion) return true;
    if (version !== CURRENT_TERMS_VERSION) return true;
    return pricingVersion !== CURRENT_PRICING_ACK_VERSION;
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {{ ip_address?: string|null, user_agent?: string|null }} [auditMeta]
 */
function recordTermsAcceptance(db, userId, auditMeta) {
    const now = new Date().toISOString();
    const ip = auditMeta && auditMeta.ip_address ? String(auditMeta.ip_address).slice(0, 64) : null;
    const userAgent =
        auditMeta && auditMeta.user_agent ? String(auditMeta.user_agent).slice(0, 200) : null;

    db.run('BEGIN IMMEDIATE');
    try {
        db.run(
            `INSERT INTO terms_acceptance_log
                (user_id, terms_version, pricing_ack_version, accepted_at, ip_address, user_agent)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, CURRENT_TERMS_VERSION, CURRENT_PRICING_ACK_VERSION, now, ip, userAgent]
        );
        db.run(
            `UPDATE users
             SET terms_accepted_at = ?, terms_version = ?,
                 pricing_ack_at = ?, pricing_ack_version = ?,
                 updated_at = datetime('now')
             WHERE id = ?`,
            [now, CURRENT_TERMS_VERSION, now, CURRENT_PRICING_ACK_VERSION, userId]
        );
        db.run('COMMIT');
    } catch (err) {
        try {
            db.run('ROLLBACK');
        } catch (rollbackErr) {
            /* ignore */
        }
        throw err;
    }
}

/**
 * @param {Record<string, unknown>} user
 * @param {boolean} [isAdmin]
 */
function enrichUserWithTerms(user, isAdmin) {
    if (!user || isAdmin || coerceIsAdmin(user.is_admin)) {
        user.terms_acceptance_required = false;
    } else {
        user.terms_acceptance_required = userNeedsTermsAcceptance(user);
    }
    user.current_terms_version = CURRENT_TERMS_VERSION;
    user.current_pricing_ack_version = CURRENT_PRICING_ACK_VERSION;
    user.current_terms_effective = CURRENT_TERMS_EFFECTIVE;
    user.terms_url = TERMS_URL;
    return user;
}

module.exports = {
    CURRENT_TERMS_VERSION,
    CURRENT_PRICING_ACK_VERSION,
    CURRENT_TERMS_EFFECTIVE,
    TERMS_URL,
    userNeedsTermsAcceptance,
    recordTermsAcceptance,
    enrichUserWithTerms,
};
