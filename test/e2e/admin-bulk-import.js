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
                    form_started_at: Date.now() - 10000,
                    accept_terms: true,
                    accept_pricing_ack: true,
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
                    form_started_at: Date.now() - 10000,
                    accept_terms: true,
                    accept_pricing_ack: true,
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

        // Multi-client bulk import (Client ID column routes rows)
        let clientId2;
        {
            const res = await fetch(`${BASE}/api/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: `e2e-client2-${ts}@returnpal.test`,
                    password,
                    full_name: 'E2E Client Two',
                    company_name: 'E2E Co',
                    form_started_at: Date.now() - 10000,
                    accept_terms: true,
                    accept_pricing_ack: true,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.status !== 201) throw new Error(`Client2 register failed: ${res.status} ${JSON.stringify(data)}`);
            clientId2 = data.user && data.user.id;
            if (!clientId2) throw new Error('No client2 id from register');
        }
        const padded1 = String(parseInt(clientId, 10) || 0).padStart(4, '0');
        const csvMulti =
            `client_id,sold_date,item_name,quantity,earnings\n` +
            `${padded1},2026-03-28,E2E-Multi-One,1,11\n` +
            `${clientId2},2026-03-28,E2E-Multi-Two,1,13\n`;
        const formMulti = new FormData();
        formMulti.append('kind', 'sold');
        formMulti.append('file', new Blob([csvMulti], { type: 'text/csv' }), 'bulk-sold-multi.csv');
        const importMultiRes = await fetch(`${BASE}/api/admin/bulk-import-multi`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${adminToken}` },
            body: formMulti,
        });
        const importMultiBody = await importMultiRes.json().catch(() => ({}));
        if (!importMultiRes.ok) {
            throw new Error(`Bulk import multi failed: ${importMultiRes.status} ${JSON.stringify(importMultiBody)}`);
        }
        if (!importMultiBody.imported || importMultiBody.imported !== 2) {
            throw new Error(`Expected imported === 2, got ${JSON.stringify(importMultiBody)}`);
        }
        for (const [uid, label] of [
            [clientId, 'E2E-Multi-One'],
            [clientId2, 'E2E-Multi-Two'],
        ]) {
            const sr = await fetch(`${BASE}/api/admin/users/${uid}/sold`, {
                headers: { Authorization: `Bearer ${adminToken}` },
            });
            const sd = await sr.json().catch(() => ({}));
            if (!sr.ok) throw new Error(`GET sold multi failed for ${uid}: ${sr.status}`);
            const list = sd.items || [];
            if (!list.some((it) => String(it.product || '').includes(label))) {
                throw new Error(`Multi import product ${label} not found for user ${uid}`);
            }
        }

        // Pending queue: unknown legacy Client ID → apply after setting legacy on a new user
        const leg = `E2EPEND${ts}`;
        const csvPend = `client_id,sold_date,item_name,quantity,earnings\n${leg},2026-04-15,E2E-Pending-Queue,3,9.99\n`;
        const fdP = new FormData();
        fdP.append('kind', 'sold');
        fdP.append('queue_unmatched', '1');
        fdP.append('file', new Blob([csvPend], { type: 'text/csv' }), 'bulk-pending.csv');
        const resP = await fetch(`${BASE}/api/admin/bulk-import-multi`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${adminToken}` },
            body: fdP,
        });
        const bodyP = await resP.json().catch(() => ({}));
        if (!resP.ok) throw new Error(`Pending bulk import failed: ${resP.status} ${JSON.stringify(bodyP)}`);
        if (!bodyP.pending_rows_saved || bodyP.pending_rows_saved < 1) {
            throw new Error(`Expected pending_rows_saved >= 1, got ${JSON.stringify(bodyP)}`);
        }
        if (bodyP.imported !== 0) throw new Error(`Expected 0 imported for unknown id, got ${JSON.stringify(bodyP)}`);

        let clientId3;
        {
            const res = await fetch(`${BASE}/api/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: `e2e-client3-${ts}@returnpal.test`,
                    password,
                    full_name: 'E2E Client Three',
                    company_name: 'E2E Co',
                    form_started_at: Date.now() - 10000,
                    accept_terms: true,
                    accept_pricing_ack: true,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.status !== 201) throw new Error(`Client3 register failed: ${res.status}`);
            clientId3 = data.user && data.user.id;
        }
        const putRes = await fetch(`${BASE}/api/admin/users/${clientId3}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ legacy_client_id: leg }),
        });
        if (!putRes.ok) {
            const err = await putRes.json().catch(() => ({}));
            throw new Error(`Set legacy failed: ${putRes.status} ${JSON.stringify(err)}`);
        }
        const applyRes = await fetch(`${BASE}/api/admin/bulk-import-pending/apply`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: clientId3, kind: 'sold', legacy_key: leg.toLowerCase() }),
        });
        const applyBody = await applyRes.json().catch(() => ({}));
        if (!applyRes.ok) throw new Error(`Apply pending failed: ${applyRes.status} ${JSON.stringify(applyBody)}`);
        if (!applyBody.imported || applyBody.imported < 1) {
            throw new Error(`Expected apply imported >= 1, got ${JSON.stringify(applyBody)}`);
        }

        const sold3 = await fetch(`${BASE}/api/admin/users/${clientId3}/sold`, {
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        const sold3Data = await sold3.json().catch(() => ({}));
        if (!sold3.ok) throw new Error(`GET sold client3 failed: ${sold3.status}`);
        const items3 = sold3Data.items || [];
        if (!items3.some((it) => String(it.product || '').includes('E2E-Pending-Queue'))) {
            throw new Error('Applied pending sold row not found');
        }

        console.log('E2E admin bulk import: OK');
        console.log('  (single-client + multi-client + pending queue + apply)');
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
