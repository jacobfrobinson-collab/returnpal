/**
 * 1st-of-month statement email — monthly snapshot + invoice for all clients (opt out via digest Off).
 */
const { getDb } = require('../database');
const { isMonthlyInvoiceEmailEnabled, sendEmail, publicAppUrl, escapeHtml } = require('../utils/emailTransport');
const {
    prefsFromUserRow,
    receivesMonthlyStatement,
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

function formatDueDate(ymd) {
    if (!ymd || String(ymd).length < 10) return '';
    const [y, m, d] = String(ymd)
        .slice(0, 10)
        .split('-')
        .map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    });
}

function emptyPeriodDetail() {
    return {
        total: 0,
        status: 'Pending',
        due_date: '',
        summary: {
            sales_profit: 0,
            refunds_and_returns: 0,
            fees_deducted: 0,
            gross_net: 0,
            net_payout_estimate: 0,
        },
        _items_count: 0,
        _returns_count: 0,
    };
}

function statusTone(status) {
    if (status === 'Paid') return 'success';
    if (status === 'Pending') return 'warning';
    return 'info';
}

function statusHeroLabel(status, amount) {
    if (amount <= 0) return 'No payment due';
    if (status === 'Paid') return 'Payout sent';
    return 'Payout scheduled';
}

function buildInvoiceEmailBody(u, periodYm, detail, prefs, openClaims) {
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
    const dueLabel = formatDueDate(detail.due_date);

    const url =
        publicAppUrl() +
        '/dashboard/invoices.html' +
        (periodYm ? '?period=' + encodeURIComponent(periodYm) : '');

    let payoutScheduleHtml = '';
    if (amount > 0 && status === 'Pending' && dueLabel) {
        payoutScheduleHtml = noticeBoxHtml(
            `<strong>Payout schedule</strong><br>` +
                `Your net payout of <strong>${escapeHtml(formatGbp(amount))}</strong> for <strong>${escapeHtml(label)}</strong> is scheduled for <strong>${escapeHtml(dueLabel)}</strong> — at the end of the calendar month following your sales period. ` +
                `We'll pay you via bank transfer once the period is finalised — use the secure form on Settings or Payouts & Invoices if you have not submitted your bank details yet.`
        );
    } else if (amount > 0 && status === 'Paid') {
        payoutScheduleHtml = noticeBoxHtml(
            `<strong>Payout sent</strong><br>` +
                `Your payout of <strong>${escapeHtml(formatGbp(amount))}</strong> for <strong>${escapeHtml(label)}</strong> has been processed.`
        );
    } else if (noActivity) {
        payoutScheduleHtml = noticeBoxHtml(
            '<strong>No payment due</strong><br>There were no sales or returns in this billing period, so no payout is scheduled.'
        );
    }

    const payoutPrefNotice =
        status === 'Paid' && wantsEventEmail(prefs, 'payout_sent') && amount > 0
            ? noticeBoxHtml(
                  '<strong>Funds on the way.</strong> Your payout should appear in your account according to your usual payment schedule.'
              )
            : '';

    const summaryRows = [
        { label: 'Items sold', value: String(itemsCount) },
        { label: 'Sales profit', value: formatGbp(salesProfit) },
        { label: 'Refunds & returns', value: formatGbp(-Math.abs(refunds)), negative: refunds > 0 },
        { label: 'Fees deducted', value: formatGbp(-Math.abs(fees)), negative: fees > 0 },
        { label: 'Gross net', value: formatGbp(grossNet) },
        { label: 'Open reimbursement claims', value: String(openClaims) },
        {
            label: amount > 0 ? 'Net payout' : 'Net amount (no payment due)',
            value: formatGbp(amount),
            emphasis: true,
        },
    ];

    const intro = noActivity
        ? `Your <strong>monthly snapshot</strong> for <strong>${escapeHtml(label)}</strong> is ready. The billing period has ended and there were no sales or returns recorded — your invoice reflects zero activity.`
        : `Your <strong>monthly snapshot and invoice</strong> for <strong>${escapeHtml(label)}</strong> are ready. Below is your period summary; your full billing statement is available on the invoices page.`;

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
        summaryTableHtml('Monthly snapshot', summaryRows) +
        payoutScheduleHtml +
        noticeBoxHtml(
            '<strong>📎 Billing statement</strong><br>' +
                'Open your invoices page for a line-by-line breakdown of every sale, return, and fee in this period.'
        ) +
        payoutPrefNotice +
        paragraphHtml('If you have any questions about this billing period, please contact our support team.') +
        ctaButtonHtml('Go to invoices', url) +
        signOffHtml();

    const html = wrapBrandedEmail({
        title: 'Monthly account snapshot',
        subtitle: label,
        bodyHtml,
        recipientEmail: u.email,
        preheader: `${label}: ${formatGbp(amount)} payout · ${status}`,
    });

    const payoutLine =
        amount > 0 && dueLabel && status === 'Pending'
            ? `Payout of ${formatGbp(amount)} is scheduled for ${dueLabel}.`
            : status === 'Paid' && amount > 0
              ? 'Your payout for this period has been sent.'
              : '';

    const text = buildPlainEmail({
        title: `ReturnPal monthly snapshot — ${label}`,
        greeting: `Hello ${name},`,
        paragraphs: [
            noActivity
                ? `Monthly snapshot for ${label}: no sales or returns recorded.`
                : `Your monthly snapshot and invoice for ${label} are ready.`,
            payoutLine,
            'View your full statement on the invoices page.',
        ].filter(Boolean),
        summaryLines: summaryRows,
        ctaLabel: 'Go to invoices',
        ctaUrl: url,
        recipientEmail: u.email,
    });

    return { subject: `ReturnPal monthly snapshot — ${label}`, text, html };
}

async function sendMonthlyInvoiceForUser(db, u, periodYm) {
    const refKey = periodYm;
    if (wasEmailSent(db, u.id, 'monthly_invoice', refKey)) return;

    const p = parsePeriodYm(periodYm);
    if (!p) return;
    let detail = buildInvoicePeriodPayload(db, u.id, p);
    if (!detail) detail = emptyPeriodDetail();

    const openClaims = parseResults(
        db.exec(
            `SELECT COUNT(*) AS c FROM reimbursement_claims
             WHERE user_id = ? AND case_status IN ('draft','ready','submitted')`,
            [u.id]
        )
    );

    const prefs = prefsFromUserRow(u);
    const { subject, text, html } = buildInvoiceEmailBody(
        u,
        periodYm,
        detail,
        prefs,
        openClaims[0]?.c || 0
    );
    const sent = await sendEmail({ to: u.email, subject, text, html });
    if (sent) recordEmailSent(db, u.id, 'monthly_invoice', refKey);
}

async function runMonthlyInvoiceOnce() {
    if (!isMonthlyInvoiceEmailEnabled()) return;

    const db = await getDb();
    const periodYm = maxInvoicablePeriodYm();
    const users = listNonAdminUsersWithEmail(db).filter((u) =>
        receivesMonthlyStatement(prefsFromUserRow(u))
    );

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
    /** 1st of month 09:00 UK — previous month snapshot + invoice. */
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
