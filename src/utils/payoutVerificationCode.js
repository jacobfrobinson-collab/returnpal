'use strict';

const crypto = require('crypto');

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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

/**
 * RP-XXXX-XXXX (10 chars, no ambiguous 0/O/1/I).
 */
function generatePayoutVerificationCode() {
    const bytes = crypto.randomBytes(10);
    let raw = '';
    for (let i = 0; i < 10; i++) {
        raw += CHARSET[bytes[i] % CHARSET.length];
    }
    return 'RP-' + raw.slice(0, 4) + '-' + raw.slice(4, 8);
}

function normalizeEnvString(value) {
    let s = String(value || '').trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        s = s.slice(1, -1).trim();
    }
    return s;
}

function getBankDetailsFormBaseUrl() {
    return normalizeEnvString(process.env.PAYOUT_BANK_DETAILS_FORM_URL);
}

function jotformCodeFieldName() {
    return String(process.env.PAYOUT_JOTFORM_CODE_FIELD || 'payout_verification_code').trim();
}

function jotformEmailFieldName() {
    return String(process.env.PAYOUT_JOTFORM_EMAIL_FIELD || 'email').trim();
}

/**
 * @param {string} baseUrl
 * @param {string} code
 * @param {string} [email]
 */
function buildBankDetailsFormUrl(baseUrl, code, email) {
    const base = String(baseUrl || '').trim();
    if (!base || !code) return '';
    try {
        const u = new URL(base);
        const codeField = jotformCodeFieldName();
        u.searchParams.set(codeField, code);
        u.searchParams.set(codeField + '[lock]', '1');
        if (email) {
            const emailField = jotformEmailFieldName();
            u.searchParams.set(emailField, email);
            u.searchParams.set(emailField + '[lock]', '1');
        }
        return u.toString();
    } catch {
        const sep = base.includes('?') ? '&' : '?';
        const codeField = encodeURIComponent(jotformCodeFieldName());
        const enc = encodeURIComponent(code);
        let url = base + sep + codeField + '=' + enc + '&' + encodeURIComponent(codeField + '[lock]') + '=1';
        if (email) {
            const emailField = encodeURIComponent(jotformEmailFieldName());
            url += '&' + emailField + '=' + encodeURIComponent(email);
            url += '&' + encodeURIComponent(jotformEmailFieldName() + '[lock]') + '=1';
        }
        return url;
    }
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {{ persist?: boolean }} [opts]
 */
function ensurePayoutVerificationCode(db, userId, opts = {}) {
    const rows = parseResults(
        db.exec(
            `SELECT payout_verification_code, email FROM users WHERE id = ?`,
            [userId]
        )
    );
    if (!rows.length) return null;
    let code = String(rows[0].payout_verification_code || '').trim();
    if (!code) {
        code = generatePayoutVerificationCode();
        let attempts = 0;
        while (attempts < 8) {
            const clash = parseResults(
                db.exec('SELECT id FROM users WHERE payout_verification_code = ? AND id != ?', [code, userId])
            );
            if (!clash.length) break;
            code = generatePayoutVerificationCode();
            attempts += 1;
        }
        db.run(
            `UPDATE users SET payout_verification_code = ?, updated_at = datetime('now') WHERE id = ?`,
            [code, userId]
        );
    }
    const baseUrl = getBankDetailsFormBaseUrl();
    const email = rows[0].email || '';
    return {
        payout_verification_code: code,
        bank_details_form_url: buildBankDetailsFormUrl(baseUrl, code, email),
        form_configured: !!baseUrl,
    };
}

/**
 * Normalize pasted Jotform / admin lookup input to stored RP-XXXX-XXXX form.
 */
function normalizePayoutVerificationCodeInput(raw) {
    let s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!s) return '';
    s = s.replace(/^RP[-\s]*/i, '');
    const alnum = s.replace(/[^A-Z0-9]/g, '');
    if (alnum.length < 8) return '';
    return 'RP-' + alnum.slice(0, 4) + '-' + alnum.slice(4, 8);
}

/**
 * @param {import('sql.js').Database} db
 * @param {string} codeInput
 */
function lookupClientByPayoutVerificationCode(db, codeInput) {
    const code = normalizePayoutVerificationCodeInput(codeInput);
    if (!code) return null;
    const rows = parseResults(
        db.exec(
            `SELECT id, email, full_name, company_name, payout_verification_code
             FROM users WHERE payout_verification_code = ?`,
            [code]
        )
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
        id: row.id,
        client_code: 'RP' + String(row.id).padStart(4, '0'),
        email: row.email || '',
        full_name: row.full_name || '',
        company_name: row.company_name || '',
        payout_verification_code: row.payout_verification_code || code,
    };
}

module.exports = {
    generatePayoutVerificationCode,
    ensurePayoutVerificationCode,
    buildBankDetailsFormUrl,
    getBankDetailsFormBaseUrl,
    normalizePayoutVerificationCodeInput,
    lookupClientByPayoutVerificationCode,
};
