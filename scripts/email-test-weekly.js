#!/usr/bin/env node
/**
 * Send weekly digest immediately (operator smoke test).
 * Usage: node scripts/email-test-weekly.js [userId-or-email]
 */
require('dotenv').config();

const { getDb } = require('../src/database');
const { runWeeklyDigestOnce, sendDigestForUser } = require('../src/jobs/weeklyDigest');
const { isWeeklyDigestEnabled } = require('../src/utils/emailTransport');
const { prefsFromUserRow } = require('../src/utils/emailPreferences');
const { weeklyDigestRefKey, calendarWeekMonSun } = require('../src/utils/emailWeekBounds');
const { wasEmailSent } = require('../src/utils/emailLog');

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

function reportEmailEnv() {
    const need = ['EMAIL_ENABLED', 'SMTP_HOST', 'WEEKLY_DIGEST_EMAIL_ENABLED'];
    const missing = need.filter((k) => !(process.env[k] || '').trim());
    console.error('Email env not ready. Missing or empty:', missing.join(', ') || '(check values are 1 / set)');
    console.error('Render Shell may not load Web Service env — run: echo $EMAIL_ENABLED $SMTP_HOST');
}

async function resolveUser(db, arg) {
    if (!arg) return null;
    if (String(arg).includes('@')) {
        const rows = parseResults(
            db.exec(
                `SELECT id, email, full_name, client_preferences, weekly_digest_email FROM users WHERE LOWER(email) = LOWER(?)`,
                [String(arg).trim()]
            )
        );
        return rows[0] || null;
    }
    const userId = parseInt(arg, 10);
    if (!Number.isFinite(userId)) return null;
    const rows = parseResults(
        db.exec(
            `SELECT id, email, full_name, client_preferences, weekly_digest_email FROM users WHERE id = ?`,
            [userId]
        )
    );
    return rows[0] || null;
}

async function main() {
    const arg = process.argv[2] || null;
    if (!isWeeklyDigestEnabled()) {
        reportEmailEnv();
        process.exit(1);
    }
    const db = await getDb();
    if (arg) {
        const u = await resolveUser(db, arg);
        if (!u) {
            console.error('User not found:', arg, '(use numeric id or account email)');
            process.exit(1);
        }
        if (!u.email) {
            console.error('User has no email');
            process.exit(1);
        }
        const prefs = prefsFromUserRow(u);
        if (prefs.email_digest === 'off') {
            console.warn('User has scheduled emails set to Off; sending test anyway.');
        }
        const bounds = calendarWeekMonSun();
        const refKey = weeklyDigestRefKey();
        if (wasEmailSent(db, u.id, 'weekly_digest', refKey)) {
            console.log('Skipped: weekly digest already sent this week for user', u.id, u.email);
            console.log('Clear email_log for this user/kind to re-test.');
            return;
        }
        await sendDigestForUser(db, u, refKey, bounds);
        if (wasEmailSent(db, u.id, 'weekly_digest', refKey)) {
            console.log('Weekly digest sent to user', u.id, u.email, `(${bounds.startYmd} – ${bounds.endYmd})`);
        } else {
            console.log('Send attempted but email_log not updated — check Render logs for SMTP errors.');
        }
        return;
    }
    await runWeeklyDigestOnce();
    console.log('Weekly digest job completed for all subscribers.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
