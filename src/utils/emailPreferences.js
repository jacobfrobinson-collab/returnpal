const { parseClientPreferences } = require('./clientPreferences');

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

/** Merge client_preferences JSON with legacy weekly_digest_email column. */
function prefsFromUserRow(row) {
    const prefs = parseClientPreferences(row.client_preferences);
    const legacyWeekly =
        row.weekly_digest_email === 1 ||
        row.weekly_digest_email === '1' ||
        row.weekly_digest_email === true;
    if (prefs.email_digest === 'off' && legacyWeekly) {
        return { ...prefs, email_digest: 'weekly' };
    }
    return prefs;
}

function getUserEmailPrefs(db, userId) {
    const rows = parseResults(
        db.exec(
            `SELECT client_preferences, weekly_digest_email, email FROM users WHERE id = ?`,
            [userId]
        )
    );
    if (!rows.length) return null;
    return {
        ...prefsFromUserRow(rows[0]),
        email: rows[0].email || '',
    };
}

/** Weekly Sunday summary — all clients unless they explicitly opted out. */
function receivesWeeklySummary(prefs) {
    if (!prefs) return true;
    return String(prefs.email_digest).toLowerCase() !== 'off';
}

/** @deprecated use receivesWeeklySummary */
function wantsWeeklyDigest(prefs) {
    return receivesWeeklySummary(prefs);
}

function wantsMonthlyDigest(prefs) {
    return receivesMonthlyStatement(prefs);
}

/** Monthly statement on the 1st — all clients unless digest is off. */
function receivesMonthlyStatement(prefs) {
    if (!prefs) return true;
    if (String(prefs.email_digest).toLowerCase() === 'off') return false;
    return true;
}

function wantsMonthlyInvoice(prefs) {
    return receivesMonthlyStatement(prefs);
}

function wantsEventEmail(prefs, eventType) {
    if (!prefs) return false;
    const map = {
        package_delivered: 'email_package_delivered',
        item_sold: 'email_item_sold',
        payout_sent: 'email_payout_sent',
    };
    const key = map[eventType];
    if (!key) return false;
    return prefs[key] !== false;
}

function listNonAdminUsersWithEmail(db) {
    return parseResults(
        db.exec(
            `SELECT id, email, full_name, client_preferences, weekly_digest_email
             FROM users
             WHERE COALESCE(is_admin, 0) = 0
               AND email IS NOT NULL AND TRIM(email) <> ''`
        )
    );
}

module.exports = {
    prefsFromUserRow,
    getUserEmailPrefs,
    receivesWeeklySummary,
    receivesMonthlyStatement,
    wantsWeeklyDigest,
    wantsMonthlyDigest,
    wantsMonthlyInvoice,
    wantsEventEmail,
    listNonAdminUsersWithEmail,
};
