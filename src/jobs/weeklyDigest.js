/**
 * Optional Monday 08:00 digest email (configure SMTP_* env vars).
 */
const { getDb } = require('../database');

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

function buildDigestBody(u, stats) {
    const name = u.full_name || u.email || 'there';
    return {
        subject: 'Your ReturnPal week in review',
        text:
            `Hi ${name},\n\n` +
            `Here is activity on your account in the last 7 days:\n` +
            `• Received check-ins: ${stats.received}\n` +
            `• Sales recorded: ${stats.sold}\n` +
            `• Reimbursement claims: ${stats.claims}\n\n` +
            `Open your dashboard: ${process.env.PUBLIC_APP_URL || 'https://returnpal.co.uk'}/dashboard/index.html\n\n` +
            `— ReturnPal`,
        html:
            `<p>Hi ${escapeHtml(name)},</p>` +
            `<p>Activity in the last 7 days:</p><ul>` +
            `<li>Received check-ins: <strong>${stats.received}</strong></li>` +
            `<li>Sales recorded: <strong>${stats.sold}</strong></li>` +
            `<li>Reimbursement claims: <strong>${stats.claims}</strong></li></ul>` +
            `<p><a href="${escapeHtml(process.env.PUBLIC_APP_URL || 'https://returnpal.co.uk')}/dashboard/index.html">Open dashboard</a></p>` +
            `<p>— ReturnPal</p>`,
    };
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function sendDigestForUser(nodemailer, transport, u) {
    const db = await getDb();
    const uid = u.id;
    const received = parseResults(
        db.exec(
            "SELECT COUNT(*) as c FROM received_items WHERE user_id = ? AND date_received >= datetime('now', '-7 days')",
            [uid]
        )
    );
    const sold = parseResults(
        db.exec(
            "SELECT COUNT(*) as c FROM sold_items WHERE user_id = ? AND sold_date >= date(datetime('now', '-7 days'))",
            [uid]
        )
    );
    const claims = parseResults(
        db.exec(
            "SELECT COUNT(*) as c FROM reimbursement_claims WHERE user_id = ? AND created_at >= datetime('now', '-7 days')",
            [uid]
        )
    );
    const stats = {
        received: received[0]?.c || 0,
        sold: sold[0]?.c || 0,
        claims: claims[0]?.c || 0,
    };
    if (stats.received + stats.sold + stats.claims === 0) return;

    const { subject, text, html } = buildDigestBody(u, stats);
    const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@returnpal.local';
    await transport.sendMail({
        from,
        to: u.email,
        subject,
        text,
        html,
    });
}

async function runWeeklyDigestOnce() {
    if (process.env.WEEKLY_DIGEST_EMAIL_ENABLED !== '1') {
        return;
    }
    if (!process.env.SMTP_HOST) {
        console.warn('[weekly-digest] WEEKLY_DIGEST_EMAIL_ENABLED=1 but SMTP_HOST is not set; skipping send.');
        return;
    }
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === '1',
        auth:
            process.env.SMTP_USER && process.env.SMTP_PASS
                ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
                : undefined,
    });

    const db = await getDb();
    const users = parseResults(
        db.exec(
            `SELECT id, email, full_name FROM users
             WHERE COALESCE(is_admin, 0) = 0
               AND COALESCE(weekly_digest_email, 1) = 1
               AND email IS NOT NULL AND TRIM(email) <> ''`
        )
    );

    for (const u of users) {
        try {
            await sendDigestForUser(nodemailer, transport, u);
        } catch (e) {
            console.error('[weekly-digest] send failed for user', u.id, e.message || e);
        }
    }
    console.log('[weekly-digest] completed run for', users.length, 'subscribers');
}

function startWeeklyDigestScheduler() {
    if (process.env.WEEKLY_DIGEST_EMAIL_ENABLED !== '1') {
        return;
    }
    let cron;
    try {
        cron = require('node-cron');
    } catch (e) {
        console.warn('[weekly-digest] node-cron not installed; scheduler disabled.');
        return;
    }
    const expr = process.env.WEEKLY_DIGEST_CRON || '0 8 * * 1';
    cron.schedule(
        expr,
        () => {
            runWeeklyDigestOnce().catch((err) => console.error('[weekly-digest]', err));
        },
        { timezone: process.env.WEEKLY_DIGEST_TZ || 'Europe/London' }
    );
    console.log('[weekly-digest] scheduler started:', expr, process.env.WEEKLY_DIGEST_TZ || 'Europe/London');
}

module.exports = { startWeeklyDigestScheduler, runWeeklyDigestOnce };
