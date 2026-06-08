/**
 * 1st of month digest for users with email_digest = monthly.
 */
const { getDb } = require('../database');
const { isMonthlyDigestEnabled, sendEmail, publicAppUrl } = require('../utils/emailTransport');
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

function periodLabel(periodYm) {
    const p = parsePeriodYm(periodYm);
    if (!p) return periodYm;
    const d = new Date(p.y, p.m - 1, 1);
    return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function buildMonthlyDigestBody(u, periodYm, stats, detail) {
    const name = u.full_name || u.email || 'there';
    const label = periodLabel(periodYm);
    const url = publicAppUrl() + '/dashboard/analytics.html';
    const salesProfit = detail?.summary?.sales_profit ?? 0;
    const refunds = detail?.summary?.refunds_and_returns ?? 0;
    const fees = detail?.summary?.fees_deducted ?? 0;

    const summaryRows = [
        { label: 'Items sold', value: String(stats.itemsSold) },
        { label: 'Sales profit', value: formatGbp(salesProfit), emphasis: true },
        { label: 'Refunds & returns', value: formatGbp(-Math.abs(refunds)), negative: refunds > 0 },
        { label: 'Fees deducted', value: formatGbp(-Math.abs(fees)), negative: fees > 0 },
        { label: 'Net payout estimate', value: formatGbp(stats.netPayout), emphasis: true },
        { label: 'Open reimbursement claims', value: String(stats.openClaims) },
    ];

    const bodyHtml =
        greetingHtml(name) +
        paragraphHtml(
            `Your <strong>${label}</strong> account summary is ready. Here are the key numbers from the billing period that just ended.`
        ) +
        heroAmountBlock({
            label: 'Net payout estimate',
            amount: stats.netPayout,
            statusLabel: stats.netPayout > 0 ? 'Period complete' : 'No payment due',
            statusTone: stats.netPayout > 0 ? 'success' : 'muted',
        }) +
        summaryTableHtml('Period summary', summaryRows) +
        paragraphHtml('View analytics for ROI trends, recovery scorecard, and inventory insights.') +
        ctaButtonHtml('Go to analytics', url) +
        signOffHtml();

    const html = wrapBrandedEmail({
        title: 'Monthly account summary',
        subtitle: label,
        bodyHtml,
        recipientEmail: u.email,
        preheader: `${label}: ${formatGbp(stats.netPayout)} net payout · ${stats.itemsSold} items sold`,
    });

    const text = buildPlainEmail({
        title: `Your ReturnPal summary for ${label}`,
        greeting: `Hello ${name},`,
        paragraphs: [`Your account summary for ${label} is ready.`],
        summaryLines: summaryRows,
        ctaLabel: 'View analytics',
        ctaUrl: url,
        recipientEmail: u.email,
    });

    return { subject: `Your ReturnPal summary for ${label}`, text, html };
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

    const { subject, text, html } = buildMonthlyDigestBody(u, periodYm, stats, detail);
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
