/**
 * 1st of month invoice email for users with email_monthly_invoice enabled.
 */
const { getDb } = require('../database');
const { isMonthlyInvoiceEmailEnabled, sendEmail, publicAppUrl, escapeHtml } = require('../utils/emailTransport');
const {
    prefsFromUserRow,
    wantsMonthlyInvoice,
    wantsEventEmail,
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
    noticeBoxHtml,
    ctaButtonHtml,
    signOffHtml,
    buildPlainEmail,
    formatGbp,
} = require('../utils/emailTemplates');

function periodLabel(periodYm) {
    const p = parsePeriodYm(periodYm);
    if (!p) return periodYm;
    const d = new Date(p.y, p.m - 1, 1);
    return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function statusTone(status) {
    if (status === 'Paid') return 'success';
    if (status === 'Pending') return 'warning';
    return 'info';
}

function statusHeroLabel(status, amount) {
    if (amount <= 0) return 'No payment due';
    if (status === 'Paid') return 'Payout sent';
    return 'Payout pending';
}

function buildInvoiceEmailBody(u, periodYm, detail, prefs) {
    const name = u.full_name || u.email || 'there';
    const label = periodLabel(periodYm);
    const amount = Number(detail.total) || 0;
    const status = detail.status || 'Pending';
    const summary = detail.summary || {};
    const salesProfit = Number(summary.sales_profit) || 0;
    const refunds = Number(summary.refunds_and_returns) || 0;
    const fees = Number(summary.fees_deducted) || 0;
    const grossNet = Number(summary.gross_net) || 0;
    const itemsCount = detail._items_count || 0;
    const returnsCount = detail._returns_count || 0;
    const noActivity = itemsCount === 0 && returnsCount === 0;

    const url =
        publicAppUrl() +
        '/dashboard/invoices.html' +
        (periodYm ? '?period=' + encodeURIComponent(periodYm) : '');

    const payoutNotice =
        status === 'Paid' && wantsEventEmail(prefs, 'payout_sent')
            ? noticeBoxHtml(
                  '<strong>Your payout has been sent.</strong> Funds for this period should appear in your account according to your usual payment schedule.'
              )
            : '';

    const summaryRows = [
        { label: 'Sales profit', value: formatGbp(salesProfit) },
        { label: 'Refunds & returns', value: formatGbp(-Math.abs(refunds)), negative: refunds > 0 },
        { label: 'Fees deducted', value: formatGbp(-Math.abs(fees)), negative: fees > 0 },
        { label: 'Gross net', value: formatGbp(grossNet) },
        { label: 'Items sold in period', value: String(itemsCount) },
        { label: 'Returns in period', value: String(returnsCount) },
        {
            label: amount > 0 ? 'Net payout' : 'Net amount (no payment due)',
            value: formatGbp(amount),
            emphasis: true,
        },
    ];

    const intro = noActivity
        ? `The billing period for <strong>${escapeHtml(label)}</strong> has ended. There were no sales or returns recorded during this time. You can check your dashboard for the current status of all your products.`
        : `The billing period for <strong>${escapeHtml(label)}</strong> has ended. Your monthly statement is ready — see the summary below and open your invoices page for the full breakdown.`;

    const bodyHtml =
        greetingHtml(name) +
        paragraphHtml(intro) +
        heroAmountBlock({
            label: 'Payout amount',
            amount,
            statusLabel: statusHeroLabel(status, amount),
            statusTone: noActivity ? 'muted' : statusTone(status),
            noActivity,
        }) +
        summaryTableHtml('Period summary', summaryRows) +
        noticeBoxHtml(
            '<strong>📎 View your full billing statement online</strong><br>' +
                'Open your invoices page for a detailed breakdown of all sales, returns, and fees for this period.'
        ) +
        payoutNotice +
        paragraphHtml('If you have any questions about this billing period, please contact our support team.') +
        ctaButtonHtml('Go to invoices', url) +
        signOffHtml();

    const html = wrapBrandedEmail({
        title: 'Billing period update',
        subtitle: label,
        bodyHtml,
        recipientEmail: u.email,
        preheader: `${label}: ${formatGbp(amount)} · ${status}`,
    });

    const payoutLine =
        status === 'Paid' && wantsEventEmail(prefs, 'payout_sent')
            ? 'Your payout for this period has been sent.'
            : '';

    const text = buildPlainEmail({
        title: `ReturnPal billing period update — ${label}`,
        greeting: `Hello ${name},`,
        paragraphs: [
            noActivity
                ? `The billing period for ${label} has ended. There were no sales or returns recorded.`
                : `Your monthly statement for ${label} is ready.`,
            `Status: ${status}.`,
            payoutLine,
            'View your full statement on the invoices page.',
        ].filter(Boolean),
        summaryLines: summaryRows,
        ctaLabel: 'Go to invoices',
        ctaUrl: url,
        recipientEmail: u.email,
    });

    return { subject: `ReturnPal billing update — ${label}`, text, html };
}

async function sendMonthlyInvoiceForUser(db, u, periodYm) {
    const refKey = periodYm;
    if (wasEmailSent(db, u.id, 'monthly_invoice', refKey)) return;

    const p = parsePeriodYm(periodYm);
    if (!p) return;
    const detail = buildInvoicePeriodPayload(db, u.id, p);
    if (!detail) return;
    const salesN = detail._items_count || 0;
    const returnsN = detail._returns_count || 0;
    if (salesN === 0 && returnsN === 0) return;

    const prefs = prefsFromUserRow(u);
    const { subject, text, html } = buildInvoiceEmailBody(u, periodYm, detail, prefs);
    const sent = await sendEmail({ to: u.email, subject, text, html });
    if (sent) recordEmailSent(db, u.id, 'monthly_invoice', refKey);
}

async function runMonthlyInvoiceOnce() {
    if (!isMonthlyInvoiceEmailEnabled()) return;

    const db = await getDb();
    const periodYm = maxInvoicablePeriodYm();
    const users = listNonAdminUsersWithEmail(db).filter((u) => wantsMonthlyInvoice(prefsFromUserRow(u)));

    for (const u of users) {
        try {
            await sendMonthlyInvoiceForUser(db, u, periodYm);
        } catch (e) {
            console.error('[monthly-invoice] send failed for user', u.id, e.message || e);
        }
    }
    console.log('[monthly-invoice] completed run for', users.length, 'subscribers, period', periodYm);
}

function startMonthlyInvoiceScheduler() {
    if (!isMonthlyInvoiceEmailEnabled()) return;
    let cron;
    try {
        cron = require('node-cron');
    } catch (e) {
        console.warn('[monthly-invoice] node-cron not installed; scheduler disabled.');
        return;
    }
    const expr = process.env.MONTHLY_INVOICE_CRON || '0 9 1 * *';
    const tz = process.env.WEEKLY_DIGEST_TZ || 'Europe/London';
    cron.schedule(
        expr,
        () => {
            runMonthlyInvoiceOnce().catch((err) => console.error('[monthly-invoice]', err));
        },
        { timezone: tz }
    );
    console.log('[monthly-invoice] scheduler started:', expr, tz);
}

module.exports = { startMonthlyInvoiceScheduler, runMonthlyInvoiceOnce, sendMonthlyInvoiceForUser };
