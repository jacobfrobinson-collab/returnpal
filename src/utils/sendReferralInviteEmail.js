'use strict';

const { sendEmail, publicAppUrl, isTransactionalEmailEnabled, escapeHtml } = require('./emailTransport');
const {
    BRAND,
    wrapBrandedEmail,
    paragraphHtml,
    noticeBoxHtml,
    ctaButtonHtml,
    signOffHtml,
    buildPlainEmail,
    summaryTableHtml,
} = require('./emailTemplates');

function referralComparisonTableHtml() {
    const header =
        `<tr>` +
        `<th style="padding:12px 16px;background:${BRAND.bg};border-bottom:1px solid ${BRAND.border};font-size:13px;text-align:left;color:${BRAND.textMuted};"></th>` +
        `<th style="padding:12px 16px;background:#e8f6fc;border-bottom:1px solid ${BRAND.border};font-size:13px;text-align:left;color:${BRAND.primary};font-weight:700;">ReturnPal</th>` +
        `<th style="padding:12px 16px;background:${BRAND.bg};border-bottom:1px solid ${BRAND.border};font-size:13px;text-align:left;color:${BRAND.textMuted};font-weight:600;">Typical returns services</th>` +
        `</tr>`;
    const row = (label, rp, other) =>
        `<tr>` +
        `<td style="padding:12px 16px;border-bottom:1px solid ${BRAND.border};font-size:14px;color:${BRAND.textMuted};vertical-align:top;">${escapeHtml(label)}</td>` +
        `<td style="padding:12px 16px;border-bottom:1px solid ${BRAND.border};font-size:14px;color:${BRAND.text};vertical-align:top;font-weight:600;">${escapeHtml(rp)}</td>` +
        `<td style="padding:12px 16px;border-bottom:1px solid ${BRAND.border};font-size:14px;color:${BRAND.textMuted};vertical-align:top;">${escapeHtml(other)}</td>` +
        `</tr>`;
    const rows =
        row(
            'Recovery approach',
            'Best route for best value: inspect, pursue reimbursements, then resale or liquidation',
            'Often listed on eBay and left to sell'
        ) +
        row('Reimbursement checks', 'Included in the workflow', 'Rarely part of the service') +
        row('Visibility', 'Dashboard for packages, sales, and payouts', 'Limited reporting');
    return (
        `<div style="margin:0 0 24px;">` +
        `<div style="font-size:13px;font-weight:700;color:${BRAND.text};text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;">ReturnPal vs typical returns services</div>` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND.border};border-radius:8px;overflow:hidden;background:${BRAND.white};">` +
        header +
        rows +
        `</table></div>`
    );
}

/**
 * @param {object} opts
 * @param {string} opts.inviteeEmail
 * @param {string} opts.referrerName
 * @param {string} opts.referralLink
 * @param {string} [opts.personalMessage]
 */
function buildReferralInviteEmail(opts) {
    const inviteeEmail = String(opts.inviteeEmail || '').trim();
    const referrerName = String(opts.referrerName || 'A ReturnPal seller').trim() || 'A ReturnPal seller';
    const referralLink = String(opts.referralLink || '').trim();
    const personalMessage = String(opts.personalMessage || '').trim().slice(0, 500);
    const site = publicAppUrl();

    let personalHtml = '';
    let personalPlain = '';
    if (personalMessage) {
        const safe = escapeHtml(personalMessage).replace(/\n/g, '<br>');
        personalHtml = noticeBoxHtml(
            `<strong>A note from ${escapeHtml(referrerName)}:</strong><br><span style="font-style:italic;">${safe}</span>`
        );
        personalPlain = `A note from ${referrerName}:\n"${personalMessage}"\n\n`;
    }

    const bodyHtml =
        `<p style="margin:0 0 20px;font-size:16px;line-height:1.5;color:#323a46;">Hello,</p>` +
        paragraphHtml(
            `<strong>${escapeHtml(referrerName)}</strong> uses ReturnPal for Amazon returns recovery and suggested you take a look.`
        ) +
        personalHtml +
        paragraphHtml(
            'ReturnPal manages the work end to end: receiving returns, inspection, reimbursement checks, resale, and liquidation. You get a clear dashboard for every package, with performance-based pricing and no monthly subscription.'
        ) +
        summaryTableHtml('At a glance', [
            { label: 'Pricing', value: 'Performance-based, no setup fees' },
            { label: 'Dashboard', value: 'Track packages, sales, and payouts' },
            { label: 'Turnaround', value: 'Most returns processed in 24 to 72 hours' },
        ]) +
        referralComparisonTableHtml() +
        noticeBoxHtml(
            `<strong>Create your account</strong><br>Use ${escapeHtml(referrerName)}'s referral link below to sign up. Registration takes a few minutes.`
        ) +
        ctaButtonHtml('Sign up for ReturnPal', referralLink || site + '/login.html') +
        paragraphHtml(
            `Or copy this link: <a href="${escapeHtml(referralLink || site)}" style="color:#128BD0;word-break:break-all;">${escapeHtml(referralLink || site)}</a>`
        ) +
        signOffHtml();

    const subject = referrerName + " thinks you'll love this";

    const text = buildPlainEmail({
        title: subject,
        greeting: 'Hello,',
        paragraphs: [
            referrerName + ' uses ReturnPal for Amazon returns recovery and suggested you take a look.',
            personalPlain,
            'ReturnPal handles receiving, inspection, reimbursement checks, resale, and liquidation, with performance-based pricing and no monthly subscription.',
            'ReturnPal vs typical services: structured recovery (inspect, reimbursements, resale or liquidation) vs often listing on eBay and hoping it sells.',
            'Create your account using the link below:',
        ],
        ctaLabel: 'Sign up',
        ctaUrl: referralLink || site + '/login.html',
        recipientEmail: inviteeEmail,
    });

    const html = wrapBrandedEmail({
        title: "You're invited to ReturnPal",
        subtitle: referrerName + " thinks you'll love this",
        bodyHtml,
        recipientEmail: inviteeEmail,
        preheader: referrerName + ' invited you to try ReturnPal for Amazon returns recovery',
    });

    return { subject, text, html };
}

/**
 * @param {object} opts
 */
async function sendReferralInviteEmail(opts) {
    if (!isTransactionalEmailEnabled()) {
        console.warn('[referral-invite] skipped — transactional email disabled');
        return { sent: false, reason: 'email_disabled' };
    }
    const to = String(opts.inviteeEmail || '').trim().toLowerCase();
    if (!to) return { sent: false, reason: 'missing_email' };

    const { subject, text, html } = buildReferralInviteEmail(opts);
    const sent = await sendEmail({ to, subject, text, html });
    return { sent: !!sent };
}

module.exports = { buildReferralInviteEmail, sendReferralInviteEmail };
