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
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
