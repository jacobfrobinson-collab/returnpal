/**
 * E2E: register client + admin, promote admin via set-admin.js, bulk-import CSV for sold items, verify via admin API.
 * Run: npm run test:e2e:admin
 * Requires API at API_BASE (default http://localhost:3000). Optional E2E_START_SERVER=1.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');

/** Prefer 127.0.0.1 on Windows so fetch does not prefer IPv6 ::1 when the server is IPv4-only. */
const BASE = process.env.API_BASE || 'http://127.0.0.1:3000';
const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'bulk-sold.csv');

async function waitForHealth(timeoutMs = 45000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`${BASE}/api/health`);
            if (res.ok) return;
        } catch {
            /* retry */
        }
        await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`Server not reachable at ${BASE}`);
}

async function healthOkOnce() {
    try {
        const res = await fetch(`${BASE}/api/health`);
        return res.ok;
    } catch {
        return false;
    }
}

async function main() {
    let serverProc = null;
    if (process.env.E2E_START_SERVER === '1') {
        const alreadyUp = await healthOkOnce();
        if (!alreadyUp) {
            serverProc = spawn(process.execPath, ['src/server.js'], {
                cwd: ROOT,
                stdio: 'ignore',
                env: { ...process.env, PORT: process.env.PORT || '3000' },
            });
        }
    }

    try {
        await waitForHealth();

        const ts = Date.now();
        const clientEmail = `e2e-client-${ts}@returnpal.test`;
        const adminEmail = `e2e-admin-${ts}@returnpal.test`;
        const password = 'e2eBulkImport1!';

        let clientId;
        {
            const res = await fetch(`${BASE}/api/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: clientEmail,
                    password,
                    full_name: 'E2E Client',
                    company_name: 'E2E Co',
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.status !== 201) throw new Error(`Client register failed: ${res.status} ${JSON.stringify(data)}`);
            clientId = data.user && data.user.id;
            if (!clientId) throw new Error('No client id from register');
        }

        {
            const res = await fetch(`${BASE}/api/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: adminEmail,
                    password,
                    full_name: 'E2E Admin',
                    company_name: 'E2E Co',
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.status !== 201) throw new Error(`Admin register failed: ${res.status} ${JSON.stringify(data)}`);
        }

        try {
            execFileSync(process.execPath, [path.join(ROOT, 'set-admin.js'), adminEmail], {
                cwd: ROOT,
                stdio: 'inherit',
                env: { ...process.env },
            });
        } catch (e) {
            throw new Error(
                `set-admin failed (${e.message}). Run from repo root with DB_PATH pointing at the same DB as the server.`
            );
        }

        const loginRes = await fetch(`${BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: adminEmail, password }),
        });
        const loginData = await loginRes.json().catch(() => ({}));
        if (!loginRes.ok || !loginData.token) {
            throw new Error(`Admin login failed: ${loginRes.status} ${JSON.stringify(loginData)}`);
        }
        const adminToken = loginData.token;

        const buf = fs.readFileSync(FIXTURE);
        const form = new FormData();
        form.append('kind', 'sold');
        form.append('file', new Blob([buf], { type: 'text/csv' }), 'bulk-sold.csv');
        const importRes = await fetch(`${BASE}/api/admin/users/${clientId}/bulk-import`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${adminToken}` },
            body: form,
        });
        const importBody = await importRes.json().catch(() => ({}));
        if (!importRes.ok) {
            throw new Error(`Bulk import failed: ${importRes.status} ${JSON.stringify(importBody)}`);
        }
        if (!importBody.imported || importBody.imported < 1) {
            throw new Error(`Expected imported >= 1, got ${JSON.stringify(importBody)}`);
        }

        const soldRes = await fetch(`${BASE}/api/admin/users/${clientId}/sold`, {
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        const soldData = await soldRes.json().catch(() => ({}));
        if (!soldRes.ok) throw new Error(`GET sold failed: ${soldRes.status}`);
        const items = soldData.items || [];
        const found = items.some((it) => String(it.product || '').includes('E2E-Bulk-Widget'));
        if (!found) {
            throw new Error('Imported sold row not found in /api/admin/users/:id/sold');
        }

        console.log('E2E admin bulk import: OK');
        console.log('  (register client + admin, set-admin, POST bulk-import sold CSV, verify sold list)');
    } finally {
        if (serverProc && !serverProc.killed) {
            try {
                serverProc.kill('SIGTERM');
            } catch {
                /* ignore */
            }
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
