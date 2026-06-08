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

    return maybeSendEventEmail(db, userId, 'package_delivered', `package:${packageId}`, {
        subject: `Package delivered: ${ref}`,
        text,
        html,
    });
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

    return maybeSendEventEmail(db, userId, 'item_sold', `sold:${soldItemId}`, {
        subject: `Item sold: ${itemName}`,
        text,
        html,
    });
}

module.exports = {
    maybeSendEventEmail,
    sendPackageDeliveredEmail,
    sendItemSoldEmail,
};
