/**
 * Email ReturnPal operators for inbound messages (client queries, homepage contact form).
 */
const PUBLIC_CONTACT_LOG_USER_ID = 0;
const { isEmailConfigured, sendEmail, publicAppUrl, escapeHtml } = require('./emailTransport');
const {
    wrapBrandedEmail,
    greetingHtml,
    paragraphHtml,
    summaryTableHtml,
    ctaButtonHtml,
    signOffHtml,
    buildPlainEmail,
} = require('./emailTemplates');
const { wasEmailSent, recordEmailSent } = require('./emailLog');

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

function envFlag(name) {
    const v = (process.env[name] || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}

function isAdminQueryNotifyEnabled() {
    if (!isEmailConfigured()) return false;
    if (envFlag('ADMIN_QUERY_NOTIFY_ENABLED')) return true;
    return envFlag('TRANSACTIONAL_EMAIL_ENABLED');
}

function adminNotifyEmail() {
    return (
        (process.env.ADMIN_QUERY_NOTIFY_EMAIL || '').trim() ||
        (process.env.ADMIN_NOTIFY_EMAIL || '').trim() ||
        'contact@returnpal.co.uk'
    );
}

function truncate(text, max = 4000) {
    const s = String(text || '').trim();
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
}

function fetchClientUser(db, userId) {
    const rows = parseResults(
        db.exec(
            `SELECT id, email, full_name, company_name FROM users WHERE id = ?`,
            [userId]
        )
    );
    return rows[0] || null;
}

function buildAdminQueryEmail({ client, queryId, message, contextLabel, contextType, isFollowUp }) {
    const clientName = client.full_name || client.email || 'Client';
    const clientEmail = client.email || '';
    const company = client.company_name || '';
    const about = contextLabel || contextType || 'General';
    const adminUrl = publicAppUrl() + '/admin/queries.html';
    const title = isFollowUp ? 'Client query follow-up' : 'New client query';
    const subject = isFollowUp
        ? `ReturnPal: follow-up on query #${queryId} — ${clientName}`
        : `ReturnPal: new client query #${queryId} — ${clientName}`;

    const msgHtml = escapeHtml(truncate(message)).replace(/\n/g, '<br>');

    const summaryRows = [
        { label: 'Client', value: clientName, emphasis: true },
        { label: 'Email', value: clientEmail || '—' },
        ...(company ? [{ label: 'Company', value: company }] : []),
        { label: 'Query #', value: String(queryId) },
        { label: 'About', value: about || '—' },
        { label: 'Type', value: String(contextType || 'general') },
    ];

    const bodyHtml =
        greetingHtml('team') +
        paragraphHtml(
            isFollowUp
                ? `<strong>${escapeHtml(clientName)}</strong> sent a <strong>follow-up</strong> on query <strong>#${queryId}</strong>. Reply from the admin queries page so it appears in their dashboard thread.`
                : `<strong>${escapeHtml(clientName)}</strong> submitted a <strong>new question</strong> from the client dashboard.`
        ) +
        summaryTableHtml('Query details', summaryRows) +
        `<div style="margin:0 0 24px;padding:16px 18px;background:#f8fafc;border:1px solid #d8dfe7;border-radius:8px;">` +
        `<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#687d92;margin-bottom:8px;">Message</div>` +
        `<div style="font-size:15px;line-height:1.6;color:#323a46;white-space:pre-wrap;">${msgHtml}</div></div>` +
        ctaButtonHtml('Open admin queries', adminUrl) +
        signOffHtml();

    const html = wrapBrandedEmail({
        title,
        subtitle: `Query #${queryId}`,
        bodyHtml,
        preheader: `${clientName}: ${truncate(message, 120)}`,
    });

    const text = buildPlainEmail({
        title: subject,
        greeting: 'Hello team,',
        paragraphs: [
            isFollowUp
                ? `${clientName} (${clientEmail}) sent a follow-up on query #${queryId}.`
                : `${clientName} (${clientEmail}) submitted a new query (#${queryId}).`,
            `About: ${about}`,
            '',
            'Message:',
            truncate(message),
        ],
        ctaLabel: 'Admin queries',
        ctaUrl: adminUrl,
    });

    return { subject, text, html };
}

/**
 * @param {import('sql.js').Database} db
 * @param {object} opts
 * @param {number} opts.queryId
 * @param {number} opts.clientUserId
 * @param {string} opts.message
 * @param {string} [opts.contextLabel]
 * @param {string} [opts.contextType]
 * @param {boolean} [opts.isFollowUp]
 * @param {number} [opts.messageId] — for follow-up idempotency
 */
async function notifyAdminClientQuery(db, opts) {
    if (!isAdminQueryNotifyEnabled()) return false;

    const to = adminNotifyEmail();
    if (!to) {
        console.warn('[admin-query-notify] no ADMIN_QUERY_NOTIFY_EMAIL configured');
        return false;
    }

    const {
        queryId,
        clientUserId,
        message,
        contextLabel = '',
        contextType = 'general',
        isFollowUp = false,
        messageId = null,
    } = opts;

    const refKey = isFollowUp && messageId != null
        ? `query:${queryId}:msg:${messageId}`
        : `query:${queryId}:new`;

    if (wasEmailSent(db, clientUserId, 'admin_query_notify', refKey)) {
        return false;
    }

    const client = fetchClientUser(db, clientUserId);
    if (!client) return false;

    const { subject, text, html } = buildAdminQueryEmail({
        client,
        queryId,
        message,
        contextLabel,
        contextType,
        isFollowUp,
    });

    const sent = await sendEmail({ to, subject, text, html });
    if (sent) {
        recordEmailSent(db, clientUserId, 'admin_query_notify', refKey);
        console.log('[admin-query-notify] sent to', to, 'for query', queryId);
    }
    return sent;
}

function buildAdminContactFormEmail({ name, email, subject, message, contactId }) {
    const title = 'New website contact message';
    const emailSubject = `ReturnPal: contact form — ${subject || name}`;
    const msgHtml = escapeHtml(truncate(message)).replace(/\n/g, '<br>');

    const summaryRows = [
        { label: 'Name', value: name || '—', emphasis: true },
        { label: 'Email', value: email || '—' },
        { label: 'Subject', value: subject || '—' },
        { label: 'Message #', value: contactId != null ? String(contactId) : '—' },
    ];

    const bodyHtml =
        greetingHtml('team') +
        paragraphHtml(
            `Someone submitted the <strong>contact form</strong> on the ReturnPal homepage. Reply directly to their email address below.`
        ) +
        summaryTableHtml('Contact details', summaryRows) +
        `<div style="margin:0 0 24px;padding:16px 18px;background:#f8fafc;border:1px solid #d8dfe7;border-radius:8px;">` +
        `<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#687d92;margin-bottom:8px;">Message</div>` +
        `<div style="font-size:15px;line-height:1.6;color:#323a46;">${msgHtml}</div></div>` +
        (email
            ? `<p style="margin:0 0 24px;font-size:14px;color:#687d92;">Reply: <a href="mailto:${escapeHtml(email)}" style="color:#128BD0;">${escapeHtml(email)}</a></p>`
            : '') +
        signOffHtml();

    const html = wrapBrandedEmail({
        title,
        subtitle: subject || 'Homepage contact',
        bodyHtml,
        preheader: `${name}: ${truncate(message, 120)}`,
    });

    const text = buildPlainEmail({
        title: emailSubject,
        greeting: 'Hello team,',
        paragraphs: [
            `New message from the homepage contact form.`,
            `From: ${name} <${email}>`,
            `Subject: ${subject}`,
            '',
            'Message:',
            truncate(message),
        ],
    });

    return { subject: emailSubject, text, html };
}

/**
 * @param {import('sql.js').Database} db
 * @param {object} opts
 * @param {number} opts.contactId
 * @param {string} opts.name
 * @param {string} opts.email
 * @param {string} opts.subject
 * @param {string} opts.message
 */
async function notifyAdminContactMessage(db, opts) {
    if (!isAdminQueryNotifyEnabled()) return false;

    const to = adminNotifyEmail();
    if (!to) {
        console.warn('[admin-contact-notify] no ADMIN_QUERY_NOTIFY_EMAIL configured');
        return false;
    }

    const { contactId, name, email, subject, message } = opts;
    const refKey = `contact:${contactId}`;

    if (wasEmailSent(db, PUBLIC_CONTACT_LOG_USER_ID, 'admin_contact_notify', refKey)) {
        return false;
    }

    const { subject: emailSubject, text, html } = buildAdminContactFormEmail({
        name,
        email,
        subject,
        message,
        contactId,
    });

    const sent = await sendEmail({ to, subject: emailSubject, text, html });
    if (sent) {
        recordEmailSent(db, PUBLIC_CONTACT_LOG_USER_ID, 'admin_contact_notify', refKey);
        console.log('[admin-contact-notify] sent to', to, 'for contact', contactId);
    }
    return sent;
}

module.exports = {
    isAdminQueryNotifyEnabled,
    adminNotifyEmail,
    notifyAdminClientQuery,
    notifyAdminContactMessage,
    PUBLIC_CONTACT_LOG_USER_ID,
};
