/**
 * Client activity beacons for admin audit log (pages, exports, journey).
 * Requires API from /assets/js/api.js loaded first.
 */
(function (global) {
    const PAGE_ACTIONS = [
        ['received', 'page_received'],
        ['sold-items', 'page_sold_items'],
        ['settings', 'page_settings'],
        ['returns-settings', 'page_returns_settings'],
        ['package-detail', 'page_package_detail'],
        ['packages', 'page_packages'],
        ['invoices', 'page_invoices'],
        ['inventory', 'page_inventory'],
        ['analytics', 'page_analytics'],
        ['queries', 'page_queries'],
        ['reimbursement', 'page_reimbursement'],
        ['prep-sendback', 'page_prep_sendback'],
        ['lost-items', 'page_lost_items'],
        ['referrals', 'page_referrals'],
        ['exports', 'page_exports'],
        ['activity', 'page_activity'],
        ['announcements', 'page_announcements'],
        ['your-stock', 'page_your_stock'],
        ['item-pending', 'page_item_pending'],
        ['scorecard', 'page_scorecard'],
        ['faq', 'page_faq'],
        ['my-clients', 'page_my_clients'],
    ];

    function resolvePageAction() {
        const path = (global.location && global.location.pathname) || '';
        const lower = path.toLowerCase();
        if (/\/dashboard\/?(index\.html)?$/i.test(lower) || lower.endsWith('/dashboard/')) {
            return 'page_overview';
        }
        for (let i = 0; i < PAGE_ACTIONS.length; i++) {
            if (lower.includes(PAGE_ACTIONS[i][0])) return PAGE_ACTIONS[i][1];
        }
        return 'page_dashboard';
    }

    function logPage() {
        if (!global.API || typeof global.API.logClientAuditEvent !== 'function') return Promise.resolve();
        return global.API.logClientAuditEvent({
            category: 'view',
            action: resolvePageAction(),
            path: global.location.pathname || '',
        });
    }

    function log(action, opts) {
        if (!global.API || typeof global.API.logClientAuditEvent !== 'function') return Promise.resolve();
        const o = opts || {};
        return global.API.logClientAuditEvent({
            category: o.category || 'export',
            action: action,
            resource: o.resource,
            detail: o.detail,
            path: o.path || global.location.pathname || '',
        });
    }

    global.ClientAudit = {
        logPage: logPage,
        log: log,
        resolvePageAction: resolvePageAction,
    };
})(typeof window !== 'undefined' ? window : globalThis);
