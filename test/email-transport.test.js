/**
 * Email transport env checks (no live SMTP).
 */
const assert = require('assert');

function withEnv(patch, fn) {
    const prev = {};
    for (const k of Object.keys(patch)) {
        prev[k] = process.env[k];
        if (patch[k] === undefined) delete process.env[k];
        else process.env[k] = patch[k];
    }
    try {
        fn();
    } finally {
        for (const k of Object.keys(patch)) {
            if (prev[k] === undefined) delete process.env[k];
            else process.env[k] = prev[k];
        }
    }
}

function reloadTransport() {
    delete require.cache[require.resolve('../src/utils/emailTransport')];
    return require('../src/utils/emailTransport');
}

withEnv(
    { EMAIL_ENABLED: '0', SMTP_HOST: 'smtp.example.com' },
    () => {
        const t = reloadTransport();
        assert.strictEqual(t.isEmailConfigured(), false);
    }
);

withEnv(
    { EMAIL_ENABLED: '1', SMTP_HOST: '' },
    () => {
        const t = reloadTransport();
        assert.strictEqual(t.isEmailConfigured(), false);
    }
);

withEnv(
    { EMAIL_ENABLED: '1', SMTP_HOST: 'smtp.example.com', TRANSACTIONAL_EMAIL_ENABLED: '1' },
    () => {
        const t = reloadTransport();
        assert.strictEqual(t.isEmailConfigured(), true);
        assert.strictEqual(t.isTransactionalEmailEnabled(), true);
        assert.strictEqual(t.isWeeklyDigestEnabled(), false);
    }
);

withEnv(
    {
        EMAIL_ENABLED: '1',
        SMTP_HOST: 'smtp.example.com',
        WEEKLY_DIGEST_EMAIL_ENABLED: '1',
        PUBLIC_APP_URL: 'https://example.com/',
    },
    () => {
        const t = reloadTransport();
        assert.strictEqual(t.isWeeklyDigestEnabled(), true);
        assert.strictEqual(t.publicAppUrl(), 'https://example.com');
    }
);

console.log('email-transport.test.js: ok');
