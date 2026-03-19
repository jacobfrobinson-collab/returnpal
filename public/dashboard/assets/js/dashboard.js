/**
 * ReturnPal Dashboard Controller
 * Handles all dashboard pages: packages, received, sold, pending, invoices, settings
 * Include AFTER api.js and jQuery on every dashboard page.
 */

const Dashboard = {
    init() {
        const params = new URLSearchParams(window.location.search);
        const impersonateToken = params.get('impersonate');
        if (impersonateToken) {
            API.setToken(impersonateToken);
            API.request('/auth/me').then(me => {
                if (me && me.user) API.setUser(me.user);
                window.history.replaceState({}, '', window.location.pathname + (window.location.hash || ''));
                sessionStorage.setItem('returnpal_impersonating', '1');
                this.injectImpersonationBanner();
            }).catch(() => {}).finally(() => this._initRest());
            return;
        }
        this._initRest();
    },

    _initRest() {
        // Auth guard - redirect to login if not authenticated
        if (!API.isLoggedIn()) {
            window.location.href = '/login.html';
            return;
        }

        if (sessionStorage.getItem('returnpal_impersonating') === '1') {
            this.injectImpersonationBanner();
        }

        // Set user name and Client ID in dropdown (4-digit padded)
        const user = API.getUser();
        if (user) {
            const clientIdFormatted = user.id != null ? String(user.id).padStart(4, '0') : '';
            const $userMenu = $('#page-header-user-dropdown').siblings('.dropdown-menu').first();
            $userMenu.find('.dropdown-header').first().text('Welcome ' + (user.full_name || user.email).split(' ')[0] + '!');
            if (!$userMenu.find('#dashboard-client-id-dropdown').length && clientIdFormatted) {
                $userMenu.find('.dropdown-header').first().after(
                    '<div class="dropdown-item disabled small py-2" id="dashboard-client-id-dropdown">Client ID: <strong>' + clientIdFormatted + '</strong> <span class="text-muted">(use for return address)</span></div>'
                );
            }
            // Returns Settings page: show "ReturnPal 0001" in the return address block
            const $returnsClientId = $('#returns-settings-client-id');
            if ($returnsClientId.length) $returnsClientId.text(clientIdFormatted ? 'ReturnPal ' + clientIdFormatted : '—');
        }

        // Logout handler
        $(document).on('click', 'a[href="login.html"], a[href="../login.html"], a[href="/login.html"]', function(e) {
            // Only intercept logout links (ones with "Logout" text)
            if ($(this).text().trim() === 'Logout') {
                e.preventDefault();
                API.logout();
            }
        });

        // Keep sidebar links relative (packages.html, index.html, etc.) so they work
        // from both file:// and http:// without sending users to the wrong page.

        // Clear activity auto-refresh when not on activity page
        if (this._activityTimer) {
            clearTimeout(this._activityTimer);
            this._activityTimer = null;
        }

        // Detect which page we're on and load data
        const page = (window.location.pathname || '').toLowerCase();
        const isOverview = page.includes('dashboard/index') || page.endsWith('dashboard/') || page === '/dashboard' || page.endsWith('/dashboard') && !page.includes('packages') || (page.endsWith('index.html') && page.includes('dashboard'));
        if (isOverview) {
            this.loadOverview();
        } else if (page.includes('packages')) {
            this.loadPackages();
        } else if (page.includes('activity')) {
            this.loadActivity();
        } else if (page.includes('inventory')) {
            this.loadInventory();
        } else if (page.includes('analytics')) {
            this.loadAnalytics();
        } else if (page.includes('item-detail')) {
            this.loadItemDetail();
        } else if (page.includes('package-detail')) {
            this.loadPackageDetail();
        } else if (page.includes('received')) {
            this.loadReceived();
        } else if (page.includes('sold-items')) {
            this.loadSold();
        } else if (page.includes('item-pending')) {
            this.loadPending();
        } else if (page.includes('invoices')) {
            this.loadInvoices();
        } else if (page.includes('referrals')) {
            this.loadReferrals();
        } else if (page.includes('roi-report')) {
            this.loadRoiReport();
        } else if (page.includes('settings')) {
            this.loadSettings();
        } else if (page.includes('announcements')) {
            this.loadAnnouncements();
        }

        this.injectAnnouncementsLink();
        this.injectReimbursementLink();
        this.injectConnectAmazonLink();
        this.updateNotificationDots();

        $('#activity-date-range').on('change', () => this.loadActivity());
        $('#invoices-date-range').on('change', () => this.loadInvoices());
        $('#sold-recovery-filter').on('change', () => this.loadSold());
        $('#sold-search').on('input', () => this.loadSold());
        $('#sold-search-by').on('change', () => this.loadSold());
        $('#pending-recovery-filter').on('change', () => this.loadPending());
        $('#pending-search').on('input', () => this.loadPending());
        $('#pending-search-by').on('change', () => this.loadPending());
        $('#received-search-by').on('change', () => this.loadReceived());
        $('#activity-type-filter').on('change', () => this.loadActivity());
        $('#analytics-date-range').on('change', () => this.loadAnalytics());
        $('#export-csv').on('click', () => this.exportAnalyticsCsv());
        $('#invoices-export-csv').on('click', () => this.exportInvoicesCsv());
        $('#invoices-download-accountant').on('click', () => this.exportInvoicesForAccountant());
        $('#invoices-export-xero').on('click', (e) => { e.preventDefault(); this.exportInvoicesXero(); });
        $('#invoices-export-quickbooks').on('click', (e) => { e.preventDefault(); this.exportInvoicesQuickBooks(); });

        // Global search: on Enter or after delay, navigate to packages with query or show results
        const $search = $('#dashboard-global-search');
        if ($search.length) {
            $search.on('keydown', function(e) {
                if (e.which === 13) {
                    e.preventDefault();
                    const q = $(this).val().trim();
                    if (q) window.location.href = 'packages.html?search=' + encodeURIComponent(q);
                }
            });
        }

        // Inject topbar search/notifications/help on pages that don't have them
        this.injectTopbarExtras();
        // Inject Refer a seller modal and sidebar link if missing
        this.injectReferModal();
        this.injectReferSidebarLink();
        this.injectReturnsSettingsLink();
        this.injectSupportModal();
        this.injectCommandPalette();
        this.initCommandPalette();
        this.injectFooter();
        $(document).on('click', '#support-submit-btn', function() {
            const regarding = $('#support-regarding').val() || 'general';
            const ref = $('#support-reference').val().trim();
            const msg = $('#support-message').val().trim();
            if (!msg) return alert('Please enter a message.');
            const subj = 'Support: ' + regarding + (ref ? ' – ' + ref : '');
            const mailto = 'mailto:support@returnpal.co?subject=' + encodeURIComponent(subj) + '&body=' + encodeURIComponent(msg);
            const modal = bootstrap.Modal.getInstance(document.getElementById('supportModal'));
            if (modal) modal.hide();
            $('#support-reference, #support-message').val('');
            window.location.href = mailto;
        });
        // Recovery-route alert: remove if previously dismissed so it never comes back
        (function() {
            if (localStorage.getItem('returnpal_dismissed_recovery_route_alert') === 'true') {
                $('#dashboard-recovery-route-alert').remove();
            }
        })();
        $(document).on('click', '#dashboard-recovery-route-alert-dismiss', function(e) {
            e.preventDefault();
            e.stopPropagation();
            localStorage.setItem('returnpal_dismissed_recovery_route_alert', 'true');
            $('#dashboard-recovery-route-alert').remove();
        });

        // Refer a friend: send invite (UI only; backend later)
        $(document).on('click', '#refer-send-btn', function() {
            const email = $('#refer-email').val().trim();
            if (!email) return alert('Please enter their email.');
            const msg = $('#refer-message').val().trim();
            const modal = bootstrap.Modal.getInstance(document.getElementById('referFriendModal'));
            if (modal) modal.hide();
            $('#refer-email').val('');
            $('#refer-message').val('');
            alert('Invite will be sent to ' + email + ' when the backend is connected.');
        });
    },

    injectReferModal() {
        if ($('#referFriendModal').length) return;
        const html = '<div class="modal fade" id="referFriendModal" tabindex="-1"><div class="modal-dialog modal-dialog-centered"><div class="modal-content"><div class="modal-header"><h5 class="modal-title">Refer a seller</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body"><p class="text-muted small">Invite another seller to try ReturnPal.</p><div class="mb-3"><label class="form-label">Their email</label><input type="email" class="form-control" id="refer-email" placeholder="seller@example.com" /></div><div class="mb-3"><label class="form-label">Optional message</label><textarea class="form-control" id="refer-message" rows="2" placeholder="Add a short note..."></textarea></div></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="button" class="btn btn-primary" id="refer-send-btn">Send invite</button></div></div></div></div>';
        $('body').append(html);
    },
    injectSupportModal() {
        if ($('#supportModal').length) return;
        const html = '<div class="modal fade" id="supportModal" tabindex="-1"><div class="modal-dialog modal-dialog-centered"><div class="modal-content"><div class="modal-header"><h5 class="modal-title">Contact support</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body"><p class="text-muted small">Reference a package or invoice so we can help quickly.</p><div class="mb-3"><label class="form-label">Regarding</label><select class="form-select" id="support-regarding"><option value="general">General</option><option value="package">Package</option><option value="invoice">Invoice</option><option value="payout">Payout</option></select></div><div class="mb-3"><label class="form-label">Reference (optional)</label><input type="text" class="form-control" id="support-reference" placeholder="e.g. TRACK-RP001 or March 2026" /></div><div class="mb-3"><label class="form-label">Message</label><textarea class="form-control" id="support-message" rows="4" placeholder="Describe your question or issue..."></textarea></div></div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button type="button" class="btn btn-primary" id="support-submit-btn">Send message</button></div></div></div></div>';
        $('body').append(html);
    },
    injectReferSidebarLink() {
        if ($('#navbar-nav a[data-bs-target="#referFriendModal"]').length) return;
        const $faq = $('#navbar-nav a[href="/faq.html"], #navbar-nav a[href="faq.html"]').closest('li');
        if ($faq.length) $faq.after('<li class="nav-item"><a class="nav-link" href="#" data-bs-toggle="modal" data-bs-target="#referFriendModal"><span class="nav-icon"><i class="ri-user-shared-line"></i></span><span class="nav-text">Refer a seller</span></a></li>');
    },
    injectReturnsSettingsLink() {
        if ($('#navbar-nav a[href="returns-settings.html"]').length) return;
        const $settings = $('#navbar-nav a[href="settings.html"]').closest('li');
        if ($settings.length) $settings.before('<li class="nav-item"><a class="nav-link" href="returns-settings.html"><span class="nav-icon"><i class="ri-settings-4-line"></i></span><span class="nav-text">Returns Settings</span></a></li>');
    },
    injectAnnouncementsLink() {
        if ($('#navbar-nav a[href="announcements.html"]').length) return;
        const $settings = $('#navbar-nav a[href="settings.html"]').closest('li');
        if ($settings.length) $settings.before('<li class="nav-item"><a class="nav-link position-relative" href="announcements.html" id="nav-link-announcements"><span class="nav-icon"><i class="ri-megaphone-line"></i></span><span class="nav-text">Announcements</span></a></li>');
    },
    injectReimbursementLink() {
        if ($('#navbar-nav a[href="reimbursement.html"]').length) return;
        const $settings = $('#navbar-nav a[href="settings.html"]').closest('li');
        if ($settings.length) $settings.before('<li class="nav-item"><a class="nav-link" href="reimbursement.html"><span class="nav-icon"><i class="ri-refund-line"></i></span><span class="nav-text">Reimbursement / Claims</span></a></li>');
    },
    injectConnectAmazonLink() {
        if ($('#nav-link-connect-amazon').length) return;
        const $settings = $('#navbar-nav a[href="settings.html"]').closest('li');
        if ($settings.length) $settings.before('<li class="nav-item"><a class="nav-link position-relative" href="settings.html" id="nav-link-connect-amazon"><span class="nav-icon"><i class="ri-amazon-line"></i></span><span class="nav-text">Connect Amazon</span></a></li>');
    },
    updateNotificationDots() {
        const unread = this.getUnreadAnnouncementsCount();
        const $ann = $('#navbar-nav a[href="announcements.html"]').first();
        if ($ann.length) {
            if (!$ann.hasClass('position-relative')) $ann.addClass('position-relative');
            let $dot = $ann.find('.rp-nav-dot');
            if (unread > 0) {
                if (!$dot.length) $ann.append('<span class="rp-nav-dot position-absolute top-0 end-0 translate-middle rounded-circle bg-danger" style="width:8px;height:8px;"></span>');
            } else $dot.remove();
        }
        const amazonConnected = localStorage.getItem('returnpal_amazon_connected') === 'true';
        const $amazon = $('#nav-link-connect-amazon');
        if ($amazon.length && !amazonConnected) {
            if (!$amazon.find('.rp-nav-dot').length) $amazon.append('<span class="rp-nav-dot position-absolute top-0 end-0 translate-middle rounded-circle bg-danger" style="width:8px;height:8px;"></span>');
        } else if ($amazon.length) $amazon.find('.rp-nav-dot').remove();
    },

    injectImpersonationBanner() {
        if ($('#rp-impersonation-banner').length) return;
        const user = API.getUser();
        const name = (user && (user.full_name || user.email)) || 'Client';
        const html = '<div id="rp-impersonation-banner" class="d-flex align-items-center justify-content-between px-3 py-2 bg-warning bg-opacity-25 border-bottom border-warning" style="position:sticky;top:0;z-index:1025;">' +
            '<span class="small"><strong>Viewing as ' + (name.replace(/</g, '&lt;')) + '</strong></span>' +
            '<a href="/admin/index.html" class="btn btn-sm btn-outline-dark">Return to admin</a>' +
            '</div>';
        // Prepend to page-content so the sidebar stays full-height and scrollable (banner was covering it when on body)
        const $target = $('.page-content').length ? $('.page-content') : $('body');
        $target.prepend(html);
        $('#rp-impersonation-banner a').on('click', function() {
            sessionStorage.removeItem('returnpal_impersonating');
        });
    },

    injectCommandPalette() {
        if ($('#commandPaletteModal').length) return;
        const html = '<div class="modal fade" id="commandPaletteModal" tabindex="-1" aria-labelledby="commandPaletteLabel" aria-hidden="true">' +
            '<div class="modal-dialog modal-dialog-centered modal-sm">' +
            '<div class="modal-content">' +
            '<div class="modal-header border-0 pb-0">' +
            '<h5 class="modal-title small fw-semibold" id="commandPaletteLabel">Quick actions</h5>' +
            '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>' +
            '</div>' +
            '<div class="modal-body pt-2">' +
            '<input type="text" class="form-control form-control-sm mb-3" id="command-palette-search" placeholder="Search or navigate..." aria-label="Search" />' +
            '<div class="list-group list-group-flush">' +
            '<a href="index.html" class="list-group-item list-group-item-action list-group-item-light border-0 py-2 small">Dashboard</a>' +
            '<a href="packages.html" class="list-group-item list-group-item-action list-group-item-light border-0 py-2 small">Packages Sent</a>' +
            '<a href="sold-items.html" class="list-group-item list-group-item-action list-group-item-light border-0 py-2 small">Sold Items</a>' +
            '<a href="invoices.html" class="list-group-item list-group-item-action list-group-item-light border-0 py-2 small">Payouts & Invoices</a>' +
            '<a href="analytics.html" class="list-group-item list-group-item-action list-group-item-light border-0 py-2 small">Analytics</a>' +
            '<a href="returns-settings.html" class="list-group-item list-group-item-action list-group-item-light border-0 py-2 small">Returns Settings</a>' +
            '<a href="announcements.html" class="list-group-item list-group-item-action list-group-item-light border-0 py-2 small">Announcements</a>' +
            '<a href="settings.html" class="list-group-item list-group-item-action list-group-item-light border-0 py-2 small">Settings</a>' +
            '</div>' +
            '</div>' +
            '</div></div></div>';
        $('body').append(html);
    },
    initCommandPalette() {
        $(document).on('keydown', function(e) {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                const modal = document.getElementById('commandPaletteModal');
                if (modal) {
                    const m = new (window.bootstrap && window.bootstrap.Modal)(modal);
                    m.show();
                    setTimeout(function() { $('#command-palette-search').focus(); }, 100);
                }
            }
        });
    },

    injectFooter() {
        const $footer = $('.footer').not('.rp-footer');
        if (!$footer.length) return;
        $footer.addClass('rp-footer');
        const year = new Date().getFullYear();
        const content = '<div class="row align-items-center justify-content-between flex-wrap gap-2"><div class="col-12 col-md-auto text-center text-md-start">' + year + ' &copy; ReturnPal</div><div class="col-12 col-md-auto text-center"><a href="../index.html#contact">Status</a><span class="mx-2">·</span><a href="faq.html">FAQ</a><span class="mx-2">·</span><a href="../index.html#contact">Support</a><span class="mx-2">·</span><a href="../privacy.html">Privacy</a><span class="mx-2">·</span><a href="../terms.html">Terms</a></div></div>';
        $footer.find('.container-fluid').first().html(content);
    },

    updateOnboardingCheckmark(selector, done, linkUrl) {
        const $el = $(selector);
        if (!$el.length) return;
        const $icon = $el.find('i').first();
        if (!$icon.length) return;
        $icon.removeClass('ri-checkbox-blank-circle-line ri-checkbox-circle-fill text-muted text-success').addClass(done ? 'ri-checkbox-circle-fill text-success' : 'ri-checkbox-blank-circle-line text-muted');
    },

    injectTopbarExtras() {
        if ($('#dashboard-global-search').length) return;
        const $nav = $('.navbar-header .d-flex.align-items-center.gap-2');
        if (!$nav.length) return;
        $nav.append(
            '<div class="topbar-item d-none d-md-block" style="min-width: 200px;">' +
            '<input type="text" class="form-control form-control-sm" id="dashboard-global-search" placeholder="Search packages, items..." aria-label="Search" />' +
            '</div>'
        );
        const $gap1 = $('.navbar-header .d-flex.gap-1');
        if ($gap1.length && !$('#dashboard-notifications-btn').length) {
            $gap1.prepend(
                '<div class="dropdown topbar-item">' +
                '<button type="button" class="topbar-button position-relative" data-bs-toggle="dropdown" aria-label="Notifications" id="dashboard-notifications-btn">' +
                '<i class="ri-notification-3-line fs-24"></i><span class="position-absolute top-0 start-100 translate-middle badge rounded-pill bg-danger py-1 px-1" style="font-size: 10px;">3</span>' +
                '</button>' +
                '<div class="dropdown-menu dropdown-menu-end py-0" style="min-width: 320px;">' +
                '<div class="dropdown-header border-bottom">Notifications</div>' +
                '<a class="dropdown-item py-3 border-bottom" href="packages.html">Package TRACK-RP001 delivered</a>' +
                '<a class="dropdown-item py-3 border-bottom" href="sold-items.html">Item sold: Wireless Earbuds Pro £34.99</a>' +
                '<a class="dropdown-item py-3" href="invoices.html">Payout £1,240.00 sent</a>' +
                '<a class="dropdown-item text-center small text-primary" href="activity.html">View all activity</a>' +
                '</div></div>' +
                '<a href="/index.html#contact" class="topbar-item topbar-button d-none d-lg-flex align-items-center" title="Help"><i class="ri-customer-service-2-line fs-24"></i></a>'
            );
        }
    },

    // ─── Helper: format date ─────────────────────────────────
    formatDate(dateStr) {
        if (!dateStr) return '-';
        const d = new Date(dateStr);
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'numeric', year: 'numeric' });
    },

    // ─── Helper: status badge (design token colors) ───────────
    statusBadge(status) {
        const tokenMap = {
            'Processing': 'badge-status-processing',
            'Pending': 'badge-status-pending',
            'Overdue': 'badge-status-error',
            'In Transit': 'badge-status-transit',
            'Delivered': 'badge-status-transit',
            'Processed': 'badge-status-completed',
            'Completed': 'badge-status-completed',
            'Paid': 'badge-status-completed',
            'Sold': 'badge-status-completed',
            'New': 'badge-status-completed',
            'Initial Inspection': 'badge-status-completed',
            'Listing': 'badge-status-processing',
            'Ready for Sale': 'badge-status-completed',
            'Quality Check': 'badge-status-transit',
            'Rejected': 'badge-status-error',
            'Return Verification': 'badge-status-error',
            'Cancelled': 'badge-status-error',
            'Refunded': 'badge-status-pending'
        };
        const cls = tokenMap[status] || 'badge-status-pending';
        return `<span class="badge ${cls} py-1 px-2 fs-12">${status}</span>`;
    },

    showLoading($container, message) {
        if (!$container || !$container.length) return;
        const html = '<div class="rp-loading text-center py-5 text-muted"><span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>' + (message || 'Loading…') + '</div>';
        $container.html(html);
    },
    showError($container, message, tryAgainFn) {
        if (!$container || !$container.length) return;
        const btn = tryAgainFn ? '<button type="button" class="btn btn-outline-primary btn-sm mt-2">Try again</button>' : '';
        $container.html('<div class="rp-error text-center py-5"><p class="text-danger mb-0">' + (message || 'Something went wrong.') + '</p>' + btn + '</div>');
        if (tryAgainFn && typeof tryAgainFn === 'function') {
            $container.find('.btn').on('click', tryAgainFn);
        }
    },

    showToast(message, type) {
        type = type || 'success';
        let $wrap = $('#rp-toast-container');
        if (!$wrap.length) {
            $wrap = $('<div id="rp-toast-container" class="position-fixed bottom-0 end-0 p-3" style="z-index: 9999;"></div>').appendTo('body');
        }
        const $toast = $('<div class="toast align-items-center text-bg-' + (type === 'error' ? 'danger' : 'success') + ' border-0 show" role="alert"><div class="d-flex"><div class="toast-body">' + (message || 'Saved') + '</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div></div>');
        $wrap.append($toast);
        setTimeout(function() {
            $toast.fadeOut(200, function() { $(this).remove(); });
        }, 2800);
    },

    // ─── Helper: count-up animation ───────────────────────────
    animateValue(el, start, end, duration, prefix = '', suffix = '') {
        const isMoney = typeof end === 'number' && (prefix === '£' || suffix === '£');
        const startTime = performance.now();
        function formatMoney(n) {
            const fixed = Number(n).toFixed(2);
            const parts = fixed.split('.');
            parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
            return parts.join('.');
        }
        function update(now) {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const easeOut = 1 - Math.pow(1 - progress, 2);
            const current = start + (end - start) * easeOut;
            if (isMoney || (typeof end === 'number' && end % 1 !== 0)) {
                el.textContent = prefix + formatMoney(current) + suffix;
            } else {
                el.textContent = prefix + Math.round(current).toLocaleString() + suffix;
            }
            if (progress < 1) requestAnimationFrame(update);
        }
        requestAnimationFrame(update);
    },

    // ─── OVERVIEW PAGE ───────────────────────────────────────
    async loadOverview() {
        const user = API.getUser();
        const firstName = (user && (user.full_name || user.email).split(' ')[0]) || 'there';
        const $hello = $('#dashboard-hello');
        if ($hello.length) $hello.text('Welcome back, ' + firstName);

        // Client ID for return address (4-digit padded)
        const clientIdFormatted = (user && user.id != null) ? String(user.id).padStart(4, '0') : '—';
        const $clientIdVal = $('#dashboard-client-id-value');
        if ($clientIdVal.length) $clientIdVal.text(clientIdFormatted);
        $('#dashboard-copy-client-id').off('click').on('click', function() {
            const id = (API.getUser() || {}).id;
            if (id == null) return;
            const toCopy = String(id).padStart(4, '0');
            navigator.clipboard.writeText(toCopy).then(() => {
                Dashboard.showToast('Client ID copied to clipboard', 'success');
            }).catch(() => {});
        });

        const $feed = $('#dashboard-activity');
        if ($feed.length) this.showLoading($feed, 'Loading…');

        try {
            const data = await API.getDashboardSummary();
            const totalRecovered = Number(data.total_recovered) || 0;
            const itemsProcessing = Number(data.items_processing) || 0;
            const itemsSold = Number(data.items_sold) || 0;
            const packagesSent = Number(data.packages_sent) || 0;

            // KPI count-up
            const kpiDuration = 1200;
            const $kpiTotal = $('[data-kpi="total_recovered"]');
            if ($kpiTotal.length) this.animateValue($kpiTotal[0], 0, totalRecovered, kpiDuration, '£');
            const $delta = $('[data-kpi-delta]');
            if (data.total_recovered_delta_30d != null && $delta.length) {
                $delta.text('+' + Number(data.total_recovered_delta_30d).toFixed(1) + '% last 30d');
            }
            const $kpiProc = $('[data-kpi="items_processing"]');
            if ($kpiProc.length) this.animateValue($kpiProc[0], 0, itemsProcessing, kpiDuration);
            const $sub = $('[data-kpi-sub]');
            if (data.items_processing_total != null && $sub.length) {
                $sub.text(itemsProcessing + ' of ' + data.items_processing_total + ' total');
            }
            const $kpiSold = $('[data-kpi="items_sold"]');
            if ($kpiSold.length) this.animateValue($kpiSold[0], 0, itemsSold, kpiDuration);
            const $kpiPkg = $('[data-kpi="packages_sent"]');
            if ($kpiPkg.length) this.animateValue($kpiPkg[0], 0, packagesSent, kpiDuration);

            // Onboarding banner when no packages
            const $banner = $('#dashboard-onboarding-banner');
            if ($banner.length) $banner.toggleClass('d-none', packagesSent > 0);
            // Post-payout referral nudge (show once when they have recovery, dismissible)
            const $nudge = $('#dashboard-payout-nudge');
            const nudgeDismissed = localStorage.getItem('returnpal_nudge_dismissed') === 'true';
            if ($nudge.length && totalRecovered > 0 && !nudgeDismissed) {
                $('#dashboard-payout-nudge-amount').text(totalRecovered.toFixed(2));
                $nudge.removeClass('d-none').addClass('d-flex');
            } else if ($nudge.length) {
                $nudge.addClass('d-none');
            }
            $('#dashboard-payout-nudge-dismiss').off('click').on('click', function() {
                localStorage.setItem('returnpal_nudge_dismissed', 'true');
                $('#dashboard-payout-nudge').addClass('d-none');
            });

            // Onboarding checklist checkmarks
            const amazonConnected = localStorage.getItem('returnpal_amazon_connected') === 'true';
            const hasPayout = !!(data.latest_payout && data.latest_payout.amount) || (itemsSold > 0);
            const hasPrepCentre = !!(localStorage.getItem('returnpal_prep_name') || '').trim();
            this.updateOnboardingCheckmark('#onboarding-1', packagesSent > 0, 'packages.html');
            this.updateOnboardingCheckmark('#onboarding-2', amazonConnected, null);
            this.updateOnboardingCheckmark('#onboarding-3', hasPayout, 'invoices.html');
            this.updateOnboardingCheckmark('#onboarding-4', hasPrepCentre, 'settings.html');

            // Last updated + refresh
            this._lastOverviewUpdate = Date.now();
            const $lastUpdated = $('#dashboard-last-updated');
            if ($lastUpdated.length) $lastUpdated.text('Data as of just now');
            $('#dashboard-refresh').off('click').on('click', () => {
                const $btn = $('#dashboard-refresh');
                $btn.prop('disabled', true).find('i').addClass('ri-loader-4-line');
                this.loadOverview().finally(() => {
                    $btn.prop('disabled', false).find('i').removeClass('ri-loader-4-line');
                });
            });
            if (!this._overviewAgoInterval && $('#dashboard-last-updated').length) {
                const self = this;
                this._overviewAgoInterval = setInterval(function() {
                    if (!self._lastOverviewUpdate) return;
                    const sec = Math.floor((Date.now() - self._lastOverviewUpdate) / 1000);
                    const $el = $('#dashboard-last-updated');
                    if (!$el.length) return;
                    if (sec < 60) $el.text('Data as of just now');
                    else if (sec < 3600) $el.text('Data as of ' + Math.floor(sec / 60) + ' min ago');
                    else $el.text('Data as of ' + Math.floor(sec / 3600) + ' hr ago');
                }, 60000);
            }

            // Recent activity
            const activities = data.recent_activity || [];
            const $feed = $('#dashboard-activity');
            if ($feed.length) {
                if (activities.length === 0) {
                    $feed.html('<div class="list-group-item border-0 py-5 text-center"><p class="text-muted mb-3">No recent activity. Ship a package or connect your Amazon account to get started.</p><a href="packages.html" class="btn btn-primary btn-sm">Add Package</a></div>');
                } else {
                    $feed.empty();
                    activities.slice(0, 6).forEach(evt => {
                        const time = evt.timestamp ? this.formatTimeAgo(evt.timestamp) : '';
                        const link = evt.link ? (' href="' + evt.link + '"' ) : '';
                        const icon = evt.icon || 'ri-circle-line';
                        $feed.append(
                            '<a class="list-group-item list-group-item-action border-0 py-3 d-flex align-items-start" role="article"' + link + '>' +
                            '<i class="' + icon + ' me-2 mt-1 text-muted"></i>' +
                            '<div class="flex-grow-1"><span class="d-block">' + (evt.message || '') + '</span>' +
                            (time ? '<small class="text-muted">' + time + '</small>' : '') + '</div>' +
                            (evt.cta ? '<span class="badge bg-primary-subtle text-primary">' + evt.cta + '</span>' : '') +
                            '</a>'
                        );
                    });
                }
            }

            // Top items
            const topItems = data.top_items || [];
            const $top = $('#dashboard-top-items');
            if ($top.length) {
                $top.empty();
                if (topItems.length === 0) {
                    $top.append('<li class="text-muted small">No items yet</li>');
                } else {
                    topItems.forEach(item => {
                        const href = 'item-detail.html?id=' + (item.id || '');
                        $top.append(
                            '<li class="d-flex justify-content-between align-items-center py-1">' +
                            '<a href="' + href + '" class="text-body">' + (item.name || item.title || item.reference) + '</a>' +
                            '<span class="rp-label">£' + Number(item.value || 0).toFixed(2) + '</span></li>'
                        );
                    });
                }
            }

            // Latest payout
            const payout = data.latest_payout;
            const $payout = $('#dashboard-payout');
            if ($payout.length) {
                if (!payout) {
                    $payout.html('<span class="text-muted">No payouts yet</span>');
                } else {
                    $payout.html(
                        '<div class="d-flex justify-content-between align-items-center">' +
                        '<span>£' + Number(payout.amount || 0).toFixed(2) + '</span>' +
                        '<span class="badge bg-success-subtle text-success">' + (payout.status || 'Paid') + '</span></div>' +
                        (payout.date ? '<small class="text-muted">' + this.formatDate(payout.date) + '</small>' : '')
                    );
                }
            }

            // Announcements widget
            const $annWidget = $('#dashboard-announcements-widget');
            if ($annWidget.length) {
                const announcements = this.getAnnouncementsData().slice(0, 2);
                if (announcements.length === 0) {
                    $annWidget.html('<span class="text-muted small">No announcements</span>');
                } else {
                    const html = announcements.map(a => {
                        const dateStr = a.date ? new Date(a.date + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
                        const sum = (a.summary || '').slice(0, 60) + ((a.summary || '').length > 60 ? '…' : '');
                        return '<div class="mb-2"><a href="announcements.html" class="text-body small fw-medium">' + (a.title || '') + '</a><br><small class="text-muted">' + dateStr + ' – ' + sum + '</small></div>';
                    }).join('');
                    $annWidget.html(html);
                }
            }
        } catch (err) {
            console.error('Load overview error:', err);
            this.showError($('#dashboard-activity'), err.error || 'Unable to load summary.', () => this.loadOverview());
        }

        $('#dashboard-export-report').off('click').on('click', function() {
            Dashboard.exportReport();
        });
        // First-visit tooltip (once)
        if ($('#dashboard-onboarding-checklist').length && !localStorage.getItem('returnpal_tooltips_seen') && packagesSent === 0) {
            setTimeout(() => {
                Dashboard.showToast('Tip: Add your first package, set up prep centre in Settings, and use Export Report to download data.', 'success');
                localStorage.setItem('returnpal_tooltips_seen', 'true');
            }, 1500);
        }
    },

    exportReport() {
        const self = this;
        API.getDashboardSummary().then(function(data) {
            const rows = [
                ['Metric', 'Value'],
                ['Total Recovered', '£' + Number(data.total_recovered || 0).toFixed(2)],
                ['Items Processing', data.items_processing || 0],
                ['Items Sold', data.items_sold || 0],
                ['Packages Sent', data.packages_sent || 0]
            ];
            const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'returnpal-overview-' + new Date().toISOString().slice(0, 10) + '.csv';
            a.click();
            URL.revokeObjectURL(a.href);
            Dashboard.showToast('Report downloaded');
        }).catch(function() {
            window.location.href = 'analytics.html';
        });
    },

    formatTimeAgo(iso) {
        const d = new Date(iso);
        const now = new Date();
        const sec = Math.floor((now - d) / 1000);
        if (sec < 60) return 'Just now';
        if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
        if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
        if (sec < 604800) return Math.floor(sec / 86400) + 'd ago';
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    },

    // ─── PACKAGES PAGE ───────────────────────────────────────
    _packagesList: null,
    _packagesSort: { key: 'date_added', dir: 'desc' },

    buildPackageRow(pkg) {
        const productsHtml = (pkg.products || []).map(p => {
            const condBadge = p.condition !== 'New' ? '' : ` <span class="badge bg-success-subtle text-success py-1 px-2 fs-12">${p.condition}</span>`;
            return `${p.product_name} <span class="mx-1">x${p.quantity}</span>${condBadge}`;
        }).join(', ');
        const prepSendKey = 'returnpal_prep_send_' + pkg.id;
        const prepSendChecked = localStorage.getItem(prepSendKey) === 'true';
        return `
            <tr class="rp-table-row" data-id="${pkg.id}" data-href="package-detail.html?id=${pkg.id}" tabindex="0" role="button">
                <td>${pkg.reference}</td>
                <td>${productsHtml}</td>
                <td>${pkg.total_qty}</td>
                <td>${this.statusBadge(pkg.status)}</td>
                <td>${this.formatDate(pkg.date_added)}</td>
                <td>${pkg.notes || '-'}</td>
                <td class="text-center">
                    <label class="form-check form-check-sm d-inline-flex align-items-center justify-content-center mb-0" title="Send eligible items to my prep centre for Amazon return">
                        <input type="checkbox" class="form-check-input prep-centre-checkbox" data-id="${pkg.id}" ${prepSendChecked ? 'checked' : ''} />
                        <span class="form-check-label visually-hidden">Send to prep centre</span>
                    </label>
                </td>
                <td>
                    <a href="#" class="edit-pkg" data-id="${pkg.id}" data-bs-toggle="modal" data-bs-target="#editPackage" onclick="event.stopPropagation();"><i class="ri-edit-line fs-18"></i></a>
                </td>
            </tr>
        `;
    },

    renderPackagesSortIcons() {
        const { key, dir } = this._packagesSort;
        $('.rp-sortable').each(function() {
            const $th = $(this);
            const sortKey = $th.data('sort');
            const $icon = $th.find('.rp-sort-icon');
            $th.removeClass('rp-sort-active');
            $icon.removeClass('ri-arrow-up-line ri-arrow-down-line').addClass('ri-arrow-up-down-line opacity-50');
            if (sortKey === key) {
                $th.addClass('rp-sort-active');
                $icon.removeClass('ri-arrow-up-down-line opacity-50').addClass(dir === 'asc' ? 'ri-arrow-up-line' : 'ri-arrow-down-line');
            }
        });
    },

    async loadPackages() {
        const $tbody = $('table tbody');
        if ($tbody.length) $tbody.html('<tr><td colspan="8" class="text-center py-5 text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Loading packages…</td></tr>');
        try {
            const data = await API.getPackages();
            $tbody.empty();
            let list = data.packages || [];

            if (list.length === 0) {
                $tbody.html('<tr><td colspan="8" class="text-center py-5"><p class="text-muted mb-3">No packages yet. Send your first package to start recovering value.</p><a href="#" class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addPackage">Add Package</a></td></tr>');
                if ($('.seco-title').length) $('.seco-title').text('0 packages');
                this._packagesList = [];
                return;
            }

            const searchQuery = (new URLSearchParams(window.location.search).get('search') || '').trim().toLowerCase();
            if (searchQuery) {
                list = list.filter(p => {
                    const ref = (p.reference || '').toLowerCase();
                    const notes = (p.notes || '').toLowerCase();
                    return ref.includes(searchQuery) || notes.includes(searchQuery);
                });
            }
            this._packagesAfterSearch = list.slice();
            const statusFilter = ($('#packages-status-select').val() || '').trim();
            if (statusFilter) list = list.filter(p => (p.status || '') === statusFilter);
            this._packagesList = list;
            const { key, dir } = this._packagesSort;
            const mult = dir === 'asc' ? 1 : -1;
            list.sort((a, b) => {
                let va = a[key], vb = b[key];
                if (key === 'date_added') {
                    va = new Date(va || 0).getTime();
                    vb = new Date(vb || 0).getTime();
                } else if (key === 'reference' || key === 'status') {
                    va = (va || '').toString().toLowerCase();
                    vb = (vb || '').toString().toLowerCase();
                } else if (key === 'total_qty') {
                    va = Number(va) || 0;
                    vb = Number(vb) || 0;
                }
                if (va < vb) return -1 * mult;
                if (va > vb) return 1 * mult;
                return 0;
            });

            const pageSize = 20;
            this._packagesVisible = Math.min(pageSize, list.length);
            list.slice(0, this._packagesVisible).forEach(pkg => $tbody.append(this.buildPackageRow(pkg)));
            const $loadMore = $('#packages-load-more');
            if ($loadMore.length && list.length > this._packagesVisible) {
                $loadMore.removeClass('d-none');
                $('#packages-load-more-btn').off('click').on('click', () => {
                    this._packagesVisible = Math.min(this._packagesVisible + pageSize, this._packagesList.length);
                    $tbody.empty();
                    this._packagesList.slice(0, this._packagesVisible).forEach(pkg => $tbody.append(this.buildPackageRow(pkg)));
                    if (this._packagesVisible >= this._packagesList.length) $loadMore.addClass('d-none');
                    this.renderPackagesSortIcons();
                });
            } else if ($loadMore.length) $loadMore.addClass('d-none');

            const inTransit = (data.packages || []).filter(p => p.status === 'In Transit').length;
            const subText = statusFilter ? (list.length + ' package' + (list.length !== 1 ? 's' : '') + ' (' + statusFilter + ')') : (list.length === (data.packages || []).length ? inTransit + ' package' + (inTransit !== 1 ? 's' : '') + ' in transit' : list.length + ' package' + (list.length !== 1 ? 's' : '') + (searchQuery ? ' matching search' : ''));
            $('.seco-title').text(subText);

            this.renderPackagesSortIcons();
            const self = this;
            $(document).off('click', '.rp-sortable').on('click', '.rp-sortable', function(e) {
                const key = $(e.currentTarget).data('sort');
                if (!key) return;
                if (self._packagesSort.key === key) self._packagesSort.dir = self._packagesSort.dir === 'asc' ? 'desc' : 'asc';
                else self._packagesSort = { key, dir: 'asc' };
                const mult = self._packagesSort.dir === 'asc' ? 1 : -1;
                self._packagesList.sort((a, b) => {
                    let va = a[key], vb = b[key];
                    if (key === 'date_added') { va = new Date(va || 0).getTime(); vb = new Date(vb || 0).getTime(); }
                    else if (key === 'reference' || key === 'status') { va = (va || '').toString().toLowerCase(); vb = (vb || '').toString().toLowerCase(); }
                    else if (key === 'total_qty') { va = Number(va) || 0; vb = Number(vb) || 0; }
                    if (va < vb) return -1 * mult; if (va > vb) return 1 * mult; return 0;
                });
                $tbody.empty();
                self._packagesVisible = Math.min(20, self._packagesList.length);
                self._packagesList.slice(0, self._packagesVisible).forEach(pkg => $tbody.append(self.buildPackageRow(pkg)));
                if ($('#packages-load-more').length) {
                    if (self._packagesList.length > self._packagesVisible) $('#packages-load-more').removeClass('d-none');
                    else $('#packages-load-more').addClass('d-none');
                }
                self.renderPackagesSortIcons();
            });

            $(document).off('change', '#packages-status-select').on('change', '#packages-status-select', () => {
                const statusFilter = ($('#packages-status-select').val() || '').trim();
                let list = (this._packagesAfterSearch || []).slice();
                if (statusFilter) list = list.filter(p => (p.status || '') === statusFilter);
                this._packagesList = list;
                const mult = this._packagesSort.dir === 'asc' ? 1 : -1;
                const key = this._packagesSort.key;
                list.sort((a, b) => {
                    let va = a[key], vb = b[key];
                    if (key === 'date_added') { va = new Date(va || 0).getTime(); vb = new Date(vb || 0).getTime(); }
                    else if (key === 'reference' || key === 'status') { va = (va || '').toString().toLowerCase(); vb = (vb || '').toString().toLowerCase(); }
                    else if (key === 'total_qty') { va = Number(va) || 0; vb = Number(vb) || 0; }
                    if (va < vb) return -1 * mult; if (va > vb) return 1 * mult; return 0;
                });
                $tbody.empty();
                this._packagesVisible = Math.min(20, list.length);
                list.slice(0, this._packagesVisible).forEach(pkg => $tbody.append(this.buildPackageRow(pkg)));
                if ($('#packages-load-more').length) {
                    if (list.length > this._packagesVisible) $('#packages-load-more').removeClass('d-none');
                    else $('#packages-load-more').addClass('d-none');
                }
                $('.seco-title').text(list.length + ' package' + (list.length !== 1 ? 's' : '') + (statusFilter ? ' (' + statusFilter + ')' : ''));
            });
            this.bindPackageEvents();
            $(document).off('click keypress', '.rp-table-row').on('click keypress', '.rp-table-row', function(e) {
                if ($(e.target).closest('.edit-pkg').length) return;
                if ($(e.target).closest('.prep-centre-checkbox').length || $(e.target).closest('label').find('.prep-centre-checkbox').length) return;
                if (e.type === 'keypress' && e.which !== 13) return;
                const href = $(this).data('href');
                if (href) window.location.href = href;
            });
            $(document).off('change', '.prep-centre-checkbox').on('change', '.prep-centre-checkbox', function() {
                const id = $(this).data('id');
                const key = 'returnpal_prep_send_' + id;
                localStorage.setItem(key, $(this).is(':checked'));
            });
        } catch (err) {
            console.error('Load packages error:', err);
            const msg = err.error || 'Unable to load packages.';
            $tbody.html('<tr><td colspan="8" class="text-center py-5"><p class="text-danger mb-2">' + msg + '</p><button type="button" class="btn btn-outline-primary btn-sm">Try again</button></td></tr>');
            $tbody.find('.btn').on('click', () => this.loadPackages());
        }
    },

    bindPackageEvents() {
        const self = this;

        // Edit package - load data into modal
        $(document).on('click', '.edit-pkg', async function(e) {
            e.preventDefault();
            const id = $(this).data('id');
            if (!id) return;
            try {
                const data = await API.getPackage(id);
                const pkg = data && data.package;
                if (!pkg) {
                    alert('Package not found.');
                    return;
                }
                const modal = $('#editPackage');
                modal.find('input[type="text"]').first().val(pkg.reference || '');
                modal.find('textarea').val(pkg.notes || '');
                modal.data('package-id', id);

                const wrapper = modal.find('.product-wrapper');
                wrapper.empty();
                const products = pkg.products || [];
                products.forEach((p, i) => {
                    wrapper.append(self.productRowHtml(p.product_name, p.quantity, p.condition, products.length === 1, p.asin, p.cost_of_goods));
                });
            } catch(err) {
                console.error('Load package for edit:', err);
                alert(err.error || 'Failed to load package.');
            }
        });

        // Save edited package
        $(document).on('click', '#editPackage .btn-primary', async function() {
            const $btn = $(this);
            if ($btn.prop('disabled')) return;
            const modal = $('#editPackage');
            const id = modal.data('package-id');
            if (!id) return alert('Package not found.');
            const reference = modal.find('input[type="text"]').first().val().trim();
            const notes = modal.find('textarea').val().trim();
            const products = self.getProductsFromModal(modal);

            if (!reference || products.length === 0) return alert('Please fill in all required fields.');

            try {
                $btn.prop('disabled', true).text('Saving...');
                await API.updatePackage(id, { reference, notes, products });
                const inst = bootstrap.Modal.getInstance(modal[0]);
                if (inst) inst.hide();
                self.loadPackages();
            } catch(err) {
                alert(err.error || 'Failed to update package.');
            } finally {
                $btn.prop('disabled', false).text('Save changes');
            }
        });

        // Delete package
        $(document).on('click', '#editPackage .btn-danger', async function() {
            const $btn = $(this);
            if ($btn.prop('disabled')) return;
            const id = $('#editPackage').data('package-id');
            if (!id) return;
            if (!confirm('Are you sure you want to delete this package?')) return;

            try {
                $btn.prop('disabled', true);
                await API.deletePackage(id);
                const inst = bootstrap.Modal.getInstance($('#editPackage')[0]);
                if (inst) inst.hide();
                self.loadPackages();
            } catch(err) {
                alert(err.error || 'Failed to delete package.');
            } finally {
                $btn.prop('disabled', false);
            }
        });

        // Add new package
        $(document).on('click', '#addPackage .btn-primary', async function() {
            const $btn = $(this);
            if ($btn.prop('disabled')) return;
            const modal = $('#addPackage');
            const reference = modal.find('input[type="text"]').first().val().trim();
            const notes = modal.find('textarea').val().trim();
            const products = self.getProductsFromModal(modal);

            if (!reference || products.length === 0) return alert('Please fill in a reference and at least one product.');

            try {
                $btn.prop('disabled', true).text('Saving...');
                await API.createPackage({ reference, products, notes });
                const inst = bootstrap.Modal.getInstance(modal[0]);
                if (inst) inst.hide();
                modal.find('input[type="text"], .rp-product-asin, .rp-product-cost').val('');
                modal.find('textarea').val('');
                modal.find('.product-wrapper').html(self.productRowHtml('', 1, 'New', true, '', ''));
                self.loadPackages();
            } catch(err) {
                alert(err.error || 'Failed to create package.');
            } finally {
                $btn.prop('disabled', false).text('Add Package');
            }
        });

        // Bulk upload
        $(document).on('click', '#bulkUpload .btn-primary', async function() {
            const $btn = $(this);
            if ($btn.prop('disabled')) return;
            const fileInput = $('#bulkUpload input[type="file"]')[0];
            if (!fileInput || !fileInput.files || !fileInput.files[0]) {
                return alert('Please select a file first.');
            }

            try {
                $btn.prop('disabled', true).text('Uploading...');
                const result = await API.uploadPackages(fileInput.files[0]);
                alert(result.message || 'Upload complete.');
                const inst = bootstrap.Modal.getInstance($('#bulkUpload')[0]);
                if (inst) inst.hide();
                self.loadPackages();
            } catch(err) {
                alert(err.error || 'Upload failed.');
            } finally {
                $btn.prop('disabled', false).text('Upload');
            }
        });

        // Download template
        $(document).on('click', '#bulkUpload .btn-success', function(e) {
            e.preventDefault();
            window.location.href = '/api/upload/template?token=' + API.getToken();
        });
    },

    productRowHtml(name, qty, condition, disableRemove, asin, cost) {
        return `
        <div class="product-row bg-light rounded p-2 grid grid-cols-12 gap-2 align-items-end mb-1">
            <div class="g-col-5 space-y-1">
                <label class="form-label">Product Name / SKU</label>
                <input type="text" class="form-control rp-product-name" placeholder="e.g., iPhone Case" value="${name || ''}">
                <label class="form-label mt-1">ASIN (optional)</label>
                <input type="text" class="form-control rp-product-asin" placeholder="e.g., B0C1234567" value="${asin || ''}">
                <label class="form-label mt-1">Cost of goods (£, optional)</label>
                <input type="number" step="0.01" min="0" class="form-control rp-product-cost" placeholder="e.g., 12.50" value="${cost != null && cost !== '' ? cost : ''}">
            </div>
            <div class="g-col-2 space-y-1">
                <label class="form-label">Qty</label>
                <input type="number" class="form-control rp-product-qty" value="${qty || 1}" min="1">
            </div>
            <div class="g-col-4 space-y-1">
                <label class="form-label">Condition</label>
                <select class="form-select rp-product-condition">
                    <option${condition === 'New' ? ' selected' : ''}>New</option>
                    <option${condition === 'Used' ? ' selected' : ''}>Used</option>
                    <option${condition === 'Return' ? ' selected' : ''}>Return</option>
                    <option${condition === 'Return Review' ? ' selected' : ''}>Return Review</option>
                </select>
            </div>
            <div class="g-col-1 d-flex justify-content-end">
                <button class="btn btn-sm btn-light remove-row"${disableRemove ? ' disabled' : ''}>
                    <i class="ri-delete-bin-line fs-18"></i>
                </button>
            </div>
        </div>`;
    },

    getProductsFromModal(modal) {
        const products = [];
        modal.find('.product-row').each(function() {
            const name = $(this).find('.rp-product-name').val().trim();
            const asin = $(this).find('.rp-product-asin').val().trim();
            const qty = parseInt($(this).find('.rp-product-qty').val(), 10) || 1;
            const condition = $(this).find('.rp-product-condition').val();
            const costStr = $(this).find('.rp-product-cost').val().trim();
            const costNum = costStr ? Number(costStr) : null;
            const cost = costNum != null && !isNaN(costNum) && costNum >= 0 ? costNum : null;
            if (name) {
                const product = { product_name: name, quantity: qty, condition: condition };
                if (asin) product.asin = asin;
                if (cost != null) product.cost_of_goods = cost;
                products.push(product);
            }
        });
        return products;
    },

    // ─── RECEIVED PAGE ───────────────────────────────────────
    _receivedSort: { key: 'date_received', dir: 'desc' },
    buildReceivedRow(item) {
        const photos = item.photos || [];
        const photosHtml = photos.length ? photos.slice(0, 2).map((url, idx) => '<a href="' + url + '" target="_blank" rel="noopener" class="d-inline-block me-1"><img src="' + url + '" alt="Condition ' + (idx + 1) + '" width="40" height="30" class="rounded border object-fit-cover" /></a>').join('') + (photos.length > 2 ? ' <small class="text-muted">+' + (photos.length - 2) + '</small>' : '') : '<span class="text-muted">-</span>';
        return '<tr><td>' + (item.reference || '') + '</td><td>' + (item.items_description || '') + '</td><td>' + (item.quantity || '') + '</td><td>' + this.statusBadge(item.status) + '</td><td>' + this.formatDate(item.date_received) + '</td><td>' + photosHtml + '</td><td>' + (item.notes || '-') + '</td></tr>';
    },
    async loadReceived() {
        const $tbody = $('table tbody');
        if ($tbody.length) $tbody.html('<tr><td colspan="7" class="text-center py-5 text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</td></tr>');
        try {
            const data = await API.getReceived();
            $tbody.empty();
            $('.seco-title').text(data.total + ' Total Received');

            if (!data.items || data.items.length === 0) {
                $tbody.html('<tr><td colspan="7" class="text-center py-5"><p class="text-muted mb-3">No received items yet. Add a package and we’ll list it here once it arrives.</p><a href="packages.html" class="btn btn-primary">Go to Packages</a></td></tr>');
                return;
            }

            const raw = data.items || [];
            this._receivedListFull = raw;
            const searchQ = ($('#received-search').val() || '').trim().toLowerCase();
            const searchBy = ($('#received-search-by').val() || 'all').toLowerCase();
            let list = raw.slice();
            if (searchQ) {
                if (searchBy === 'reference') list = list.filter(i => String(i.reference || '').toLowerCase().includes(searchQ));
                else if (searchBy === 'items_description') list = list.filter(i => String(i.items_description || '').toLowerCase().includes(searchQ));
                else if (searchBy === 'status') list = list.filter(i => String(i.status || '').toLowerCase().includes(searchQ));
                else if (searchBy === 'notes') list = list.filter(i => String(i.notes || '').toLowerCase().includes(searchQ));
                else list = list.filter(i => (String(i.reference || '').toLowerCase() + ' ' + (i.items_description || '').toLowerCase() + ' ' + (i.status || '').toLowerCase() + ' ' + (i.notes || '').toLowerCase()).includes(searchQ));
            }
            const { key, dir } = this._receivedSort;
            const mult = dir === 'asc' ? 1 : -1;
            list.sort((a, b) => {
                let va = a[key], vb = b[key];
                if (key === 'date_received') { va = new Date(va || 0).getTime(); vb = new Date(vb || 0).getTime(); }
                else if (key === 'reference' || key === 'status') { va = String(va || '').toLowerCase(); vb = String(vb || '').toLowerCase(); }
                else if (key === 'quantity') { va = Number(va) || 0; vb = Number(vb) || 0; }
                if (va < vb) return -1 * mult; if (va > vb) return 1 * mult; return 0;
            });
            this._receivedListFiltered = list;
            const pageSize = 20;
            this._receivedVisible = Math.min(pageSize, list.length);
            const toShow = list.slice(0, this._receivedVisible);
            toShow.forEach(item => $tbody.append(this.buildReceivedRow(item)));
            const $loadMore = $('#received-load-more');
            if ($loadMore.length) {
                if (list.length > this._receivedVisible) {
                    $loadMore.removeClass('d-none');
                    $('#received-load-more-btn').off('click').on('click', () => {
                        this._receivedVisible = Math.min(this._receivedVisible + pageSize, this._receivedListFiltered.length);
                        $tbody.empty();
                        this._receivedListFiltered.slice(0, this._receivedVisible).forEach(item => $tbody.append(this.buildReceivedRow(item)));
                        if (this._receivedVisible >= this._receivedListFiltered.length) $loadMore.addClass('d-none');
                        this.renderReceivedSortIcons();
                    });
                } else $loadMore.addClass('d-none');
            }
            $('.seco-title').text(list.length + ' Total Received' + (searchQ ? ' (filtered)' : ''));
            this.renderReceivedSortIcons();
            $(document).off('input', '#received-search').on('input', '#received-search', () => this.loadReceived());
            $(document).off('click', '#received-table .rp-sortable').on('click', '#received-table .rp-sortable', (e) => {
                const key = $(e.currentTarget).data('sort');
                if (!key) return;
                if (this._receivedSort.key === key) this._receivedSort.dir = this._receivedSort.dir === 'asc' ? 'desc' : 'asc';
                else this._receivedSort = { key, dir: 'asc' };
                this.loadReceived();
            });
        } catch(err) {
            console.error('Load received error:', err);
            const msg = err.error || 'Unable to load received items.';
            $tbody.html('<tr><td colspan="7" class="text-center py-5"><p class="text-danger mb-2">' + msg + '</p><button type="button" class="btn btn-outline-primary btn-sm">Try again</button></td></tr>');
            $tbody.find('.btn').on('click', () => this.loadReceived());
        }
    },
    renderReceivedSortIcons() {
        const $thead = $('#received-table thead');
        if (!$thead.length) return;
        const { key, dir } = this._receivedSort || { key: 'date_received', dir: 'desc' };
        $thead.find('.rp-sortable').each(function() {
            const $th = $(this);
            const sortKey = $th.data('sort');
            const $icon = $th.find('.rp-sort-icon');
            $th.removeClass('rp-sort-active');
            $icon.removeClass('ri-arrow-up-line ri-arrow-down-line').addClass('ri-arrow-up-down-line opacity-50');
            if (sortKey === key) {
                $th.addClass('rp-sort-active');
                $icon.removeClass('ri-arrow-up-down-line opacity-50').addClass(dir === 'asc' ? 'ri-arrow-up-line' : 'ri-arrow-down-line');
            }
        });
    },

    // ─── SOLD ITEMS PAGE ─────────────────────────────────────
    recoveryRouteBadge(route, status, damageNote) {
        const r = (route || 'Resale').toLowerCase();
        const s = (status || '').toLowerCase();
        if (r === 'not recoverable' || route === 'Not recoverable') {
            const reason = damageNote || 'No recovery';
            return '<span class="badge bg-secondary-subtle text-secondary py-1 px-2 fs-12" title="Condition / damage note">' + reason + '</span>';
        }
        const isReimb = r === 'reimbursement';
        const label = isReimb ? 'Reimbursement' : 'Resale';
        const sub = (isReimb && (s === 'reimbursed' || status === 'Reimbursed')) ? 'Reimbursed' : (isReimb ? 'In progress' : (s === 'sold' || status === 'Sold' ? 'Sold' : status || '-'));
        const cls = isReimb ? 'info' : 'success';
        return '<span class="badge bg-' + cls + '-subtle text-' + cls + ' py-1 px-2 fs-12" title="Recovery route">' + label + ' – ' + sub + '</span>';
    },
    async loadSold() {
        const $tbody = $('table tbody');
        if ($tbody.length) $tbody.html('<tr><td colspan="10" class="text-center py-5 text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</td></tr>');
        try {
            const data = await API.getSold();
            const filter = $('#sold-recovery-filter').val() || '';

            // Update stat cards (use filtered count for display if filtering)
            let items = data.items || [];
            if (filter === 'resale_sold') items = items.filter(i => (i.recovery_route || 'Resale') === 'Resale' && (i.recovery_status || 'Sold') === 'Sold');
            else if (filter === 'reimbursement_reimbursed') items = items.filter(i => (i.recovery_route || '') === 'Reimbursement' && (i.recovery_status || '') === 'Reimbursed');
            else if (filter === 'not_recoverable') items = items.filter(i => (i.recovery_route || '') === 'Not recoverable');
            const soldSearch = ($('#sold-search').val() || '').trim().toLowerCase();
            const soldSearchBy = ($('#sold-search-by').val() || 'all').toLowerCase();
            if (soldSearch) {
                if (soldSearchBy === 'reference') items = items.filter(i => String(i.reference || '').toLowerCase().includes(soldSearch));
                else if (soldSearchBy === 'product') items = items.filter(i => String(i.product || '').toLowerCase().includes(soldSearch));
                else if (soldSearchBy === 'asin') items = items.filter(i => String(i.asin || '').toLowerCase().includes(soldSearch));
                else items = items.filter(i => (String(i.reference || '') + ' ' + (i.product || '') + ' ' + (i.asin || '')).toLowerCase().includes(soldSearch));
            }
            const cards = $('.card-body h3');
            if (data.stats && !filter) {
                $(cards[0]).text('£' + Number(data.stats.total_earnings).toFixed(2));
                $(cards[1]).text(data.stats.items_sold);
                $(cards[2]).text('£' + Number(data.stats.avg_earnings).toFixed(2));
                $(cards[3]).text(Number(data.stats.avg_margin).toFixed(2) + '%');
            } else if (items.length) {
                const tot = items.reduce((s, i) => s + (Number(i.profit) || 0), 0);
                const qty = items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
                $(cards[0]).text('£' + tot.toFixed(2));
                $(cards[1]).text(qty);
                $(cards[2]).text(qty ? '£' + (tot / qty).toFixed(2) : '£0.00');
                $(cards[3]).text(items.length ? Number(items[0].margin || 0).toFixed(2) + '%' : '0%');
            }

            $tbody.empty();
            $('.seco-title').text(items.length + ' Total Sold' + (filter || soldSearch ? ' (filtered)' : ''));

            if (items.length === 0) {
                $tbody.html('<tr><td colspan="10" class="text-center py-5"><p class="text-muted mb-3">No sold items match this filter. Change the recovery route filter or send more packages.</p><a href="packages.html" class="btn btn-primary">Send packages</a></td></tr>');
                return;
            }

            this._soldListFiltered = items;
            const pageSize = 20;
            this._soldVisible = Math.min(pageSize, items.length);
            const toShow = items.slice(0, this._soldVisible);
            toShow.forEach(item => {
                $tbody.append(`
                    <tr>
                        <td>${item.reference}</td>
                        <td>${item.product}</td>
                        <td>${item.quantity}</td>
                        <td>£${Number(item.unit_price).toFixed(2)}</td>
                        <td class="text-success">£${Number(item.total_revenue).toFixed(2)}</td>
                        <td class="text-success">£${Number(item.profit).toFixed(2)}</td>
                        <td class="text-primary">${Number(item.margin).toFixed(0)}%</td>
                        <td>${this.recoveryRouteBadge(item.recovery_route, item.recovery_status, item.damage_note)}</td>
                        <td>${this.formatDate(item.sold_date)}</td>
                        <td>${this.statusBadge(item.status)}</td>
                    </tr>
                `);
            });
            const $loadMore = $('#sold-load-more');
            if ($loadMore.length && items.length > this._soldVisible) {
                $loadMore.removeClass('d-none');
                $('#sold-load-more-btn').off('click').on('click', () => {
                    this._soldVisible = Math.min(this._soldVisible + pageSize, this._soldListFiltered.length);
                    $tbody.empty();
                    this._soldListFiltered.slice(0, this._soldVisible).forEach(item => {
                        $tbody.append(`
                            <tr>
                                <td>${item.reference}</td>
                                <td>${item.product}</td>
                                <td>${item.quantity}</td>
                                <td>£${Number(item.unit_price).toFixed(2)}</td>
                                <td class="text-success">£${Number(item.total_revenue).toFixed(2)}</td>
                                <td class="text-success">£${Number(item.profit).toFixed(2)}</td>
                                <td class="text-primary">${Number(item.margin).toFixed(0)}%</td>
                                <td>${this.recoveryRouteBadge(item.recovery_route, item.recovery_status, item.damage_note)}</td>
                                <td>${this.formatDate(item.sold_date)}</td>
                                <td>${this.statusBadge(item.status)}</td>
                            </tr>
                        `);
                    });
                    if (this._soldVisible >= this._soldListFiltered.length) $loadMore.addClass('d-none');
                });
            } else if ($loadMore.length) $loadMore.addClass('d-none');
        } catch(err) {
            console.error('Load sold error:', err);
            const msg = err.error || 'Unable to load sold items.';
            $tbody.html('<tr><td colspan="10" class="text-center py-5"><p class="text-danger mb-2">' + msg + '</p><button type="button" class="btn btn-outline-primary btn-sm">Try again</button></td></tr>');
            $tbody.find('.btn').on('click', () => this.loadSold());
        }
    },

    // ─── PENDING ITEMS PAGE ──────────────────────────────────
    async loadPending() {
        const $tbody = $('table tbody');
        if ($tbody.length) $tbody.html('<tr><td colspan="8" class="text-center py-5 text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</td></tr>');
        try {
            const data = await API.getPending();
            const filter = $('#pending-recovery-filter').val() || '';
            let items = data.items || [];
            if (filter === 'resale') items = items.filter(i => (i.recovery_route || 'Resale') === 'Resale');
            else if (filter === 'reimbursement') items = items.filter(i => (i.recovery_route || '') === 'Reimbursement');
            const pendingSearch = ($('#pending-search').val() || '').trim().toLowerCase();
            const pendingSearchBy = ($('#pending-search-by').val() || 'all').toLowerCase();
            if (pendingSearch) {
                if (pendingSearchBy === 'reference') items = items.filter(i => String(i.reference || '').toLowerCase().includes(pendingSearch));
                else if (pendingSearchBy === 'product') items = items.filter(i => String(i.product || '').toLowerCase().includes(pendingSearch));
                else if (pendingSearchBy === 'asin') items = items.filter(i => String(i.asin || '').toLowerCase().includes(pendingSearch));
                else items = items.filter(i => (String(i.reference || '') + ' ' + (i.product || '') + ' ' + (i.asin || '')).toLowerCase().includes(pendingSearch));
            }

            const cards = $('.card-body h3');
            if (data.stats && !filter) {
                $(cards[0]).text(data.stats.pending_count);
                $(cards[1]).text(data.stats.total_quantity);
                $(cards[2]).text(data.stats.oldest_date ? this.formatDate(data.stats.oldest_date) : '--');
            } else {
                $(cards[0]).text(items.length);
                $(cards[1]).text(items.reduce((s, i) => s + (Number(i.quantity) || 0), 0));
                const oldest = items.length ? items.map(i => i.received_date).sort()[0] : null;
                $(cards[2]).text(oldest ? this.formatDate(oldest) : '--');
            }

            $tbody.empty();
            $('.seco-title').text(items.length + ' Items Pending' + (filter || pendingSearch ? ' (filtered)' : ''));

            if (items.length === 0) {
                $tbody.html('<tr><td colspan="8" class="text-center py-5"><p class="text-muted mb-3">No pending items match this filter. Change the recovery route filter or view received packages.</p><a href="received.html" class="btn btn-primary">View Received</a></td></tr>');
                return;
            }

            this._pendingListFiltered = items;
            const pageSize = 20;
            this._pendingVisible = Math.min(pageSize, items.length);
            const toShow = items.slice(0, this._pendingVisible);
            toShow.forEach(item => {
                $tbody.append(`
                    <tr>
                        <td>${item.reference}</td>
                        <td>${item.product}</td>
                        <td>${item.quantity}</td>
                        <td>${this.formatDate(item.received_date)}</td>
                        <td>${this.recoveryRouteBadge(item.recovery_route, item.recovery_status)}</td>
                        <td>${this.statusBadge(item.current_stage)}</td>
                        <td>${this.formatDate(item.est_completion)}</td>
                        <td>${item.notes || '-'}</td>
                    </tr>
                `);
            });
            const $loadMore = $('#pending-load-more');
            if ($loadMore.length && items.length > this._pendingVisible) {
                $loadMore.removeClass('d-none');
                $('#pending-load-more-btn').off('click').on('click', () => {
                    this._pendingVisible = Math.min(this._pendingVisible + pageSize, this._pendingListFiltered.length);
                    $tbody.empty();
                    this._pendingListFiltered.slice(0, this._pendingVisible).forEach(item => {
                        $tbody.append(`
                            <tr>
                                <td>${item.reference}</td>
                                <td>${item.product}</td>
                                <td>${item.quantity}</td>
                                <td>${this.formatDate(item.received_date)}</td>
                                <td>${this.recoveryRouteBadge(item.recovery_route, item.recovery_status)}</td>
                                <td>${this.statusBadge(item.current_stage)}</td>
                                <td>${this.formatDate(item.est_completion)}</td>
                                <td>${item.notes || '-'}</td>
                            </tr>
                        `);
                    });
                    if (this._pendingVisible >= this._pendingListFiltered.length) $loadMore.addClass('d-none');
                });
            } else if ($loadMore.length) $loadMore.addClass('d-none');
        } catch(err) {
            console.error('Load pending error:', err);
            const msg = err.error || 'Unable to load pending items.';
            $tbody.html('<tr><td colspan="8" class="text-center py-5"><p class="text-danger mb-2">' + msg + '</p><button type="button" class="btn btn-outline-primary btn-sm">Try again</button></td></tr>');
            $tbody.find('.btn').on('click', () => this.loadPending());
        }
    },

    // ─── INVOICES PAGE ───────────────────────────────────────
    async loadInvoices() {
        const $tbody = $('table tbody');
        if ($tbody.length) $tbody.html('<tr><td colspan="7" class="text-center py-5 text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</td></tr>');
        try {
            const data = await API.getInvoices();
            $tbody.empty();

            const rawInvoices = data.invoices || [];
            if (rawInvoices.length === 0) {
                $('.seco-title').text('0 invoices');
                $tbody.html('<tr><td colspan="7" class="text-center py-5"><p class="text-muted mb-3">No invoices yet. Monthly invoices appear here after you have sales.</p><a href="sold-items.html" class="btn btn-primary">View Sold Items</a></td></tr>');
                return;
            }

            // Group by month (one invoice per month): key = "YYYY-MM"
            const byMonth = {};
            const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            rawInvoices.forEach(inv => {
                const dateStr = inv.date_issued || inv.due_date || inv.sold_date;
                const d = dateStr ? new Date(dateStr) : new Date();
                const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
                if (!byMonth[key]) {
                    const payoutDate = new Date(d.getFullYear(), d.getMonth() + 2, 0);
                    byMonth[key] = {
                        key,
                        year: d.getFullYear(),
                        month: d.getMonth(),
                        amount: 0,
                        items_count: 0,
                        vat_amount: 0,
                        status: inv.status,
                        date_issued: dateStr,
                        payout_date: payoutDate
                    };
                }
                byMonth[key].amount += Number(inv.amount) || 0;
                byMonth[key].items_count += Number(inv.items_count) || 0;
                byMonth[key].vat_amount += Number(inv.vat_amount) || 0;
                if (inv.status === 'Pending' || inv.status === 'Overdue') byMonth[key].status = inv.status;
            });

            let monthly = Object.values(byMonth).sort((a, b) => {
                return (b.year - a.year) || (b.month - a.month);
            });

            const range = $('#invoices-date-range').val() || 'all';
            const now = Date.now();
            const day = 24 * 60 * 60 * 1000;
            if (range === '7') monthly = monthly.filter(m => m.payout_date && (now - new Date(m.payout_date).getTime()) <= 7 * day);
            if (range === '30') monthly = monthly.filter(m => m.payout_date && (now - new Date(m.payout_date).getTime()) <= 30 * day);

            window._lastInvoicesData = monthly;
            $('.seco-title').text(monthly.length + ' invoice' + (monthly.length !== 1 ? 's' : ''));

            const totalVat = monthly.reduce((s, m) => s + (Number(m.vat_amount) || 0), 0);
            const $vatSummary = $('#invoices-vat-summary');
            if ($vatSummary.length) {
                $('#invoices-vat-amount').text('£' + totalVat.toFixed(2));
                $vatSummary.toggleClass('d-none', monthly.length === 0);
            }

            monthly.forEach(m => {
                const periodLabel = monthNames[m.month] + ' ' + m.year;
                $tbody.append(`
                    <tr>
                        <td><strong>${periodLabel}</strong></td>
                        <td>${this.formatDate(m.date_issued)}</td>
                        <td>${this.formatDate(m.payout_date)}</td>
                        <td class="text-success">£${Number(m.amount).toFixed(2)}</td>
                        <td>${m.items_count}</td>
                        <td>${this.statusBadge(m.status)}</td>
                        <td class="text-center">
                            <button type="button" class="btn btn-link btn-sm p-0 text-primary invoice-download-btn" data-period="${m.key}" title="Download invoice (print)"><i class="ri-download-2-fill fs-18"></i></button>
                        </td>
                    </tr>
                `);
            });
            $tbody.find('.invoice-download-btn').on('click', function() {
                const period = $(this).data('period');
                if (period) Dashboard.downloadInvoiceMonth(period);
            });
        } catch(err) {
            console.error('Load invoices error:', err);
            const msg = err.error || 'Unable to load invoices.';
            $tbody.html('<tr><td colspan="7" class="text-center py-5"><p class="text-danger mb-2">' + msg + '</p><button type="button" class="btn btn-outline-primary btn-sm">Try again</button></td></tr>');
            $tbody.find('.btn').on('click', () => this.loadInvoices());
        }
    },

    // ─── REFERRALS PAGE ───────────────────────────────────────
    async loadReferrals() {
        const $tbody = $('#referrals-tbody');
        if (!$tbody.length) return;
        try {
            const data = await API.getReferrals();
            const list = data.referrals || [];
            const totalEarned = data.total_earned != null ? data.total_earned : list.reduce((s, r) => s + (Number(r.earned) || 0), 0);
            const signedUp = list.filter(r => r.status === 'Signed up' || r.status === 'Active').length;
            const active = list.filter(r => r.status === 'Active').length;

            $('#referrals-total').text(list.length);
            $('#referrals-signed-up').text(signedUp);
            $('#referrals-active').text(active);
            $('#referrals-earned').text('£' + Number(totalEarned).toFixed(2));
            const link = data.referral_link || '';
            const $input = $('#referral-link-input');
            if ($input.length && link) $input.val(link);

            // Tiered rewards: show current tier, reward per referral, next tier hint
            const tiers = data.tiers || [
                { min_active: 1, max_active: 5, reward_per_referral: 10, label: 'Tier 1' },
                { min_active: 6, max_active: 10, reward_per_referral: 15, label: 'Tier 2' },
                { min_active: 11, max_active: null, reward_per_referral: 20, label: 'Tier 3' }
            ];
            let currentTier = data.current_tier || null;
            if (!currentTier && tiers.length) {
                for (let i = tiers.length - 1; i >= 0; i--) {
                    if (active >= tiers[i].min_active && (tiers[i].max_active == null || active <= tiers[i].max_active)) {
                        currentTier = tiers[i];
                        break;
                    }
                }
                if (!currentTier) currentTier = tiers[0];
            }
            const tierIdx = currentTier ? tiers.findIndex(t => t.label === currentTier.label) : 0;
            const nextTier = data.next_tier || (tierIdx >= 0 && tierIdx < tiers.length - 1 ? tiers[tierIdx + 1] : null);
            const activeRequired = nextTier ? (nextTier.active_required != null ? nextTier.active_required : Math.max(0, (nextTier.min_active || 0) - active)) : 0;

            $('#referrals-tier-label').text(currentTier ? currentTier.label : '-');
            $('#referrals-tier-reward').text(currentTier ? '£' + (currentTier.reward_per_referral || 0) + ' per active referral' : '£0 per active referral');
            if (nextTier && activeRequired > 0) {
                $('#referrals-tier-next').text(activeRequired + ' more active referral' + (activeRequired !== 1 ? 's' : '') + ' to reach ' + (nextTier.label || 'next tier') + ' (£' + (nextTier.reward_per_referral || 0) + ' per referral).').removeClass('d-none');
            } else if (currentTier && tierIdx >= tiers.length - 1) {
                $('#referrals-tier-next').text('You’re in the top tier. Keep referring to earn £' + (currentTier.reward_per_referral || 0) + ' per active referral.').removeClass('d-none');
            } else {
                $('#referrals-tier-next').addClass('d-none').text('');
            }
            const $breakdown = $('#referrals-tier-breakdown');
            if ($breakdown.length && tiers.length) {
                $breakdown.html(tiers.map(t => {
                    const range = t.max_active != null ? (t.min_active + '–' + t.max_active) : (t.min_active + '+');
                    return '<span class="d-inline-block me-3">' + (t.label || '') + ' (' + range + ' active): £' + (t.reward_per_referral || 0) + ' each</span>';
                }).join(''));
            }

            $tbody.empty();
            if (list.length === 0) {
                $tbody.html('<tr><td colspan="4" class="text-center py-5 text-muted">No referrals yet. Use "Refer a seller" or share your referral link.</td></tr>');
            } else {
                list.forEach(r => {
                    const date = r.referred_at ? new Date(r.referred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '-';
                    const statusClass = r.status === 'Active' ? 'success' : r.status === 'Signed up' ? 'info' : 'secondary';
                    const earned = r.earned != null ? '£' + Number(r.earned).toFixed(2) : '-';
                    $tbody.append(
                        '<tr><td>' + (r.email || '-') + '</td><td>' + date + '</td><td><span class="badge bg-' + statusClass + '-subtle text-' + statusClass + '">' + (r.status || 'Pending') + '</span></td><td class="text-end">' + earned + '</td></tr>'
                    );
                });
            }

            $('#referral-link-copy').off('click').on('click', function() {
                const input = document.getElementById('referral-link-input');
                if (input) {
                    input.select();
                    navigator.clipboard.writeText(input.value).then(() => {
                        const $btn = $(this);
                        const orig = $btn.html();
                        $btn.html('<i class="ri-check-line"></i>');
                        setTimeout(() => $btn.html(orig), 1500);
                    });
                }
            });
        } catch (err) {
            console.error('Load referrals error:', err);
            $tbody.html('<tr><td colspan="4" class="text-center py-5"><p class="text-danger mb-2">' + (err.error || 'Unable to load referrals.') + '</p><button type="button" class="btn btn-outline-primary btn-sm">Try again</button></td></tr>');
            $tbody.find('.btn').on('click', () => this.loadReferrals());
        }
    },

    // ─── ROI REPORT PAGE ─────────────────────────────────────
    async loadRoiReport() {
        const $content = $('#roi-report-content');
        if (!$content.length) return;
        const range = $('#roi-report-date-range').val() || 'current_month';
        let params = {};
        if (range === '7' || range === '30' || range === '90') {
            const days = parseInt(range, 10);
            const end = new Date();
            const start = new Date(); start.setDate(start.getDate() - days);
            params = { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
        } else if (range === 'custom') {
            const from = $('#roi-report-from').val();
            const to = $('#roi-report-to').val();
            if (from) params.from = from;
            if (to) params.to = to;
        }
        try {
            const data = await API.getRoiReport(params);
            const fmt = (n) => '£' + Number(n).toFixed(2);
            const periodStart = data.period_start ? new Date(data.period_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
            const periodEnd = data.period_end ? new Date(data.period_end).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
            $('#roi-period-text').text(periodStart && periodEnd ? periodStart + ' – ' + periodEnd : (data.period_start || '') + ' – ' + (data.period_end || ''));
            $('#roi-cost-sent').text(fmt(data.cost_value_sent || 0));
            $('#roi-recovered').text(fmt(data.recovered || 0));
            $('#roi-you-kept').text(fmt(data.you_kept || 0));
            $('#roi-fees').text(fmt(data.fees || 0));
            $('#roi-hours-saved').text((data.estimated_hours_saved != null ? data.estimated_hours_saved : 0) + ' hrs');
            $('#roi-recovery-rate').text(Number(data.recovery_rate_pct || 0).toFixed(1) + '%');
            $('#roi-category-avg').text(Number(data.category_avg_pct || 0).toFixed(0) + '%');
            const top = data.top_items || [];
            const $top = $('#roi-top-items');
            $top.empty();
            if (top.length === 0) $top.append('<li class="text-muted">No items this period</li>');
            else top.forEach(i => $top.append('<li class="py-1">' + (i.name || '') + ' – ' + fmt(i.recovered) + ' recovered, ' + fmt(i.you_kept) + ' to you</li>'));
            const noRec = data.no_recovery_items || [];
            const $noRec = $('#roi-no-recovery');
            $noRec.empty();
            if (noRec.length === 0) $noRec.append('<li class="text-muted">None</li>');
            else noRec.forEach(i => $noRec.append('<li class="py-1">' + (i.name || '') + (i.reason ? ' <span class="text-muted">– ' + i.reason + '</span>' : '') + (i.note ? ' <small class="text-muted">(' + i.note + ')</small>' : '') + '</li>'));
            $('#roi-report-download-pdf').off('click').on('click', () => window.print());
        } catch (err) {
            console.error('Load ROI report error:', err);
            $('#roi-period-text').text('Unable to load report.');
            $('#roi-cost-sent,#roi-recovered,#roi-you-kept').text('-');
        }
        $('#roi-report-date-range').off('change').on('change', function() {
            $('#roi-report-custom-dates').toggleClass('d-none', $(this).val() !== 'custom').addClass('d-flex');
        });
        $('#roi-report-apply-custom').off('click').on('click', () => this.loadRoiReport());
    },

    // ─── ANNOUNCEMENTS ───────────────────────────────────────
    getAnnouncementsData() {
        return [
            { id: 'ann-1', title: 'Update return address', date: '2026-03-10', summary: 'You can now update your default return address in Settings → Billing. We’ll use it for all new shipments unless you override per package.', body: 'You can now update your default return address in Settings → Billing. We’ll use it for all new shipments unless you override per package. This helps keep labels correct when you move or use a different warehouse.' },
            { id: 'ann-2', title: 'Shipments page update', date: '2026-03-05', summary: 'The Received and Packages pages now support search by reference, product, and status. Use the new filters to find items faster.', body: 'The Received and Packages pages now support search by reference, product, and status. Use the new filters to find items faster. We’ve also added pagination so long lists stay responsive.' },
            { id: 'ann-3', title: 'Announcements feed', date: '2026-03-01', summary: 'New Announcements page: address changes, new features, and operational reminders in one place so you don’t rely only on email.', body: 'New Announcements page: address changes, new features, and operational reminders in one place so you don’t rely only on email. Check the sidebar for the latest updates.' }
        ];
    },
    getUnreadAnnouncementsCount() {
        const announcements = this.getAnnouncementsData();
        let readIds = [];
        try { readIds = JSON.parse(localStorage.getItem('returnpal_announcements_read') || '[]'); } catch (e) {}
        return announcements.filter(a => !readIds.includes(a.id)).length;
    },
    markAllAnnouncementsRead() {
        const announcements = this.getAnnouncementsData();
        const ids = announcements.map(a => a.id);
        localStorage.setItem('returnpal_announcements_read', JSON.stringify(ids));
        this.updateNotificationDots();
    },
    async loadAnnouncements() {
        const $feed = $('#announcements-feed');
        if (!$feed.length) return;
        $feed.html('<div class="list-group-item border-0 py-4 text-muted text-center"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</div>');
        const announcements = this.getAnnouncementsData();
        this.markAllAnnouncementsRead();
        $feed.empty();
        if (announcements.length === 0) {
            $feed.html('<div class="list-group-item border-0 py-5 text-center"><p class="text-muted mb-0">No announcements yet.</p></div>');
            return;
        }
        announcements.forEach(a => {
            const dateStr = a.date ? new Date(a.date + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
            const fullId = 'announcement-full-' + a.id;
            $feed.append(
                '<div class="list-group-item border-0 border-bottom py-3" data-announcement-id="' + a.id + '">' +
                '<div class="d-flex justify-content-between align-items-start flex-wrap gap-2">' +
                '<div><h6 class="mb-1">' + (a.title || '') + '</h6><small class="text-muted">' + dateStr + '</small></div>' +
                '<button type="button" class="btn btn-link btn-sm p-0 text-primary" data-bs-toggle="collapse" data-bs-target="#' + fullId + '" aria-expanded="false">View full</button>' +
                '</div>' +
                '<p class="mb-2 mt-1 small">' + (a.summary || '') + '</p>' +
                '<div class="collapse" id="' + fullId + '"><div class="small text-muted">' + (a.body || '') + '</div></div>' +
                '</div>'
            );
        });
        this.updateNotificationDots();
    },

    // ─── ACTIVITY PAGE ───────────────────────────────────────
    async loadActivity() {
        const $feed = $('#activity-feed');
        if (!$feed.length) return;
        this.showLoading($feed, 'Loading activity…');
        try {
            const range = $('#activity-date-range').val() || 'all';
            const data = await API.getActivity({ limit: 50 });
            const events = data.events || data;
            let list = Array.isArray(events) ? events : [];
            const now = Date.now();
            const filterByRange = (ts) => {
                if (!ts) return true;
                const t = new Date(ts).getTime();
                if (range === '7') return (now - t) <= 7 * 24 * 60 * 60 * 1000;
                if (range === '30') return (now - t) <= 30 * 24 * 60 * 60 * 1000;
                return true;
            };
            list = list.filter(evt => filterByRange(evt.timestamp));
            const typeFilter = ($('#activity-type-filter').val() || '').toLowerCase();
            if (typeFilter === 'delivered') list = list.filter(e => (String(e.message || '') + ' ' + (e.type || '')).toLowerCase().includes('delivered'));
            else if (typeFilter === 'sold') list = list.filter(e => (String(e.message || '') + ' ' + (e.type || '')).toLowerCase().includes('sold'));
            else if (typeFilter === 'payout') list = list.filter(e => (String(e.message || '') + ' ' + (e.type || '')).toLowerCase().includes('payout'));
            $feed.empty();
            if (list.length === 0) {
                $feed.html('<div class="list-group-item border-0 py-5 text-center"><p class="text-muted mb-3">No recent activity. Ship a package or connect your Amazon account to get started.</p><a href="packages.html" class="btn btn-primary btn-sm">Add Package</a></div>');
            } else {
                list.forEach(evt => {
                    const time = evt.timestamp ? this.formatTimeAgo(evt.timestamp) : '';
                    const link = evt.link ? ' href="' + evt.link + '"' : '';
                    const icon = evt.icon || 'ri-circle-line';
                    $feed.append(
                        '<a class="list-group-item list-group-item-action border-0 py-3 d-flex align-items-start" role="article"' + link + '>' +
                        '<i class="' + icon + ' me-2 mt-1 text-muted"></i>' +
                        '<div class="flex-grow-1"><span class="d-block">' + (evt.message || '') + '</span>' +
                        (time ? '<small class="text-muted">' + time + '</small>' : '') + '</div>' +
                        (evt.cta ? '<span class="badge bg-primary-subtle text-primary">' + evt.cta + '</span>' : '') +
                        '</a>'
                    );
                });
            }
            const $live = $('#activity-live');
            if ($live.length) $live.addClass('rp-live-dot').attr('aria-label', 'Live updates on');
            if (this._activityTimer) clearTimeout(this._activityTimer);
            this._activityTimer = setTimeout(() => this.loadActivity(), 25000);
        } catch (err) {
            console.error('Load activity error:', err);
            this.showError($feed, err.error || 'Unable to load activity.', () => this.loadActivity());
        }
    },

    // ─── INVENTORY PAGE ───────────────────────────────────────
    async loadInventory() {
        const $cards = $('#inventory-cards');
        if (!$cards.length) return;
        const $stageBar = $('#inventory-stage-bar');
        if ($stageBar.length) $stageBar.html('<span class="spinner-border spinner-border-sm me-2"></span>Loading…');
        try {
            const data = await API.getInventorySummary();
            $('#inv-received').text(data.items_received ?? 0);
            $('#inv-processing').text(data.items_processing ?? 0);
            $('#inv-sold').text(data.items_sold ?? 0);
            $('#inv-awaiting-inspection').text(data.awaiting_inspection ?? 0);
            $('#inv-awaiting-listing').text(data.awaiting_listing ?? 0);
            $('#inv-est-value').text('£' + Number(data.estimated_resale_value || 0).toFixed(2));
            $('#inv-recovered').text('£' + Number(data.recovered_so_far || 0).toFixed(2));
            $('#inv-remaining').text('£' + Number(data.potential_remaining_value || data.estimated_resale_value - data.recovered_so_far || 0).toFixed(2));
            const sb = data.stage_breakdown || {};
            const total = (sb.inspection || 0) + (sb.listing || 0) + (sb.listed || 0) + (sb.sold || 0) + (sb.storage || 0) || 1;
            const pct = v => Math.round((v / total) * 100);
            const $bar = $('#inventory-stage-bar');
            if ($bar.length && total) {
                $bar.html(
                    '<div class="progress rounded" style="height:24px">' +
                    '<div class="progress-bar bg-warning" style="width:' + pct(sb.inspection || 0) + '%">Inspection</div>' +
                    '<div class="progress-bar bg-info" style="width:' + pct(sb.listing || 0) + '%">Listing</div>' +
                    '<div class="progress-bar bg-primary" style="width:' + pct(sb.listed || 0) + '%">Listed</div>' +
                    '<div class="progress-bar bg-success" style="width:' + pct(sb.sold || 0) + '%">Sold</div>' +
                    '<div class="progress-bar bg-secondary" style="width:' + pct(sb.storage || 0) + '%">Storage</div>' +
                    '</div>'
                );
            }
        } catch (err) {
            console.error('Load inventory error:', err);
            if ($stageBar.length) {
                $stageBar.html('<p class="text-danger mb-2">' + (err.error || 'Unable to load inventory.') + '</p><button type="button" class="btn btn-outline-primary btn-sm">Try again</button>');
                $stageBar.find('.btn').on('click', () => this.loadInventory());
            }
        }
    },

    // ─── ANALYTICS PAGE ───────────────────────────────────────
    async loadAnalytics() {
        const $chart = $('#analytics-chart');
        if (!$chart.length) return;
        $chart.html('<div class="text-center py-5 text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</div>');
        try {
            const data = await API.getAnalytics();
            window._lastAnalyticsData = data;
            const range = $('#analytics-date-range').val() || '6';
            let series = data.recoveredOverTime || [];
            const n = parseInt(range, 10);
            if (range === '7' || range === '30' || range === '90') {
                const months = range === '7' ? 0.25 : range === '30' ? 1 : 3;
                series = series.slice(-Math.max(1, Math.ceil(months * (series.length / 6))));
            } else {
                series = series.slice(-Math.min(n, series.length));
            }
            $('#kpi-recovery-rate').text(Number((data.recoveryRate || 0) * 100).toFixed(0) + '%');
            $('#kpi-avg-recovery').text('£' + Number(data.avgRecoveryPerItem || 0).toFixed(2));
            $chart.empty();
            if (window.ApexCharts && series.length) {
                new ApexCharts($chart[0], {
                    chart: { type: 'line', toolbar: { show: false } },
                    series: [{ name: 'Recovered', data: series.map(d => d.value) }],
                    xaxis: { categories: series.map(d => d.month) },
                    stroke: { curve: 'smooth', width: 2 },
                    colors: ['#0d6efd']
                }).render();
            } else {
                $chart.html('<div class="text-center py-5 text-muted">No chart data yet.</div>');
            }
        } catch (err) {
            console.error('Load analytics error:', err);
            $chart.html('<div class="text-center py-5"><p class="text-danger mb-2">' + (err.error || 'Unable to load analytics.') + '</p><button type="button" class="btn btn-outline-primary btn-sm">Try again</button></div>');
            $chart.find('.btn').on('click', () => this.loadAnalytics());
        }
    },

    exportAnalyticsCsv() {
        const data = window._lastAnalyticsData;
        const rows = [['Month', 'Recovered (£)']];
        if (data && data.recoveredOverTime && data.recoveredOverTime.length) {
            data.recoveredOverTime.forEach(d => { rows.push([d.month, Number(d.value).toFixed(2)]); });
        }
        const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'returnpal-analytics-' + new Date().toISOString().slice(0, 10) + '.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    },

    exportInvoicesCsv() {
        const monthly = window._lastInvoicesData || [];
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const rows = [['Period', 'Date issued', 'Payout date', 'Amount', 'Items', 'Status']];
        monthly.forEach(m => {
            rows.push([
                monthNames[m.month] + ' ' + m.year,
                this.formatDate(m.date_issued),
                this.formatDate(m.payout_date),
                '£' + Number(m.amount).toFixed(2),
                m.items_count,
                m.status || ''
            ]);
        });
        const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'returnpal-invoices-' + new Date().toISOString().slice(0, 10) + '.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    },

    exportInvoicesForAccountant() {
        const monthly = window._lastInvoicesData || [];
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const vatNumber = localStorage.getItem('returnpal_vat_number') || '';
        let csv = 'ReturnPal - Invoice summary for accountant\n';
        csv += 'Exported: ' + new Date().toISOString().slice(0, 10) + '\n';
        if (vatNumber) csv += 'VAT number: ' + vatNumber + '\n';
        csv += '\nPeriod,Date issued,Payout date,Amount (£),VAT (£),Items,Status\n';
        monthly.forEach(m => {
            csv += '"' + (monthNames[m.month] + ' ' + m.year) + '",' + this.formatDate(m.date_issued) + ',' + this.formatDate(m.payout_date) + ',' + Number(m.amount).toFixed(2) + ',' + Number(m.vat_amount || 0).toFixed(2) + ',' + m.items_count + ',"' + (m.status || '') + '"\n';
        });
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'returnpal-accountant-' + new Date().toISOString().slice(0, 10) + '.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    },
    exportInvoicesXero() {
        const monthly = window._lastInvoicesData || [];
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        let csv = '*Date,*Amount,*Description\n';
        monthly.forEach(m => {
            const label = monthNames[m.month] + ' ' + m.year + ' - ReturnPal recovery';
            csv += this.formatDate(m.date_issued) + ',' + Number(m.amount).toFixed(2) + ',"' + label + '"\n';
        });
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'returnpal-xero-' + new Date().toISOString().slice(0, 10) + '.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    },
    exportInvoicesQuickBooks() {
        const monthly = window._lastInvoicesData || [];
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        let csv = 'Date,Amount,Description,Memo\n';
        monthly.forEach(m => {
            const label = monthNames[m.month] + ' ' + m.year + ' - ReturnPal recovery';
            csv += this.formatDate(m.date_issued) + ',' + Number(m.amount).toFixed(2) + ',"' + label + '","Returns recovery payout"\n';
        });
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'returnpal-quickbooks-' + new Date().toISOString().slice(0, 10) + '.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    },
    async downloadInvoiceMonth(period) {
        try {
            const data = await API.getInvoiceDetail(period);
            const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            const [y, m] = period.split('-').map(Number);
            const periodLabel = data.period_label || (monthNames[(m || 1) - 1] + ' ' + (y || new Date().getFullYear()));

            const today = new Date();
            const invoiceDate = this.formatDateUK(today);
            const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
            const dueDate = this.formatDateUK(lastDay);

            let invoiceNum = sessionStorage.getItem('returnpal_invoice_num_' + period);
            if (!invoiceNum) {
                const r = Math.floor(1000 + Math.random() * 9000);
                invoiceNum = 'INV-' + today.getFullYear() + '-' + String(r);
                sessionStorage.setItem('returnpal_invoice_num_' + period, invoiceNum);
            }

            const vatNumber = (localStorage.getItem('returnpal_vat_number') || '').trim();
            const isVatRegistered = !!vatNumber;
            const lineItems = data.line_items || [];
            const subtotalNet = lineItems.reduce((s, i) => s + (Number(i.amount || 0) * (Number(i.quantity) || 1)), 0);
            const vatAmount = isVatRegistered ? (subtotalNet * 0.2) : 0;
            const totalGBP = isVatRegistered ? (subtotalNet + vatAmount) : (subtotalNet * 0.8);
            const amountDue = totalGBP;

            const billingName = localStorage.getItem('returnpal_billing_name') || '';
            const billingCompany = localStorage.getItem('returnpal_billing_company') || '';
            const billingAddress = (localStorage.getItem('returnpal_billing_address') || '').replace(/\n/g, '<br/>');
            const billingPhone = localStorage.getItem('returnpal_billing_phone') || '';

            const sender = 'JR Liquidations Limited<br/>Co. Reg. No.: 16355878<br/>Email: invoice@returnpal.co.uk<br/>Phone: +447774904697<br/>Website: returnpal.co.uk';
            const billTo = (billingName ? billingName + '<br/>' : '') + (billingCompany ? billingCompany + '<br/>' : '') + (billingAddress || '') + (billingPhone ? '<br/>' + billingPhone : '');

            const unitLabel = 'each';
            let tableRows = lineItems.map(i => {
                const qty = Number(i.quantity) || 1;
                const netPerUnit = Number(i.amount || 0);
                const lineTotal = netPerUnit * qty;
                const vatCol = isVatRegistered ? '<td class="num">20%</td>' : '';
                return '<tr><td>' + (i.description || '') + '</td><td class="num">' + qty + '</td><td>' + unitLabel + '</td><td class="num">£' + netPerUnit.toFixed(2) + '</td>' + vatCol + '<td class="num">£' + lineTotal.toFixed(2) + '</td></tr>';
            }).join('');

            const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Invoice ' + invoiceNum + '</title><style>' +
                '*{box-sizing:border-box;} body{margin:0;font-family:"Segoe UI",-apple-system,BlinkMacSystemFont,Roboto,"Helvetica Neue",Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a;background:#fff;}' +
                '.doc{max-width:720px;margin:0 auto;padding:48px 40px;}' +
                '.brand{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:32px;border-bottom:2px solid #1a1a1a;margin-bottom:32px;}' +
                '.brand-name{font-size:11px;letter-spacing:0.2em;text-transform:uppercase;font-weight:600;color:#1a1a1a;margin-bottom:4px;}' +
                '.invoice-title{font-size:28px;font-weight:700;letter-spacing:-0.02em;color:#1a1a1a;}' +
                '.from-block{text-align:right;font-size:13px;color:#444;line-height:1.7;}' +
                '.from-block strong{display:block;font-size:12px;letter-spacing:0.05em;text-transform:uppercase;color:#666;margin-bottom:6px;}' +
                '.to-block{margin-top:24px;}' +
                '.to-block .label{font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#666;margin-bottom:8px;font-weight:600;}' +
                '.to-block .value{font-size:14px;color:#1a1a1a;line-height:1.7;}' +
                '.meta-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin:28px 0 24px;padding:20px 24px;background:#f8f9fa;border-radius:6px;}' +
                '.meta-item .label{font-size:11px;letter-spacing:0.05em;text-transform:uppercase;color:#666;margin-bottom:4px;}' +
                '.meta-item .value{font-size:15px;font-weight:600;color:#1a1a1a;}' +
                '.period-note{font-size:13px;color:#555;margin-bottom:20px;}' +
                '.items-table{width:100%;border-collapse:collapse;margin:0 0 24px;font-size:13px;}' +
                '.items-table thead th{text-align:left;padding:12px 14px;background:#1a1a1a;color:#fff;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;}' +
                '.items-table thead th.num,.items-table td.num{text-align:right;}' +
                '.items-table tbody td{padding:14px;border-bottom:1px solid #e8e8e8;vertical-align:top;}' +
                '.items-table tbody tr:last-child td{border-bottom:none;}' +
                '.items-table .totals-row td{padding:10px 14px;border-bottom:1px solid #e8e8e8;font-weight:500;}' +
                '.items-table .totals-row.final td{padding:14px;font-size:15px;font-weight:700;background:#f8f9fa;border-bottom:none;}' +
                '.terms-box{margin-top:40px;padding:20px 24px;background:#f8f9fa;border-radius:6px;font-size:12px;color:#555;line-height:1.6;}' +
                '.terms-box p{margin:0 0 8px;}' +
                '.terms-box p:last-child{margin-bottom:0;}' +
                '@media print{.doc{padding:24px;}.brand{border-bottom-color:#1a1a1a;} body{background:#fff;}}' +
                '</style></head><body>' +
                '<div class="doc">' +
                '<div class="brand">' +
                '<div><div class="brand-name">ReturnPal</div><div class="invoice-title">Invoice</div></div>' +
                '<div class="from-block"><strong>From</strong>' + sender + '</div>' +
                '</div>' +
                '<div class="to-block"><div class="label">Bill to</div><div class="value">' + (billTo || '-') + '</div></div>' +
                '<div class="meta-grid">' +
                '<div class="meta-item"><div class="label">Invoice number</div><div class="value">' + invoiceNum + '</div></div>' +
                '<div class="meta-item"><div class="label">Invoice date</div><div class="value">' + invoiceDate + '</div></div>' +
                '<div class="meta-item"><div class="label">Due date</div><div class="value">' + dueDate + '</div></div>' +
                '</div>' +
                '<p class="period-note">Payout for period: <strong>' + periodLabel + '</strong> (items sold and recovered).</p>' +
                '<table class="items-table">' +
                '<thead><tr><th>Description</th><th class="num">Quantity</th><th>Unit</th><th class="num">Price</th>' + (isVatRegistered ? '<th class="num">VAT</th>' : '') + '<th class="num">Amount</th></tr></thead><tbody>' +
                tableRows +
                '<tr class="totals-row"><td colspan="' + (isVatRegistered ? 5 : 4) + '" class="num">Subtotal ' + (isVatRegistered ? '(ex. VAT)' : '') + '</td><td class="num">£' + subtotalNet.toFixed(2) + '</td></tr>' +
                (isVatRegistered ? ('<tr class="totals-row"><td colspan="5" class="num">VAT 20%</td><td class="num">£' + vatAmount.toFixed(2) + '</td></tr>' +
                '<tr class="totals-row"><td colspan="5" class="num">Total GBP</td><td class="num">£' + (subtotalNet + vatAmount).toFixed(2) + '</td></tr>') : '') +
                '<tr class="totals-row final"><td colspan="' + (isVatRegistered ? 5 : 4) + '" class="num">Amount due</td><td class="num">£' + amountDue.toFixed(2) + '</td></tr>' +
                '</tbody></table>' +
                '<div class="terms-box">' +
                (isVatRegistered && vatNumber ? '<p><strong>VAT No.</strong> ' + vatNumber + '. VAT may be subject to reverse charge where applicable.</p>' : '<p>This is a non-VAT invoice. A 20% deduction has been applied as you are not VAT registered.</p>') +
                '<p>Payment is due by the date stated above. Thank you for selling with ReturnPal.</p>' +
                '</div></div></body></html>';
            const w = window.open('', '_blank');
            w.document.write(html);
            w.document.close();
            w.focus();
            setTimeout(() => { w.print(); }, 250);
        } catch (err) {
            console.error('Download invoice error:', err);
            alert(err.error || 'Unable to load invoice.');
        }
    },
    formatDateUK(d) {
        if (!d) return '';
        const x = d instanceof Date ? d : new Date(d);
        const day = String(x.getDate()).padStart(2, '0');
        const month = String(x.getMonth() + 1).padStart(2, '0');
        const year = x.getFullYear();
        return day + '/' + month + '/' + year;
    },

    // ─── ITEM DETAIL PAGE ─────────────────────────────────────
    async loadItemDetail() {
        const id = new URLSearchParams(window.location.search).get('id');
        if (!id) return;
        const $card = $('#item-timeline').closest('.rp-card').first();
        if ($card.length) this.showLoading($card, 'Loading…');
        try {
            const data = await API.getItem(id);
            $('#item-title').text(data.title || data.reference || 'Item');
            $('#item-sku').text(data.sku || data.reference || '-');
            $('#item-status').html(this.statusBadge(data.status || 'Processing'));
            $('#item-condition').text(data.condition_notes || '-');
            $('#item-resale').text('£' + Number(data.resale_price || 0).toFixed(2));
            $('#item-payout').text('£' + Number(data.estimated_payout || 0).toFixed(2));
            const timeline = data.timeline || [];
            const $tl = $('#item-timeline');
            if ($tl.length) {
                $tl.empty();
                timeline.forEach(t => {
                    $tl.append('<div class="d-flex mb-2"><small class="text-muted me-2">' + (t.timestamp ? this.formatTimeAgo(t.timestamp) : '') + '</small><span>' + (t.message || '') + '</span></div>');
                });
            }
        } catch (err) {
            console.error('Load item detail error:', err);
            if ($card.length) this.showError($card, err.error || 'Unable to load item.', () => this.loadItemDetail());
        }
    },

    // ─── PACKAGE DETAIL PAGE ──────────────────────────────────
    async loadPackageDetail() {
        const id = new URLSearchParams(window.location.search).get('id');
        if (!id) return;
        const $card = $('#pkg-items').closest('.rp-card').first();
        if ($card.length) this.showLoading($card, 'Loading…');
        try {
            const data = await API.getPackageDetail(id);
            $('#pkg-reference').text(data.reference || '-');
            $('#pkg-breadcrumb-ref').text(data.reference || '-');
            $('#pkg-status').html(this.statusBadge(data.shipping_status || data.status || 'Delivered'));
            $('#pkg-received').text(this.formatDate(data.received_date) || '-');
            $('#pkg-carrier').text(data.carrier || '-');
            const items = data.items || [];
            const $list = $('#pkg-items');
            $list.empty();
            items.forEach(it => {
                $list.append('<li class="list-group-item d-flex justify-content-between"><a href="item-detail.html?id=' + (it.id || '') + '">' + (it.title || it.reference) + '</a>' + this.statusBadge(it.status || '') + '</li>');
            });
            const timeline = data.timeline || [];
            const $tl = $('#pkg-timeline');
            $tl.empty();
            timeline.forEach(t => {
                $tl.append('<div class="d-flex mb-2"><small class="text-muted me-2">' + (t.timestamp ? this.formatTimeAgo(t.timestamp) : '') + '</small><span>' + (t.message || '') + '</span></div>');
            });
        } catch (err) {
            console.error('Load package detail error:', err);
            if ($card.length) this.showError($card, err.error || 'Unable to load package.', () => this.loadPackageDetail());
        }
    },

    // ─── SETTINGS PAGE ───────────────────────────────────────
    async loadSettings() {
        try {
            const data = await API.getSettings();
            if (data.settings) {
                $('#flexSwitchCheckDefault').prop('checked', !!data.settings.vat_registered);
                $('input[placeholder*="discord"]').val(data.settings.discord_webhook || '');
            }
            // Profile details (name, email from user; company from profile or billing)
            const user = API.getUser();
            const profileName = localStorage.getItem('returnpal_profile_name') || (user && user.full_name) || '';
            const profileEmail = (user && user.email) || '';
            const profileCompany = localStorage.getItem('returnpal_profile_company') || localStorage.getItem('returnpal_billing_company') || '';
            $('#settings-profile-name').val(profileName);
            $('#settings-profile-email').val(profileEmail);
            $('#settings-profile-company').val(profileCompany);
            $(document).off('click', '#settings-profile-save').on('click', '#settings-profile-save', function() {
                localStorage.setItem('returnpal_profile_name', $('#settings-profile-name').val().trim());
                localStorage.setItem('returnpal_profile_company', $('#settings-profile-company').val().trim());
                const $btn = $(this);
                $btn.text('Saved!');
                Dashboard.showToast('Profile saved');
                setTimeout(() => $btn.text('Save'), 1500);
            });
            // Billing / invoice details
            const billingKeys = { name: 'returnpal_billing_name', company: 'returnpal_billing_company', address: 'returnpal_billing_address', phone: 'returnpal_billing_phone' };
            $('#settings-billing-name').val(localStorage.getItem(billingKeys.name) || '');
            $('#settings-billing-company').val(localStorage.getItem(billingKeys.company) || '');
            $('#settings-billing-address').val(localStorage.getItem(billingKeys.address) || '');
            $('#settings-billing-phone').val(localStorage.getItem(billingKeys.phone) || '');
            $(document).off('click', '#settings-billing-save').on('click', '#settings-billing-save', function() {
                localStorage.setItem(billingKeys.name, $('#settings-billing-name').val().trim());
                localStorage.setItem(billingKeys.company, $('#settings-billing-company').val().trim());
                localStorage.setItem(billingKeys.address, $('#settings-billing-address').val().trim());
                localStorage.setItem(billingKeys.phone, $('#settings-billing-phone').val().trim());
                const $btn = $(this);
                $btn.text('Saved!');
                Dashboard.showToast('Billing details saved');
                setTimeout(() => $btn.text('Save billing details'), 1500);
            });
            // Prep centre details
            const prepKeys = { name: 'returnpal_prep_name', address: 'returnpal_prep_address', contact: 'returnpal_prep_contact', phone: 'returnpal_prep_phone', email: 'returnpal_prep_email', reference: 'returnpal_prep_reference' };
            $('#settings-prep-name').val(localStorage.getItem(prepKeys.name) || '');
            $('#settings-prep-address').val(localStorage.getItem(prepKeys.address) || '');
            $('#settings-prep-contact').val(localStorage.getItem(prepKeys.contact) || '');
            $('#settings-prep-phone').val(localStorage.getItem(prepKeys.phone) || '');
            $('#settings-prep-email').val(localStorage.getItem(prepKeys.email) || '');
            $('#settings-prep-reference').val(localStorage.getItem(prepKeys.reference) || '');
            $(document).off('click', '#settings-prep-save').on('click', '#settings-prep-save', function() {
                localStorage.setItem(prepKeys.name, $('#settings-prep-name').val().trim());
                localStorage.setItem(prepKeys.address, $('#settings-prep-address').val().trim());
                localStorage.setItem(prepKeys.contact, $('#settings-prep-contact').val().trim());
                localStorage.setItem(prepKeys.phone, $('#settings-prep-phone').val().trim());
                localStorage.setItem(prepKeys.email, $('#settings-prep-email').val().trim());
                localStorage.setItem(prepKeys.reference, $('#settings-prep-reference').val().trim());
                const $btn = $(this);
                $btn.text('Saved!');
                Dashboard.showToast('Prep centre details saved');
                setTimeout(() => $btn.text('Save prep centre details'), 1500);
            });
            // Email monthly invoice at start of month
            const $emailMonthlyInv = $('#email-monthly-invoice');
            if ($emailMonthlyInv.length) {
                $emailMonthlyInv.prop('checked', localStorage.getItem('returnpal_email_monthly_invoice') === 'true');
                $emailMonthlyInv.on('change', function() { localStorage.setItem('returnpal_email_monthly_invoice', $(this).is(':checked')); });
            }
            // VAT number (UK/EU) - persist in localStorage for accountant export
            const $vatNum = $('#settings-vat-number');
            if ($vatNum.length) {
                $vatNum.val(localStorage.getItem('returnpal_vat_number') || '');
                $vatNum.on('change blur', function() { localStorage.setItem('returnpal_vat_number', $(this).val().trim()); });
            }
            // Email digest preference
            const $digest = $('#email-digest-preference');
            if ($digest.length) {
                $digest.val(localStorage.getItem('returnpal_email_digest') || 'off');
                $digest.on('change', function() { localStorage.setItem('returnpal_email_digest', $(this).val()); });
            }

            // VAT toggle
            $('#flexSwitchCheckDefault').on('change', async function() {
                try {
                    await API.updateVat($(this).is(':checked'));
                } catch(err) {
                    alert(err.error || 'Failed to update VAT setting.');
                    $(this).prop('checked', !$(this).is(':checked'));
                }
            });

            // Save webhook
            $(document).on('click', '.card-body .btn-primary', async function() {
                const webhook = $(this).closest('.card-body').find('input').val().trim();
                try {
                    $(this).prop('disabled', true).text('Saving...');
                    await API.updateWebhook(webhook);
                    $(this).text('Saved!');
                    setTimeout(() => $(this).text('Save Webhook').prop('disabled', false), 1500);
                } catch(err) {
                    alert(err.error || 'Failed to save webhook.');
                    $(this).prop('disabled', false).text('Save Webhook');
                }
            });
        } catch(err) {
            console.error('Load settings error:', err);
        }
    }
};

// Auto-init when DOM is ready
$(document).ready(function() {
    Dashboard.init();
});
