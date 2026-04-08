/**
 * ReturnPal API integration tests.
 * Run with: npm test
 * Ensure the server is running first: npm start (in another terminal).
 * If you added new API routes, restart the server and run tests again.
 */

const BASE = process.env.API_BASE || 'http://localhost:3000';

async function request(method, path, body = null, token = null) {
    const url = path.startsWith('http') ? path : BASE + path;
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
}

function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
}

async function runTests() {
    let token = null;
    const testEmail = 'test-' + Date.now() + '@returnpal.test';
    const testPassword = 'testpass123';

    console.log('API Base:', BASE);
    console.log('');

    // Health (no auth)
    try {
        const health = await request('GET', '/api/health');
        assert(health.status === 200, 'Health should return 200');
        assert(health.data.status === 'ok', 'Health should return status ok');
        console.log('  ✓ GET /api/health');
    } catch (e) {
        console.error('  ✗ GET /api/health:', e.message);
        console.error('    Is the server running? Start with: npm start');
        process.exit(1);
    }

    // Register
    try {
        const reg = await request('POST', '/api/auth/register', {
            email: testEmail,
            password: testPassword,
            full_name: 'Test User',
            company_name: 'Test Co'
        });
        assert(reg.status === 201, 'Register should return 201');
        assert(reg.data.token, 'Register should return token');
        assert(reg.data.user && reg.data.user.id > 0, 'Register should return numeric user.id for Client ID');
        token = reg.data.token;
        console.log('  ✓ POST /api/auth/register');
    } catch (e) {
        console.error('  ✗ POST /api/auth/register:', e.message);
        process.exit(1);
    }

    // Login
    try {
        const login = await request('POST', '/api/auth/login', { email: testEmail, password: testPassword });
        assert(login.status === 200, 'Login should return 200');
        assert(login.data.token, 'Login should return token');
        token = login.data.token;
        console.log('  ✓ POST /api/auth/login');
    } catch (e) {
        console.error('  ✗ POST /api/auth/login:', e.message);
        process.exit(1);
    }

    // Wanted marketplace (public list + create)
    try {
        const wantedList = await request('GET', '/api/wanted');
        assert(wantedList.status === 200, 'Wanted list should return 200');
        assert(Array.isArray(wantedList.data.listings), 'Wanted should return listings array');
        console.log('  ✓ GET /api/wanted');
    } catch (e) {
        console.error('  ✗ GET /api/wanted:', e.message);
    }

    try {
        const fd = new FormData();
        fd.append('title', 'Test wanted item');
        fd.append('description', 'Integration test description for wanted listing.');
        fd.append('category', 'Test');
        fd.append('budget_min', '10');
        fd.append('budget_max', '50');
        const url = BASE + '/api/wanted';
        const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
        const data = await res.json().catch(() => ({}));
        assert(res.status === 201, 'POST wanted should return 201');
        assert(data.id > 0, 'POST wanted should return id');
        console.log('  ✓ POST /api/wanted (multipart)');
    } catch (e) {
        console.error('  ✗ POST /api/wanted:', e.message);
    }

    // Dashboard stats (auth)
    try {
        const stats = await request('GET', '/api/dashboard/stats', null, token);
        assert(stats.status === 200, 'Dashboard stats should return 200');
        assert(typeof stats.data.total_packages === 'number', 'Stats should have total_packages');
        console.log('  ✓ GET /api/dashboard/stats');
    } catch (e) {
        console.error('  ✗ GET /api/dashboard/stats:', e.message);
    }

    // Dashboard summary (auth)
    try {
        const summary = await request('GET', '/api/dashboard/summary', null, token);
        assert(summary.status === 200, 'Dashboard summary should return 200');
        assert(Array.isArray(summary.data.recent_activity), 'Summary should have recent_activity');
        console.log('  ✓ GET /api/dashboard/summary');
    } catch (e) {
        console.error('  ✗ GET /api/dashboard/summary:', e.message);
    }

    // Packages list (auth)
    try {
        const packages = await request('GET', '/api/packages', null, token);
        assert(packages.status === 200, 'Packages should return 200');
        assert(Array.isArray(packages.data.packages), 'Response should have packages array');
        console.log('  ✓ GET /api/packages');
    } catch (e) {
        console.error('  ✗ GET /api/packages:', e.message);
    }

    // Create package (CRUD)
    let packageId = null;
    try {
        const create = await request('POST', '/api/packages', {
            reference: 'TEST-REF-' + Date.now(),
            notes: 'Integration test',
            products: [{ product_name: 'Test Product', quantity: 1 }]
        }, token);
        assert(create.status === 201, 'Create package should return 201');
        assert(create.data.package_id, 'Create should return package_id');
        packageId = create.data.package_id;
        console.log('  ✓ POST /api/packages');
    } catch (e) {
        console.error('  ✗ POST /api/packages:', e.message);
    }

    // Referrals (auth)
    try {
        const ref = await request('GET', '/api/referrals', null, token);
        assert(ref.status === 200, 'Referrals should return 200');
        assert(Array.isArray(ref.data.referrals), 'Referrals should have referrals array');
        assert(ref.data.referral_link, 'Referrals should have referral_link');
        console.log('  ✓ GET /api/referrals');
    } catch (e) {
        console.error('  ✗ GET /api/referrals:', e.message);
    }

    // Inventory summary (auth)
    try {
        const inv = await request('GET', '/api/inventory/summary', null, token);
        assert(inv.status === 200, 'Inventory summary should return 200');
        assert(typeof inv.data.items_received === 'number', 'Inventory should have items_received');
        console.log('  ✓ GET /api/inventory/summary');
    } catch (e) {
        console.error('  ✗ GET /api/inventory/summary:', e.message);
    }

    // Analytics (auth)
    try {
        const analytics = await request('GET', '/api/analytics', null, token);
        assert(analytics.status === 200, 'Analytics should return 200');
        assert(Array.isArray(analytics.data.recoveredOverTime), 'Analytics should have recoveredOverTime');
        console.log('  ✓ GET /api/analytics');
    } catch (e) {
        console.error('  ✗ GET /api/analytics:', e.message);
    }

    // Invoice by period (auth)
    try {
        const period = new Date().toISOString().slice(0, 7);
        const invPeriod = await request('GET', '/api/invoices/period/' + period, null, token);
        assert(invPeriod.status === 200, 'Invoice period should return 200');
        assert(Array.isArray(invPeriod.data.line_items), 'Invoice period should have line_items');
        console.log('  ✓ GET /api/invoices/period/:period');
    } catch (e) {
        console.error('  ✗ GET /api/invoices/period/:period:', e.message);
    }

    // Invoices list (dashboard Payouts page)
    try {
        const invList = await request('GET', '/api/invoices', null, token);
        assert(invList.status === 200, 'Invoices list should return 200');
        assert(Array.isArray(invList.data.invoices), 'Invoices should have invoices array');
        console.log('  ✓ GET /api/invoices');
    } catch (e) {
        console.error('  ✗ GET /api/invoices:', e.message);
    }

    // Balance (overview live balance card)
    try {
        const bal = await request('GET', '/api/balance/summary', null, token);
        assert(bal.status === 200, 'Balance summary should return 200');
        assert(bal.data.breakdown != null, 'Balance should have breakdown');
        console.log('  ✓ GET /api/balance/summary');
    } catch (e) {
        console.error('  ✗ GET /api/balance/summary:', e.message);
    }

    try {
        const led = await request('GET', '/api/balance/ledger?limit=5', null, token);
        assert(led.status === 200, 'Balance ledger should return 200');
        assert(Array.isArray(led.data.lines), 'Ledger should have lines array');
        console.log('  ✓ GET /api/balance/ledger');
    } catch (e) {
        console.error('  ✗ GET /api/balance/ledger:', e.message);
    }

    // Item query (sold/pending Query button)
    try {
        const q = await request('POST', '/api/queries', {
            context_type: 'sold',
            context_id: 1,
            context_label: 'Test product',
            message: 'Integration test query message for button flow.'
        }, token);
        assert(q.status === 201, 'Create query should return 201');
        console.log('  ✓ POST /api/queries');
    } catch (e) {
        console.error('  ✗ POST /api/queries:', e.message);
    }

    try {
        const qList = await request('GET', '/api/queries', null, token);
        assert(qList.status === 200, 'Queries list should return 200');
        assert(Array.isArray(qList.data.queries), 'Queries should have queries array');
        console.log('  ✓ GET /api/queries');
    } catch (e) {
        console.error('  ✗ GET /api/queries:', e.message);
    }

    // Sold / pending / received (tables)
    try {
        const sold = await request('GET', '/api/sold', null, token);
        assert(sold.status === 200, 'Sold should return 200');
        assert(Array.isArray(sold.data.items), 'Sold should have items');
        console.log('  ✓ GET /api/sold');
    } catch (e) {
        console.error('  ✗ GET /api/sold:', e.message);
    }

    try {
        const pend = await request('GET', '/api/pending', null, token);
        assert(pend.status === 200, 'Pending should return 200');
        assert(Array.isArray(pend.data.items), 'Pending should have items');
        console.log('  ✓ GET /api/pending');
    } catch (e) {
        console.error('  ✗ GET /api/pending:', e.message);
    }

    try {
        const rec = await request('GET', '/api/received', null, token);
        assert(rec.status === 200, 'Received should return 200');
        assert(Array.isArray(rec.data.items), 'Received should have items');
        assert(Array.isArray(rec.data.packages), 'Received should have packages');
        console.log('  ✓ GET /api/received');
    } catch (e) {
        console.error('  ✗ GET /api/received:', e.message);
    }

    // Activity feed & notifications dropdown
    try {
        const act = await request('GET', '/api/activity?limit=10', null, token);
        assert(act.status === 200, 'Activity should return 200');
        assert(Array.isArray(act.data.events), 'Activity should have events');
        console.log('  ✓ GET /api/activity');
    } catch (e) {
        console.error('  ✗ GET /api/activity:', e.message);
    }

    // Settings (settings page)
    try {
        const settings = await request('GET', '/api/settings', null, token);
        assert(settings.status === 200, 'Settings should return 200');
        console.log('  ✓ GET /api/settings');
    } catch (e) {
        console.error('  ✗ GET /api/settings:', e.message);
    }

    // ROI report
    try {
        const roi = await request('GET', '/api/reports/roi', null, token);
        assert(roi.status === 200, 'ROI report should return 200');
        console.log('  ✓ GET /api/reports/roi');
    } catch (e) {
        console.error('  ✗ GET /api/reports/roi:', e.message);
    }

    // Reimbursement claims list
    try {
        const reimb = await request('GET', '/api/reimbursement/claims', null, token);
        assert(reimb.status === 200, 'Reimbursement claims should return 200');
        assert(Array.isArray(reimb.data.claims), 'Claims should be array');
        console.log('  ✓ GET /api/reimbursement/claims');
    } catch (e) {
        console.error('  ✗ GET /api/reimbursement/claims:', e.message);
    }

    // Inventory CSV import (Inventory page button)
    try {
        const imp = await request('POST', '/api/inventory/import', {
            rows: [{ product: 'Test CSV line', quantity: '1', sku: 'SKU-TEST', reference: 'TEST-CSV-' + Date.now() }]
        }, token);
        assert(imp.status === 200, 'Inventory import should return 200');
        assert(imp.data.imported >= 1, 'Import should report imported count');
        console.log('  ✓ POST /api/inventory/import');
    } catch (e) {
        console.error('  ✗ POST /api/inventory/import:', e.message);
    }

    // Auth profile (avatar/settings)
    try {
        const me = await request('GET', '/api/auth/me', null, token);
        assert(me.status === 200, 'Auth me should return 200');
        assert(me.data.user && me.data.user.email, 'Me should have user.email');
        console.log('  ✓ GET /api/auth/me');
    } catch (e) {
        console.error('  ✗ GET /api/auth/me:', e.message);
    }

    // Delete package (CRUD cleanup)
    if (packageId) {
        try {
            const del = await request('DELETE', '/api/packages/' + packageId, null, token);
            assert(del.status === 200, 'Delete package should return 200');
            console.log('  ✓ DELETE /api/packages/:id');
        } catch (e) {
            console.error('  ✗ DELETE /api/packages/:id:', e.message);
        }
    }

    // Contact form (landing / marketing — no auth)
    try {
        const contact = await request('POST', '/api/contact', {
            name: 'Test',
            email: 'test-contact@returnpal.test',
            subject: 'Smoke test',
            message: 'Integration test message body for contact endpoint.'
        });
        assert(contact.status === 201, 'Contact should return 201');
        console.log('  ✓ POST /api/contact');
    } catch (e) {
        console.error('  ✗ POST /api/contact:', e.message);
    }

    // Unauthorized access
    try {
        const noAuth = await request('GET', '/api/packages');
        assert(noAuth.status === 401, 'Packages without token should return 401');
        console.log('  ✓ Auth required (401 without token)');
    } catch (e) {
        console.error('  ✗ Auth required:', e.message);
    }

    console.log('');
    console.log('Integration tests completed.');
    console.log('Note: Dashboard buttons that only open mailto, navigate, or print were not clicked in this run.');
    console.log('Run the app with: npm start  then open /dashboard/ for manual smoke testing if needed.');
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
