const rateLimit = require('express-rate-limit');
const ipKeyGenerator = rateLimit.ipKeyGenerator;

function enabled() {
    return process.env.ADMIN_RATE_LIMIT_ENABLED !== '0';
}

/** Stricter cap for large spreadsheet uploads */
const bulkImportLimiter = rateLimit({
    windowMs: parseInt(process.env.ADMIN_BULK_WINDOW_MS || String(15 * 60 * 1000), 10),
    max: parseInt(process.env.ADMIN_BULK_MAX || '40', 10),
    message: { error: 'Too many bulk imports. Try again in a few minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) =>
        req.user && req.user.id ? `admin-bulk:${req.user.id}` : ipKeyGenerator(req.ip || 'unknown'),
});

/** General admin POST/PUT/PATCH/DELETE (excluding bulk-import, which uses bulkImportLimiter) */
const adminMutationLimiter = rateLimit({
    windowMs: parseInt(process.env.ADMIN_MUTATION_WINDOW_MS || String(60 * 1000), 10),
    max: parseInt(process.env.ADMIN_MUTATION_MAX || '120', 10),
    message: { error: 'Too many admin actions. Try again shortly.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) =>
        req.user && req.user.id ? `admin:${req.user.id}` : ipKeyGenerator(req.ip || 'unknown'),
});

/**
 * Apply after auth + requireAdmin. Limits mutating methods only.
 */
function adminRateLimitMiddleware(req, res, next) {
    if (!enabled()) return next();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const p = req.path || '';
    if (req.method === 'POST' && p.includes('bulk-import')) {
        return bulkImportLimiter(req, res, next);
    }
    return adminMutationLimiter(req, res, next);
}

module.exports = { adminRateLimitMiddleware, bulkImportLimiter, adminMutationLimiter };
