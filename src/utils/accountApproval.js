/**
 * Optional admin approval for new self-service registrations.
 */

function isSignupApprovalRequired() {
    return process.env.SIGNUP_REQUIRE_ADMIN_APPROVAL === '1';
}

function defaultAccountStatusForSignup() {
    return isSignupApprovalRequired() ? 'pending' : 'approved';
}

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

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 */
function getUserAccountStatus(db, userId) {
    const rows = parseResults(
        db.exec('SELECT COALESCE(account_status, \'approved\') AS account_status FROM users WHERE id = ?', [
            userId,
        ])
    );
    return rows[0]?.account_status || 'approved';
}

function accountStatusBlocksAccess(status, isAdmin) {
    if (isAdmin) return false;
    return status === 'pending' || status === 'rejected';
}

const PENDING_MESSAGE =
    'Your account is waiting for ReturnPal approval. You will be able to log in once an administrator approves your registration.';
const REJECTED_MESSAGE = 'This registration was not approved. Contact ReturnPal if you believe this is an error.';

module.exports = {
    isSignupApprovalRequired,
    defaultAccountStatusForSignup,
    getUserAccountStatus,
    accountStatusBlocksAccess,
    PENDING_MESSAGE,
    REJECTED_MESSAGE,
};
