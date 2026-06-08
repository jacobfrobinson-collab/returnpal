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

function periodLabel(periodYm) {
    const p = parsePeriodYm(periodYm);
    if (!p) return periodYm;
    const d = new Date(p.y, p.m - 1, 1);
    return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function buildInvoiceEmailBody(u, periodYm, detail, prefs) {
    const name = u.full_name || u.email || 'there';
    const label = periodLabel(periodYm);
    const amount = Number(detail.total) || 0;
    const status = detail.status || 'Pending';
    const url =
        publicAppUrl() +
        '/dashboard/invoices.html' +
        (periodYm ? '?period=' + encodeURIComponent(periodYm) : '');
    const payoutLine =
        status === 'Paid' && wantsEventEmail(prefs, 'payout_sent')
            ? '\n\nYour payout for this period has been sent.'
            : '';
    const payoutHtml =
        status === 'Paid' && wantsEventEmail(prefs, 'payout_sent')
            ? '<p><strong>Your payout for this period has been sent.</strong></p>'
            : '';
    return {
        subject: `ReturnPal invoice — ${label}`,
        text:
            `Hi ${name},\n\n` +
            `Your monthly statement for ${label} is ready.\n` +
            `Net payout: £${amount.toFixed(2)}\n` +
            `Status: ${status}${payoutLine}\n\n` +
            `View invoice: ${url}\n\n` +
            `— ReturnPal`,
        html:
            `<p>Hi ${escapeHtml(name)},</p>` +
            `<p>Your monthly statement for <strong>${escapeHtml(label)}</strong> is ready.</p>` +
            `<ul>` +
            `<li>Net payout: <strong>£${amount.toFixed(2)}</strong></li>` +
            `<li>Status: <strong>${escapeHtml(status)}</strong></li></ul>` +
            payoutHtml +
            `<p><a href="${escapeHtml(url)}">View invoice</a></p>` +
            `<p>— ReturnPal</p>`,
    };
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
