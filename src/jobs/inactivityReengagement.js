/**
 * Re-engage clients with no packages in 60 days.
 */
const { getDb } = require('../database');
const { isWeeklyDigestEnabled, sendEmail, publicAppUrl } = require('../utils/emailTransport');
const { prefsFromUserRow, listNonAdminUsersWithEmail } = require('../utils/emailPreferences');
const { wasEmailSent, recordEmailSent } = require('../utils/emailLog');
const { getRecoveredBreakdown } = require('../utils/clientRecoveryMetrics');
const {
    wrapBrandedEmail,
    greetingHtml,
    paragraphHtml,
    ctaButtonHtml,
    signOffHtml,
    buildPlainEmail,
    formatGbp,
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

function lastQuarterBounds() {
    const end = new Date();
    const start = new Date();
    start.setMonth(start.getMonth() - 3);
    return {
        startYmd: start.toISOString().slice(0, 10),
        endYmd: end.toISOString().slice(0, 10),
    };
}

async function runInactivityReengagementOnce() {
    if (!isWeeklyDigestEnabled()) return;
    const db = await getDb();
    const refKey = 'inactive:' + new Date().toISOString().slice(0, 7);
    const users = listNonAdminUsersWithEmail(db).filter((u) => {
        const prefs = prefsFromUserRow(u);
        return String(prefs.email_digest).toLowerCase() !== 'off';
    });

    for (const u of users) {
        try {
            if (wasEmailSent(db, u.id, 'inactivity_reengagement', refKey)) continue;

            const recentPkg = parseResults(
                db.exec(
                    `SELECT COUNT(*) AS c FROM packages WHERE user_id = ? AND date_added >= datetime('now', '-60 days')`,
                    [u.id]
                )
            );
            if ((recentPkg[0]?.c || 0) > 0) continue;

            const everPkg = parseResults(
                db.exec('SELECT COUNT(*) AS c FROM packages WHERE user_id = ?', [u.id])
            );
            if ((everPkg[0]?.c || 0) === 0) continue;

            const bounds = lastQuarterBounds();
            const recovery = getRecoveredBreakdown(db, u.id, {
                sinceYmd: bounds.startYmd,
                untilYmd: bounds.endYmd,
            });

            const name = u.full_name || u.email || 'there';
            const url = publicAppUrl() + '/dashboard/packages.html';
            const bodyHtml =
                greetingHtml(name) +
                paragraphHtml(
                    `We have not seen a new package from you in the last <strong>60 days</strong>. Still sending returns? Your last quarter recovery was <strong>${formatGbp(recovery.total_recovered)}</strong>.`
                ) +
                paragraphHtml('Send your next batch whenever you are ready — we will pick up where we left off.') +
                ctaButtonHtml('Add a package', url) +
                signOffHtml();

            const html = wrapBrandedEmail({
                title: 'Still sending returns?',
                subtitle: formatGbp(recovery.total_recovered) + ' last quarter',
                bodyHtml,
                recipientEmail: u.email,
                preheader: `Last quarter you recovered ${formatGbp(recovery.total_recovered)}`,
            });

            const text = buildPlainEmail({
                title: 'Still sending returns?',
                greeting: `Hello ${name},`,
                paragraphs: [
                    'No packages in 60 days. Last quarter recovery: ' + formatGbp(recovery.total_recovered) + '.',
                ],
                ctaLabel: 'Add a package',
                ctaUrl: url,
                recipientEmail: u.email,
            });

            const sent = await sendEmail({
                to: u.email,
                subject: 'Still sending returns? Here’s your recovery last quarter',
                text,
                html,
            });
            if (sent) recordEmailSent(db, u.id, 'inactivity_reengagement', refKey);
        } catch (e) {
            console.error('[inactivity] user', u.id, e.message || e);
        }
    }
}

function startInactivityReengagementScheduler() {
    if (!isWeeklyDigestEnabled()) return;
    let cron;
    try {
        cron = require('node-cron');
    } catch (e) {
        return;
    }
    const expr = process.env.INACTIVITY_CRON || '0 11 * * 1';
    cron.schedule(
        expr,
        () => runInactivityReengagementOnce().catch((err) => console.error('[inactivity]', err)),
        { timezone: process.env.WEEKLY_DIGEST_TZ || 'Europe/London' }
    );
    console.log('[inactivity] scheduler started:', expr);
}

module.exports = { startInactivityReengagementScheduler, runInactivityReengagementOnce };
