/**
 * Sunday weekly summary email — all clients (opt out via Settings → Email digest → Off).
 */
const { getDb } = require('../database');
const { isWeeklyDigestEnabled, sendEmail, publicAppUrl } = require('../utils/emailTransport');
const {
    prefsFromUserRow,
    receivesWeeklySummary,
    listNonAdminUsersWithEmail,
} = require('../utils/emailPreferences');
const { wasEmailSent, recordEmailSent } = require('../utils/emailLog');
const { calendarWeekMonSun, weeklyDigestRefKey, weekLabel } = require('../utils/emailWeekBounds');
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

function fetchWeekStats(db, userId, startYmd, endYmd) {
    const received = parseResults(
        db.exec(
            `SELECT COUNT(*) as c FROM received_items
             WHERE user_id = ? AND date_received >= ? AND date_received <= ?`,
            [userId, `${startYmd} 00:00:00`, `${endYmd} 23:59:59`]
        )
    );
    const sold = parseResults(
        db.exec(
            `SELECT COUNT(*) as c FROM sold_items
             WHERE user_id = ? AND sold_date >= ? AND sold_date <= ?`,
            [userId, startYmd, endYmd]
        )
    );
    const soldSum = parseResults(
        db.exec(
            `SELECT COALESCE(SUM(COALESCE(profit, total_revenue, 0)), 0) AS s
             FROM sold_items WHERE user_id = ? AND sold_date >= ? AND sold_date <= ?`,
            [userId, startYmd, endYmd]
        )
    );
    const claims = parseResults(
        db.exec(
            `SELECT COUNT(*) as c FROM reimbursement_claims
             WHERE user_id = ? AND created_at >= ? AND created_at <= ?`,
            [userId, `${startYmd} 00:00:00`, `${endYmd} 23:59:59`]
        )
    );
    return {
        received: received[0]?.c || 0,
        sold: sold[0]?.c || 0,
        soldRecovered: Number(soldSum[0]?.s) || 0,
        claims: claims[0]?.c || 0,
    };
}

function buildDigestBody(u, stats, periodLabel) {
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
                ? `Here is your ReturnPal summary for the week <strong>${periodLabel}</strong> — all sales recovered and activity recorded during that period.`
                : `The week <strong>${periodLabel}</strong> has ended. There were no reimbursements, sales, or check-ins recorded during this time. You can open your dashboard to view the current status of your inventory.`
        ) +
        heroAmountBlock({
            label: 'Recovered this week',
            amount: stats.soldRecovered,
            statusLabel: hasActivity ? 'Week complete' : 'No activity',
            statusTone: hasActivity ? 'success' : 'muted',
            noActivity: !hasActivity,
        }) +
        summaryTableHtml('Week in review', summaryRows) +
        paragraphHtml('Your dashboard has full details on packages, sold items, and reimbursement claims.') +
        ctaButtonHtml('Go to dashboard', url) +
        signOffHtml();

    const html = wrapBrandedEmail({
        title: 'Your week in review',
        subtitle: periodLabel,
        bodyHtml,
        recipientEmail: u.email,
        preheader: `Week ${periodLabel}: ${formatGbp(stats.soldRecovered)} recovered · ${stats.sold} sales`,
    });

    const text = buildPlainEmail({
        title: 'Your ReturnPal week in review',
        greeting: `Hello ${name},`,
        paragraphs: [
            hasActivity
                ? `Summary for week ${periodLabel}.`
                : `No activity was recorded for week ${periodLabel}.`,
        ],
        summaryLines: summaryRows,
        ctaLabel: 'Open dashboard',
        ctaUrl: url,
        recipientEmail: u.email,
    });

    return { subject: `Your ReturnPal week in review — ${periodLabel}`, text, html };
}

async function sendDigestForUser(db, u, refKey, bounds) {
    const uid = u.id;
    if (wasEmailSent(db, uid, 'weekly_digest', refKey)) return;

    const { startYmd, endYmd } = bounds || calendarWeekMonSun();
    const stats = fetchWeekStats(db, uid, startYmd, endYmd);
    const periodLabel = weekLabel(startYmd, endYmd);

    const { subject, text, html } = buildDigestBody(u, stats, periodLabel);
    const sent = await sendEmail({ to: u.email, subject, text, html });
    if (sent) recordEmailSent(db, uid, 'weekly_digest', refKey);
}

async function runWeeklyDigestOnce() {
    if (!isWeeklyDigestEnabled()) {
        return;
    }

    const db = await getDb();
    const bounds = calendarWeekMonSun();
    const refKey = weeklyDigestRefKey();
    const users = listNonAdminUsersWithEmail(db).filter((u) =>
        receivesWeeklySummary(prefsFromUserRow(u))
    );

    for (const u of users) {
        try {
            await sendDigestForUser(db, u, refKey, bounds);
        } catch (e) {
            console.error('[weekly-digest] send failed for user', u.id, e.message || e);
        }
    }
    console.log('[weekly-digest] completed run for', users.length, 'subscribers, week', bounds.startYmd, 'to', bounds.endYmd);
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
    /** Sunday 18:00 UK — end of calendar week (Mon–Sun). */
    const expr = process.env.WEEKLY_DIGEST_CRON || '0 18 * * 0';
    cron.schedule(
        expr,
        () => {
            runWeeklyDigestOnce().catch((err) => console.error('[weekly-digest]', err));
        },
        { timezone: process.env.WEEKLY_DIGEST_TZ || 'Europe/London' }
    );
    console.log('[weekly-digest] scheduler started:', expr, process.env.WEEKLY_DIGEST_TZ || 'Europe/London');
}

module.exports = { startWeeklyDigestScheduler, runWeeklyDigestOnce, sendDigestForUser, fetchWeekStats };
