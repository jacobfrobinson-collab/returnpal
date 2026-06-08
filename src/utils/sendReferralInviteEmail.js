'use strict';

const { sendEmail, publicAppUrl, isTransactionalEmailEnabled, escapeHtml } = require('./emailTransport');
const {
    wrapBrandedEmail,
    paragraphHtml,
    noticeBoxHtml,
    ctaButtonHtml,
    signOffHtml,
    buildPlainEmail,
    summaryTableHtml,
} = require('./emailTemplates');

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
            `<strong>${escapeHtml(referrerName)}</strong> uses ReturnPal to turn Amazon returns into recovered revenue — and thought you might benefit too.`
        ) +
        personalHtml +
        paragraphHtml(
            'ReturnPal handles the full returns recovery process: inspection, reimbursement checks, resale, and liquidation. You stay focused on growing your business while we work on getting money back from returned inventory.'
        ) +
        summaryTableHtml('Why sellers choose ReturnPal', [
            { label: 'Performance-based pricing', value: 'No subscriptions or setup fees' },
            { label: 'Full visibility', value: 'Track every package in your dashboard' },
            { label: 'Fast processing', value: 'Most returns handled in 24–72 hours' },
        ]) +
        noticeBoxHtml(
            `<strong>Ready to get started?</strong><br>Create your free account with ${escapeHtml(referrerName)}'s referral link below. It only takes a few minutes to sign up.`
        ) +
        ctaButtonHtml('Create your free ReturnPal account', referralLink || site + '/login.html') +
        paragraphHtml(
            `Or copy this link: <a href="${escapeHtml(referralLink || site)}" style="color:#128BD0;word-break:break-all;">${escapeHtml(referralLink || site)}</a>`
        ) +
        signOffHtml();

    const subject = referrerName + ' invited you to try ReturnPal';

    const text = buildPlainEmail({
        title: subject,
        greeting: 'Hello,',
        paragraphs: [
            referrerName + ' uses ReturnPal to recover revenue from Amazon returns and invited you to try it.',
            personalPlain,
            'ReturnPal handles inspection, reimbursement checks, resale, and liquidation — with performance-based pricing and no subscriptions.',
            'Create your free account using the link below:',
        ],
        ctaLabel: 'Sign up',
        ctaUrl: referralLink || site + '/login.html',
        recipientEmail: inviteeEmail,
    });

    const html = wrapBrandedEmail({
        title: "You're invited to ReturnPal",
        subtitle: referrerName + " thinks you'll love it",
        bodyHtml,
        recipientEmail: inviteeEmail,
        preheader: referrerName + ' invited you — recover revenue from Amazon returns with ReturnPal',
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
