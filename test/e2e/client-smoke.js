/**
 * Playwright E2E smoke: login via UI, exercise overview controls, load each dashboard page.
 * Run with: npm run test:e2e
 * Requires API server (default http://localhost:3000). Optionally set E2E_START_SERVER=1 to spawn it.
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const BASE = process.env.API_BASE || 'http://localhost:3000';
const ROOT = path.join(__dirname, '..', '..');

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
    throw new Error(`Server not reachable at ${BASE} (start with: npm start)`);
}

async function healthOkOnce() {
    try {
        const res = await fetch(`${BASE}/api/health`);
        return res.ok;
    } catch {
        return false;
    }
}

async function registerUser() {
    const email = `e2e-${Date.now()}@returnpal.test`;
    const password = 'e2epass123';
    const res = await fetch(`${BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email,
            password,
            full_name: 'E2E User',
            company_name: 'E2E Co'
        })
    });
    const data = await res.json().catch(() => ({}));
    if (res.status !== 201) {
        throw new Error(`Register failed (${res.status}): ${JSON.stringify(data)}`);
    }
    return { email, password };
}

async function main() {
    let serverProc = null;
    if (process.env.E2E_START_SERVER === '1') {
        const alreadyUp = await healthOkOnce();
        if (!alreadyUp) {
            serverProc = spawn(process.execPath, ['src/server.js'], {
                cwd: ROOT,
                stdio: 'ignore',
                env: { ...process.env, PORT: process.env.PORT || '3000' }
            });
        }
    }

    try {
        await waitForHealth();
        const { email, password } = await registerUser();

        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ baseURL: BASE });
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
        const page = await context.newPage();

        const pageErrors = [];
        page.on('pageerror', (err) => pageErrors.push(err.message));

        await page.goto('/login.html', { waitUntil: 'load', timeout: 30000 });
        await page.waitForSelector('#login-email', { state: 'visible' });
        await page.fill('#login-email', email);
        await page.fill('#login-password', password);
        await page.click('#login-btn');
        await page.waitForURL(/\/dashboard\/index\.html/, { timeout: 25000 });

        await page.locator('#dashboard-hello').waitFor({ state: 'visible', timeout: 20000 });

        await page.click('#dashboard-refresh');
        await page.locator('#dashboard-date-range').selectOption('7');
        await page.click('#dashboard-export-report');
        await page.click('#dashboard-copy-client-id');
        await page.click('#dashboard-notifications-btn');
        await page.click('#light-dark-mode');

        const recoveryDismiss = page.locator('#dashboard-recovery-route-alert-dismiss');
        if (await recoveryDismiss.isVisible().catch(() => false)) {
            await recoveryDismiss.click();
        }

        const dashPages = [
            'packages.html',
            'received.html',
            'sold-items.html',
            'item-pending.html',
            'activity.html',
            'inventory.html',
            'analytics.html',
            'invoices.html',
            'roi-report.html',
            'reimbursement.html',
            'referrals.html',
            'settings.html',
            'faq.html'
        ];

        for (const h of dashPages) {
            await page.goto(`/dashboard/${h}`, { waitUntil: 'load', timeout: 45000 });
            await page.locator('body').waitFor({ state: 'visible' });
            await page.locator('.wrapper').first().waitFor({ state: 'visible', timeout: 15000 });
        }

        await browser.close();

        if (pageErrors.length) {
            console.error('Page JS errors:', pageErrors);
            process.exit(1);
        }

        console.log('E2E client smoke: OK');
        console.log('  (login UI, overview buttons, all dashboard pages loaded without uncaught errors)');
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
