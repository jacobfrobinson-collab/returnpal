#!/usr/bin/env node
/**
 * Send weekly digest immediately (operator smoke test).
 * Usage: node scripts/email-test-weekly.js [userId]
 */
require('dotenv').config();

const { getDb } = require('../src/database');
const { runWeeklyDigestOnce, sendDigestForUser } = require('../src/jobs/weeklyDigest');
const { isWeeklyDigestEnabled } = require('../src/utils/emailTransport');
const { prefsFromUserRow, weeklyDigestRefKey } = require('../src/utils/emailPreferences');
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
    console.error('Set vars in Dashboard → Environment, redeploy, or export them in this shell for a one-off test.');
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
        if (prefs.email_digest !== 'weekly') {
            console.warn('User email_digest is not weekly; sending test digest anyway.');
        }
        const refKey = weeklyDigestRefKey();
        if (wasEmailSent(db, u.id, 'weekly_digest', refKey)) {
            console.log('Skipped: weekly digest already sent this week for user', u.id, u.email);
            return;
        }
        const received = parseResults(
            db.exec(
                "SELECT COUNT(*) as c FROM received_items WHERE user_id = ? AND date_received >= datetime('now', '-7 days')",
                [u.id]
            )
        );
        const sold = parseResults(
            db.exec(
                "SELECT COUNT(*) as c FROM sold_items WHERE user_id = ? AND sold_date >= date(datetime('now', '-7 days'))",
                [u.id]
            )
        );
        const claims = parseResults(
            db.exec(
                "SELECT COUNT(*) as c FROM reimbursement_claims WHERE user_id = ? AND created_at >= datetime('now', '-7 days')",
                [u.id]
            )
        );
        const activity =
            (received[0]?.c || 0) + (sold[0]?.c || 0) + (claims[0]?.c || 0);
        if (activity === 0) {
            console.log(
                'Skipped: no activity in the last 7 days for user',
                u.id,
                u.email,
                '(weekly digest only sends when there is activity)'
            );
            return;
        }
        await sendDigestForUser(db, u, refKey);
        if (wasEmailSent(db, u.id, 'weekly_digest', refKey)) {
            console.log('Weekly digest sent to user', u.id, u.email);
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
