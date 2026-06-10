'use strict';

const assert = require('assert');
const initSqlJs = require('sql.js');
const {
    sanitizeAuditDetail,
    resolveAuditActor,
    logClientAudit,
    listClientAudit,
    logClientAuditBeacon,
} = require('../src/utils/clientAudit');

async function createDb() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT,
        full_name TEXT
    )`);
    db.run(`INSERT INTO users (id, email, full_name) VALUES (1, 'client@test', 'Test Client')`);
    db.run(`INSERT INTO users (id, email, full_name) VALUES (2, 'admin@test', 'Admin User')`);
    db.run(`INSERT INTO users (id, email, full_name) VALUES (3, 'hub@test', 'Hub User')`);
    db.run(`
        CREATE TABLE client_audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            actor_type TEXT NOT NULL DEFAULT 'client',
            actor_user_id INTEGER,
            category TEXT NOT NULL,
            action TEXT NOT NULL,
            resource TEXT DEFAULT '',
            detail TEXT DEFAULT '',
            path TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);
    return db;
}

function mockReq(user) {
    return { user, headers: {} };
}

(async () => {
    const sanitized = sanitizeAuditDetail({
        product: 'Widget',
        password: 'secret123',
        discord_webhook: 'https://discord.com/api/webhooks/x',
        nested: { bank_account: '12345', qty: 2 },
    });
    assert.strictEqual(sanitized.product, 'Widget');
    assert.strictEqual(sanitized.password, '[redacted]');
    assert.strictEqual(sanitized.discord_webhook, '[redacted]');
    assert.strictEqual(sanitized.nested.bank_account, '[redacted]');
    assert.strictEqual(sanitized.nested.qty, 2);

    const clientActor = resolveAuditActor(mockReq({ id: 1, email: 'client@test' }));
    assert.strictEqual(clientActor.actor_type, 'client');
    assert.strictEqual(clientActor.user_id, 1);
    assert.strictEqual(clientActor.actor_user_id, 1);

    const impActor = resolveAuditActor(
        mockReq({ id: 1, email: 'client@test', acted_by_admin_id: 2 })
    );
    assert.strictEqual(impActor.actor_type, 'admin_impersonation');
    assert.strictEqual(impActor.actor_user_id, 2);

    const delActor = resolveAuditActor(
        mockReq({ id: 1, email: 'client@test', delegate_hub_id: 3 })
    );
    assert.strictEqual(delActor.actor_type, 'delegate_view');
    assert.strictEqual(delActor.actor_user_id, 3);

    const db = await createDb();
    const saveDb = require('../src/database').saveDb;
    const origSave = saveDb;
    require('../src/database').saveDb = () => {};

    try {
        logClientAudit(db, mockReq({ id: 1, email: 'client@test' }), {
            category: 'create',
            action: 'package_create',
            resource: 'RP-1',
            detail: { reference: 'RP-1' },
        });
        logClientAudit(db, mockReq({ id: 1, email: 'client@test' }), {
            category: 'view',
            action: 'page_received',
            path: '/dashboard/received.html',
        });

        const all = listClientAudit(db, { user_id: 1 });
        assert.ok(all.length >= 2, 'expected at least 2 audit rows');

        const creates = listClientAudit(db, { user_id: 1, category: 'create' });
        assert.strictEqual(creates.length, 1);
        assert.strictEqual(creates[0].action, 'package_create');
        assert.strictEqual(creates[0].client_email, 'client@test');

        logClientAudit(db, mockReq({ id: 1, email: 'client@test', acted_by_admin_id: 2 }), {
            category: 'view',
            action: 'page_settings',
        });
        const clientsOnly = listClientAudit(db, { user_id: 1, clients_only: true });
        const allForUser = listClientAudit(db, { user_id: 1, clients_only: false });
        assert.ok(clientsOnly.every((r) => r.actor_type === 'client'), 'clients_only excludes impersonation');
        assert.ok(allForUser.some((r) => r.actor_type === 'admin_impersonation'), 'include_admin shows impersonation');

        const beacon = logClientAuditBeacon(db, mockReq({ id: 1 }), {
            category: 'view',
            action: 'page_sold_items',
            path: '/dashboard/sold-items.html',
        });
        assert.strictEqual(beacon.logged, true);

        const debounced = logClientAuditBeacon(db, mockReq({ id: 1 }), {
            category: 'view',
            action: 'page_sold_items',
        });
        assert.strictEqual(debounced.logged, false);
        assert.strictEqual(debounced.skipped, 'debounced');

        const rejected = logClientAuditBeacon(db, mockReq({ id: 1 }), {
            category: 'update',
            action: 'package_create',
        });
        assert.strictEqual(rejected.logged, false);
    } finally {
        require('../src/database').saveDb = origSave;
    }

    console.log('client-audit.test.js: ok');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
