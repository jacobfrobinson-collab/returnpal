const rateLimit = require('express-rate-limit');

const registerLimiter = rateLimit({
    windowMs: parseInt(process.env.REGISTER_RATE_LIMIT_WINDOW_MS || String(60 * 60 * 1000), 10),
    max: parseInt(process.env.REGISTER_RATE_LIMIT_MAX || '5', 10),
    message: { error: 'Too many registration attempts from this connection. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.REGISTER_RATE_LIMIT_ENABLED === '0',
});

const loginLimiter = rateLimit({
    windowMs: parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || String(15 * 60 * 1000), 10),
    max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '20', 10),
    message: { error: 'Too many login attempts. Please try again in a few minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.LOGIN_RATE_LIMIT_ENABLED === '0',
});

module.exports = { registerLimiter, loginLimiter };
