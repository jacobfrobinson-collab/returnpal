/**
 * Optional Monday 08:00 weekly digest email.
 */
const { getDb } = require('../database');
const { isWeeklyDigestEnabled, sendEmail, publicAppUrl } = require('../utils/emailTransport');
const {
    prefsFromUserRow,
    wantsWeeklyDigest,
    listNonAdminUsersWithEmail,
    weeklyDigestRefKey,
} = require('../utils/emailPreferences');
const { wasEmailSent, recordEmailSent } = require('../utils/emailLog');
const {
    wrapBrandedEmail,
    greetingHtml,
    paragraphHtml,
    heroAmountBlock,
    summaryTableHtml,
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

function buildDigestBody(u, stats) {
    const name = u.full_name || u.email || 'there';
    const url = publicAppUrl() + '/dashboard/index.html';
    const hasActivity = stats.received + stats.sold + stats.claims > 0;

    const summaryRows = [
        { label: 'Received check-ins', value: String(stats.received) },
        { label: 'Sales recorded', value: String(stats.sold) },
        { label: '£ recovered from sales', value: formatGbp(stats.soldRecovered), emphasis: stats.soldRecovered > 0 },
        { label: 'Reimbursement claims', value: String(stats.claims) },
    ];

    const bodyHtml =
        greetingHtml(name) +
        paragraphHtml(
            hasActivity
                ? 'Here is a snapshot of activity on your ReturnPal account over the <strong>last 7 days</strong>.'
                : 'There was no recorded activity on your account in the last 7 days.'
        ) +
        heroAmountBlock({
            label: 'Recovered this week',
            amount: stats.soldRecovered,
            statusLabel: hasActivity ? 'Weekly update' : 'No activity',
            statusTone: hasActivity ? 'success' : 'muted',
            noActivity: !hasActivity,
        }) +
        summaryTableHtml('Week in review', summaryRows) +
        paragraphHtml('Open your dashboard for full details on packages, sold items, and claims.') +
        ctaButtonHtml('Go to dashboard', url) +
        signOffHtml();

    const html = wrapBrandedEmail({
        title: 'Your week in review',
        subtitle: 'Weekly account summary',
        bodyHtml,
        recipientEmail: u.email,
        preheader: `${stats.sold} sales · ${formatGbp(stats.soldRecovered)} recovered this week`,
    });

    const text = buildPlainEmail({
        title: 'Your ReturnPal week in review',
        greeting: `Hello ${name},`,
        paragraphs: [
            hasActivity
                ? 'Here is activity on your account in the last 7 days.'
                : 'There was no recorded activity in the last 7 days.',
        ],
        summaryLines: summaryRows,
        ctaLabel: 'Open dashboard',
        ctaUrl: url,
        recipientEmail: u.email,
    });

    return { subject: 'Your ReturnPal week in review', text, html };
}

async function sendDigestForUser(db, u, refKey) {
    const uid = u.id;
    if (wasEmailSent(db, uid, 'weekly_digest', refKey)) return;

    const received = parseResults(
        db.exec(
            "SELECT COUNT(*) as c FROM received_items WHERE user_id = ? AND date_received >= datetime('now', '-7 days')",
            [uid]
        )
    );
    const sold = parseResults(
        db.exec(
            "SELECT COUNT(*) as c FROM sold_items WHERE user_id = ? AND sold_date >= date(datetime('now', '-7 days'))",
            [uid]
        )
    );
    const soldSum = parseResults(
        db.exec(
            `SELECT COALESCE(SUM(COALESCE(profit, total_revenue, 0)), 0) AS s
             FROM sold_items WHERE user_id = ? AND sold_date >= date(datetime('now', '-7 days'))`,
            [uid]
        )
    );
    const claims = parseResults(
        db.exec(
            "SELECT COUNT(*) as c FROM reimbursement_claims WHERE user_id = ? AND created_at >= datetime('now', '-7 days')",
            [uid]
        )
    );
    const stats = {
        received: received[0]?.c || 0,
        sold: sold[0]?.c || 0,
        soldRecovered: Number(soldSum[0]?.s) || 0,
        claims: claims[0]?.c || 0,
    };
    if (stats.received + stats.sold + stats.claims === 0) return;

    const { subject, text, html } = buildDigestBody(u, stats);
    const sent = await sendEmail({ to: u.email, subject, text, html });
    if (sent) recordEmailSent(db, uid, 'weekly_digest', refKey);
}

async function runWeeklyDigestOnce() {
    if (!isWeeklyDigestEnabled()) {
        return;
    }

    const db = await getDb();
    const refKey = weeklyDigestRefKey();
    const users = listNonAdminUsersWithEmail(db).filter((u) => wantsWeeklyDigest(prefsFromUserRow(u)));

    for (const u of users) {
        try {
            await sendDigestForUser(db, u, refKey);
        } catch (e) {
            console.error('[weekly-digest] send failed for user', u.id, e.message || e);
        }
    }
    console.log('[weekly-digest] completed run for', users.length, 'subscribers');
}

function startWeeklyDigestScheduler() {
    if (!isWeeklyDigestEnabled()) {
        return;
    }
    let cron;
    try {
        cron = require('node-cron');
    } catch (e) {
        console.warn('[weekly-digest] node-cron not installed; scheduler disabled.');
        return;
    }
    const expr = process.env.WEEKLY_DIGEST_CRON || '0 8 * * 1';
    cron.schedule(
        expr,
        () => {
            runWeeklyDigestOnce().catch((err) => console.error('[weekly-digest]', err));
        },
        { timezone: process.env.WEEKLY_DIGEST_TZ || 'Europe/London' }
    );
    console.log('[weekly-digest] scheduler started:', expr, process.env.WEEKLY_DIGEST_TZ || 'Europe/London');
}

module.exports = { startWeeklyDigestScheduler, runWeeklyDigestOnce, sendDigestForUser };
