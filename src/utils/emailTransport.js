/**
 * Shared SMTP transport for outbound email (digests, invoices, transactional).
 */

function envFlag(name) {
    const v = (process.env[name] || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}

function isEmailConfigured() {
    return envFlag('EMAIL_ENABLED') && !!(process.env.SMTP_HOST || '').trim();
}

function isTransactionalEmailEnabled() {
    return isEmailConfigured() && envFlag('TRANSACTIONAL_EMAIL_ENABLED');
}

function isWeeklyDigestEnabled() {
    return isEmailConfigured() && envFlag('WEEKLY_DIGEST_EMAIL_ENABLED');
}

function isMonthlyDigestEnabled() {
    return isEmailConfigured() && envFlag('MONTHLY_DIGEST_EMAIL_ENABLED');
}

function isMonthlyInvoiceEmailEnabled() {
    return isEmailConfigured() && envFlag('MONTHLY_INVOICE_EMAIL_ENABLED');
}

function publicAppUrl() {
    return (
        (process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'https://www.returnpal.co.uk')
            .replace(/\/$/, '')
    );
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function createTransport() {
    const nodemailer = require('nodemailer');
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === '1',
        auth:
            process.env.SMTP_USER && process.env.SMTP_PASS
                ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
                : undefined,
    });
}

async function sendEmail({ to, subject, text, html }) {
    if (!isEmailConfigured()) {
        console.warn('[email] skipped send (EMAIL_ENABLED=0 or SMTP_HOST unset):', subject);
        return false;
    }
    if (!to || !String(to).trim()) {
        console.warn('[email] skipped send — missing recipient:', subject);
        return false;
    }
    const transport = createTransport();
    const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@returnpal.local';
    await transport.sendMail({
        from,
        to: String(to).trim(),
        subject,
        text,
        html: html || undefined,
    });
    return true;
}

module.exports = {
    envFlag,
    isEmailConfigured,
    isTransactionalEmailEnabled,
    isWeeklyDigestEnabled,
    isMonthlyDigestEnabled,
    isMonthlyInvoiceEmailEnabled,
    publicAppUrl,
    escapeHtml,
    createTransport,
    sendEmail,
};
