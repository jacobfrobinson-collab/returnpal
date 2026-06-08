/**
 * Password reset tokens and branded reset emails.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { saveDb } = require('../database');
const { isEmailConfigured, sendEmail, publicAppUrl, escapeHtml } = require('./emailTransport');
const {
    wrapBrandedEmail,
    greetingHtml,
    paragraphHtml,
    ctaButtonHtml,
    signOffHtml,
    buildPlainEmail,
} = require('./emailTemplates');

const DEFAULT_TTL_HOURS = 24;

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

function tokenTtlHours() {
    const n = parseInt(process.env.PASSWORD_RESET_TTL_HOURS || String(DEFAULT_TTL_HOURS), 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_HOURS;
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function ensurePasswordResetSchema(db) {
    db.run(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            used_at TEXT DEFAULT '',
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_password_reset_hash ON password_reset_tokens(token_hash)');
}

function invalidateUserTokens(db, userId) {
    db.run(
        `UPDATE password_reset_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at = ''`,
        [userId]
    );
}

function createResetToken(db, userId) {
    ensurePasswordResetSchema(db);
    invalidateUserTokens(db, userId);
    const raw = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(raw);
    const hours = tokenTtlHours();
    db.run(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES (?, ?, datetime('now', ?))`,
        [userId, tokenHash, `+${hours} hours`]
    );
    return { token: raw, ttlHours: hours };
}

function findValidTokenRow(db, rawToken) {
    ensurePasswordResetSchema(db);
    const tokenHash = hashToken(rawToken);
    const rows = parseResults(
        db.exec(
            `SELECT id, user_id, expires_at, used_at FROM password_reset_tokens
             WHERE token_hash = ? AND used_at = '' AND expires_at > datetime('now')
             ORDER BY id DESC LIMIT 1`,
            [tokenHash]
        )
    );
    return rows[0] || null;
}

async function applyPasswordReset(db, rawToken, newPassword) {
    const row = findValidTokenRow(db, rawToken);
    if (!row) {
        throw Object.assign(new Error('Invalid or expired reset link. Request a new one from the login page.'), {
            code: 'invalid_token',
        });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    db.run("UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?", [hash, row.user_id]);
    db.run(`UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?`, [row.id]);
    invalidateUserTokens(db, row.user_id);
    saveDb();
    return row.user_id;
}

function buildResetEmail({ name, resetUrl, ttlHours }) {
    const subject = 'Reset your ReturnPal password';
    const bodyHtml =
        greetingHtml(name || 'there') +
        paragraphHtml(
            'We received a request to reset the password for your ReturnPal account. Click the button below to choose a new password.'
        ) +
        ctaButtonHtml('Reset password', resetUrl) +
        paragraphHtml(
            `This link expires in <strong>${ttlHours} hour${ttlHours === 1 ? '' : 's'}</strong>. If you did not request a reset, you can ignore this email — your password will not change.`
        ) +
        signOffHtml();

    const html = wrapBrandedEmail({
        title: 'Password reset',
        subtitle: subject,
        bodyHtml,
        preheader: 'Reset your ReturnPal password',
    });

    const text = buildPlainEmail({
        title: subject,
        greeting: `Hi ${name || 'there'},`,
        paragraphs: [
            'We received a request to reset your ReturnPal password.',
            `Reset link (expires in ${ttlHours} hours):`,
            resetUrl,
            'If you did not request this, ignore this email.',
        ],
    });

    return { subject, text, html };
}

async function sendPasswordResetEmail(db, user, rawToken, ttlHours) {
    if (!isEmailConfigured()) {
        console.warn('[password-reset] email not configured — token created but not sent');
        return false;
    }
    const resetUrl =
        publicAppUrl() + '/reset-password.html?token=' + encodeURIComponent(rawToken);
    const { subject, text, html } = buildResetEmail({
        name: user.full_name || user.email,
        resetUrl,
        ttlHours,
    });
    return sendEmail({ to: user.email, subject, text, html });
}

module.exports = {
    ensurePasswordResetSchema,
    createResetToken,
    findValidTokenRow,
    applyPasswordReset,
    sendPasswordResetEmail,
    hashToken,
    tokenTtlHours,
};
