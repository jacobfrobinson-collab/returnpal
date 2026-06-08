/**
 * Sunday action-required digest — billing, ready claims, query replies only.
 */
const { getDb } = require('../database');
const { isWeeklyDigestEnabled, sendEmail, publicAppUrl } = require('../utils/emailTransport');
const { prefsFromUserRow, listNonAdminUsersWithEmail } = require('../utils/emailPreferences');
const { wasEmailSent, recordEmailSent } = require('../utils/emailLog');
const { weeklyDigestRefKey } = require('../utils/emailWeekBounds');
const { getClientActionItems } = require('../utils/clientActionItems');
const {
    wrapBrandedEmail,
    greetingHtml,
    paragraphHtml,
    ctaButtonHtml,
    signOffHtml,
    buildPlainEmail,
} = require('../utils/emailTemplates');

function wantsActionDigest(prefs) {
    if (!prefs) return false;
    if (String(prefs.email_digest).toLowerCase() === 'off') return false;
    return prefs.email_action_digest !== false;
}

function buildActionBody(u, items) {
    const name = u.full_name || u.email || 'there';
    const url = publicAppUrl() + '/dashboard/index.html';
    const listHtml = items
        .map((it) => `<li style="margin-bottom:8px;">${it.text}</li>`)
        .join('');
    const bodyHtml =
        greetingHtml(name) +
        paragraphHtml('These items need your attention on ReturnPal:') +
        `<ul style="padding-left:20px;margin:16px 0;">${listHtml}</ul>` +
        ctaButtonHtml('Open dashboard', url) +
        signOffHtml();

    const html = wrapBrandedEmail({
        title: 'Action required',
        subtitle: `${items.length} item${items.length === 1 ? '' : 's'}`,
        bodyHtml,
        recipientEmail: u.email,
        preheader: items[0]?.text || 'Items need your attention',
    });

    const text = buildPlainEmail({
        title: 'ReturnPal — action required',
        greeting: `Hello ${name},`,
        paragraphs: items.map((it) => it.text),
        ctaLabel: 'Open dashboard',
        ctaUrl: url,
        recipientEmail: u.email,
    });

    return { subject: `Action required — ${items.length} item${items.length === 1 ? '' : 's'} on ReturnPal`, text, html };
}

async function runWeeklyActionDigestOnce() {
    if (!isWeeklyDigestEnabled()) return;
    const db = await getDb();
    const refKey = 'action:' + weeklyDigestRefKey();
    const users = listNonAdminUsersWithEmail(db).filter((u) => wantsActionDigest(prefsFromUserRow(u)));

    for (const u of users) {
        try {
            if (wasEmailSent(db, u.id, 'weekly_action_digest', refKey)) continue;
            const items = getClientActionItems(db, u.id);
            if (!items.length) continue;
            const { subject, text, html } = buildActionBody(u, items);
            const sent = await sendEmail({ to: u.email, subject, text, html });
            if (sent) recordEmailSent(db, u.id, 'weekly_action_digest', refKey);
        } catch (e) {
            console.error('[weekly-action] user', u.id, e.message || e);
        }
    }
    console.log('[weekly-action] completed for', users.length, 'subscribers');
}

function startWeeklyActionDigestScheduler() {
    if (!isWeeklyDigestEnabled()) return;
    let cron;
    try {
        cron = require('node-cron');
    } catch (e) {
        return;
    }
    const expr = process.env.WEEKLY_ACTION_CRON || '0 19 * * 0';
    cron.schedule(
        expr,
        () => runWeeklyActionDigestOnce().catch((err) => console.error('[weekly-action]', err)),
        { timezone: process.env.WEEKLY_DIGEST_TZ || 'Europe/London' }
    );
    console.log('[weekly-action] scheduler started:', expr);
}

module.exports = { startWeeklyActionDigestScheduler, runWeeklyActionDigestOnce };
