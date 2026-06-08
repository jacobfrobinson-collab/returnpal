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

async function main() {
    const userId = process.argv[2] ? parseInt(process.argv[2], 10) : null;
    if (!isWeeklyDigestEnabled()) {
        console.error('Set EMAIL_ENABLED=1, SMTP_HOST, and WEEKLY_DIGEST_EMAIL_ENABLED=1');
        process.exit(1);
    }
    const db = await getDb();
    if (userId) {
        const rows = parseResults(
            db.exec(
                `SELECT id, email, full_name, client_preferences, weekly_digest_email FROM users WHERE id = ?`,
                [userId]
            )
        );
        if (!rows.length) {
            console.error('User not found:', userId);
            process.exit(1);
        }
        const u = rows[0];
        if (!u.email) {
            console.error('User has no email');
            process.exit(1);
        }
        const prefs = prefsFromUserRow(u);
        if (prefs.email_digest !== 'weekly') {
            console.warn('User email_digest is not weekly; sending test digest anyway.');
        }
        await sendDigestForUser(db, u, weeklyDigestRefKey());
        console.log('Weekly digest sent to user', userId, u.email);
        return;
    }
    await runWeeklyDigestOnce();
    console.log('Weekly digest job completed for all subscribers.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
