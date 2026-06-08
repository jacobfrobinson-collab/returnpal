const { isTransactionalEmailEnabled, sendEmail, publicAppUrl, escapeHtml } = require('./emailTransport');
const { getUserEmailPrefs, wantsEventEmail } = require('./emailPreferences');
const { wasEmailSent, recordEmailSent } = require('./emailLog');
const {
    wrapBrandedEmail,
    greetingHtml,
    paragraphHtml,
    heroAmountBlock,
    ctaButtonHtml,
    signOffHtml,
    buildPlainEmail,
    formatGbp,
} = require('./emailTemplates');
const { dispatchClientWebhook } = require('./webhookDispatcher');

function highValueThreshold() {
    return Number(process.env.HIGH_VALUE_ALERT_GBP) || 500;
}

function isHighValue(amount) {
    return (Number(amount) || 0) >= highValueThreshold();
}

/**
 * Send a one-off event email if user prefs and env allow. Idempotent per refKey.
 */
async function maybeSendEventEmail(db, userId, kind, refKey, { subject, text, html }) {
    if (!isTransactionalEmailEnabled()) return false;
    const prefs = getUserEmailPrefs(db, userId);
    if (!prefs || !prefs.email) return false;
    if (!wantsEventEmail(prefs, kind)) return false;
    if (wasEmailSent(db, userId, kind, refKey)) return false;

    const sent = await sendEmail({
        to: prefs.email,
        subject,
        text,
        html,
    });
    if (sent) recordEmailSent(db, userId, kind, refKey);
    return sent;
}

async function sendPackageDeliveredEmail(db, userId, packageId, reference) {
    const prefs = getUserEmailPrefs(db, userId);
    const name = (prefs && prefs.billing_name) || '';
    const ref = String(reference || '').trim() || 'your package';
    const url = publicAppUrl() + '/dashboard/packages.html';

    const bodyHtml =
        greetingHtml(name || 'there') +
        paragraphHtml(
            `Good news — your package <strong>${escapeHtml(ref)}</strong> has been marked as <strong>delivered</strong> at ReturnPal. We'll process items and update your dashboard as they move through the pipeline.`
        ) +
        heroAmountBlock({
            label: 'Package reference',
            amount: 0,
            displayText: ref,
            statusLabel: 'Delivered',
            statusTone: 'success',
        }) +
        ctaButtonHtml('View packages', url) +
        signOffHtml();

    const html = wrapBrandedEmail({
        title: 'Package delivered',
        subtitle: ref,
        bodyHtml,
        recipientEmail: prefs?.email,
        preheader: `Package ${ref} has been delivered`,
    });

    const text = buildPlainEmail({
        title: `Package delivered: ${ref}`,
        greeting: `Hello ${name || 'there'},`,
        paragraphs: [`Your package ${ref} has been marked as delivered at ReturnPal.`],
        ctaLabel: 'View packages',
        ctaUrl: url,
        recipientEmail: prefs?.email,
    });

    const sent = await maybeSendEventEmail(db, userId, 'package_delivered', `package:${packageId}`, {
        subject: `Package delivered: ${ref}`,
        text,
        html,
    });
    dispatchClientWebhook(db, userId, 'package_delivered', { reference: ref }).catch(() => {});
    return sent;
}

async function sendItemSoldEmail(db, userId, soldItemId, product, amount) {
    const prefs = getUserEmailPrefs(db, userId);
    const name = (prefs && prefs.billing_name) || '';
    const itemName = String(product || 'Item').trim();
    const amt = Number(amount) || 0;
    const url = publicAppUrl() + '/dashboard/sold-items.html';

    const bodyHtml =
        greetingHtml(name || 'there') +
        paragraphHtml(
            `An item on your account has been recorded as <strong>sold</strong>. Recovery has been updated on your dashboard.`
        ) +
        heroAmountBlock({
            label: itemName,
            amount: amt,
            statusLabel: 'Sold',
            statusTone: 'success',
        }) +
        ctaButtonHtml('View sold items', url) +
        signOffHtml();

    const html = wrapBrandedEmail({
        title: 'Item sold',
        subtitle: formatGbp(amt),
        bodyHtml,
        recipientEmail: prefs?.email,
        preheader: `${itemName} sold for ${formatGbp(amt)}`,
    });

    const text = buildPlainEmail({
        title: `Item sold: ${itemName}`,
        greeting: `Hello ${name || 'there'},`,
        paragraphs: [`Item "${itemName}" was recorded as sold for ${formatGbp(amt)}.`],
        ctaLabel: 'View sold items',
        ctaUrl: url,
        recipientEmail: prefs?.email,
    });

    const sent = await maybeSendEventEmail(db, userId, 'item_sold', `sold:${soldItemId}`, {
        subject: `Item sold: ${itemName}`,
        text,
        html,
    });
    dispatchClientWebhook(db, userId, 'item_sold', {
        product: itemName,
        amount_label: formatGbp(amt),
    }).catch(() => {});
    if (isHighValue(amt)) {
        await sendHighValueAlertEmail(db, userId, `sold:${soldItemId}`, itemName, amt, 'sold');
        dispatchClientWebhook(db, userId, 'high_value_received', {
            product: itemName,
            amount_label: formatGbp(amt),
        }).catch(() => {});
    }
    return sent;
}

async function sendHighValueAlertEmail(db, userId, refKey, product, amount, kind) {
    const prefs = getUserEmailPrefs(db, userId);
    const name = (prefs && prefs.billing_name) || '';
    const itemName = String(product || 'Item').trim();
    const amt = Number(amount) || 0;
    const url =
        kind === 'sold'
            ? publicAppUrl() + '/dashboard/sold-items.html'
            : publicAppUrl() + '/dashboard/received.html';

    const bodyHtml =
        greetingHtml(name || 'there') +
        paragraphHtml(
            `A high-value item (${formatGbp(amt)}+) has been ${kind === 'sold' ? 'sold' : 'received'} on your account: <strong>${escapeHtml(itemName)}</strong>.`
        ) +
        heroAmountBlock({
            label: itemName,
            amount: amt,
            statusLabel: kind === 'sold' ? 'Sold' : 'Received',
            statusTone: 'success',
        }) +
        ctaButtonHtml(kind === 'sold' ? 'View sold items' : 'View received', url) +
        signOffHtml();

    const html = wrapBrandedEmail({
        title: 'High-value item alert',
        subtitle: formatGbp(amt),
        bodyHtml,
        recipientEmail: prefs?.email,
        preheader: `${itemName} — ${formatGbp(amt)}`,
    });

    const text = buildPlainEmail({
        title: `High-value item: ${itemName}`,
        greeting: `Hello ${name || 'there'},`,
        paragraphs: [`${itemName} (${formatGbp(amt)}) was ${kind}.`],
        ctaLabel: 'Open dashboard',
        ctaUrl: url,
        recipientEmail: prefs?.email,
    });

    return maybeSendEventEmail(db, userId, 'high_value_alert', refKey, {
        subject: `High-value item ${kind}: ${itemName}`,
        text,
        html,
    });
}

async function sendHighValueReceivedEmail(db, userId, receivedId, product, amount) {
    if (!isHighValue(amount)) return false;
    return sendHighValueAlertEmail(db, userId, `received:${receivedId}`, product, amount, 'received');
}

async function sendPayoutPaidEmail(db, userId, periodYm, amount, bankReference) {
    const prefs = getUserEmailPrefs(db, userId);
    const name = (prefs && prefs.billing_name) || '';
    const amt = Number(amount) || 0;
    const url = publicAppUrl() + '/dashboard/invoices.html';
    const refLine = bankReference ? ` Bank reference: <strong>${escapeHtml(bankReference)}</strong>.` : '';

    const bodyHtml =
        greetingHtml(name || 'there') +
        paragraphHtml(
            `Your payout for <strong>${escapeHtml(periodYm)}</strong> has been marked as <strong>paid</strong> (${formatGbp(amt)}).${refLine}`
        ) +
        ctaButtonHtml('View invoices', url) +
        signOffHtml();

    const html = wrapBrandedEmail({
        title: 'Payout sent',
        subtitle: formatGbp(amt),
        bodyHtml,
        recipientEmail: prefs?.email,
        preheader: `Payout ${formatGbp(amt)} for ${periodYm}`,
    });

    const text = buildPlainEmail({
        title: `Payout sent: ${periodYm}`,
        greeting: `Hello ${name || 'there'},`,
        paragraphs: [`Payout for ${periodYm}: ${formatGbp(amt)}.${bankReference ? ' Ref: ' + bankReference : ''}`],
        ctaLabel: 'View invoices',
        ctaUrl: url,
        recipientEmail: prefs?.email,
    });

    const sent = await maybeSendEventEmail(db, userId, 'payout_sent', `payout:${periodYm}`, {
        subject: `Payout sent — ${periodYm}`,
        text,
        html,
    });
    dispatchClientWebhook(db, userId, 'payout_paid', {
        period: periodYm,
        amount_label: formatGbp(amt),
        bank_reference: bankReference || '',
    }).catch(() => {});
    return sent;
}

async function sendQueryReplyWebhook(db, userId, subject) {
    dispatchClientWebhook(db, userId, 'query_reply', { subject: subject || '' }).catch(() => {});
}

module.exports = {
    maybeSendEventEmail,
    sendPackageDeliveredEmail,
    sendItemSoldEmail,
    sendHighValueReceivedEmail,
    sendPayoutPaidEmail,
    sendQueryReplyWebhook,
    highValueThreshold,
    isHighValue,
};

