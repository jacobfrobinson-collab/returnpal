/**
 * 1st of month digest for users with email_digest = monthly.
 */
const { getDb } = require('../database');
const { isMonthlyDigestEnabled, sendEmail, publicAppUrl, escapeHtml } = require('../utils/emailTransport');
const {
    prefsFromUserRow,
    wantsMonthlyDigest,
    listNonAdminUsersWithEmail,
} = require('../utils/emailPreferences');
const { wasEmailSent, recordEmailSent } = require('../utils/emailLog');
const {
    maxInvoicablePeriodYm,
    parsePeriodYm,
    buildInvoicePeriodPayload,
} = require('../utils/computedMonthlyStatements');

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

function periodLabel(periodYm) {
    const p = parsePeriodYm(periodYm);
    if (!p) return periodYm;
    const d = new Date(p.y, p.m - 1, 1);
    return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function buildMonthlyDigestBody(u, periodYm, stats) {
    const name = u.full_name || u.email || 'there';
    const label = periodLabel(periodYm);
    const url = publicAppUrl() + '/dashboard/analytics.html';
    return {
        subject: `Your ReturnPal summary for ${label}`,
        text:
            `Hi ${name},\n\n` +
            `Here is your account summary for ${label}:\n` +
            `• Items sold: ${stats.itemsSold}\n` +
            `• Net payout estimate: £${stats.netPayout.toFixed(2)}\n` +
            `• Open reimbursement claims: ${stats.openClaims}\n\n` +
            `View analytics: ${url}\n\n` +
            `— ReturnPal`,
        html:
            `<p>Hi ${escapeHtml(name)},</p>` +
            `<p>Your account summary for <strong>${escapeHtml(label)}</strong>:</p><ul>` +
            `<li>Items sold: <strong>${stats.itemsSold}</strong></li>` +
            `<li>Net payout estimate: <strong>£${stats.netPayout.toFixed(2)}</strong></li>` +
            `<li>Open reimbursement claims: <strong>${stats.openClaims}</strong></li></ul>` +
            `<p><a href="${escapeHtml(url)}">View analytics</a></p>` +
            `<p>— ReturnPal</p>`,
    };
}

async function sendMonthlyDigestForUser(db, u, periodYm) {
    const refKey = periodYm;
    if (wasEmailSent(db, u.id, 'monthly_digest', refKey)) return;

    const p = parsePeriodYm(periodYm);
    if (!p) return;
    const detail = buildInvoicePeriodPayload(db, u.id, p);
    const itemsSold = detail ? detail._items_count || 0 : 0;
    const returnsN = detail ? detail._returns_count || 0 : 0;
    if (itemsSold === 0 && returnsN === 0) return;

    const openClaims = parseResults(
        db.exec(
            `SELECT COUNT(*) AS c FROM reimbursement_claims
             WHERE user_id = ? AND case_status IN ('draft','ready','submitted')`,
            [u.id]
        )
    );
    const stats = {
        itemsSold,
        netPayout: detail ? Number(detail.summary?.net_payout_estimate) || 0 : 0,
        openClaims: openClaims[0]?.c || 0,
    };

    const { subject, text, html } = buildMonthlyDigestBody(u, periodYm, stats);
    const sent = await sendEmail({ to: u.email, subject, text, html });
    if (sent) recordEmailSent(db, u.id, 'monthly_digest', refKey);
}

async function runMonthlyDigestOnce() {
    if (!isMonthlyDigestEnabled()) return;

    const db = await getDb();
    const periodYm = maxInvoicablePeriodYm();
    const users = listNonAdminUsersWithEmail(db).filter((u) => wantsMonthlyDigest(prefsFromUserRow(u)));

    for (const u of users) {
        try {
            await sendMonthlyDigestForUser(db, u, periodYm);
        } catch (e) {
            console.error('[monthly-digest] send failed for user', u.id, e.message || e);
        }
    }
    console.log('[monthly-digest] completed run for', users.length, 'subscribers, period', periodYm);
}

function startMonthlyDigestScheduler() {
    if (!isMonthlyDigestEnabled()) return;
    let cron;
    try {
        cron = require('node-cron');
    } catch (e) {
        console.warn('[monthly-digest] node-cron not installed; scheduler disabled.');
        return;
    }
    const expr = process.env.MONTHLY_DIGEST_CRON || '0 8 1 * *';
    const tz = process.env.WEEKLY_DIGEST_TZ || 'Europe/London';
    cron.schedule(
        expr,
        () => {
            runMonthlyDigestOnce().catch((err) => console.error('[monthly-digest]', err));
        },
        { timezone: tz }
    );
    console.log('[monthly-digest] scheduler started:', expr, tz);
}

module.exports = { startMonthlyDigestScheduler, runMonthlyDigestOnce };
