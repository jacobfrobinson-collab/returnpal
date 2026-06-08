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

function wantsWeeklyDigest(prefs) {
    return prefs && String(prefs.email_digest).toLowerCase() === 'weekly';
}

function wantsMonthlyDigest(prefs) {
    return prefs && String(prefs.email_digest).toLowerCase() === 'monthly';
}

function wantsMonthlyInvoice(prefs) {
    return prefs && prefs.email_monthly_invoice === true;
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

/** Monday YYYY-MM-DD in Europe/London for weekly digest idempotency. */
function weeklyDigestRefKey(date = new Date()) {
    const tz = process.env.WEEKLY_DIGEST_TZ || 'Europe/London';
    try {
        const fmt = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
        const parts = fmt.formatToParts(date);
        const y = Number(parts.find((p) => p.type === 'year').value);
        const m = Number(parts.find((p) => p.type === 'month').value);
        const d = Number(parts.find((p) => p.type === 'day').value);
        const utc = new Date(Date.UTC(y, m - 1, d));
        const day = utc.getUTCDay();
        const diff = day === 0 ? -6 : 1 - day;
        utc.setUTCDate(utc.getUTCDate() + diff);
        const ym = utc.getUTCFullYear();
        const mm = String(utc.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(utc.getUTCDate()).padStart(2, '0');
        return `week:${ym}-${mm}-${dd}`;
    } catch {
        return `week:${date.toISOString().slice(0, 10)}`;
    }
}

module.exports = {
    prefsFromUserRow,
    getUserEmailPrefs,
    wantsWeeklyDigest,
    wantsMonthlyDigest,
    wantsMonthlyInvoice,
    wantsEventEmail,
    listNonAdminUsersWithEmail,
    weeklyDigestRefKey,
};
