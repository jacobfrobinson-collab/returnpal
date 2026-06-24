const jwt = require('jsonwebtoken');
const { getDb } = require('../database');
const {
    getUserAccountStatus,
    accountStatusBlocksAccess,
    PENDING_MESSAGE,
    REJECTED_MESSAGE,
} = require('../utils/accountApproval');
const { coerceIsAdmin } = require('../utils/coerceIsAdmin');
const {
    userNeedsTermsAcceptance,
    CURRENT_TERMS_VERSION,
    TERMS_URL,
} = require('../utils/termsOfService');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-me';

function generateToken(user, expiresIn) {
    const payload = { id: user.id, email: user.email };
    if (user.is_admin !== undefined) payload.is_admin = !!user.is_admin;
    if (user.delegate_hub_id != null) payload.delegate_hub_id = user.delegate_hub_id;
    if (user.acted_by_admin_id != null) payload.acted_by_admin_id = user.acted_by_admin_id;
    return jwt.sign(
        payload,
        JWT_SECRET,
        { expiresIn: expiresIn || process.env.JWT_EXPIRES_IN || '7d' }
    );
}

const DELEGATE_READONLY_MESSAGE =
    'Read-only access. Prep centre views cannot add, edit, or delete client data. Contact ReturnPal admin.';

async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        if (decoded.delegate_hub_id != null) {
            req.user.is_delegate_readonly = true;
            const method = req.method.toUpperCase();
            const auditBeacon =
                method === 'POST' &&
                String(req.originalUrl || '').includes('/client/audit/event');
            if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !auditBeacon) {
                return res.status(403).json({ error: DELEGATE_READONLY_MESSAGE, read_only: true });
            }
        }
        const isAdmin = coerceIsAdmin(decoded.is_admin);
        if (!isAdmin) {
            const db = await getDb();
            const status = getUserAccountStatus(db, decoded.id);
            if (status === 'pending') {
                return res.status(403).json({ error: PENDING_MESSAGE, approval_pending: true });
            }
            if (status === 'rejected') {
                return res.status(403).json({ error: REJECTED_MESSAGE, approval_rejected: true });
            }
            const pathOnly = (req.originalUrl || req.url || '').split('?')[0];
            const skipTermsCheck = pathOnly === '/api/auth/me' || pathOnly === '/api/auth/accept-terms';
            if (!skipTermsCheck) {
                const termsRes = db.exec(
                    'SELECT terms_accepted_at, terms_version FROM users WHERE id = ?',
                    [decoded.id]
                );
                let termsRow = {};
                if (termsRes.length && termsRes[0].values && termsRes[0].values.length) {
                    const cols = termsRes[0].columns;
                    const row = termsRes[0].values[0];
                    cols.forEach((col, i) => {
                        termsRow[col] = row[i];
                    });
                }
                if (userNeedsTermsAcceptance(termsRow)) {
                    return res.status(403).json({
                        error: 'You must accept the current Terms of Service to use ReturnPal.',
                        terms_acceptance_required: true,
                        terms_version: CURRENT_TERMS_VERSION,
                        terms_url: TERMS_URL,
                    });
                }
            }
        }
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

function requireAdmin(req, res, next) {
    if (!req.user || !req.user.is_admin) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

/** Sets req.user when a valid Bearer token is present; otherwise continues without auth. */
function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return next();
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
    } catch (err) {
        // Invalid token: treat as anonymous for public routes
    }
    next();
}

module.exports = { generateToken, authMiddleware, requireAdmin, optionalAuth };
