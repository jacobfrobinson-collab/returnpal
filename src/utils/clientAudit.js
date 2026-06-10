const { saveDb } = require('../database');
const { coerceIsAdmin } = require('./coerceIsAdmin');

const SENSITIVE_KEY = /password|token|secret|webhook|bank|sort_code|account_number|iban/i;
const MAX_STRING_LEN = 500;
const MAX_DETAIL_LEN = 4000;

/** In-memory debounce for page views (per process). */
const recentPageViews = new Map();
const PAGE_VIEW_DEBOUNCE_MS = 30000;

const BEACON_CATEGORIES = new Set(['view', 'export']);
const BEACON_ACTION_PREFIXES = ['page_', 'export_', 'package_journey_open', 'print_invoice'];

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
 * Deep-copy and redact sensitive fields for audit storage.
 * @param {unknown} obj
 * @returns {unknown}
 */
function sanitizeAuditDetail(obj) {
    if (obj == null) return obj;
    if (typeof obj !== 'object') {
        const s = String(obj);
        return s.length > MAX_STRING_LEN ? s.slice(0, MAX_STRING_LEN) + '…' : s;
    }
    if (Array.isArray(obj)) {
        return obj.map(sanitizeAuditDetail);
    }
    const out = {};
    for (const [key, val] of Object.entries(obj)) {
        if (SENSITIVE_KEY.test(key)) {
            if (typeof val === 'boolean') out[key] = val;
            else if (val != null && String(val).trim() !== '') out[key] = '[redacted]';
            else out[key] = val;
            continue;
        }
        if (typeof val === 'string' && val.length > MAX_STRING_LEN) {
            out[key] = val.slice(0, MAX_STRING_LEN) + '…';
        } else if (val && typeof val === 'object') {
            out[key] = sanitizeAuditDetail(val);
        } else {
            out[key] = val;
        }
    }
    return out;
}

/**
 * @param {import('express').Request} req
 */
function resolveAuditActor(req) {
    const user = req.user || {};
    const clientUserId = user.id;
    if (user.acted_by_admin_id != null) {
        return {
            user_id: clientUserId,
            actor_type: 'admin_impersonation',
            actor_user_id: user.acted_by_admin_id,
        };
    }
    if (user.delegate_hub_id != null) {
        return {
            user_id: clientUserId,
            actor_type: 'delegate_view',
            actor_user_id: user.delegate_hub_id,
        };
    }
    return {
        user_id: clientUserId,
        actor_type: 'client',
        actor_user_id: clientUserId,
    };
}

function serializeDetail(detail) {
    if (detail == null) return '';
    const sanitized = sanitizeAuditDetail(detail);
    if (typeof sanitized === 'string') return sanitized.slice(0, MAX_DETAIL_LEN);
    try {
        return JSON.stringify(sanitized).slice(0, MAX_DETAIL_LEN);
    } catch (e) {
        return String(sanitized).slice(0, MAX_DETAIL_LEN);
    }
}

/** Skip when a real admin JWT is used (admin actions use admin_audit_log). */
function shouldLogClientAudit(req) {
    const user = req.user || {};
    if (coerceIsAdmin(user.is_admin) && user.acted_by_admin_id == null) return false;
    return !!user.id;
}

/**
 * @param {import('sql.js').Database} db
 * @param {import('express').Request} req
 * @param {{ category: string, action: string, resource?: string, detail?: unknown, path?: string }} opts
 */
function logClientAudit(db, req, opts) {
    try {
        if (!shouldLogClientAudit(req)) return;
        const actor = resolveAuditActor(req);
        if (!actor.user_id) return;
        const detailStr = serializeDetail(opts.detail);
        db.run(
            `INSERT INTO client_audit_log
             (user_id, actor_type, actor_user_id, category, action, resource, detail, path)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                actor.user_id,
                actor.actor_type,
                actor.actor_user_id || null,
                String(opts.category || '').slice(0, 40),
                String(opts.action || '').slice(0, 200),
                String(opts.resource || '').slice(0, 200),
                detailStr,
                String(opts.path || '').slice(0, 500),
            ]
        );
        saveDb();
    } catch (e) {
        console.error('client_audit_log insert failed:', e);
    }
}

/**
 * @param {string} action
 */
function isBeaconActionAllowed(action) {
    const a = String(action || '');
    return BEACON_ACTION_PREFIXES.some((prefix) =>
        prefix.endsWith('_') ? a.startsWith(prefix) : a === prefix
    );
}

/**
 * @param {import('sql.js').Database} db
 * @param {import('express').Request} req
 * @param {{ category: string, action: string, resource?: string, detail?: unknown, path?: string }} body
 * @returns {{ logged: boolean, skipped?: string }}
 */
function logClientAuditBeacon(db, req, body) {
    if (!shouldLogClientAudit(req)) {
        return { logged: false, skipped: 'admin_token' };
    }
    const category = String(body.category || '').toLowerCase();
    const action = String(body.action || '');
    if (!BEACON_CATEGORIES.has(category)) {
        return { logged: false, skipped: 'invalid_category' };
    }
    if (!isBeaconActionAllowed(action)) {
        return { logged: false, skipped: 'invalid_action' };
    }
    if (category === 'view' && action.startsWith('page_')) {
        const actor = resolveAuditActor(req);
        const key = `${actor.user_id}:${action}`;
        const now = Date.now();
        const last = recentPageViews.get(key);
        if (last && now - last < PAGE_VIEW_DEBOUNCE_MS) {
            return { logged: false, skipped: 'debounced' };
        }
        recentPageViews.set(key, now);
    }
    logClientAudit(db, req, {
        category,
        action,
        resource: body.resource,
        detail: body.detail,
        path: body.path || req.headers['x-audit-path'] || '',
    });
    return { logged: true };
}

/**
 * @param {import('sql.js').Database} db
 * @param {{ user_id?: number, category?: string, action?: string, limit?: number, offset?: number, since?: string, until?: string }} [opts]
 */
function listClientAudit(db, opts = {}) {
    const limit = Math.min(200, Math.max(1, parseInt(opts.limit, 10) || 80));
    const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
    const clauses = [];
    const params = [];

    if (opts.user_id != null && !isNaN(parseInt(opts.user_id, 10))) {
        clauses.push('a.user_id = ?');
        params.push(parseInt(opts.user_id, 10));
    }
    if (opts.category) {
        clauses.push('a.category = ?');
        params.push(String(opts.category));
    }
    if (opts.action) {
        clauses.push('a.action = ?');
        params.push(String(opts.action));
    }
    if (opts.since) {
        clauses.push('a.created_at >= ?');
        params.push(String(opts.since));
    }
    if (opts.until) {
        clauses.push('a.created_at <= ?');
        params.push(String(opts.until));
    }

    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    params.push(limit, offset);

    const rows = parseResults(
        db.exec(
            `SELECT a.id, a.user_id, a.actor_type, a.actor_user_id, a.category, a.action,
                    a.resource, a.detail, a.path, a.created_at,
                    u.email AS client_email, u.full_name AS client_name,
                    au.email AS actor_email, au.full_name AS actor_name
             FROM client_audit_log a
             LEFT JOIN users u ON u.id = a.user_id
             LEFT JOIN users au ON au.id = a.actor_user_id
             ${where}
             ORDER BY a.id DESC LIMIT ? OFFSET ?`,
            params
        )
    );
    return rows;
}

module.exports = {
    sanitizeAuditDetail,
    resolveAuditActor,
    shouldLogClientAudit,
    logClientAudit,
    logClientAuditBeacon,
    listClientAudit,
    isBeaconActionAllowed,
};
