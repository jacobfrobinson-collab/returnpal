/** Returns Recovery Terms of Service — version tracking for client acceptance. */

const { coerceIsAdmin } = require('./coerceIsAdmin');

const CURRENT_TERMS_VERSION = '1.0';
const CURRENT_TERMS_EFFECTIVE = '2026-06-24';
const TERMS_URL = '/terms.html';

/**
 * @param {{ terms_accepted_at?: string|null, terms_version?: string|null }} userRow
 */
function userNeedsTermsAcceptance(userRow) {
    if (!userRow) return true;
    const acceptedAt = userRow.terms_accepted_at != null ? String(userRow.terms_accepted_at).trim() : '';
    const version = userRow.terms_version != null ? String(userRow.terms_version).trim() : '';
    if (!acceptedAt || !version) return true;
    return version !== CURRENT_TERMS_VERSION;
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 */
function recordTermsAcceptance(db, userId) {
    const now = new Date().toISOString();
    db.run(
        `UPDATE users SET terms_accepted_at = ?, terms_version = ?, updated_at = datetime('now') WHERE id = ?`,
        [now, CURRENT_TERMS_VERSION, userId]
    );
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
    user.current_terms_effective = CURRENT_TERMS_EFFECTIVE;
    user.terms_url = TERMS_URL;
    return user;
}

module.exports = {
    CURRENT_TERMS_VERSION,
    CURRENT_TERMS_EFFECTIVE,
    TERMS_URL,
    userNeedsTermsAcceptance,
    recordTermsAcceptance,
    enrichUserWithTerms,
};
