/**
 * Signup anti-spam: disposable emails, name checks, honeypot, timing, Turnstile.
 */

/** Common disposable / throwaway email domains (lowercase). */
const DISPOSABLE_DOMAINS = new Set([
    '10minutemail.com',
    '10minutemail.net',
    'guerrillamail.com',
    'guerrillamail.net',
    'guerrillamail.org',
    'guerrillamail.biz',
    'sharklasers.com',
    'grr.la',
    'mailinator.com',
    'mailinator.net',
    'mailinator2.com',
    'tempmail.com',
    'temp-mail.org',
    'temp-mail.io',
    'throwaway.email',
    'yopmail.com',
    'yopmail.fr',
    'trashmail.com',
    'trashmail.me',
    'getnada.com',
    'dispostable.com',
    'maildrop.cc',
    'fakeinbox.com',
    'mintemail.com',
    'emailondeck.com',
    'spamgourmet.com',
    'mytemp.email',
    'tempail.com',
    'burnermail.io',
    'inboxkitten.com',
    'mailnesia.com',
    'mohmal.com',
    'tmpmail.net',
    'tmpmail.org',
    'dropmail.me',
    'harakirimail.com',
    'mailcatch.com',
    'mailsac.com',
    'tempr.email',
    'discard.email',
    'mailpoof.com',
    'crazymailing.com',
    'mail.tm',
    'ethereal.email',
    'mailforspam.com',
    'spam4.me',
    'trbvm.com',
    'wegwerfemail.de',
    'wegwerfemail.net',
    'spambox.us',
    'mailnull.com',
    'spambog.com',
    'spambog.de',
    'spambog.ru',
    '0815.ru',
    'objectmail.com',
    'proxymail.eu',
    'rcpt.at',
    'trash-mail.at',
    'trashmail.at',
    'trashmail.com',
    'trashmail.de',
    'trashmail.io',
    'trashmail.me',
    'trashmail.net',
    'trashmail.org',
    'trashmail.ws',
    'mailscrap.com',
    'getairmail.com',
    'fakemailgenerator.com',
    'emailfake.com',
    'cuvox.de',
    'dayrep.com',
    'einrot.com',
    'gustr.com',
    'jourrapide.com',
    'rhyta.com',
    'superrito.com',
    'teleworm.us',
]);

const BLOCKED_NAME_PATTERNS = [
    /^test\s*user$/i,
    /^fake\s/i,
    /^spam/i,
    /^asdf+$/i,
    /^qwerty/i,
    /^null$/i,
    /^undefined$/i,
    /^admin$/i,
    /^user\s*\d*$/i,
];

function emailDomain(email) {
    const parts = String(email || '')
        .toLowerCase()
        .trim()
        .split('@');
    if (parts.length !== 2) return '';
    return parts[1];
}

function isDisposableEmail(email) {
    const domain = emailDomain(email);
    if (!domain) return false;
    if (DISPOSABLE_DOMAINS.has(domain)) return true;
    // subdomain of known disposable providers
    for (const d of DISPOSABLE_DOMAINS) {
        if (domain.endsWith('.' + d)) return true;
    }
    return false;
}

function validateSignupName(name) {
    const n = String(name || '').trim().replace(/\s+/g, ' ');
    if (n.length < 2) return 'Please enter your full name (at least 2 characters).';
    if (n.length > 80) return 'Name is too long.';
    if (!/[a-zA-Z]/.test(n)) return 'Please enter a real name using letters.';
    if (/^[\d\s._-]+$/.test(n)) return 'Please enter a real name.';
    if (/(.)\1{4,}/.test(n)) return 'Please enter a valid name.';
    for (const re of BLOCKED_NAME_PATTERNS) {
        if (re.test(n)) return 'Please enter your real name.';
    }
    return null;
}

function checkHoneypot(body) {
    const traps = ['website', 'company_url', 'url', 'fax'];
    for (const key of traps) {
        const v = body && body[key];
        if (v != null && String(v).trim() !== '') {
            return 'Registration could not be completed.';
        }
    }
    return null;
}

function checkFormTiming(body) {
    const minSec = parseInt(process.env.SIGNUP_MIN_FORM_SECONDS || '3', 10);
    if (!Number.isFinite(minSec) || minSec <= 0) return null;
    const started = parseInt(body && body.form_started_at, 10);
    if (!Number.isFinite(started)) {
        return 'Please open the registration form and try again.';
    }
    if (Date.now() - started < minSec * 1000) {
        return 'Please wait a moment and try again.';
    }
    return null;
}

function isTurnstileConfigured() {
    return !!(process.env.TURNSTILE_SECRET_KEY && process.env.TURNSTILE_SECRET_KEY.trim());
}

function isTurnstileRequired() {
    if (!isTurnstileConfigured()) return false;
    return process.env.SIGNUP_TURNSTILE_REQUIRED !== '0';
}

function getTurnstileSiteKey() {
    const key = process.env.TURNSTILE_SITE_KEY;
    return key && String(key).trim() ? String(key).trim() : null;
}

/**
 * @param {string} token
 * @param {string} [remoteIp]
 */
async function verifyTurnstile(token, remoteIp) {
    if (!isTurnstileRequired()) {
        return { ok: true, skipped: true };
    }
    const secret = process.env.TURNSTILE_SECRET_KEY.trim();
    if (!token || !String(token).trim()) {
        return { ok: false, error: 'Please complete the security check below.' };
    }
    try {
        const params = new URLSearchParams({
            secret,
            response: String(token).trim(),
        });
        if (remoteIp) params.set('remoteip', remoteIp);
        const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
        });
        const data = await res.json().catch(() => ({}));
        if (data.success) return { ok: true };
        return { ok: false, error: 'Security check failed. Please refresh and try again.' };
    } catch (err) {
        console.error('Turnstile verify error:', err);
        return { ok: false, error: 'Security check unavailable. Try again shortly.' };
    }
}

/**
 * Run all signup checks. Returns { ok: true } or { ok: false, error, status }.
 */
async function validateSignupRequest(body, remoteIp) {
    const honeypotErr = checkHoneypot(body);
    if (honeypotErr) return { ok: false, error: honeypotErr, status: 400 };

    const timingErr = checkFormTiming(body);
    if (timingErr) return { ok: false, error: timingErr, status: 400 };

    const nameErr = validateSignupName(body && body.full_name);
    if (nameErr) return { ok: false, error: nameErr, status: 400 };

    const email = body && body.email;
    if (isDisposableEmail(email)) {
        return {
            ok: false,
            error: 'Please use a permanent business email address. Temporary email providers are not allowed.',
            status: 400,
        };
    }

    const ts = await verifyTurnstile(body && body.turnstile_token, remoteIp);
    if (!ts.ok) return { ok: false, error: ts.error, status: 400 };

    return { ok: true };
}

module.exports = {
    isDisposableEmail,
    validateSignupName,
    checkHoneypot,
    checkFormTiming,
    verifyTurnstile,
    validateSignupRequest,
    getTurnstileSiteKey,
    isTurnstileRequired,
    isTurnstileConfigured,
};
