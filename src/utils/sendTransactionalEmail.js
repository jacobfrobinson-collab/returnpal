const { isTransactionalEmailEnabled, sendEmail, publicAppUrl, escapeHtml } = require('./emailTransport');
const { getUserEmailPrefs, wantsEventEmail } = require('./emailPreferences');
const { wasEmailSent, recordEmailSent } = require('./emailLog');

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
    const ref = String(reference || '').trim() || 'your package';
    const url = publicAppUrl() + '/dashboard/packages.html';
    return maybeSendEventEmail(db, userId, 'package_delivered', `package:${packageId}`, {
        subject: `Package delivered: ${ref}`,
        text: `Your package ${ref} has been marked as delivered at ReturnPal.\n\nView packages: ${url}\n\n— ReturnPal`,
        html:
            `<p>Your package <strong>${escapeHtml(ref)}</strong> has been marked as delivered at ReturnPal.</p>` +
            `<p><a href="${escapeHtml(url)}">View packages</a></p><p>— ReturnPal</p>`,
    });
}

async function sendItemSoldEmail(db, userId, soldItemId, product, amount) {
    const name = String(product || 'Item').trim();
    const amt = Number(amount) || 0;
    const url = publicAppUrl() + '/dashboard/sold-items.html';
    return maybeSendEventEmail(db, userId, 'item_sold', `sold:${soldItemId}`, {
        subject: `Item sold: ${name}`,
        text: `Item "${name}" was recorded as sold for £${amt.toFixed(2)}.\n\nView sold items: ${url}\n\n— ReturnPal`,
        html:
            `<p>Item <strong>${escapeHtml(name)}</strong> was recorded as sold for <strong>£${amt.toFixed(2)}</strong>.</p>` +
            `<p><a href="${escapeHtml(url)}">View sold items</a></p><p>— ReturnPal</p>`,
    });
}

module.exports = {
    maybeSendEventEmail,
    sendPackageDeliveredEmail,
    sendItemSoldEmail,
};
