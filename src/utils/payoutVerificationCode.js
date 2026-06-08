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
function readPayoutOnFileFields(row) {
    const onFile = row && (row.payout_details_on_file === 1 || row.payout_details_on_file === '1');
    return {
        payout_details_on_file: !!onFile,
        payout_details_submitted_at: String((row && row.payout_details_submitted_at) || '').trim(),
    };
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {{ onFile: boolean, submittedAt?: string }} opts
 */
function setPayoutDetailsOnFile(db, userId, opts) {
    const onFile = opts.onFile ? 1 : 0;
    const submittedAt = opts.onFile
        ? opts.submittedAt || new Date().toISOString().slice(0, 19).replace('T', ' ')
        : '';
    db.run(
        `UPDATE users SET payout_details_on_file = ?, payout_details_submitted_at = ?, updated_at = datetime('now') WHERE id = ?`,
        [onFile, submittedAt, userId]
    );
    return {
        payout_details_on_file: !!onFile,
        payout_details_submitted_at: submittedAt,
    };
}

/**
 * @param {import('sql.js').Database} db
 * @param {string} codeInput
 */
function recordPayoutDetailsFromWebhook(db, codeInput) {
    const match = lookupClientByPayoutVerificationCode(db, codeInput);
    if (!match) return null;
    const flags = setPayoutDetailsOnFile(db, match.id, { onFile: true });
    return {
        userId: match.id,
        email: match.email,
        ...flags,
    };
}

const PAYOUT_CODE_IN_TEXT = /RP[-\s]?[A-Z0-9]{4}[-\s]?[A-Z0-9]{4}/i;

function extractCodeFromText(value) {
    const m = String(value || '').match(PAYOUT_CODE_IN_TEXT);
    if (!m) return '';
    return normalizePayoutVerificationCodeInput(m[0]);
}

function scanObjectForPayoutCode(obj, depth) {
    if (!obj || depth > 6) return '';
    if (typeof obj === 'string') return extractCodeFromText(obj);
    if (Array.isArray(obj)) {
        for (const item of obj) {
            const found = scanObjectForPayoutCode(item, depth + 1);
            if (found) return found;
        }
        return '';
    }
    if (typeof obj !== 'object') return '';
    for (const key of Object.keys(obj)) {
        const val = obj[key];
        const keyLower = String(key).toLowerCase();
        if (
            keyLower.includes('payout') &&
            (keyLower.includes('code') || keyLower.includes('verification'))
        ) {
            const direct = extractCodeFromText(val);
            if (direct) return direct;
        }
        const found = scanObjectForPayoutCode(val, depth + 1);
        if (found) return found;
    }
    return '';
}

/**
 * Extract verification code from Jotform webhook body (rawRequest or flat fields).
 * Jotform often uses internal keys like q5_payoutVerificationCode — we also scan for RP-XXXX-XXXX.
 * @param {object} body
 */
function extractPayoutCodeFromJotformBody(body) {
    if (!body || typeof body !== 'object') return '';
    const field = jotformCodeFieldName();
    let raw = body.rawRequest;
    if (raw) {
        try {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (parsed && parsed[field] != null) {
                const direct = extractCodeFromText(parsed[field]);
                if (direct) return direct;
            }
            for (const key of Object.keys(parsed || {})) {
                if (String(key).toLowerCase() === field.toLowerCase() && parsed[key] != null) {
                    const direct = extractCodeFromText(parsed[key]);
                    if (direct) return direct;
                }
            }
            const scanned = scanObjectForPayoutCode(parsed, 0);
            if (scanned) return scanned;
        } catch {
            /* fall through */
        }
    }
    if (body[field] != null) {
        const direct = extractCodeFromText(body[field]);
        if (direct) return direct;
    }
    for (const key of Object.keys(body)) {
        if (String(key).toLowerCase() === field.toLowerCase() && body[key] != null) {
            const direct = extractCodeFromText(body[key]);
            if (direct) return direct;
        }
    }
    return scanObjectForPayoutCode(body, 0);
}

function ensurePayoutVerificationCode(db, userId, opts = {}) {
    const rows = parseResults(
        db.exec(
            `SELECT payout_verification_code, email, payout_details_on_file, payout_details_submitted_at
             FROM users WHERE id = ?`,
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
    const onFile = readPayoutOnFileFields(rows[0]);
    return {
        payout_verification_code: code,
        bank_details_form_url: buildBankDetailsFormUrl(baseUrl, code, email),
        form_configured: !!baseUrl,
        ...onFile,
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
    jotformCodeFieldName,
    normalizePayoutVerificationCodeInput,
    lookupClientByPayoutVerificationCode,
    setPayoutDetailsOnFile,
    recordPayoutDetailsFromWebhook,
    extractPayoutCodeFromJotformBody,
    readPayoutOnFileFields,
};
