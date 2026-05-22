const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-me';

function generateToken(user, expiresIn) {
    const payload = { id: user.id, email: user.email };
    if (user.is_admin !== undefined) payload.is_admin = !!user.is_admin;
    if (user.delegate_hub_id != null) payload.delegate_hub_id = user.delegate_hub_id;
    return jwt.sign(
        payload,
        JWT_SECRET,
        { expiresIn: expiresIn || process.env.JWT_EXPIRES_IN || '7d' }
    );
}

const DELEGATE_READONLY_MESSAGE =
    'Read-only access. Prep centre views cannot add, edit, or delete client data. Contact ReturnPal admin.';

function authMiddleware(req, res, next) {
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
            if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
                return res.status(403).json({ error: DELEGATE_READONLY_MESSAGE, read_only: true });
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
