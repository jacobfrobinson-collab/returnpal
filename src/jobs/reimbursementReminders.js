/**
 * Daily reminders for ready reimbursement claims.
 */
const { getDb } = require('../database');
const { isTransactionalEmailEnabled, sendEmail, publicAppUrl } = require('../utils/emailTransport');
const { getUserEmailPrefs } = require('../utils/emailPreferences');
const { wasEmailSent, recordEmailSent } = require('../utils/emailLog');
const {
    wrapBrandedEmail,
    greetingHtml,
    paragraphHtml,
    ctaButtonHtml,
    signOffHtml,
    buildPlainEmail,
} = require('../utils/emailTemplates');

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

const REMINDER_DAYS = [0, 3, 7];

async function runReimbursementRemindersOnce() {
    if (!isTransactionalEmailEnabled()) return;
    const db = await getDb();
    const claims = parseResults(
        db.exec(
            `SELECT id, user_id, item_description, updated_at FROM reimbursement_claims WHERE case_status = 'ready'`
        )
    );

    for (const c of claims) {
        try {
            const updated = c.updated_at || '';
            const days = updated
                ? Math.floor((Date.now() - new Date(String(updated).replace(' ', 'T')).getTime()) / 86400000)
                : 0;
            if (!REMINDER_DAYS.includes(days)) continue;

            const refKey = `claim:${c.id}:day${days}`;
            if (wasEmailSent(db, c.user_id, 'reimbursement_reminder', refKey)) continue;

            const prefs = getUserEmailPrefs(db, c.user_id);
            if (!prefs || !prefs.email) continue;

            const name = prefs.billing_name || prefs.email || 'there';
            const url = publicAppUrl() + '/dashboard/reimbursement.html';
            const product = c.item_description || 'Item';
            const bodyHtml =
                greetingHtml(name) +
                paragraphHtml(
                    `Claim <strong>#${c.id}</strong> for <strong>${product}</strong> is ready to file in Seller Central. Amazon reimbursement windows often close — we recommend filing within <strong>7 days</strong>.`
                ) +
                ctaButtonHtml('File claim', url) +
                signOffHtml();

            const html = wrapBrandedEmail({
                title: 'Reimbursement claim ready',
                subtitle: `Claim #${c.id}`,
                bodyHtml,
                recipientEmail: prefs.email,
                preheader: `Claim #${c.id} ready — file within 7 days`,
            });

            const text = buildPlainEmail({
                title: `Claim #${c.id} ready to file`,
                greeting: `Hello ${name},`,
                paragraphs: [
                    `Claim #${c.id} (${product}) is ready. Amazon windows often close — file within 7 days.`,
                ],
                ctaLabel: 'Open reimbursement',
                ctaUrl: url,
                recipientEmail: prefs.email,
            });

            const sent = await sendEmail({
                to: prefs.email,
                subject: `Claim #${c.id} ready — file within 7 days`,
                text,
                html,
            });
            if (sent) recordEmailSent(db, c.user_id, 'reimbursement_reminder', refKey);
        } catch (e) {
            console.error('[reimb-reminder] claim', c.id, e.message || e);
        }
    }
}

function startReimbursementRemindersScheduler() {
    if (!isTransactionalEmailEnabled()) return;
    let cron;
    try {
        cron = require('node-cron');
    } catch (e) {
        return;
    }
    const expr = process.env.REIMBURSEMENT_REMINDER_CRON || '0 10 * * *';
    cron.schedule(
        expr,
        () => runReimbursementRemindersOnce().catch((err) => console.error('[reimb-reminder]', err)),
        { timezone: process.env.WEEKLY_DIGEST_TZ || 'Europe/London' }
    );
    console.log('[reimb-reminder] scheduler started:', expr);
}

module.exports = { startReimbursementRemindersScheduler, runReimbursementRemindersOnce };
