/**
 * Branded HTML email layouts for ReturnPal (table-based, inline styles for clients).
 */
const { publicAppUrl, escapeHtml } = require('./emailTransport');

const BRAND = {
    primary: '#128BD0',
    primaryDark: '#0e6fa8',
    secondary: '#9035e3',
    success: '#5cc184',
    warning: '#f0934e',
    info: '#45c5cd',
    danger: '#e96767',
    text: '#323a46',
    textMuted: '#687d92',
    border: '#d8dfe7',
    bg: '#eef2f7',
    white: '#ffffff',
};

function logoUrl() {
    const custom = (process.env.EMAIL_LOGO_URL || '').trim();
    if (custom) return custom;
    return publicAppUrl() + '/assets/img/logo/logo.png';
}

function supportEmail() {
    return (process.env.EMAIL_SUPPORT_ADDRESS || 'contact@returnpal.co.uk').trim();
}

function formatGbp(amount) {
    const n = Number(amount) || 0;
    const abs = Math.abs(n).toFixed(2);
    if (n < 0) return `-£${abs}`;
    return `£${abs}`;
}

/**
 * @param {object} opts
 * @param {string} opts.title - Email heading
 * @param {string} [opts.subtitle]
 * @param {string} opts.bodyHtml - Inner content
 * @param {string} [opts.recipientEmail] - Shown in footer
 * @param {string} [opts.preheader] - Inbox preview (hidden)
 */
function wrapBrandedEmail({ title, subtitle, bodyHtml, recipientEmail, preheader }) {
    const year = new Date().getFullYear();
    const site = publicAppUrl();
    const support = supportEmail();
    const logo = escapeHtml(logoUrl());
    const pre = preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>` : '';

    return (
        `${pre}` +
        `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escapeHtml(title)}</title></head>` +
        `<body style="margin:0;padding:0;background-color:${BRAND.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.text};">` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.bg};padding:24px 12px;">` +
        `<tr><td align="center">` +
        `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${BRAND.white};border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(18,139,208,0.12);">` +
        `<tr><td style="background:linear-gradient(135deg,${BRAND.primary} 0%,${BRAND.secondary} 100%);padding:28px 32px;text-align:center;">` +
        `<img src="${logo}" alt="ReturnPal" width="140" style="display:block;margin:0 auto 12px;max-width:140px;height:auto;border:0;" />` +
        `<div style="font-size:22px;font-weight:700;color:${BRAND.white};letter-spacing:-0.02em;">${escapeHtml(title)}</div>` +
        (subtitle
            ? `<div style="font-size:14px;color:rgba(255,255,255,0.92);margin-top:6px;">${escapeHtml(subtitle)}</div>`
            : '') +
        `</td></tr>` +
        `<tr><td style="padding:32px;">${bodyHtml}</td></tr>` +
        `<tr><td style="padding:24px 32px;background:${BRAND.bg};border-top:1px solid ${BRAND.border};text-align:center;font-size:13px;color:${BRAND.textMuted};line-height:1.6;">` +
        `<p style="margin:0 0 8px;font-weight:600;color:${BRAND.text};">ReturnPal</p>` +
        `<p style="margin:0 0 12px;">` +
        `<a href="${escapeHtml(site)}" style="color:${BRAND.primary};text-decoration:none;">Visit website</a>` +
        ` &nbsp;|&nbsp; ` +
        `<a href="mailto:${escapeHtml(support)}" style="color:${BRAND.primary};text-decoration:none;">Contact support</a>` +
        `</p>` +
        `<p style="margin:0;font-size:12px;">© ${year} ReturnPal. All rights reserved.</p>` +
        (recipientEmail
            ? `<p style="margin:8px 0 0;font-size:11px;color:${BRAND.textMuted};">This email was sent to ${escapeHtml(recipientEmail)}</p>`
            : '') +
        `</td></tr></table></td></tr></table></body></html>`
    );
}

function greetingHtml(name) {
    const who = escapeHtml(name || 'there');
    return `<p style="margin:0 0 20px;font-size:16px;line-height:1.5;color:${BRAND.text};">Hello <strong>${who}</strong>,</p>`;
}

function paragraphHtml(text) {
    return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${BRAND.textMuted};">${text}</p>`;
}

function statusBadge(label, tone) {
    const colors = {
        success: { bg: '#e8f8ef', fg: '#2d8a55', border: '#5cc184' },
        warning: { bg: '#fff4e8', fg: '#b45309', border: '#f0934e' },
        info: { bg: '#e8f6fc', fg: '#0e6fa8', border: BRAND.primary },
        muted: { bg: BRAND.bg, fg: BRAND.textMuted, border: BRAND.border },
    };
    const c = colors[tone] || colors.info;
    return (
        `<span style="display:inline-block;padding:6px 14px;border-radius:20px;font-size:12px;font-weight:700;` +
        `letter-spacing:0.04em;text-transform:uppercase;background:${c.bg};color:${c.fg};border:1px solid ${c.border};">` +
        `${escapeHtml(label)}</span>`
    );
}

/**
 * Hero payout / headline amount block (Unturned-style).
 */
function heroAmountBlock({ label, amount, statusLabel, statusTone, noActivity, displayText }) {
    const display = displayText != null ? String(displayText) : noActivity ? formatGbp(0) : formatGbp(amount);
    const sub = noActivity && !displayText ? 'No activity' : label;
    return (
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background:linear-gradient(135deg,${BRAND.bg} 0%,#f0f7fc 100%);border-radius:10px;border:1px solid ${BRAND.border};">` +
        `<tr><td style="padding:24px;text-align:center;">` +
        `<div style="font-size:13px;font-weight:600;color:${BRAND.textMuted};text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">${escapeHtml(sub)}</div>` +
        `<div style="font-size:${displayText ? '22px' : '36px'};font-weight:800;color:${BRAND.primary};letter-spacing:-0.03em;line-height:1.2;word-break:break-word;">${escapeHtml(display)}</div>` +
        (statusLabel
            ? `<div style="margin-top:14px;">${statusBadge(statusLabel, statusTone || 'info')}</div>`
            : '') +
        `</td></tr></table>`
    );
}

/**
 * @param {Array<{label:string,value:string,emphasis?:boolean,negative?:boolean}>} rows
 */
function summaryTableHtml(title, rows) {
    let rowsHtml = '';
    for (const row of rows) {
        const valColor = row.negative ? BRAND.danger : row.emphasis ? BRAND.primary : BRAND.text;
        const valWeight = row.emphasis ? '700' : '600';
        rowsHtml +=
            `<tr>` +
            `<td style="padding:12px 16px;border-bottom:1px solid ${BRAND.border};font-size:14px;color:${BRAND.textMuted};">${escapeHtml(row.label)}</td>` +
            `<td style="padding:12px 16px;border-bottom:1px solid ${BRAND.border};font-size:14px;text-align:right;font-weight:${valWeight};color:${valColor};white-space:nowrap;">${escapeHtml(row.value)}</td>` +
            `</tr>`;
    }
    return (
        `<div style="margin:0 0 24px;">` +
        `<div style="font-size:13px;font-weight:700;color:${BRAND.text};text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;">${escapeHtml(title)}</div>` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND.border};border-radius:8px;overflow:hidden;background:${BRAND.white};">` +
        rowsHtml +
        `</table></div>`
    );
}

function noticeBoxHtml(html) {
    return (
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">` +
        `<tr><td style="padding:16px 18px;background:#f0f9ff;border-left:4px solid ${BRAND.primary};border-radius:0 8px 8px 0;font-size:14px;line-height:1.55;color:${BRAND.text};">` +
        html +
        `</td></tr></table>`
    );
}

function ctaButtonHtml(text, url) {
    return (
        `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">` +
        `<tr><td style="border-radius:8px;background:linear-gradient(135deg,${BRAND.primary} 0%,${BRAND.primaryDark} 100%);">` +
        `<a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:${BRAND.white};text-decoration:none;border-radius:8px;">` +
        `${escapeHtml(text)} →` +
        `</a></td></tr></table>`
    );
}

function signOffHtml() {
    return `<p style="margin:24px 0 0;font-size:15px;color:${BRAND.text};">Thanks!<br><strong style="color:${BRAND.primary};">The ReturnPal team</strong></p>`;
}

function buildPlainEmail({ title, greeting, paragraphs, summaryLines, ctaLabel, ctaUrl, recipientEmail }) {
    const lines = [
        title,
        '',
        greeting,
        '',
        ...paragraphs,
        '',
    ];
    if (summaryLines && summaryLines.length) {
        lines.push('Summary', ...summaryLines.map((r) => `  ${r.label}: ${r.value}`), '');
    }
    if (ctaLabel && ctaUrl) {
        lines.push(`${ctaLabel}: ${ctaUrl}`, '');
    }
    lines.push('Thanks!', 'ReturnPal', publicAppUrl());
    if (recipientEmail) lines.push('', `This email was sent to ${recipientEmail}`);
    return lines.join('\n');
}

module.exports = {
    BRAND,
    logoUrl,
    formatGbp,
    wrapBrandedEmail,
    greetingHtml,
    paragraphHtml,
    statusBadge,
    heroAmountBlock,
    summaryTableHtml,
    noticeBoxHtml,
    ctaButtonHtml,
    signOffHtml,
    buildPlainEmail,
};
