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

withEnv(
    {
        EMAIL_ENABLED: '1',
        SMTP_HOST: 'smtp.gmail.com',
        ADMIN_QUERY_NOTIFY_ENABLED: '1',
        ADMIN_QUERY_NOTIFY_EMAIL: 'ops@returnpal.co.uk',
    },
    () => {
        delete require.cache[require.resolve('../src/utils/adminQueryNotification')];
        const mod = require('../src/utils/adminQueryNotification');
        assert.strictEqual(mod.isAdminQueryNotifyEnabled(), true);
        assert.strictEqual(mod.adminNotifyEmail(), 'ops@returnpal.co.uk');
    }
);

withEnv(
    {
        EMAIL_ENABLED: '1',
        SMTP_HOST: 'smtp.gmail.com',
        ADMIN_QUERY_NOTIFY_ENABLED: undefined,
        TRANSACTIONAL_EMAIL_ENABLED: '1',
        ADMIN_QUERY_NOTIFY_EMAIL: undefined,
        ADMIN_NOTIFY_EMAIL: undefined,
    },
    () => {
        delete require.cache[require.resolve('../src/utils/adminQueryNotification')];
        const mod = require('../src/utils/adminQueryNotification');
        assert.strictEqual(mod.isAdminQueryNotifyEnabled(), true);
        assert.strictEqual(mod.adminNotifyEmail(), 'contact@returnpal.co.uk');
    }
);

console.log('admin-query-notification.test.js: ok');
