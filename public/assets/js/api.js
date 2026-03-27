/**
 * ReturnPal API Client
 * Include this script on every page that needs API access.
 * Usage: <script src="/assets/js/api.js"></script>  (landing/login pages)
 *        <script src="../assets/js/api.js"></script> (if needed from subfolders)
 *   OR   referenced via absolute path from dashboard pages
 */

const API = {
    baseUrl: '/api',

    // ─── Token Management ────────────────────────────────────
    getSessionToken() {
        // Session auth is only valid during explicit impersonation mode.
        if (sessionStorage.getItem('returnpal_impersonating') !== '1') return null;
        return sessionStorage.getItem('returnpal_session_token');
    },
    getToken() {
        return this.getSessionToken() || localStorage.getItem('returnpal_token');
    },
    setToken(token) {
        localStorage.setItem('returnpal_token', token);
    },
    setSessionToken(token) {
        sessionStorage.setItem('returnpal_session_token', token);
    },
    clearSessionAuth() {
        sessionStorage.removeItem('returnpal_session_token');
        sessionStorage.removeItem('returnpal_session_user');
    },
    clearToken() {
        this.clearSessionAuth();
        localStorage.removeItem('returnpal_token');
        localStorage.removeItem('returnpal_user');
    },
    getSessionUser() {
        if (sessionStorage.getItem('returnpal_impersonating') !== '1') return null;
        try {
            return JSON.parse(sessionStorage.getItem('returnpal_session_user'));
        } catch { return null; }
    },
    getUser() {
        const sessionUser = this.getSessionUser();
        if (sessionUser) return sessionUser;
        try { return JSON.parse(localStorage.getItem('returnpal_user')); } catch { return null; }
    },
    /** Ensure numeric `id` is stored so Client ID / JWT stay in sync after register/login. */
    _normalizeUserForStorage(user) {
        if (!user || typeof user !== 'object') return user;
        const u = { ...user };
        if (u.id != null && u.id !== '') {
            const n = parseInt(u.id, 10);
            if (Number.isFinite(n) && n > 0) u.id = n;
        }
        return u;
    },
    setUser(user) {
        localStorage.setItem('returnpal_user', JSON.stringify(this._normalizeUserForStorage(user)));
    },
    setSessionUser(user) {
        sessionStorage.setItem('returnpal_session_user', JSON.stringify(this._normalizeUserForStorage(user)));
    },
    isLoggedIn() {
        return !!this.getToken();
    },

    /**
     * Same cleanup + redirect as a normal 401 from request() — use when using skipAuthRedirect
     * so the user is not left with a stale token (login.html would send them back to dashboard).
     */
    navigateAwayOnUnauthorized() {
        const hadSessionToken = !!this.getSessionToken();
        if (hadSessionToken) {
            this.clearSessionAuth();
            sessionStorage.removeItem('returnpal_impersonating');
            if (localStorage.getItem('returnpal_token') && this.isCurrentUserAdmin()) {
                window.location.href = '/admin/index.html';
                return;
            }
        } else {
            this.clearToken();
        }
        window.location.href = '/login.html';
    },

    /** Decode JWT payload (no verify — for UI routing only). */
    _decodeJwtPayload(token) {
        try {
            const parts = (token || '').split('.');
            if (parts.length < 2) return null;
            const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
            return JSON.parse(atob(padded));
        } catch {
            return null;
        }
    },

    /** True if stored user or JWT indicates admin (cached user can omit is_admin). */
    isCurrentUserAdmin() {
        const u = this.getUser();
        if (u && u.is_admin) return true;
        const p = this._decodeJwtPayload(this.getToken());
        return !!(p && p.is_admin);
    },

    // ─── Core Request Method ─────────────────────────────────
    async request(endpoint, options = {}) {
        const url = this.baseUrl + endpoint;
        const { skipAuthRedirect, ...fetchOptions } = options;
        const config = {
            headers: { 'Content-Type': 'application/json' },
            ...fetchOptions,
        };

        const token = this.getToken();
        if (token) {
            config.headers['Authorization'] = 'Bearer ' + token;
        }

        if (config.body && typeof config.body === 'object' && !(config.body instanceof FormData)) {
            config.body = JSON.stringify(config.body);
        }

        // For FormData (file uploads), remove Content-Type so browser sets it
        if (config.body instanceof FormData) {
            delete config.headers['Content-Type'];
        }

        try {
            const response = await fetch(url, config);

            if (response.status === 401) {
                // Let callers handle auth (e.g. reimbursement page must not redirect before Dashboard.init runs).
                if (skipAuthRedirect) {
                    throw { status: 401, error: 'Unauthorized' };
                }
                this.navigateAwayOnUnauthorized();
                return null;
            }

            const data = await response.json();

            if (!response.ok) {
                throw { status: response.status, ...data };
            }

            return data;
        } catch (err) {
            if (err.status) throw err;
            console.error('API request failed:', err);
            throw { error: 'Network error. Please try again.' };
        }
    },

    // ─── Auth ────────────────────────────────────────────────
    async login(email, password) {
        const data = await this.request('/auth/login', {
            method: 'POST',
            body: { email, password }
        });
        if (data && data.token) {
            this.setToken(data.token);
            this.setUser(data.user);
        }
        return data;
    },

    async register(email, password, full_name, company_name, referral_code) {
        const body = { email, password, full_name, company_name };
        if (referral_code != null && String(referral_code).trim() !== '') {
            body.referral_code = String(referral_code).trim();
        }
        const data = await this.request('/auth/register', {
            method: 'POST',
            body
        });
        if (data && data.token) {
            this.setToken(data.token);
            this.setUser(data.user);
        }
        return data;
    },

    async getProfile(options) {
        return this.request('/auth/me', options || {});
    },

    async updateProfile(profile) {
        return this.request('/auth/profile', { method: 'PUT', body: profile });
    },

    async uploadAvatar(file) {
        if (!file || !(file instanceof Blob)) {
            throw Object.assign(new Error('Choose an image file'), { status: 400 });
        }
        const fd = new FormData();
        fd.append('photo', file);
        const token = this.getToken();
        const res = await fetch(this.baseUrl + '/auth/avatar', {
            method: 'POST',
            headers: token ? { Authorization: 'Bearer ' + token } : {},
            body: fd
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw Object.assign(new Error(data.error || 'Upload failed'), { status: res.status, error: data.error });
        }
        const u = this.getUser();
        if (u) this.setUser({ ...u, avatar_url: data.avatar_url });
        return data;
    },

    async deleteAvatar() {
        const data = await this.request('/auth/avatar', { method: 'DELETE' });
        const u = this.getUser();
        if (u) this.setUser({ ...u, avatar_url: data.avatar_url != null ? data.avatar_url : '' });
        return data;
    },

    async changePassword(current_password, new_password) {
        return this.request('/auth/password', {
            method: 'PUT',
            body: { current_password, new_password }
        });
    },

    logout() {
        this.clearToken();
        window.location.href = '/login.html';
    },

    // ─── Packages ────────────────────────────────────────────
    async getPackages() {
        if (window.RETURNPAL_CONFIG && window.RETURNPAL_CONFIG.useMock) return this._getPackagesMock();
        try {
            return await this.request('/packages');
        } catch (err) {
            if (err.status === 404 || err.status === 501) return this._getPackagesMock();
            throw err;
        }
    },
    _getPackagesMock() {
        const now = new Date();
        const date = (d) => { const x = new Date(now); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10); };
        const products = [
            { name: 'Wireless Earbuds Pro', qty: 2, condition: 'Return' },
            { name: 'USB-C Hub 7-in-1', qty: 1, condition: 'New' },
            { name: 'Phone Stand Desk Mount', qty: 3, condition: 'Used' },
            { name: 'Screen Protector Pack', qty: 1, condition: 'Return Review' },
            { name: 'Tablet Case Folio', qty: 1, condition: 'New' }
        ];
        const refs = ['TRACK-RP001', 'TRACK-RP002', 'TRACK-RP003', 'TRACK-RP004', 'TRACK-RP005'];
        const statuses = ['In Transit', 'Delivered', 'In Transit', 'Delivered', 'Delivered'];
        return {
            packages: refs.map((ref, i) => ({
                id: 'pkg-' + (i + 1),
                reference: ref,
                products: [{ product_name: products[i].name, quantity: products[i].qty, condition: products[i].condition }],
                total_qty: products[i].qty,
                status: statuses[i],
                date_added: date(2 + i),
                notes: i === 0 ? 'Priority delivery' : ''
            }))
        };
    },
    async getPackage(id) {
        if (window.RETURNPAL_CONFIG && window.RETURNPAL_CONFIG.useMock) return this._getPackageMock(id);
        try {
            return await this.request('/packages/' + id);
        } catch (err) {
            if (err.status === 404 || err.status === 501) return this._getPackageMock(id);
            throw err;
        }
    },
    _getPackageMock(id) {
        const list = this._getPackagesMock().packages;
        const pkg = list.find(p => p.id === id) || list[0];
        return { package: pkg };
    },
    async getPackageDetail(id) {
        if (window.RETURNPAL_CONFIG && window.RETURNPAL_CONFIG.useMock) return this._getPackageDetailMock(id);
        try {
            const data = await this.request('/packages/' + id);
            const pkg = data.package;
            if (!pkg) return this._getPackageDetailMock(id);
            const items = (pkg.products || []).map((prod, i) => ({
                id: prod.id || (pkg.id + '-prod-' + (i + 1)),
                title: prod.product_name || prod.name,
                reference: (pkg.reference || '') + '-' + (i + 1),
                status: pkg.status || 'Processing'
            }));
            return {
                reference: pkg.reference,
                shipping_status: pkg.status,
                status: pkg.status,
                received_date: pkg.date_added || null,
                carrier: 'Royal Mail',
                items,
                timeline: []
            };
        } catch (err) {
            if (err.status === 404 || err.status === 501) return this._getPackageDetailMock(id);
            throw err;
        }
    },
    _getPackageDetailMock(id) {
        const { package: pkg } = this._getPackageMock(id);
        const items = (pkg.products || []).map((prod, i) => ({
            id: 'item-' + (pkg.id || id).replace('pkg-', '') + '-' + (i + 1),
            title: prod.product_name || prod.name,
            reference: pkg.reference + '-' + (i + 1),
            status: ['Initial Inspection', 'Processing', 'Ready for Sale'][i % 3]
        }));
        const now = new Date();
        const daysAgo = (d) => { const x = new Date(now); x.setDate(x.getDate() - d); return x.toISOString(); };
        const timeline = [
            { timestamp: daysAgo(4), message: 'Package created and shipped.' },
            { timestamp: daysAgo(2), message: 'In transit.' },
            { timestamp: daysAgo(0), message: pkg.status === 'Delivered' ? 'Delivered and received.' : 'Expected delivery soon.' }
        ];
        return {
            reference: pkg.reference,
            shipping_status: pkg.status,
            status: pkg.status,
            received_date: pkg.status === 'Delivered' ? (pkg.date_added || null) : null,
            carrier: 'Royal Mail',
            items,
            timeline
        };
    },
    async createPackage(data) {
        return this.request('/packages', { method: 'POST', body: data });
    },
    async updatePackage(id, data) {
        return this.request('/packages/' + id, { method: 'PUT', body: data });
    },
    async deletePackage(id) {
        return this.request('/packages/' + id, { method: 'DELETE' });
    },

    /** Get single item by id (tries received then pending). For item-detail page. */
    async getItem(id) {
        if (!id) throw { error: 'Item id is required' };
        if (window.RETURNPAL_CONFIG && window.RETURNPAL_CONFIG.useMock) return this._getItemMock(id);
        try {
            let data = await this.request('/received/' + id);
            if (data && data.item) return this._normalizeReceivedItem(data.item);
        } catch (e) {
            if (e.status !== 404) throw e;
        }
        try {
            const data = await this.request('/pending/' + id);
            if (data && data.item) return this._normalizePendingItem(data.item);
        } catch (e) {
            if (e.status === 404) throw { error: 'Item not found' };
            throw e;
        }
        throw { error: 'Item not found' };
    },
    _normalizeReceivedItem(item) {
        return {
            title: item.items_description || item.reference,
            reference: item.reference,
            sku: item.reference,
            status: item.status || 'Processing',
            condition_notes: item.notes || '-',
            resale_price: 0,
            estimated_payout: 0,
            timeline: [{ timestamp: item.date_received, message: 'Received' }]
        };
    },
    _normalizePendingItem(item) {
        return {
            title: item.product || item.reference,
            reference: item.reference,
            sku: item.reference,
            status: item.current_stage || 'Processing',
            condition_notes: item.notes || '-',
            resale_price: 0,
            estimated_payout: 0,
            timeline: [{ timestamp: item.received_date, message: 'Added to pending' }]
        };
    },
    _getItemMock(id) {
        return {
            title: 'Sample Item',
            reference: 'ITEM-' + id,
            sku: 'SKU-' + id,
            status: 'Processing',
            condition_notes: '-',
            resale_price: 0,
            estimated_payout: 0,
            timeline: []
        };
    },

    // ─── Received ────────────────────────────────────────────
    async getReceived() {
        if (window.RETURNPAL_CONFIG && window.RETURNPAL_CONFIG.useMock) return this._getReceivedMock();
        try {
            return await this.request('/received');
        } catch (err) {
            if (err.status === 404 || err.status === 501) return this._getReceivedMock();
            throw err;
        }
    },
    _getReceivedMock() {
        const now = new Date();
        const date = (d) => { const x = new Date(now); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10); };
        const items = [
            { ref: 'TRACK-RP001', desc: 'Wireless Earbuds Pro x2', qty: 2, status: 'Processing' },
            { ref: 'TRACK-RP001', desc: 'USB adapter x1', qty: 1, status: 'Processed' },
            { ref: 'TRACK-RP002', desc: 'USB-C Hub 7-in-1 x1', qty: 1, status: 'Quality Check' },
            { ref: 'TRACK-RP003', desc: 'Phone Stand Desk Mount x3', qty: 3, status: 'Processing' },
            { ref: 'TRACK-RP004', desc: 'Screen Protector Pack x1', qty: 1, status: 'Processed' },
            { ref: 'TRACK-RP005', desc: 'Tablet Case Folio x1', qty: 1, status: 'Quality Check' }
        ];
        const flatItems = items.map((it, i) => ({
            id: i + 1,
            reference: it.ref,
            items_description: it.desc,
            quantity: it.qty,
            status: it.status,
            date_received: date(1 + i),
            notes: '',
            photos: i < 2 ? ['https://via.placeholder.com/120x90?text=Condition+1', 'https://via.placeholder.com/120x90?text=Condition+2'] : []
        }));
        const byRef = new Map();
        flatItems.forEach((row) => {
            const k = row.reference || '';
            if (!byRef.has(k)) byRef.set(k, []);
            byRef.get(k).push(row);
        });
        const packages = [];
        byRef.forEach((rows, ref) => {
            const totalUnits = rows.reduce((a, r) => a + (Number(r.quantity) || 0), 0) || 1;
            const processedUnits = rows.filter((r) => r.status === 'Processed').reduce((a, r) => a + (Number(r.quantity) || 0), 0);
            const rejectedUnits = rows.filter((r) => r.status === 'Rejected').reduce((a, r) => a + (Number(r.quantity) || 0), 0);
            const pendingUnits = Math.max(0, totalUnits - processedUnits - rejectedUnits);
            const maxDate = rows.reduce((m, r) => {
                const t = new Date(r.date_received || 0).getTime();
                return t > m ? t : m;
            }, 0);
            packages.push({
                reference: ref,
                package_id: null,
                delivery_status: 'Delivered',
                date_received: maxDate ? new Date(maxDate).toISOString().slice(0, 10) : rows[0].date_received,
                total_units: totalUnits,
                processed_units: processedUnits,
                pending_units: pendingUnits,
                rejected_units: rejectedUnits,
                notes: '',
                items: rows.map((r) => ({
                    id: r.id,
                    items_description: r.items_description,
                    quantity: r.quantity,
                    status: r.status,
                    sku: '',
                    notes: r.notes || '',
                    date_received: r.date_received
                }))
            });
        });
        packages.sort((a, b) => new Date(b.date_received || 0) - new Date(a.date_received || 0));
        return {
            items: flatItems,
            packages,
            total: packages.length,
            items_total: flatItems.length
        };
    },

    // ─── Sold Items ──────────────────────────────────────────
    async getSold() {
        if (window.RETURNPAL_CONFIG && window.RETURNPAL_CONFIG.useMock) return this._getSoldMock();
        try {
            return await this.request('/sold');
        } catch (err) {
            if (err.status === 404 || err.status === 501) return this._getSoldMock();
            throw err;
        }
    },
    _getSoldMock() {
        const now = new Date();
        const items = [
            { product: 'Wireless Earbuds Pro', qty: 1, unit_price: 34.99, profit: 29.74, margin: 85, recovery_route: 'Resale', recovery_status: 'Sold' },
            { product: 'USB-C Hub 7-in-1', qty: 1, unit_price: 28.50, profit: 24.23, margin: 85, recovery_route: 'Resale', recovery_status: 'Sold' },
            { product: 'Phone Stand Desk Mount', qty: 2, unit_price: 18.99, profit: 32.28, margin: 85, recovery_route: 'Reimbursement', recovery_status: 'Reimbursed' },
            { product: 'Screen Protector Pack', qty: 1, unit_price: 12.00, profit: 10.20, margin: 85, recovery_route: 'Resale', recovery_status: 'Sold' },
            { product: 'Tablet Case Folio', qty: 1, unit_price: 22.45, profit: 19.08, margin: 85, recovery_route: 'Resale', recovery_status: 'Sold' },
            { product: 'Damaged cable (no claim)', qty: 1, unit_price: 0, profit: 0, margin: 0, total_revenue: 0, recovery_route: 'Not recoverable', recovery_status: 'No recovery', damage_note: 'Damaged – no claim possible' },
            { product: 'Used charger – unsellable', qty: 1, unit_price: 0, profit: 0, margin: 0, total_revenue: 0, recovery_route: 'Not recoverable', recovery_status: 'No recovery', damage_note: 'Condition below resale threshold' }
        ];
        let totalEarnings = 0, totalQty = 0;
        const today = now.toISOString().slice(0, 10);
        const ym = now.toISOString().slice(0, 7);
        const out = items.map((it, i) => {
            const total_revenue = it.unit_price * it.qty;
            totalEarnings += it.profit * it.qty;
            totalQty += it.qty;
            return {
                id: i + 1,
                reference: 'TRACK-RP' + String(i + 1).padStart(3, '0'),
                product: it.product,
                quantity: it.qty,
                unit_price: it.unit_price,
                total_revenue,
                profit: it.profit * it.qty,
                margin: it.margin,
                sold_date: today,
                status: it.recovery_route === 'Not recoverable' ? 'No recovery' : 'Sold',
                recovery_route: it.recovery_route || 'Resale',
                recovery_status: it.recovery_status || 'Sold',
                damage_note: it.damage_note || null
            };
        });
        let best = null;
        out.forEach((row) => {
            if (Number(row.total_revenue) <= 0) return;
            const route = String(row.recovery_route || 'Resale');
            if (/reimbursement/i.test(route) || /not recoverable/i.test(route)) return;
            if (!best || Number(row.total_revenue) > Number(best.total_revenue)) best = row;
        });
        const itemsOut = out.map((row) => ({
            ...row,
            is_monthly_free_processing: !!(best && best.id === row.id),
            monthly_free_processing_month: best && best.id === row.id ? ym : null
        }));
        const gross = best ? Number(best.total_revenue) : 0;
        const fee = Math.round(gross * 0.15 * 100) / 100;
        return {
            total: itemsOut.length,
            stats: {
                total_earnings: totalEarnings,
                items_sold: totalQty,
                avg_earnings: totalQty ? totalEarnings / totalQty : 0,
                avg_margin: 85
            },
            items: itemsOut,
            monthly_free_processing: {
                fee_percent: 0.15,
                revenue_interpreted_as_net: false,
                months: best ? [{
                    year_month: ym,
                    sold_item_id: best.id,
                    reference: best.reference,
                    product: best.product,
                    sold_date: best.sold_date,
                    gross_sale: gross,
                    fee_normally_charged: fee,
                    note: 'Highest-value eligible sale this calendar month — processing fee waived; you keep 100% of this sale.'
                }] : []
            }
        };
    },

    // ─── Pending Items ───────────────────────────────────────
    async getPending() {
        if (window.RETURNPAL_CONFIG && window.RETURNPAL_CONFIG.useMock) return this._getPendingMock();
        try {
            return await this.request('/pending');
        } catch (err) {
            if (err.status === 404 || err.status === 501) return this._getPendingMock();
            throw err;
        }
    },
    _getPendingMock() {
        const now = new Date();
        const date = (d) => { const x = new Date(now); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10); };
        const items = [
            { product: 'Wireless Earbuds Pro', qty: 1, stage: 'Listing', estDays: 2, recovery_route: 'Resale', recovery_status: 'Listed' },
            { product: 'USB-C Hub 7-in-1', qty: 1, stage: 'Quality Check', estDays: 1, recovery_route: 'Reimbursement', recovery_status: 'Claim submitted' },
            { product: 'Phone Stand Desk Mount', qty: 1, stage: 'Initial Inspection', estDays: 3, recovery_route: 'Resale', recovery_status: 'Inspection' },
            { product: 'Screen Protector Pack', qty: 1, stage: 'Listing', estDays: 2, recovery_route: 'Resale', recovery_status: 'Listed' },
            { product: 'Tablet Case Folio', qty: 1, stage: 'Ready for Sale', estDays: 0, recovery_route: 'Resale', recovery_status: 'Ready for sale' }
        ];
        const receivedDates = [1, 2, 3, 4, 5];
        const out = items.map((it, i) => {
            const rec = new Date(now); rec.setDate(rec.getDate() - receivedDates[i]);
            const est = new Date(rec); est.setDate(est.getDate() + it.estDays);
            return {
                reference: 'TRACK-RP' + String(i + 1).padStart(3, '0'),
                product: it.product,
                quantity: it.qty,
                received_date: rec.toISOString().slice(0, 10),
                current_stage: it.stage,
                est_completion: est.toISOString().slice(0, 10),
                notes: '',
                recovery_route: it.recovery_route || 'Resale',
                recovery_status: it.recovery_status || it.stage
            };
        });
        return {
            total: 5,
            stats: {
                pending_count: 5,
                total_quantity: 5,
                oldest_date: out[out.length - 1].received_date
            },
            items: out
        };
    },

    // ─── Invoices ────────────────────────────────────────────
    async getInvoices() {
        if (window.RETURNPAL_CONFIG && window.RETURNPAL_CONFIG.useMock) return this._getInvoicesMock();
        try {
            return await this.request('/invoices');
        } catch (err) {
            if (err.status === 404 || err.status === 501) return this._getInvoicesMock();
            throw err;
        }
    },
    _getInvoicesMock() {
        const now = new Date();
        const month = (m) => { const d = new Date(now.getFullYear(), m, 1); return d.toISOString().slice(0, 10); };
        return {
            invoices: [
                { date_issued: month(2), amount: 1240.00, items_count: 12, status: 'Paid', vat_amount: 0 },
                { date_issued: month(1), amount: 980.50, items_count: 8, status: 'Paid', vat_amount: 0 },
                { date_issued: month(0), amount: 0, items_count: 0, status: 'Pending', vat_amount: 0 }
            ]
        };
    },

    // ─── Referrals ─────────────────────────────────────────────
    async getReferrals() {
        if (window.RETURNPAL_CONFIG && window.RETURNPAL_CONFIG.useMock) return this._getReferralsMock();
        try {
            return await this.request('/referrals');
        } catch (err) {
            if (err.status === 404 || err.status === 501) return this._getReferralsMock();
            throw err;
        }
    },
    _getReferralsMock() {
        const now = new Date();
        const daysAgo = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
        // Tiered rewards: 1–5 active = £10, 6–10 = £15, 11+ = £20 per active referral
        const tiers = [
            { min_active: 1, max_active: 5, reward_per_referral: 10, label: 'Tier 1' },
            { min_active: 6, max_active: 10, reward_per_referral: 15, label: 'Tier 2' },
            { min_active: 11, max_active: null, reward_per_referral: 20, label: 'Tier 3' }
        ];
        const referrals = [
            { email: 'jane@example.com', referred_at: daysAgo(2), status: 'Pending' },
            { email: 'mike@example.com', referred_at: daysAgo(5), status: 'Signed up' },
            { email: 'sarah@example.com', referred_at: daysAgo(14), status: 'Active', earned: 10 },
            { email: 'alex@example.com', referred_at: daysAgo(21), status: 'Active', earned: 10 }
        ];
        const activeCount = referrals.filter(r => r.status === 'Active').length;
        let currentTier = tiers[0];
        let nextTier = null;
        for (let i = 0; i < tiers.length; i++) {
            const t = tiers[i];
            if (activeCount >= t.min_active && (t.max_active == null || activeCount <= t.max_active)) {
                currentTier = t;
                nextTier = tiers[i + 1] || null;
                break;
            }
        }
        if (!nextTier && tiers[tiers.indexOf(currentTier) + 1]) nextTier = tiers[tiers.indexOf(currentTier) + 1];
        const activeRequired = nextTier ? nextTier.min_active - activeCount : 0;
        return {
            referral_code: 'DEMO12',
            referral_link: 'https://returnpal.co/ref/DEMO12',
            total_earned: referrals.reduce((s, r) => s + (Number(r.earned) || 0), 0),
            tiers,
            current_tier: currentTier,
            next_tier: nextTier ? { ...nextTier, active_required: Math.max(0, activeRequired) } : null,
            referrals
        };
    },

    // ─── ROI Report ───────────────────────────────────────────
    async getRoiReport(params = {}) {
        if (window.RETURNPAL_CONFIG && window.RETURNPAL_CONFIG.useMock) return this._getRoiReportMock(params);
        try {
            const q = new URLSearchParams(params).toString();
            return await this.request('/reports/roi' + (q ? '?' + q : ''));
        } catch (err) {
            if (err.status === 404 || err.status === 501) return this._getRoiReportMock(params);
            throw err;
        }
    },
    _getRoiReportMock(params = {}) {
        const now = new Date();
        let monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
        let monthEnd = now.toISOString().slice(0, 10);
        if (params.from) monthStart = params.from;
        if (params.to) monthEnd = params.to;
        return {
            period_start: monthStart,
            period_end: monthEnd,
            cost_value_sent: 420,
            recovered: 387.50,
            you_kept: 329.38,
            fees: 58.12,
            estimated_hours_saved: 12,
            recovery_rate_pct: 92.3,
            category_avg_pct: 78,
            top_items: [
                { name: 'Wireless Earbuds Pro', recovered: 34.99, you_kept: 29.74 },
                { name: 'USB-C Hub 7-in-1', recovered: 28.50, you_kept: 24.23 },
                { name: 'Phone Stand Desk Mount', recovered: 37.98, you_kept: 32.28 }
            ],
            no_recovery_items: [
                { name: 'Damaged cable (no claim)', note: 'No charge', reason: 'Damaged – no claim possible' },
                { name: 'Used charger – unsellable', note: 'No charge', reason: 'Condition below resale threshold' }
            ]
        };
    },

    // ─── Invoice detail (per month for download) ─────────────────
    async getInvoiceDetail(period) {
        if (window.RETURNPAL_CONFIG && window.RETURNPAL_CONFIG.useMock) return this._getInvoiceDetailMock(period);
        try {
            return await this.request('/invoices/period/' + encodeURIComponent(period));
        } catch (err) {
            if (err.status === 404 || err.status === 501) return this._getInvoiceDetailMock(period);
            throw err;
        }
    },
    _getInvoiceDetailMock(period) {
        const [y, m] = period.split('-').map(Number);
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const line_items = [
            { description: 'Wireless Earbuds Pro', quantity: 1, unit_price: 34.99, amount: 29.74 },
            { description: 'USB-C Hub 7-in-1', quantity: 1, unit_price: 28.50, amount: 24.23 },
            { description: 'Phone Stand Desk Mount', quantity: 2, unit_price: 18.99, amount: 32.28 },
            { description: 'Screen Protector Pack', quantity: 1, unit_price: 12.00, amount: 10.20 },
            { description: 'Tablet Case Folio', quantity: 1, unit_price: 22.45, amount: 19.08 }
        ];
        const total = line_items.reduce((s, i) => s + (i.amount || 0), 0);
        const fees = line_items.reduce((s, i) => s + ((i.unit_price || 0) * (i.quantity || 1) - (i.amount || 0)), 0);
        const vat = 0; // or fees * 0.2 if applicable
        const statement_lines = line_items.map((i) => ({
            kind: 'sale',
            label: i.description + ' → Sold',
            amount: (i.amount || 0) * (i.quantity || 1),
            reference: ''
        }));
        return {
            period,
            period_label: monthNames[(m || 1) - 1] + ' ' + (y || new Date().getFullYear()),
            date_issued: new Date(y || 2026, (m || 1) - 1, 1).toISOString().slice(0, 10),
            line_items,
            statement_lines,
            summary: {
                sales_profit: total,
                refunds_and_returns: 0,
                fees_deducted: fees,
                net_payout_estimate: total - fees
            },
            return_lines: [],
            subtotal: total,
            fees,
            vat_amount: vat,
            total: total - fees,
            status: 'Paid'
        };
    },

    async getBalanceSummary() {
        try {
            return await this.request('/balance/summary');
        } catch (err) {
            if (err.status === 404 || err.status === 501) {
                return {
                    year_month: new Date().toISOString().slice(0, 7),
                    current_balance: 0,
                    pending_returns: 0,
                    available_for_payout: 0,
                    payout_forecast: { if_no_more_returns: 0, after_pending_returns: 0 },
                    breakdown: { sales_this_month: 0, returns_this_month: 0, fees_deducted: 0 }
                };
            }
            throw err;
        }
    },

    async getBalanceLedger(params = {}) {
        try {
            const q = params.limit ? '?limit=' + encodeURIComponent(params.limit) : '';
            return await this.request('/balance/ledger' + q);
        } catch (err) {
            if (err.status === 404 || err.status === 501) return { lines: [] };
            throw err;
        }
    },

    async submitItemQuery(body) {
        return this.request('/queries', { method: 'POST', body });
    },

    async importInventoryRows(rows) {
        return this.request('/inventory/import', { method: 'POST', body: { rows } });
    },

    // ─── Settings ────────────────────────────────────────────
    async getSettings() {
        return this.request('/settings');
    },
    async updateVat(vat_registered) {
        return this.request('/settings/vat', { method: 'PUT', body: { vat_registered } });
    },
    async updateWebhook(discord_webhook) {
        return this.request('/settings/webhook', { method: 'PUT', body: { discord_webhook } });
    },

    // ─── Contact ─────────────────────────────────────────────
    async sendContact(data) {
        return this.request('/contact', { method: 'POST', body: data });
    },

    // ─── Upload ──────────────────────────────────────────────
    async uploadPackages(file) {
        const formData = new FormData();
        formData.append('file', file);
        return this.request('/upload/packages', { method: 'POST', body: formData });
    },

    // ─── Activity ──────────────────────────────────────────────
    async getActivity(params = {}) {
        if (window.RETURNPAL_CONFIG && window.RETURNPAL_CONFIG.useMock) return this._getActivityMock();
        const limit = params.limit;
        const q = limit ? '?limit=' + encodeURIComponent(limit) : '';
        const reqOpts = params.skipAuthRedirect ? { skipAuthRedirect: true } : {};
        try {
            return await this.request('/activity' + q, reqOpts);
        } catch (err) {
            if (err.status === 404 || err.status === 501) return this._getActivityMock();
            throw err;
        }
    },
    _getActivityMock() {
        const now = new Date();
        const iso = (d) => d.toISOString();
        const daysAgo = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return iso(d); };
        return {
            events: [
                { message: 'Package TRACK-11255 marked as delivered.', timestamp: daysAgo(0), icon: 'ri-checkbox-circle-line', link: '/dashboard/packages.html' },
                { message: 'Item "Wireless Earbuds Pro" sold for £34.99.', timestamp: daysAgo(1), icon: 'ri-money-pound-circle-line', link: '/dashboard/sold-items.html' },
                { message: 'January 2026 invoice paid. £1,240.00 credited.', timestamp: daysAgo(2), icon: 'ri-bank-card-line' },
                { message: 'New package received: 3 items added to inventory.', timestamp: daysAgo(3), icon: 'ri-inbox-archive-line', link: '/dashboard/received.html' },
                { message: '5 items moved to "Ready for Sale" after inspection.', timestamp: daysAgo(4), icon: 'ri-list-check' }
            ]
        };
    },

    // ─── Inventory ────────────────────────────────────────────
    async getInventorySummary() {
        if (window.RETURNPAL_CONFIG && window.RETURNPAL_CONFIG.useMock) return this._getInventorySummaryMock();
        try {
            return await this.request('/inventory/summary');
        } catch (err) {
            if (err.status === 404 || err.status === 501) return this._getInventorySummaryMock();
            throw err;
        }
    },
    _getInventorySummaryMock() {
        return {
            items_received: 45,
            items_processing: 12,
            items_sold: 89,
            awaiting_inspection: 5,
            awaiting_listing: 7,
            estimated_resale_value: 2840,
            recovered_so_far: 452501.58,
            potential_remaining_value: 1200,
            stage_breakdown: { inspection: 5, listing: 7, listed: 12, sold: 89, storage: 3 }
        };
    },

    // ─── Analytics ────────────────────────────────────────────
    async getAnalytics() {
        if (window.RETURNPAL_CONFIG && window.RETURNPAL_CONFIG.useMock) return this._getAnalyticsMock();
        try {
            return await this.request('/analytics');
        } catch (err) {
            if (err.status === 404 || err.status === 501) return this._getAnalyticsMock();
            throw err;
        }
    },
    _getAnalyticsMock() {
        const months = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
        const values = [3200, 4100, 3850, 4520, 5100, 4800];
        return {
            recoveryRate: 0.72,
            avgRecoveryPerItem: 32.45,
            recoveredOverTime: months.map((m, i) => ({ month: m, value: values[i] })),
            sellThroughRate: 0.58,
            averageSalePrice: 28.5,
            returnRate: 0.04,
            top_categories: [
                { name: 'Wireless Earbuds Pro', units_sold: 12, profit_sum: 356.88, avg_sale_price: 34.99 },
                { name: 'USB-C Hub', units_sold: 8, profit_sum: 193.84, avg_sale_price: 28.5 }
            ],
            counts: { items_received: 120, items_sold: 70, items_refunded: 2, return_adjustments: 1 }
        };
    },

    // ─── Dashboard Stats / Summary ─────────────────────────────
    async getDashboardStats() {
        return this.request('/dashboard/stats');
    },

    /** Overview page: summary + recent activity. Tries /dashboard/summary then /dashboard/stats; falls back to mock when not found or any error. */
    async getDashboardSummary() {
        const useMock = window.RETURNPAL_CONFIG && window.RETURNPAL_CONFIG.useMock;
        if (useMock) return this._getDashboardSummaryMock();
        try {
            return await this.request('/dashboard/summary');
        } catch (err) {
            try {
                const stats = await this.request('/dashboard/stats');
                return Object.assign({ recent_activity: [], top_items: [], latest_payout: null }, stats);
            } catch (e) {
                return this._getDashboardSummaryMock();
            }
        }
    },

    _getDashboardSummaryMock() {
        const now = new Date();
        const iso = (d) => d.toISOString();
        const daysAgo = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return iso(d); };
        return {
            total_recovered: 452501.58,
            items_processing: 12,
            items_sold: 89,
            packages_sent: 24,
            total_recovered_delta_30d: 8.2,
            items_processing_total: 12,
            recent_activity: [
                { message: 'Package TRACK-11255 marked as delivered.', timestamp: daysAgo(0), icon: 'ri-checkbox-circle-line', link: '/dashboard/packages.html' },
                { message: 'Item "Wireless Earbuds Pro" sold for £34.99.', timestamp: daysAgo(1), icon: 'ri-money-pound-circle-line', link: '/dashboard/sold-items.html' },
                { message: 'January 2026 invoice paid. £1,240.00 credited.', timestamp: daysAgo(2), icon: 'ri-bank-card-line' },
                { message: 'New package received: 3 items added to inventory.', timestamp: daysAgo(3), icon: 'ri-inbox-archive-line', link: '/dashboard/received.html' },
                { message: '5 items moved to "Ready for Sale" after inspection.', timestamp: daysAgo(4), icon: 'ri-list-check' },
                { message: 'Welcome to ReturnPal. Connect your account to see live data.', timestamp: daysAgo(14), icon: 'ri-inbox-line' }
            ],
            top_items: [
                { id: 'ex1', name: 'Wireless Earbuds Pro', value: 34.99 },
                { id: 'ex2', name: 'USB-C Hub 7-in-1', value: 28.50 },
                { id: 'ex3', name: 'Phone Stand Desk Mount', value: 18.99 },
                { id: 'ex4', name: 'Screen Protector Pack', value: 12.00 },
                { id: 'ex5', name: 'Tablet Case Folio', value: 22.45 }
            ],
            latest_payout: { amount: 1240.00, status: 'Paid', date: daysAgo(2) }
        };
    },
};
