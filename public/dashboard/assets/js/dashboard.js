/**
 * ReturnPal Dashboard Controller
 * Handles all dashboard pages: packages, received, sold, pending, invoices, settings
 * Include AFTER api.js, dateUk.js, and jQuery on every dashboard page.
 */

/* global RP_DATE */

/**
 * Normalise product title for invoice print merging (fee suffix, NBSP, curly apostrophes).
 * @param {string} s
 */
function rpNormalizeInvoiceLineTitle(s) {
    return String(s || '')
        .replace(/\u00a0/g, ' ')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/[\u2019\u2018\u201b\u2032]/g, "'")
        .replace(/\s*Fee waived\s*$/i, '')
        .trim();
}

/**
 * Merge printable invoice rows by normalised product title (case-insensitive).
 * File-level so print flow never depends on `this` binding.
 * @param {Array<{ description?: string, quantity?: unknown, amount?: unknown }>} lineItems
 */
function rpConsolidateInvoiceLineItemsForPrint(lineItems) {
    const list = Array.isArray(lineItems) ? lineItems : [];
    const byKey = new Map();
    let anon = 0;
    for (const i of list) {
        const raw = rpNormalizeInvoiceLineTitle(i.description || '');
        const key = raw ? raw.toLowerCase() : '__nodesc_' + anon++;
        const qty = Number(i.quantity) || 1;
        const netPerUnit = Number(i.amount || 0);
        const lineTotal = netPerUnit * qty;
        if (!byKey.has(key)) {
            byKey.set(key, { description: raw || 'Item', totalQty: 0, sumAmount: 0 });
        }
        const b = byKey.get(key);
        b.totalQty += qty;
        b.sumAmount += lineTotal;
    }
    return Array.from(byKey.values()).map((b) => ({
        description: b.description,
        quantity: b.totalQty,
        amount: b.totalQty > 0 ? b.sumAmount / b.totalQty : 0
    }));
}

/** Shared print stylesheet for invoice and statement (save-as-PDF from print dialog). */
function rpInvoicePrintDocumentCss() {
    return (
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
        '@media print{.doc{padding:24px;}.brand{border-bottom-color:#1a1a1a;} body{background:#fff;}}'
    );
}

function rpOpenInvoicePrintWindow(html) {
    const w = window.open('', '_blank');
    if (!w) {
        alert('Please allow pop-ups to print or save as PDF.');
        return;
    }
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(function () {
        w.print();
    }, 250);
}

const Dashboard = {
    /** Set true when client reimbursement cockpit is ready for production. */
    CLIENT_REIMBURSEMENT_UI_ENABLED: false,

    isClientReimbursementUiEnabled() {
        return !!this.CLIENT_REIMBURSEMENT_UI_ENABLED;
    },

    getClientIdFromToken() {
        try {
            const token = API.getToken();
            if (!token) return null;
            const parts = token.split('.');
            if (parts.length < 2) return null;
            const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
            const decoded = JSON.parse(atob(padded));
            const n = parseInt(decoded && decoded.id, 10);
            return Number.isFinite(n) && n > 0 ? n : null;
        } catch (e) {
            return null;
        }
    },

    formatClientId(user) {
        const raw = user && user.id != null ? user.id : this.getClientIdFromToken();
        const n = parseInt(raw, 10);
        if (!Number.isFinite(n) || n <= 0) return '';
        return String(n).padStart(4, '0');
    },

    ensureItemQueryModal() {
        if (document.getElementById('rp-item-query-modal')) return;
        $('body').append(
            '<div class="modal fade" id="rp-item-query-modal" tabindex="-1" aria-labelledby="rp-item-query-title" aria-hidden="true">' +
            '<div class="modal-dialog"><div class="modal-content">' +
            '<div class="modal-header"><h5 class="modal-title" id="rp-item-query-title">Query this item</h5>' +
            '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>' +
            '<div class="modal-body"><p class="small text-muted mb-2" id="rp-item-query-context"></p>' +
            '<label class="form-label" for="rp-item-query-message">Your message</label>' +
            '<textarea class="form-control" id="rp-item-query-message" rows="4" placeholder="Describe your question or issue…"></textarea></div>' +
            '<div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>' +
            '<button type="button" class="btn btn-primary" id="rp-item-query-submit">Send query</button></div>' +
            '</div></div></div>'
        );
        const self = this;
        $(document).off('click', '#rp-item-query-submit').on('click', '#rp-item-query-submit', async function() {
            const msg = ($('#rp-item-query-message').val() || '').trim();
            const ctx = $('#rp-item-query-modal').data('ctx') || {};
            if (msg.length < 5) {
                alert('Please enter at least 5 characters.');
                return;
            }
            try {
                await API.submitItemQuery({
                    context_type: ctx.type || 'general',
                    context_id: ctx.id,
                    context_label: ctx.label || '',
                    message: msg
                });
                const el = document.getElementById('rp-item-query-modal');
                if (el && window.bootstrap) {
                    const inst = bootstrap.Modal.getInstance(el);
                    if (inst) inst.hide();
                }
                $('#rp-item-query-message').val('');
                self.showToast('Query sent. We will get back to you.');
            } catch (e) {
                alert((e && e.error) || e.message || 'Failed to send');
            }
        });
    },

    openItemQueryModal(type, id, label) {
        this.ensureItemQueryModal();
        $('#rp-item-query-modal').data('ctx', { type: type || 'general', id, label: label || '' });
        $('#rp-item-query-context').text(label || '');
        const el = document.getElementById('rp-item-query-modal');
        if (el && window.bootstrap) {
            new bootstrap.Modal(el).show();
        }
    },

    loadDashboardNotifications() {
        const $dd = $('#dashboard-notifications-dropdown');
        if (!$dd.length) return;
        API.getActivity({ limit: 12, skipAuthRedirect: true }).then((data) => {
            const events = (data && data.events) || [];
            const $badge = $('#dashboard-notifications-badge');
            if (events.length === 0) {
                $badge.addClass('d-none').text('');
                $dd.html(
                    '<div class="dropdown-header border-bottom">Notifications</div>' +
                    '<div class="dropdown-item-text py-3 px-3 text-muted small">No recent notifications.</div>' +
                    '<a class="dropdown-item text-center small text-primary py-2" href="activity.html">View all activity</a>'
                );
                return;
            }
            $badge.removeClass('d-none').text(events.length > 9 ? '9+' : String(events.length));
            const esc = (s) => String(s == null ? '' : s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
            let html = '<div class="dropdown-header border-bottom">Notifications</div>';
            events.slice(0, 6).forEach((evt) => {
                const time = evt.timestamp ? this.formatTimeAgo(evt.timestamp) : '';
                const link = evt.link ? String(evt.link) : '';
                const href = link ? ' href="' + esc(link).replace(/"/g, '&quot;') + '"' : '';
                html += '<a class="dropdown-item py-2 border-bottom small"' + href + '><span class="d-block">' + esc(evt.message || '') + '</span>' +
                    (time ? '<small class="text-muted">' + esc(time) + '</small>' : '') + '</a>';
            });
            html += '<a class="dropdown-item text-center small text-primary py-2" href="activity.html">View all activity</a>';
            $dd.html(html);
        }).catch(() => {});
    },

    userAvatarInitials(user) {
        const u = user || {};
        const name = String(u.full_name || '').trim();
        const email = String(u.email || '').trim();
        if (name) {
            const parts = name.split(/\s+/).filter(Boolean);
            if (parts.length >= 2) {
                return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
            }
            return name.slice(0, 2).toUpperCase();
        }
        if (email) return email.slice(0, 2).toUpperCase();
        return 'RP';
    },

    updateAvatarWidgets(user) {
        const u = user || {};
        const url = (u.avatar_url && String(u.avatar_url).trim()) || '';
        const initials = this.userAvatarInitials(u);
        const firstName = (u.full_name || u.email || '').split(' ')[0] || 'Client';

        const $btn = $('#page-header-user-dropdown');
        if ($btn.length) {
            let $img = $btn.find('#dashboard-header-avatar-img');
            if (!$img.length) {
                $img = $btn.find('img').first();
                if ($img.length) $img.attr('id', 'dashboard-header-avatar-img');
            }
            let $ini = $btn.find('#dashboard-header-avatar-initials');
            if (url && $img.length) {
                $img.attr('src', url).attr('alt', firstName).css({ display: '', width: 32, height: 32, objectFit: 'cover' }).show();
                $ini.hide();
            } else {
                if ($img.length) $img.hide().removeAttr('src');
                if (!$ini.length) {
                    $ini = $('<span id="dashboard-header-avatar-initials" class="rounded-circle d-inline-flex align-items-center justify-content-center bg-primary bg-opacity-10 text-primary fw-semibold flex-shrink-0" style="width:32px;height:32px;font-size:0.7rem;line-height:1" aria-hidden="true"></span>');
                    $btn.append($ini);
                }
                $ini.text(initials).show();
            }
        }

        const $sImg = $('#settings-avatar-preview-img');
        const $sIni = $('#settings-avatar-preview-initials');
        if ($sImg.length || $sIni.length) {
            if (url && $sImg.length) {
                $sImg.attr('src', url).attr('alt', '').css({ display: '', objectFit: 'cover' }).show();
                $sIni.hide();
            } else {
                if ($sImg.length) $sImg.hide().removeAttr('src');
                if ($sIni.length) {
                    $sIni.text(initials).show();
                }
            }
            $('#settings-avatar-remove').toggleClass('d-none', !url);
        }
    },

    updateUserIdentityUI(user) {
        // Always run: formatClientId falls back to JWT when cached user omits id (new signups, stale storage).
        const u = user || {};
        const clientIdFormatted = this.formatClientId(u);
        const firstName = (u.full_name || u.email || '').split(' ')[0] || 'Client';

        const $userMenu = $('#page-header-user-dropdown').siblings('.dropdown-menu').first();
        if ($userMenu.length) {
            $userMenu.find('.dropdown-header').first().text('Welcome ' + firstName + '!');
            if (clientIdFormatted) {
                const $existing = $userMenu.find('#dashboard-client-id-dropdown');
                const html = 'Client ID: <strong>' + clientIdFormatted + '</strong> <span class="text-muted">(use for return address)</span>';
                if ($existing.length) $existing.html(html);
                else $userMenu.find('.dropdown-header').first().after('<div class="dropdown-item disabled small py-2" id="dashboard-client-id-dropdown">' + html + '</div>');
            }
        }

        this.updateAvatarWidgets(u);

        // Overview card
        const $clientIdVal = $('#dashboard-client-id-value');
        if ($clientIdVal.length) $clientIdVal.text(clientIdFormatted || '—');

        // Returns Settings page address line
        const $returnsClientId = $('#returns-settings-client-id');
        if ($returnsClientId.length) $returnsClientId.text(clientIdFormatted ? 'ReturnPal ' + clientIdFormatted : '—');
    },

    init() {
        const params = new URLSearchParams(window.location.search);
        const viewAsToken = params.get('view_as');
        const impersonateToken = params.get('impersonate');
        const sessionToken = viewAsToken || impersonateToken;
        if (sessionToken) {
            API.setSessionToken(sessionToken);
            API.request('/auth/me', { skipAuthRedirect: true }).then(me => {
                if (me && me.user) API.setSessionUser(me.user);
                window.history.replaceState({}, '', window.location.pathname + (window.location.hash || ''));
                if (viewAsToken) {
                    sessionStorage.setItem('returnpal_delegate_viewing', '1');
                } else {
                    sessionStorage.setItem('returnpal_impersonating', '1');
                }
                this.injectViewingAsBanner();
            }).catch(() => {}).finally(() => this._initRest());
            return;
        }
        this._initRest();
    },

    /** Reimbursement page: full sidebar/search chrome without overview API. */
    _initReimbursementPage() {
        if (API.getSessionToken()) {
            this.injectViewingAsBanner();
        } else if (API.isDelegateViewing()) {
            this.applyDelegateReadOnlyUI();
        }
        const user = API.getUser();
        this.updateUserIdentityUI(user);
        const useSession = !!API.getSessionToken();
        const self = this;
        API.request('/auth/me', { skipAuthRedirect: true })
            .then((me) => {
                if (!me || !me.user) return;
                if (useSession) API.setSessionUser(me.user);
                else API.setUser(me.user);
                self.updateUserIdentityUI(me.user);
            })
            .catch((err) => {
                if (err && err.status === 401) API.navigateAwayOnUnauthorized();
            })
            .finally(() => {
                self.ensureClientPreferences().catch(() => {});
                self._initDashboardChrome();
                if (!self.isClientReimbursementUiEnabled()) {
                    self.blockReimbursementPageContent();
                    self.showReimbursementComingSoonModal({ redirectOnClose: true });
                    return;
                }
                self.initReimbursementSubmit();
                self.loadReimbursementClaims();
            });
    },

    blockReimbursementPageContent() {
        $('.page-content > .container-fluid').first().addClass('d-none');
    },

    injectReimbursementComingSoonModal() {
        if ($('#reimbursementComingSoonModal').length) return;
        $('body').append(
            '<div class="modal fade" id="reimbursementComingSoonModal" tabindex="-1" aria-labelledby="reimbursementComingSoonTitle" aria-hidden="true">' +
            '<div class="modal-dialog modal-dialog-centered"><div class="modal-content">' +
            '<div class="modal-header border-0 pb-0">' +
            '<h5 class="modal-title" id="reimbursementComingSoonTitle"><i class="ri-refund-line me-2 text-primary"></i>Reimbursement claims — coming soon</h5>' +
            '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>' +
            '<div class="modal-body pt-2">' +
            '<p class="text-muted mb-0">We\'re finishing the self-serve reimbursement workspace in your dashboard. ReturnPal still pursues reimbursement on your behalf where appropriate — you\'ll be able to track and submit claims here soon.</p>' +
            '</div>' +
            '<div class="modal-footer border-0 pt-0">' +
            '<button type="button" class="btn btn-primary" data-bs-dismiss="modal">OK</button>' +
            '</div></div></div></div>'
        );
    },

    showReimbursementComingSoonModal(options) {
        this.injectReimbursementComingSoonModal();
        const el = document.getElementById('reimbursementComingSoonModal');
        if (!el || typeof bootstrap === 'undefined') return;
        const opts = options || {};
        if (opts.redirectOnClose) {
            $(el)
                .off('hidden.bs.modal.rpReimbSoon')
                .one('hidden.bs.modal.rpReimbSoon', function() {
                    const path = (window.location.pathname || '').toLowerCase();
                    if (path.includes('reimbursement')) {
                        window.location.replace('index.html');
                    }
                });
        }
        bootstrap.Modal.getOrCreateInstance(el).show();
    },

    bindReimbursementNavGuard() {
        if (this.isClientReimbursementUiEnabled()) return;
        $(document)
            .off('click.rpReimbGuard', 'a[href="reimbursement.html"], a[href="/dashboard/reimbursement.html"]')
            .on(
                'click.rpReimbGuard',
                'a[href="reimbursement.html"], a[href="/dashboard/reimbursement.html"]',
                function(e) {
                    e.preventDefault();
                    Dashboard.showReimbursementComingSoonModal();
                }
            );
    },

    /** Reimbursement case cockpit — #reimbursement-list */
    loadReimbursementClaims() {
        const $list = $('#reimbursement-list');
        if (!$list.length) return;
        const self = this;

        function fmtDate(s) {
            return s ? RP_DATE.formatOrdinalEnGb(s) : '-';
        }
        function escHtml(s) {
            return String(s || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }
        function downloadOne(url, fileName) {
            const a = document.createElement('a');
            a.href = url;
            a.setAttribute('download', fileName || '');
            document.body.appendChild(a);
            a.click();
            a.remove();
        }
        function statusBadgeClass(st) {
            const m = {
                draft: 'bg-secondary',
                ready: 'bg-primary',
                submitted: 'bg-warning text-dark',
                approved: 'bg-success',
                partial: 'bg-info',
                denied: 'bg-danger',
            };
            return m[st] || 'bg-secondary';
        }

        API.request('/reimbursement/claims', { skipAuthRedirect: true })
            .then((data) => {
                window._reimbursementClaims = data.claims || [];
                self.renderReimbursementCockpit($list, window._reimbursementClaims, fmtDate, escHtml, statusBadgeClass);
            })
            .catch((err) => {
                if (err && err.status === 401) {
                    API.navigateAwayOnUnauthorized();
                    return;
                }
                $list.html('<div class="text-danger text-center py-4">Failed to load claims.</div>');
            });
    },

    renderReimbursementCockpit($list, claims, fmtDate, escHtml, statusBadgeClass) {
        const self = this;
        const filter = window._reimbursementFilter || 'all';
        const filtered =
            filter === 'all'
                ? claims
                : claims.filter((c) => (c.case_status || 'draft') === filter);

        let filterHtml = API.isDelegateViewing()
            ? ''
            : '<div class="d-flex flex-wrap gap-2 mb-3">' +
            ['all', 'ready', 'submitted', 'approved', 'partial', 'denied'].map((f) => {
                const label = f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1);
                const active = filter === f ? ' active' : '';
                return (
                    '<button type="button" class="btn btn-sm btn-outline-secondary reimb-filter-btn' +
                    active +
                    '" data-filter="' +
                    f +
                    '">' +
                    label +
                    ' (' +
                    (f === 'all' ? claims.length : claims.filter((c) => (c.case_status || 'draft') === f).length) +
                    ')</button>'
                );
            }).join('') +
            '</div>';

        if (!claims.length) {
            $list.html(
                filterHtml +
                    '<div class="text-muted text-center py-5"><p class="mb-2">No reimbursement cases yet.</p><p class="small">Submit a claim above or wait for ReturnPal to add evidence for Amazon.</p></div>'
            );
        } else if (!filtered.length) {
            $list.html(filterHtml + '<p class="text-muted small">No claims in this status.</p>');
        } else {
            let html = filterHtml;
            filtered.forEach((c, claimIdx) => {
                const st = c.case_status || 'draft';
                let photoHtml = '';
                (c.photos || []).forEach((ph, photoIdx) => {
                    const url = '/uploads/' + (ph.file_path || '');
                    const safeUrl = escHtml(url);
                    const photoName = 'claim-' + (c.id || claimIdx + 1) + '-photo-' + (photoIdx + 1) + '.jpg';
                    photoHtml +=
                        '<div><a href="' +
                        safeUrl +
                        '" target="_blank" rel="noopener"><img src="' +
                        safeUrl +
                        '" alt="Photo" /></a>' +
                        '<button type="button" class="btn btn-sm btn-outline-secondary mt-1 w-100 download-photo-btn" data-url="' +
                        safeUrl +
                        '" data-name="' +
                        escHtml(photoName) +
                        '">Download</button></div>';
                });
                if (!photoHtml) photoHtml = '<span class="text-muted small">No photos</span>';
                const recovered = Number(c.recovered_amount);
                const expected = Number(c.expected_amount);
                html +=
                    '<div class="reimb-card card border mb-3" data-claim-id="' +
                    c.id +
                    '"><div class="card-body">' +
                    '<div class="d-flex flex-wrap justify-content-between gap-2 mb-2">' +
                    '<div class="d-flex flex-wrap gap-2">' +
                    '<span class="badge ' +
                    statusBadgeClass(st) +
                    '">' +
                    escHtml(c.case_status_label || st) +
                    '</span>' +
                    '<span class="badge bg-secondary">' +
                    escHtml(c.package_reference || '') +
                    '</span></div>' +
                    (Number.isFinite(recovered) && recovered > 0
                        ? '<span class="text-success fw-semibold">Recovered £' + recovered.toFixed(2) + '</span>'
                        : Number.isFinite(expected) && expected > 0
                          ? '<span class="text-muted small">Expected £' + expected.toFixed(2) + '</span>'
                          : '') +
                    '</div>' +
                    '<h6 class="card-title">' +
                    escHtml(c.item_description || 'Item') +
                    '</h6>' +
                    '<p class="small text-muted mb-2">' +
                    escHtml(c.reimbursement_type || '') +
                    (c.seller_central_case_id ? ' · SC case: ' + escHtml(c.seller_central_case_id) : '') +
                    '</p>' +
                    '<div class="mb-2"><label class="form-label small mb-1">Seller Central case text</label>' +
                    '<textarea class="form-control form-control-sm reimb-case-text" rows="4" readonly>' +
                    escHtml(c.case_text || '') +
                    '</textarea></div>' +
                    '<div class="reimb-photos mb-2">' +
                    photoHtml +
                    '</div>' +
                    '<div class="reimb-actions flex-wrap">' +
                    '<button type="button" class="btn btn-sm btn-primary copy-case-text-btn" data-id="' +
                    c.id +
                    '"><i class="ri-file-copy-line me-1"></i>Copy case text</button>' +
                    (API.isDelegateViewing()
                        ? ''
                        : '<button type="button" class="btn btn-sm btn-outline-primary mark-submitted-btn" data-id="' +
                          c.id +
                          '"' +
                          (st === 'submitted' || st === 'approved' || st === 'partial' || st === 'denied' ? ' disabled' : '') +
                          '>Mark submitted</button>') +
                    '<a class="btn btn-sm btn-outline-success" href="' +
                    escHtml(c.seller_central_url || 'https://sellercentral.amazon.co.uk/help/hub/reference/G202130860') +
                    '" target="_blank" rel="noopener"><i class="ri-external-link-line me-1"></i>Seller Central</a>' +
                    '</div>' +
                    '<p class="small text-muted mt-2 mb-0">Added ' +
                    fmtDate(c.created_at) +
                    (c.submitted_at ? ' · Submitted ' + fmtDate(c.submitted_at) : '') +
                    '</p></div></div>';
            });
            $list.html(html);
        }

        $list.find('.reimb-filter-btn')
            .off('click')
            .on('click', function() {
                window._reimbursementFilter = $(this).data('filter');
                self.renderReimbursementCockpit($list, window._reimbursementClaims, fmtDate, escHtml, statusBadgeClass);
            });

        $list.find('.copy-case-text-btn')
            .off('click')
            .on('click', function() {
                const id = $(this).data('id');
                const $ta = $list.find('.reimb-card[data-claim-id="' + id + '"] .reimb-case-text');
                const text = $ta.val() || '';
                navigator.clipboard.writeText(text).then(() => self.showToast('Case text copied'));
            });

        $list.find('.mark-submitted-btn')
            .off('click')
            .on('click', async function() {
                const id = $(this).data('id');
                const sc = prompt('Amazon case ID (optional):', '') || '';
                try {
                    await API.patchReimbursementClaim(id, { case_status: 'submitted', seller_central_case_id: sc });
                    self.showToast('Marked as submitted');
                    self.loadReimbursementClaims();
                } catch (e) {
                    alert((e && e.error) || 'Update failed');
                }
            });

        $list.find('.download-photo-btn')
            .off('click')
            .on('click', function() {
                downloadOne($(this).data('url'), $(this).data('name'));
            });
    },

    async loadPrepSendback() {
        const $list = $('#prep-sendback-list');
        const $addr = $('#prep-sendback-address');
        if (!$list.length) return;
        try {
            await this.ensureClientPreferences();
            const data = await API.getPrepSendback();
            const prefs = data.prep_address || {};
            if ($addr.length) {
                const lines = [
                    prefs.prep_name,
                    prefs.prep_address,
                    prefs.prep_contact,
                    prefs.prep_phone,
                    prefs.prep_email,
                ].filter(Boolean);
                $addr.html(
                    lines.length
                        ? '<pre class="mb-0 small bg-light p-2 rounded">' + this.escHtml(lines.join('\n')) + '</pre>'
                        : '<p class="text-warning small mb-0">Add prep centre details in <a href="settings.html">Settings</a> first.</p>'
                );
            }
            const rows = data.requests || [];
            if (!rows.length) {
                $list.html('<p class="text-muted mb-0">No send-back requests yet.</p>');
                return;
            }
            let html = '<div class="list-group list-group-flush">';
            rows.forEach((r) => {
                html +=
                    '<div class="list-group-item px-0 py-3">' +
                    '<div class="d-flex justify-content-between"><strong>' +
                    this.escHtml(r.package_reference) +
                    '</strong><span class="badge bg-secondary">' +
                    this.escHtml(r.status) +
                    '</span></div>' +
                    '<p class="small mb-1">' +
                    this.escHtml(r.item_description) +
                    ' × ' +
                    (r.quantity || 1) +
                    '</p>' +
                    '<small class="text-muted">' +
                    (r.created_at ? RP_DATE.formatOrdinalEnGb(r.created_at) : '') +
                    '</small></div>';
            });
            html += '</div>';
            $list.html(html);
        } catch (err) {
            $list.html('<p class="text-danger">' + this.escHtml(err.error || 'Failed to load') + '</p>');
        }
        $('#prep-sendback-form')
            .off('submit')
            .on('submit', async (e) => {
                e.preventDefault();
                try {
                    await API.submitPrepSendback({
                        package_reference: $('#prep-ref').val().trim(),
                        item_description: $('#prep-item').val().trim(),
                        quantity: $('#prep-qty').val(),
                        notes: $('#prep-notes').val().trim(),
                    });
                    this.showToast('Request submitted');
                    $('#prep-sendback-form')[0].reset();
                    this.loadPrepSendback();
                } catch (err2) {
                    alert((err2 && err2.error) || 'Submit failed');
                }
            });
    },

    async loadScorecard() {
        const $root = $('#scorecard-root');
        if (!$root.length) return;
        const period = $('#scorecard-period').val() || '';
        $root.html('<div class="text-center py-4 text-muted"><span class="spinner-border spinner-border-sm"></span> Loading…</div>');
        try {
            const s = await API.getRecoveryScorecard(period || undefined);
            if ($('#scorecard-period').children().length <= 1) {
                const $sel = $('#scorecard-period');
                $sel.empty();
                (s.available_periods || []).forEach((p) => {
                    $sel.append(
                        '<option value="' +
                            p.period +
                            '"' +
                            (p.period === s.period ? ' selected' : '') +
                            '>' +
                            p.period +
                            ' · £' +
                            Number(p.amount || 0).toFixed(2) +
                            '</option>'
                    );
                });
            }
            const delta =
                s.payout.delta_vs_prior_month != null
                    ? (s.payout.delta_vs_prior_month >= 0 ? '+' : '') + '£' + Number(s.payout.delta_vs_prior_month).toFixed(2) + ' vs prior month'
                    : '';
            $root.html(
                '<div class="row g-3">' +
                '<div class="col-md-4"><div class="rp-card card border-0 p-3 h-100"><div class="small text-muted">Total recovered</div><div class="fs-3 fw-bold">£' +
                Number(s.recovery.total_recovered).toFixed(2) +
                '</div><div class="small">Resale £' +
                Number(s.recovery.resale_profit).toFixed(2) +
                ' · Reimb £' +
                Number(s.recovery.reimbursement_recovered).toFixed(2) +
                '</div></div></div>' +
                '<div class="col-md-4"><div class="rp-card card border-0 p-3 h-100"><div class="small text-muted">Payout (' +
                this.escHtml(s.period) +
                ')</div><div class="fs-3 fw-bold">£' +
                Number(s.payout.amount).toFixed(2) +
                '</div><div class="small">' +
                this.escHtml(s.payout.status) +
                (delta ? ' · ' + delta : '') +
                '</div></div></div>' +
                '<div class="col-md-4"><div class="rp-card card border-0 p-3 h-100"><div class="small text-muted">Pipeline</div><div class="fs-5 fw-bold">' +
                s.pipeline.items_processing +
                ' processing</div><div class="small">' +
                s.pipeline.reimbursement_claims_open +
                ' open claims · ' +
                s.pipeline.open_queries +
                ' open queries</div></div></div>' +
                '</div>'
            );
        } catch (err) {
            $root.html('<p class="text-danger">' + this.escHtml(err.error || 'Failed to load scorecard') + '</p>');
        }
        $('#scorecard-period')
            .off('change')
            .on('change', () => this.loadScorecard());
    },

    _initRest() {
        if (!API.isLoggedIn()) {
            window.location.assign((window.location.origin || '') + '/login.html');
            return;
        }

        const pathLower = (window.location.pathname || '').toLowerCase();
        if (pathLower.includes('reimbursement')) {
            this._initReimbursementPage();
            return;
        }

        if (API.getSessionToken()) {
            this.injectViewingAsBanner();
        } else if (API.isDelegateViewing()) {
            this.applyDelegateReadOnlyUI();
        }

        const user = API.getUser();
        this.updateUserIdentityUI(user);
        const useSession = !!API.getSessionToken();
        const self = this;
        // Verify session first with skipAuthRedirect so a 401 here does not race loadOverview / other calls
        // (which would also 401 and double-clear storage). Only then load data.
        API.request('/auth/me', { skipAuthRedirect: true }).then((me) => {
            if (me && me.user) {
                if (useSession) API.setSessionUser(me.user);
                else API.setUser(me.user);
                self.updateUserIdentityUI(me.user);
                if (me.user.linked_clients_count > 0 || me.user.is_hub_account) {
                    self.injectMyClientsLink();
                }
            }
            self._finishDashboardInit();
        }).catch((err) => {
            if (err && err.status === 401) {
                API.navigateAwayOnUnauthorized();
                return;
            }
            self._finishDashboardInit();
        });
    },

    _finishDashboardInit() {
        this.loadDashboardNotifications();
        $(document).off('click', '.rp-query-item-btn').on('click', '.rp-query-item-btn', function() {
            const $b = $(this);
            Dashboard.openItemQueryModal($b.data('ctx-type') || 'general', $b.data('ctx-id'), $b.data('ctx-label'));
        });

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

        // Detect which page we're on and load data (only true dashboard overview, never reimbursement/other subpages)
        const page = (window.location.pathname || '').toLowerCase();
        const isOverview = /\/dashboard\/?(index\.html)?$/i.test(page || '') || page === '/dashboard/index.html';
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
            this.loadSoldReturns();
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
        } else if (page.includes('queries')) {
            this.loadQueries();
        } else if (page.includes('exports')) {
            this.loadExportsHub();
        } else if (page.includes('prep-sendback')) {
            this.loadPrepSendback();
        } else if (page.includes('scorecard')) {
            this.loadScorecard();
        } else if (page.includes('my-clients')) {
            this.loadMyClients();
        }

        this.ensureClientPreferences().catch(() => {});
        this._initDashboardChrome();
        if (API.isDelegateViewing()) this.applyDelegateReadOnlyUI();

        $('#activity-date-range').on('change', () => this.loadActivity());
        $('#invoices-date-range').on('change', () => this.loadInvoices());
        $('#sold-recovery-filter').on('change', () => this.loadSold());
        $('#sold-search').on('input', () => this.loadSold());
        $('#sold-search-by').on('change', () => this.loadSold());
        $('#sold-export-csv').off('click').on('click', () => this.exportSoldItemsCsv());
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
    },

    /** Shared nav, search, modals, and attention badges for all dashboard pages. */
    _initDashboardChrome() {
        this.loadDashboardNotifications();
        this.ensureDashboardSidebarNav();
        this.injectAnnouncementsLink();
        this.injectQueriesLink();
        this.injectExportsLink();
        this.injectScorecardLink();
        this.injectPrepSendbackLink();
        this.injectMyClientsLink();
        this.injectReimbursementLink();
        this.injectConnectAmazonLink();
        this.highlightSidebarActive();
        this.fetchAnnouncementsList()
            .finally(() => {
                this.updateNotificationDots();
                this.refreshClientAttentionBadges();
            });

        this.injectTopbarExtras();
        this.initGlobalSearch();
        this.injectReferModal();
        this.injectReferSidebarLink();
        this.injectReturnsSettingsLink();
        this.injectReimbursementComingSoonModal();
        this.bindReimbursementNavGuard();
        this.injectSupportModal();
        this.injectCommandPalette();
        this.initCommandPalette();
        this.injectFooter();
        this.initMonthlySnapshotButtons();

        if (!this._dashboardChromeBound) {
            this._dashboardChromeBound = true;
            $(document).on('click', 'a[href="login.html"], a[href="../login.html"], a[href="/login.html"]', function(e) {
                if ($(this).text().trim() === 'Logout') {
                    e.preventDefault();
                    API.logout();
                }
            });
            $(document).on('click', '#support-submit-btn', function() {
                const regarding = $('#support-regarding').val() || 'general';
                const ref = $('#support-reference').val().trim();
                const msg = $('#support-message').val().trim();
                if (!msg) return alert('Please enter a message.');
                const subj = 'Support: ' + regarding + (ref ? ' – ' + ref : '');
                const mailto =
                    'mailto:support@returnpal.co?subject=' +
                    encodeURIComponent(subj) +
                    '&body=' +
                    encodeURIComponent(msg);
                const modal = bootstrap.Modal.getInstance(document.getElementById('supportModal'));
                if (modal) modal.hide();
                $('#support-reference, #support-message').val('');
                window.location.href = mailto;
            });
            if (localStorage.getItem('returnpal_dismissed_recovery_route_alert') === 'true') {
                $('#dashboard-recovery-route-alert').remove();
            }
            $(document).on('click', '#dashboard-recovery-route-alert-dismiss', function(e) {
                e.preventDefault();
                e.stopPropagation();
                localStorage.setItem('returnpal_dismissed_recovery_route_alert', 'true');
                $('#dashboard-recovery-route-alert').remove();
            });
            $(document).on('click', '#refer-send-btn', async function() {
                const email = $('#refer-email').val().trim();
                if (!email) return alert('Please enter their email.');
                const msg = $('#refer-message').val().trim();
                let link = ($('#referral-link-input').val() || '').trim();
                if (!link) {
                    try {
                        const d = await API.getReferrals();
                        link = d.referral_link || '';
                    } catch (e) { /* ignore */ }
                }
                const modal = bootstrap.Modal.getInstance(document.getElementById('referFriendModal'));
                if (modal) modal.hide();
                $('#refer-email').val('');
                $('#refer-message').val('');
                const body = (msg ? msg + '\n\n' : '') + (link ? 'Sign up with my ReturnPal referral link:\n' + link : 'Try ReturnPal for Amazon returns recovery.');
                window.location.href =
                    'mailto:' +
                    encodeURIComponent(email) +
                    '?subject=' +
                    encodeURIComponent('ReturnPal referral') +
                    '&body=' +
                    encodeURIComponent(body);
            });
            $(document).on('show.bs.modal', '#referFriendModal', async function() {
                const $inp = $('#referral-link-input');
                if ($inp.length && !$inp.val()) {
                    try {
                        const d = await API.getReferrals();
                        if (d.referral_link) $inp.val(d.referral_link);
                    } catch (e) { /* ignore */ }
                }
            });
        }
    },

    /** Pages like exports.html ship with an empty #navbar-nav; inject the standard menu. */
    ensureDashboardSidebarNav() {
        const $nav = $('#navbar-nav');
        if (!$nav.length) return;
        if ($nav.find('li.nav-item a.nav-link[href]').length >= 5) return;

        const page = (window.location.pathname || '').split('/').pop() || 'index.html';
        const items = [
            ['index.html', 'ri-dashboard-3-line', 'Overview'],
            ['my-clients.html', 'ri-group-line', 'My clients'],
            ['packages.html', 'ri-box-3-line', 'Packages Sent'],
            ['received.html', 'ri-import-line', 'Received'],
            ['sold-items.html', 'ri-list-view', 'Sold Items'],
            ['item-pending.html', 'ri-time-line', 'Items Pending'],
            ['activity.html', 'ri-history-line', 'Activity'],
            ['inventory.html', 'ri-archive-drawer-line', 'Inventory'],
            ['analytics.html', 'ri-line-chart-line', 'Analytics'],
            ['invoices.html', 'ri-receipt-line', 'Payouts & Invoices'],
            ['queries.html', 'ri-question-answer-line', 'My queries'],
            ['exports.html', 'ri-download-cloud-2-line', 'Exports hub'],
            ['scorecard.html', 'ri-pie-chart-2-line', 'Recovery scorecard'],
            ['prep-sendback.html', 'ri-truck-line', 'Prep send-back'],
            ['roi-report.html', 'ri-file-text-line', 'ROI Report'],
            ['reimbursement.html', 'ri-refund-line', 'Reimbursement / Claims'],
            ['referrals.html', 'ri-user-shared-line', 'Referrals'],
            ['settings.html', 'ri-settings-3-line', 'Settings'],
            ['faq.html', 'ri-question-line', 'FAQ'],
        ];

        let html = '<li class="menu-title">Menu</li>';
        items.forEach(([href, icon, text]) => {
            const active = href === page ? ' active' : '';
            html +=
                '<li class="nav-item"><a class="nav-link' +
                active +
                '" href="' +
                href +
                '"><span class="nav-icon"><i class="' +
                icon +
                '"></i></span><span class="nav-text">' +
                text +
                '</span></a></li>';
        });
        html +=
            '<li class="nav-item"><a class="nav-link" href="#" data-bs-toggle="modal" data-bs-target="#referFriendModal"><span class="nav-icon"><i class="ri-user-shared-line"></i></span><span class="nav-text">Refer a seller</span></a></li>';
        $nav.html(html);
    },

    highlightSidebarActive() {
        const page = (window.location.pathname || '').split('/').pop() || 'index.html';
        const norm = page === '' || page === 'dashboard' ? 'index.html' : page;
        $('#navbar-nav .nav-link').removeClass('active');
        $('#navbar-nav .nav-link[href="' + norm + '"]').addClass('active');
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
        if ($('#navbar-nav a[href="reimbursement.html"], #navbar-nav a[href="/dashboard/reimbursement.html"]').length) return;
        const $settings = $('#navbar-nav a[href="settings.html"]').closest('li');
        if ($settings.length) $settings.before('<li class="nav-item"><a class="nav-link" href="reimbursement.html"><span class="nav-icon"><i class="ri-refund-line"></i></span><span class="nav-text">Reimbursement / Claims</span></a></li>');
    },
    injectQueriesLink() {
        if ($('#navbar-nav a[href="queries.html"]').length) return;
        const $inv = $('#navbar-nav a[href="invoices.html"]').closest('li');
        if ($inv.length) {
            $inv.after('<li class="nav-item"><a class="nav-link" href="queries.html"><span class="nav-icon"><i class="ri-question-answer-line"></i></span><span class="nav-text">My queries</span></a></li>');
        }
    },
    injectExportsLink() {
        if ($('#navbar-nav a[href="exports.html"]').length) return;
        const $q = $('#navbar-nav a[href="queries.html"]').closest('li');
        if ($q.length) {
            $q.after('<li class="nav-item"><a class="nav-link" href="exports.html"><span class="nav-icon"><i class="ri-download-cloud-2-line"></i></span><span class="nav-text">Exports hub</span></a></li>');
        } else {
            const $inv = $('#navbar-nav a[href="invoices.html"]').closest('li');
            if ($inv.length) $inv.after('<li class="nav-item"><a class="nav-link" href="exports.html"><span class="nav-icon"><i class="ri-download-cloud-2-line"></i></span><span class="nav-text">Exports hub</span></a></li>');
        }
    },
    injectScorecardLink() {
        if ($('#navbar-nav a[href="scorecard.html"]').length) return;
        const $exp = $('#navbar-nav a[href="exports.html"]').closest('li');
        const $inv = $('#navbar-nav a[href="invoices.html"]').closest('li');
        const $anchor = $exp.length ? $exp : $inv;
        if (!$anchor.length) return;
        $anchor.after(
            '<li class="nav-item"><a class="nav-link" href="scorecard.html"><span class="nav-icon"><i class="ri-pie-chart-2-line"></i></span><span class="nav-text">Recovery scorecard</span></a></li>'
        );
    },
    injectPrepSendbackLink() {
        if ($('#navbar-nav a[href="prep-sendback.html"]').length) return;
        const $sc = $('#navbar-nav a[href="scorecard.html"]').closest('li');
        const $exp = $('#navbar-nav a[href="exports.html"]').closest('li');
        const $anchor = $sc.length ? $sc : $exp;
        if (!$anchor.length) return;
        $anchor.after(
            '<li class="nav-item"><a class="nav-link" href="prep-sendback.html"><span class="nav-icon"><i class="ri-truck-line"></i></span><span class="nav-text">Prep send-back</span></a></li>'
        );
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

    injectViewingAsBanner() {
        if ($('#rp-impersonation-banner').length) return;
        const user = API.getUser();
        const name = (user && (user.full_name || user.email)) || 'Client';
        const isDelegate = API.isDelegateViewing();
        const exitLabel = isDelegate ? 'Back to My clients' : 'Return to admin';
        const exitHref = isDelegate ? 'my-clients.html' : '/admin/index.html';
        const readOnlyNote = isDelegate
            ? ' <span class="text-muted">· Read-only (no add/edit/delete)</span>'
            : '';
        const html =
            '<div id="rp-impersonation-banner" class="d-flex align-items-center justify-content-between px-3 py-2 bg-warning bg-opacity-25 border-bottom border-warning" style="position:sticky;top:0;z-index:1025;">' +
            '<span class="small"><strong>Viewing ' +
            (isDelegate ? 'client: ' : 'as ') +
            (name.replace(/</g, '&lt;')) +
            '</strong>' +
            readOnlyNote +
            '</span>' +
            '<a href="' +
            exitHref +
            '" class="btn btn-sm btn-outline-dark rp-exit-view-as">' +
            exitLabel +
            '</a>' +
            '</div>';
        const $target = $('.page-content').length ? $('.page-content') : $('body');
        $target.prepend(html);
        $('#rp-impersonation-banner .rp-exit-view-as').on('click', function(e) {
            e.preventDefault();
            sessionStorage.removeItem('returnpal_impersonating');
            sessionStorage.removeItem('returnpal_delegate_viewing');
            API.clearSessionAuth();
            window.location.assign(isDelegate ? 'my-clients.html' : '/admin/index.html');
        });
        if (isDelegate) this.applyDelegateReadOnlyUI();
    },

    applyDelegateReadOnlyUI() {
        if (!API.isDelegateViewing()) return;
        document.body.classList.add('rp-delegate-readonly');

        const hideSel = [
            '#reimbursement-submit-card',
            '#reimbursement-submit-form',
            '#prep-sendback-form',
            '#prep-sendback-address',
            '#support-submit-btn',
            '#queries-new-form',
            '#query-submit-btn',
            '#settings-password-form',
            '#settings-prefs-form',
            '#settings-prep-form',
            '#settings-email-form',
            '#returns-settings-save',
            '#refer-invite-form',
        ];
        hideSel.forEach((sel) => {
            const $el = $(sel);
            if (!$el.length) return;
            $el.closest('.rp-card, .card, form').addClass('d-none');
            $el.addClass('d-none');
        });

        $('.mark-submitted-btn, .reimb-filter-btn, .rp-query-item-btn').addClass('d-none');
        $('#reimbursement-list .reimb-actions .btn').not('.copy-case-text-btn').addClass('d-none');

        $('button[type="submit"], input[type="submit"]')
            .not('.rp-exit-view-as')
            .prop('disabled', true)
            .addClass('disabled');

        $('form').each(function() {
            const $f = $(this);
            if ($f.closest('#commandPaletteModal').length) return;
            $f.on('submit.rpDelegateReadonly', function(e) {
                e.preventDefault();
                Dashboard.showToast('Read-only — contact ReturnPal to make changes');
                return false;
            });
        });

        $(document).on('click.rpDelegateReadonly', 'a.btn-primary, button.btn-primary', function(e) {
            if (!API.isDelegateViewing()) return;
            const $t = $(this);
            if ($t.closest('#rp-impersonation-banner, .main-nav, .topbar').length) return;
            if ($t.hasClass('copy-case-text-btn') || $t.hasClass('hub-open-dashboard-btn')) return;
            if ($t.attr('href') && $t.attr('href').indexOf('.html') >= 0) return;
            e.preventDefault();
            e.stopPropagation();
            Dashboard.showToast('Read-only — contact ReturnPal to make changes');
        });
    },

    injectMyClientsLink() {
        if ($('#navbar-nav a[href="my-clients.html"]').length) return;
        const user = API.getUser();
        const count = user && user.linked_clients_count;
        if (count != null && count <= 0) return;
        const $idx = $('#navbar-nav a[href="index.html"]').closest('li');
        if (!$idx.length) return;
        $idx.after(
            '<li class="nav-item"><a class="nav-link" href="my-clients.html"><span class="nav-icon"><i class="ri-group-line"></i></span><span class="nav-text">My clients</span></a></li>'
        );
        if (count == null) {
            API.getHubMeta()
                .then((m) => {
                    if (!m || !m.is_hub_account) {
                        $('#navbar-nav a[href="my-clients.html"]').closest('li').remove();
                    }
                })
                .catch(() => {});
        }
    },

    async loadMyClients() {
        const $root = $('#hub-clients-root');
        const $totals = $('#hub-totals-row');
        if (!$root.length) return;
        try {
            const data = await API.getHubOverview();
            const clients = data.clients || [];
            const t = data.totals || {};
            if ($totals.length) {
                $totals.html(
                    '<div class="col-md-3"><div class="rp-card card border-0 p-3"><div class="text-muted small">Linked clients</div><div class="fs-4 fw-semibold">' +
                        (data.client_count || 0) +
                        '</div></div></div>' +
                        '<div class="col-md-3"><div class="rp-card card border-0 p-3"><div class="text-muted small">Packages (all)</div><div class="fs-4 fw-semibold">' +
                        (t.packages_total || 0) +
                        '</div></div></div>' +
                        '<div class="col-md-3"><div class="rp-card card border-0 p-3"><div class="text-muted small">Processing</div><div class="fs-4 fw-semibold">' +
                        (t.items_processing || 0) +
                        '</div></div></div>' +
                        '<div class="col-md-3"><div class="rp-card card border-0 p-3"><div class="text-muted small">Open claims</div><div class="fs-4 fw-semibold">' +
                        (t.reimbursement_claims_open || 0) +
                        '</div></div></div>'
                );
            }
            if (!clients.length) {
                $root.html(
                    '<p class="text-muted mb-0">No linked clients yet. Ask ReturnPal to connect your prep centre account to the client IDs you manage.</p>'
                );
                return;
            }
            let html =
                '<div class="table-responsive"><table class="table table-sm align-middle mb-0"><thead><tr>' +
                '<th>Client</th><th>Packages</th><th>Processing</th><th>Claims</th><th>Recovery</th><th>Payout</th><th></th>' +
                '</tr></thead><tbody>';
            clients.forEach((c) => {
                html +=
                    '<tr><td><strong>' +
                    this.escHtml(c.name) +
                    '</strong><br><span class="small text-muted">' +
                    this.escHtml(c.client_code) +
                    (c.legacy_client_id ? ' · Legacy ' + this.escHtml(c.legacy_client_id) : '') +
                    '</span></td>' +
                    '<td>' +
                    (c.packages_total || 0) +
                    '</td><td>' +
                    (c.items_processing || 0) +
                    '</td><td>' +
                    (c.reimbursement_claims_open || 0) +
                    '</td><td>£' +
                    Number(c.recovery_total || 0).toFixed(2) +
                    '</td><td class="small">£' +
                    Number(c.payout_pending || 0).toFixed(2) +
                    ' <span class="text-muted">' +
                    this.escHtml(c.payout_status || '') +
                    '</span></td>' +
                    '<td class="text-end"><button type="button" class="btn btn-sm btn-primary hub-open-dashboard-btn" data-client-id="' +
                    c.client_id +
                    '">Open dashboard</button></td></tr>';
            });
            html += '</tbody></table></div>';
            $root.html(html);
            const self = this;
            $root.find('.hub-open-dashboard-btn').on('click', async function() {
                const id = $(this).data('client-id');
                $(this).prop('disabled', true);
                try {
                    const res = await API.hubViewAs(id);
                    if (res.token) {
                        window.location.assign(
                            'index.html?view_as=' + encodeURIComponent(res.token)
                        );
                    }
                } catch (e) {
                    alert((e && e.error) || 'Could not open client dashboard');
                    $(this).prop('disabled', false);
                }
            });
        } catch (err) {
            $root.html('<p class="text-danger">' + this.escHtml((err && err.error) || 'Failed to load clients') + '</p>');
        }
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
                '<i class="ri-notification-3-line fs-24"></i>' +
                '<span id="dashboard-notifications-badge" class="position-absolute top-0 start-100 translate-middle badge rounded-pill bg-danger py-1 px-1 d-none" style="font-size: 10px;">0</span>' +
                '</button>' +
                '<div class="dropdown-menu dropdown-menu-end py-0" style="min-width: 320px;">' +
                '<div class="dropdown-header border-bottom">Notifications</div>' +
                '<div id="dashboard-notifications-items" class="py-3 px-3 text-center text-muted small">Loading…</div>' +
                '<a class="dropdown-item text-center small text-primary" href="activity.html">View all activity</a>' +
                '</div></div>' +
                '<a href="/index.html#contact" class="topbar-item topbar-button d-none d-lg-flex align-items-center" title="Help"><i class="ri-customer-service-2-line fs-24"></i></a>'
            );

            // Load per-client notifications from the backend
            (async () => {
                try {
                    const data = await API.getDashboardSummary();
                    const recent = (data && data.recent_activity) ? data.recent_activity : [];
                    const items = recent.slice(0, 4);
                    const $itemsWrap = $('#dashboard-notifications-items');
                    if (!$itemsWrap.length) return;

                    if (items.length === 0) {
                        $itemsWrap.html('<div class="py-4 text-muted small">No new notifications</div>');
                        $('#dashboard-notifications-badge').addClass('d-none');
                        return;
                    }

                    $itemsWrap.empty();
                    items.forEach((evt, idx) => {
                        const msg = evt.message ? String(evt.message) : 'Notification';
                        const icon = evt.icon ? String(evt.icon) : 'ri-circle-line';
                        const href = evt.link ? String(evt.link) : 'activity.html';
                        const border = idx < items.length - 1 ? ' border-bottom' : '';
                        $itemsWrap.append(
                            '<a class="dropdown-item py-3' + border + '" href="' + href + '">' +
                            '<i class="' + icon + ' me-2 align-middle"></i>' +
                            msg +
                            '</a>'
                        );
                    });

                    const $badge = $('#dashboard-notifications-badge');
                    $badge.text(items.length);
                    $badge.removeClass('d-none');
                } catch (e) {
                    const $itemsWrap = $('#dashboard-notifications-items');
                    if ($itemsWrap.length) $itemsWrap.html('<div class="py-4 text-danger small">Unable to load notifications.</div>');
                }
            })();
        }
    },

    /** Sales month column only: e.g. "April 2026" (no day — statement is for the whole calendar month). */
    formatStatementPeriodLabel(ymKey) {
        if (!ymKey || !/^\d{4}-\d{2}$/.test(String(ymKey))) return '-';
        const parts = String(ymKey).split('-').map(Number);
        const y = parts[0];
        const mo = parts[1];
        if (!y || !mo || mo < 1 || mo > 12) return '-';
        const d = new Date(y, mo - 1, 1);
        return d.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    },

    // ─── Helper: human-readable calendar date (e.g. May 1st 2026). CSV / APIs use formatDateIso. ──
    formatDate(dateStr) {
        if (!dateStr) return '-';
        return RP_DATE.formatOrdinalEnGb(dateStr);
    },

    formatDateNumeric(dateStr) {
        if (!dateStr) return '-';
        return RP_DATE.formatOrdinalEnGb(dateStr);
    },

    /** YYYY-MM-DD for CSV / Excel (avoids US vs UK mis-reading of numeric dates). */
    formatDateIso(dateStr) {
        if (!dateStr) return '-';
        return RP_DATE.formatIso(dateStr);
    },

    /** Sold list date: server-computed sold_date_label only (do not re-parse on the client). */
    soldDateDisplayValue(item) {
        const apiLab = item && item.sold_date_label && String(item.sold_date_label).trim();
        if (apiLab) return apiLab;
        const iso =
            item && item.sold_date_display && String(item.sold_date_display).trim()
                ? item.sold_date_display
                : item && item.sold_date;
        if (iso && typeof RP_DATE !== 'undefined' && RP_DATE.formatOrdinalEnGb) {
            const lab = RP_DATE.formatOrdinalEnGb(iso);
            if (lab && lab !== '-') return lab;
        }
        return '-';
    },

    _soldDateSortKey(item) {
        const raw =
            item && item.sold_date_display != null && String(item.sold_date_display).trim() !== ''
                ? item.sold_date_display
                : item && item.sold_date;
        const iso =
            typeof RP_DATE !== 'undefined' && RP_DATE.stripSoldDateToIsoHead
                ? RP_DATE.stripSoldDateToIsoHead(raw)
                : String(raw || '').trim();
        return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : '0000-00-00';
    },

    /** Newest sold_date first (matches API sort); tie-break by id descending. */
    soldItemsSortRecentFirst(a, b) {
        const ia = this._soldDateSortKey(a);
        const ib = this._soldDateSortKey(b);
        const sa = ia && ia !== '-' ? ia : '0000-00-00';
        const sb = ib && ib !== '-' ? ib : '0000-00-00';
        if (sa !== sb) return sb.localeCompare(sa);
        return (Number(b.id) || 0) - (Number(a.id) || 0);
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
        const clientIdFormatted = this.formatClientId(user) || '—';
        const $clientIdVal = $('#dashboard-client-id-value');
        if ($clientIdVal.length) $clientIdVal.text(clientIdFormatted);
        $('#dashboard-copy-client-id').off('click').on('click', function() {
            const id = (API.getUser() || {}).id;
            const n = parseInt(id, 10);
            if (!Number.isFinite(n) || n <= 0) return;
            const toCopy = String(n).padStart(4, '0');
            navigator.clipboard.writeText(toCopy).then(() => {
                Dashboard.showToast('Client ID copied to clipboard', 'success');
            }).catch(() => {});
        });

        const $feed = $('#dashboard-activity');
        if ($feed.length) this.showLoading($feed, 'Loading…');

        let packagesSent = 0;
        try {
            const [data, bal, ledgerData] = await Promise.all([
                API.getDashboardSummary(),
                API.getBalanceSummary().catch(() => null),
                API.getBalanceLedger({ limit: 8 }).catch(() => ({ lines: [] }))
            ]);
            const totalRecovered = Number(data.total_recovered) || 0;
            const itemsProcessing = Number(data.items_processing) || 0;
            const itemsSold = Number(data.items_sold) || 0;
            packagesSent = Number(data.packages_sent) || 0;

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
            const claimsTotal = Number(data.reimbursement_claims_total) || 0;
            this.updateOnboardingCheckmark('#onboarding-5', claimsTotal > 0, 'reimbursement.html');

            const $wRec = $('#dash-week-received');
            if ($wRec.length) {
                $wRec.text(String(Number(data.week_received_count) || 0));
                $('#dash-week-sold').text(String(Number(data.week_sold_count) || 0));
                $('#dash-week-claims').text(String(Number(data.week_claims_count) || 0));
            }

            const escBal = (s) => String(s == null ? '' : s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
            const $balCard = $('#dashboard-balance-card');
            if ($balCard.length && bal) {
                $('#dash-balance-current').text('£' + Number(bal.current_balance || 0).toFixed(2));
                const pend = Number(bal.pending_returns || 0);
                $('#dash-balance-pending').text('−£' + pend.toFixed(2));
                $('#dash-balance-pending-note').text(bal.pending_returns_count ? '(' + bal.pending_returns_count + ' open)' : '');
                const lines = ledgerData && ledgerData.lines ? ledgerData.lines : [];
                const $prev = $('#dash-balance-ledger-preview');
                if ($prev.length) {
                    if (!lines.length) {
                        $prev.html('<p class="text-muted small mb-0">No recent sale or return lines yet.</p>');
                    } else {
                        let lh = '<div class="small fw-semibold text-muted mb-1">Recent movement</div><ul class="list-unstyled small mb-0">';
                        lines.slice(0, 6).forEach((ln) => {
                            const amt = Number(ln.amount) || 0;
                            const pos = amt >= 0;
                            lh += '<li class="d-flex justify-content-between py-1 border-bottom border-light-subtle"><span>' + escBal(ln.label || '') + '</span><span class="' + (pos ? 'text-success' : 'text-danger') + '">' + (pos ? '+' : '−') + '£' + Math.abs(amt).toFixed(2) + '</span></li>';
                        });
                        lh += '</ul><a href="invoices.html" class="small">Monthly statement →</a>';
                        $prev.html(lh);
                    }
                }
            }

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
                this.renderAnnouncementsWidget($annWidget);
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
            a.download = 'returnpal-overview-' + RP_DATE.formatIso(new Date()) + '.csv';
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
        return RP_DATE.formatOrdinalEnGb(d);
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
                // Ensure modal buttons work even when there are no existing packages.
                this.bindPackageEvents();
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
        // loadPackages() runs again after create/update, so guard against double-binding.
        if (this._packageEventsBound) return;
        this._packageEventsBound = true;
        const self = this;

        // ─── Add/Edit package modal: add/remove product rows ─────────────
        $(document).on('click', '#addPackage .add-new', function() {
            const modal = $('#addPackage');
            const wrapper = modal.find('.product-wrapper');
            if (!wrapper.length) return;
            const rows = wrapper.find('.product-row');
            const $firstRow = rows.first();
            if (!$firstRow.length) return;

            // Clone the first row so the UI fields stay consistent with the current HTML.
            const $newRow = $firstRow.clone(false, false);
            $newRow.find('input, select, textarea').each(function() {
                const $el = $(this);
                const type = ($el.attr('type') || '').toLowerCase();
                if (type === 'number') {
                    // Qty and/or cost inputs
                    if ($el.hasClass('rp-product-qty')) $el.val(1);
                    else $el.val('');
                } else if ($el.is('select')) {
                    $el.val('New');
                } else {
                    $el.val('');
                }
            });

            // Enable/disable remove based on new total
            wrapper.append($newRow);
            const updatedRows = wrapper.find('.product-row');
            updatedRows.find('.remove-row').prop('disabled', updatedRows.length <= 1);
        });

        $(document).on('click', '#addPackage .remove-row', function() {
            const modal = $('#addPackage');
            const wrapper = modal.find('.product-wrapper');
            if (!wrapper.length) return;
            $(this).closest('.product-row').remove();
            const rows = wrapper.find('.product-row');
            if (rows.length <= 1) {
                rows.find('.remove-row').prop('disabled', true);
            } else {
                rows.find('.remove-row').prop('disabled', false);
            }
        });

        $(document).on('click', '#editPackage .add-new', function() {
            const modal = $('#editPackage');
            const wrapper = modal.find('.product-wrapper');
            if (!wrapper.length) return;
            const rows = wrapper.find('.product-row');
            const $firstRow = rows.first();
            if (!$firstRow.length) return;
            const $newRow = $firstRow.clone(false, false);
            $newRow.find('input, select, textarea').each(function() {
                const $el = $(this);
                const type = ($el.attr('type') || '').toLowerCase();
                if (type === 'number') {
                    if ($el.hasClass('rp-product-qty')) $el.val(1);
                    else $el.val('');
                } else if ($el.is('select')) {
                    $el.val('New');
                } else {
                    $el.val('');
                }
            });
            wrapper.append($newRow);
            const updatedRows = wrapper.find('.product-row');
            updatedRows.find('.remove-row').prop('disabled', updatedRows.length <= 1);
        });

        $(document).on('click', '#editPackage .remove-row', function() {
            const modal = $('#editPackage');
            const wrapper = modal.find('.product-wrapper');
            if (!wrapper.length) return;
            $(this).closest('.product-row').remove();
            const rows = wrapper.find('.product-row');
            if (rows.length <= 1) {
                rows.find('.remove-row').prop('disabled', true);
            } else {
                rows.find('.remove-row').prop('disabled', false);
            }
        });

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
            // Be tolerant: fall back to older DOM structure if rp-* classes aren't present.
            const $row = $(this);
            const $nameEl = $row.find('.rp-product-name').first();
            const name = ($nameEl.length ? $nameEl.val() : $row.find('input[type="text"]').first().val() || '').toString().trim();

            const $asinEl = $row.find('.rp-product-asin').first();
            const asin = $asinEl.length ? ($asinEl.val() || '').toString().trim() : '';

            const $qtyEl = $row.find('.rp-product-qty').first();
            let qty = 1;
            if ($qtyEl.length) {
                qty = parseInt($qtyEl.val(), 10) || 1;
            } else {
                // Try to pick the numeric input that looks like "Qty" (min >= 1).
                const $qtyCandidates = $row.find('input[type="number"]').filter(function() {
                    const minAttr = parseFloat($(this).attr('min') || '0');
                    return !isNaN(minAttr) && minAttr >= 1;
                });
                qty = parseInt(($qtyCandidates.first().val() || ''), 10) || 1;
            }

            const $condEl = $row.find('.rp-product-condition').first();
            const condition = $condEl.length ? $condEl.val() : ($row.find('select').first().val() || 'New');

            const $costEl = $row.find('.rp-product-cost').first();
            let cost = null;
            if ($costEl.length) {
                const costStr = ($costEl.val() || '').toString().trim();
                const costNum = costStr ? Number(costStr) : null;
                if (costNum != null && !isNaN(costNum) && costNum >= 0) cost = costNum;
            }
            if (name) {
                const product = { product_name: name, quantity: qty, condition: condition };
                if (asin) product.asin = asin;
                if (cost != null) product.cost_of_goods = cost;
                products.push(product);
            }
        });
        return products;
    },

    // ─── RECEIVED PAGE (one row per parcel / package; units drill-down in modal) ─
    _receivedSort: { key: 'date_received', dir: 'desc' },
    _receivedPackagesFiltered: [],
    deliveryStatusBadge(status) {
        const s = String(status || '');
        const sl = s.toLowerCase();
        if (sl === 'delivered' || sl === 'received') return '<span class="badge bg-success-subtle text-success py-1 px-2 fs-12">' + s + '</span>';
        if (sl === 'processing') return '<span class="badge bg-primary-subtle text-primary py-1 px-2 fs-12">' + s + '</span>';
        if (sl === 'in transit') return '<span class="badge bg-warning-subtle text-warning py-1 px-2 fs-12">' + s + '</span>';
        if (sl === 'cancelled') return '<span class="badge bg-secondary-subtle text-secondary py-1 px-2 fs-12">' + s + '</span>';
        if (sl === 'processed') return '<span class="badge bg-info-subtle text-info py-1 px-2 fs-12">' + s + '</span>';
        return '<span class="badge bg-light text-dark py-1 px-2 fs-12">' + s + '</span>';
    },
    buildReceivedPackageRow(pkg) {
        const esc = (s) => String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        const escAttr = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        const pct = pkg.total_units > 0 ? Math.min(100, Math.round((pkg.processed_units / pkg.total_units) * 100)) : 0;
        const progressHtml =
            '<div class="d-flex align-items-center gap-2 flex-wrap">' +
            '<div class="progress flex-grow-1" style="height:10px;min-width:100px;max-width:240px;">' +
            '<div class="progress-bar bg-success" role="progressbar" style="width:' + pct + '%" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100"></div></div>' +
            '<span class="small text-nowrap"><strong>' + esc(pkg.processed_units) + '</strong>/' + esc(pkg.total_units) + ' units processed</span>' +
            (pkg.pending_units > 0 ? ' <span class="small text-muted">(' + esc(pkg.pending_units) + ' still pending)</span>' : '') +
            '</div>';
        return '<tr>' +
            '<td><strong>' + esc(pkg.reference) + '</strong></td>' +
            '<td>' + this.deliveryStatusBadge(pkg.delivery_status) + '</td>' +
            '<td>' + progressHtml + '</td>' +
            '<td>' + esc(this.formatDate(pkg.date_received)) + '</td>' +
            '<td><span class="text-muted">—</span></td>' +
            '<td class="small">' + (pkg.notes ? esc(pkg.notes) : '—') + '</td>' +
            '<td><button type="button" class="btn btn-sm btn-outline-primary rp-received-units-btn" data-rp-ref="' + escAttr(pkg.reference) + '">View units</button></td>' +
            '</tr>';
    },
    openReceivedUnitsModal(pkg) {
        const esc = (s) => String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        const title = document.getElementById('received-units-modal-title');
        const body = document.getElementById('received-units-modal-body');
        if (title) title.textContent = 'Package ' + (pkg.reference || '');
        if (!body) return;
        const rows = (pkg.items || []).map((it) =>
            '<tr><td>' + esc(it.items_description) + '</td><td class="text-center">' + esc(it.quantity) + '</td><td>' + this.statusBadge(it.status) + '</td></tr>'
        ).join('');
        const summary =
            '<p class="small text-muted mb-2">Processed: <strong>' + esc(pkg.processed_units) + '</strong> of <strong>' + esc(pkg.total_units) + '</strong> units · ' +
            'Pending: <strong>' + esc(pkg.pending_units) + '</strong>' +
            (pkg.rejected_units > 0 ? ' · Rejected: <strong>' + esc(pkg.rejected_units) + '</strong>' : '') +
            '</p>';
        body.innerHTML =
            summary +
            '<div class="table-responsive"><table class="table table-sm table-bordered mb-0">' +
            '<thead><tr><th>Line / product</th><th class="text-center">Qty</th><th>Status</th></tr></thead>' +
            '<tbody>' + (rows || '<tr><td colspan="3" class="text-muted text-center">No lines recorded yet.</td></tr>') + '</tbody></table></div>';
        const el = document.getElementById('received-units-modal');
        if (el && window.bootstrap) {
            const inst = bootstrap.Modal.getInstance(el);
            if (inst) inst.show();
            else new bootstrap.Modal(el).show();
        }
    },
    async loadReceived() {
        const $tbody = $('#received-table tbody');
        if (!$tbody.length) return;
        $tbody.html('<tr><td colspan="7" class="text-center py-5 text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</td></tr>');
        try {
            const data = await API.getReceived();
            $tbody.empty();
            const packages = Array.isArray(data.packages) ? data.packages : [];
            const totalLabel = typeof data.total === 'number' ? data.total : packages.length;
            $('.seco-title').text(totalLabel + ' packages');

            if (!packages.length) {
                $tbody.html('<tr><td colspan="7" class="text-center py-5"><p class="text-muted mb-3">No received packages yet. Add a package and we’ll list it here once it arrives.</p><a href="packages.html" class="btn btn-primary">Go to Packages</a></td></tr>');
                return;
            }

            const searchQ = ($('#received-search').val() || '').trim().toLowerCase();
            const searchBy = ($('#received-search-by').val() || 'all').toLowerCase();
            let list = packages.slice();
            if (searchQ) {
                if (searchBy === 'reference') list = list.filter((p) => String(p.reference || '').toLowerCase().includes(searchQ));
                else if (searchBy === 'delivery_status') list = list.filter((p) => String(p.delivery_status || '').toLowerCase().includes(searchQ));
                else if (searchBy === 'items_description') {
                    list = list.filter((p) => (p.items || []).some((i) => String(i.items_description || '').toLowerCase().includes(searchQ)));
                } else if (searchBy === 'notes') list = list.filter((p) => String(p.notes || '').toLowerCase().includes(searchQ));
                else {
                    list = list.filter((p) => {
                        const blob = [
                            p.reference,
                            p.delivery_status,
                            p.notes,
                            ...(p.items || []).map((i) => (i.items_description || '') + ' ' + (i.notes || ''))
                        ].join(' ').toLowerCase();
                        return blob.includes(searchQ);
                    });
                }
            }
            const { key, dir } = this._receivedSort;
            const mult = dir === 'asc' ? 1 : -1;
            list.sort((a, b) => {
                let va;
                let vb;
                if (key === 'date_received') {
                    va = new Date(a.date_received || 0).getTime();
                    vb = new Date(b.date_received || 0).getTime();
                } else if (key === 'reference' || key === 'delivery_status') {
                    va = String(a[key] || '').toLowerCase();
                    vb = String(b[key] || '').toLowerCase();
                } else if (key === 'progress') {
                    va = a.total_units > 0 ? a.processed_units / a.total_units : 0;
                    vb = b.total_units > 0 ? b.processed_units / b.total_units : 0;
                } else {
                    va = 0;
                    vb = 0;
                }
                if (va < vb) return -1 * mult;
                if (va > vb) return 1 * mult;
                return 0;
            });
            this._receivedPackagesFiltered = list;
            const pageSize = 20;
            this._receivedVisible = Math.min(pageSize, list.length);
            const toShow = list.slice(0, this._receivedVisible);
            toShow.forEach((pkg) => $tbody.append(this.buildReceivedPackageRow(pkg)));
            const $loadMore = $('#received-load-more');
            if ($loadMore.length) {
                if (list.length > this._receivedVisible) {
                    $loadMore.removeClass('d-none');
                    $('#received-load-more-btn').off('click').on('click', () => {
                        this._receivedVisible = Math.min(this._receivedVisible + pageSize, this._receivedPackagesFiltered.length);
                        $tbody.empty();
                        this._receivedPackagesFiltered.slice(0, this._receivedVisible).forEach((pkg) => $tbody.append(this.buildReceivedPackageRow(pkg)));
                        if (this._receivedVisible >= this._receivedPackagesFiltered.length) $loadMore.addClass('d-none');
                        this.renderReceivedSortIcons();
                    });
                } else $loadMore.addClass('d-none');
            }
            $('.seco-title').text(list.length + ' packages' + (searchQ ? ' (filtered)' : ''));
            this.renderReceivedSortIcons();
            $(document).off('input', '#received-search').on('input', '#received-search', () => this.loadReceived());
            $(document).off('click', '#received-table .rp-sortable').on('click', '#received-table .rp-sortable', (e) => {
                const sortKey = $(e.currentTarget).data('sort');
                if (!sortKey) return;
                if (this._receivedSort.key === sortKey) this._receivedSort.dir = this._receivedSort.dir === 'asc' ? 'desc' : 'asc';
                else this._receivedSort = { key: sortKey, dir: 'asc' };
                this.loadReceived();
            });
            const self = this;
            $(document).off('click.rprecv', '.rp-received-units-btn').on('click.rprecv', '.rp-received-units-btn', function() {
                const ref = $(this).attr('data-rp-ref');
                const pkg = (self._receivedPackagesFiltered || []).find((p) => p.reference === ref);
                if (pkg) self.openReceivedUnitsModal(pkg);
            });
        } catch (err) {
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
        const $tbody = $('#sold-items-tbody');
        if ($tbody.length) $tbody.html('<tr><td colspan="6" class="text-center py-5 text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</td></tr>');
        try {
            const data = await API.getSold();

            const esc = (s) => String(s == null ? '' : s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
            const escAttr = (s) => esc(s).replace(/'/g, '&#039;');
            const formatYmLabel = (ym) => {
                if (!ym || typeof ym !== 'string') return '';
                const p = ym.split('-');
                const y = parseInt(p[0], 10);
                const m = parseInt(p[1], 10);
                if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return ym;
                return y + '-' + String(m).padStart(2, '0');
            };
            const productCell = (item) => {
                let badge = '';
                if (item.is_monthly_free_processing) {
                    const title = 'Highest-value eligible resale in ' + formatYmLabel(item.monthly_free_processing_month) + ' — processing fee waived on this line (you keep 100% of this sale).';
                    badge = '<span class="badge bg-info-subtle text-info ms-1" title="' + escAttr(title) + '">Fee waived</span>';
                }
                return esc(item.product) + badge;
            };
            const soldRowHtml = (item) => {
                const gross = Number(item.profit != null ? item.profit : 0);
                const ret = Number(item.returns_deducted != null ? item.returns_deducted : 0);
                const net = Number(item.net_after_returns != null ? item.net_after_returns : gross - ret);
                let retTitle = '';
                if (item.returns_exceed_sale && Array.isArray(item.linked_return_adjustments) && item.linked_return_adjustments.length) {
                    const parts = item.linked_return_adjustments.map((a) => {
                        const p = (a.product || 'Refund').slice(0, 80);
                        return '£' + (Number(a.amount) || 0).toFixed(2) + ' — ' + p;
                    });
                    retTitle = ' title="Linked refund(s) exceed this sale. ' + escAttr(parts.join('; ')) + '"';
                }
                const retCell = ret > 0
                    ? '<td class="text-danger"' + retTitle + '>£' + ret.toFixed(2) + '</td>'
                    : '<td class="text-muted">—</td>';
                const netClass = net < 0 ? 'text-danger' : 'text-success';
                return (
                    '<tr>' +
                    '<td>' + this.soldDateDisplayValue(item) + '</td>' +
                    '<td>' + productCell(item) + '</td>' +
                    '<td>' + esc(String(item.quantity)) + '</td>' +
                    '<td class="text-success">£' + gross.toFixed(2) + '</td>' +
                    retCell +
                    '<td class="' + netClass + ' fw-semibold">£' + net.toFixed(2) + '</td>' +
                    '</tr>'
                );
            };

            const $banner = $('#sold-monthly-free-banner');
            const $bannerText = $('#sold-monthly-free-banner-text');
            if ($banner.length && data.monthly_free_processing && $bannerText.length) {
                const promo = data.monthly_free_processing;
                const ymNow = new Date().toISOString().slice(0, 7);
                const cur = (promo.months || []).find((m) => m.year_month === ymNow);
                if (cur) {
                    const pct = Math.round((Number(promo.fee_percent) || 0.15) * 100);
                    const g = Number(cur.gross_sale || 0).toFixed(2);
                    const fee = Number(cur.fee_normally_charged || 0).toFixed(2);
                    $bannerText.html(
                        'In <strong>' + esc(formatYmLabel(cur.year_month)) + '</strong>, your highest eligible resale by gross sale value is <strong>' + esc(cur.product || '') + '</strong> (gross £' + g + '). ' +
                        'We waive our ' + pct + '% processing fee on that line — you keep <strong>100%</strong> of that sale (fee normally ~£' + fee + ' on that line).'
                    );
                    $banner.removeClass('d-none');
                } else {
                    $banner.addClass('d-none');
                }
            } else if ($banner.length) {
                $banner.addClass('d-none');
            }

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
            items.sort((a, b) => this.soldItemsSortRecentFirst(a, b));

            const cards = $('.card-body h3');
            if (data.stats && !filter) {
                const net = data.stats.net_earnings_after_returns != null
                    ? Number(data.stats.net_earnings_after_returns)
                    : Number(data.stats.total_earnings);
                const avgNet = data.stats.avg_earnings_net != null
                    ? Number(data.stats.avg_earnings_net)
                    : Number(data.stats.avg_earnings);
                $(cards[0]).text('£' + net.toFixed(2));
                $(cards[1]).text(data.stats.items_sold);
                $(cards[2]).text('£' + avgNet.toFixed(2));
                $(cards[3]).text(Number(data.stats.avg_margin).toFixed(2) + '%');
            } else if (items.length) {
                const totNet = items.reduce((s, i) => {
                    const n = i.net_after_returns != null ? Number(i.net_after_returns) : (Number(i.profit) || 0) - (Number(i.returns_deducted) || 0);
                    return s + (Number.isFinite(n) ? n : 0);
                }, 0);
                const qty = items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
                $(cards[0]).text('£' + totNet.toFixed(2));
                $(cards[1]).text(qty);
                $(cards[2]).text(qty ? '£' + (totNet / qty).toFixed(2) : '£0.00');
                $(cards[3]).text(items.length ? Number(items[0].margin || 0).toFixed(2) + '%' : '0%');
            }

            $tbody.empty();
            const $soldCount = $('#sold-items-count');
            if ($soldCount.length) {
                $soldCount.text(items.length + ' Total Sold' + (filter || soldSearch ? ' (filtered)' : ''));
            }

            if (items.length === 0) {
                $tbody.html('<tr><td colspan="6" class="text-center py-5"><p class="text-muted mb-3">No sold items match this filter. Change the recovery route filter or send more packages.</p><a href="packages.html" class="btn btn-primary">Send packages</a></td></tr>');
                return;
            }

            this._soldListFiltered = items;
            const pageSize = 20;
            this._soldVisible = Math.min(pageSize, items.length);
            const toShow = items.slice(0, this._soldVisible);
            toShow.forEach(item => {
                $tbody.append(soldRowHtml(item));
            });
            const $loadMore = $('#sold-load-more');
            if ($loadMore.length && items.length > this._soldVisible) {
                $loadMore.removeClass('d-none');
                $('#sold-load-more-btn').off('click').on('click', () => {
                    this._soldVisible = Math.min(this._soldVisible + pageSize, this._soldListFiltered.length);
                    $tbody.empty();
                    this._soldListFiltered.slice(0, this._soldVisible).forEach(item => {
                        $tbody.append(soldRowHtml(item));
                    });
                    if (this._soldVisible >= this._soldListFiltered.length) $loadMore.addClass('d-none');
                });
            } else if ($loadMore.length) $loadMore.addClass('d-none');
        } catch(err) {
            console.error('Load sold error:', err);
            const msg = err.error || 'Unable to load sold items.';
            $tbody.html('<tr><td colspan="6" class="text-center py-5"><p class="text-danger mb-2">' + msg + '</p><button type="button" class="btn btn-outline-primary btn-sm">Try again</button></td></tr>');
            $tbody.find('.btn').on('click', () => this.loadSold());
        }
    },

    async loadSoldReturns() {
        const $tbody = $('#sold-returns-tbody');
        const $count = $('#sold-returns-count');
        if (!$tbody.length) return;
        $tbody.html('<tr><td colspan="6" class="text-center py-4 text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</td></tr>');
        try {
            const data = await API.getSoldReturns();
            const items = data.items || [];
            if ($count.length) {
                $count.text(items.length + (items.length === 1 ? ' entry' : ' entries'));
            }
            const esc = (s) => String(s == null ? '' : s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
            if (!items.length) {
                $tbody.html('<tr><td colspan="6" class="text-center py-4 text-muted">No refunds or return adjustments yet.</td></tr>');
                return;
            }
            $tbody.empty();
            items.forEach((r) => {
                const linked = r.linked_sold_item_id
                    ? '#' + esc(String(r.linked_sold_item_id)) + (r.sold_product ? ' — ' + esc(r.sold_product) : '')
                    : '—';
                const st = esc(String(r.status || ''));
                $tbody.append(
                    '<tr>' +
                    '<td>' +
                    esc(
                        r.refund_date_display ||
                            (r.refund_date ? this.formatDate(r.refund_date) : '—')
                    ) +
                    '</td>' +
                    '<td>' + esc(r.product) + '</td>' +
                    '<td>' + esc(r.reference || '') + '</td>' +
                    '<td class="text-danger">£' + Number(r.amount != null ? r.amount : 0).toFixed(2) + '</td>' +
                    '<td><span class="badge bg-secondary-subtle text-secondary">' + st + '</span></td>' +
                    '<td class="small">' + linked + '</td>' +
                    '</tr>'
                );
            });
        } catch (err) {
            console.error('Load sold returns error:', err);
            const msg = String(err.error || err.message || 'Unable to load refunds.')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            $tbody.html('<tr><td colspan="6" class="text-center py-4"><p class="text-danger mb-2">' + msg + '</p></td></tr>');
        }
    },

    // ─── PENDING ITEMS PAGE ──────────────────────────────────
    async loadPending() {
        const $tbody = $('table tbody');
        if ($tbody.length) $tbody.html('<tr><td colspan="9" class="text-center py-5 text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</td></tr>');
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
                $tbody.html('<tr><td colspan="9" class="text-center py-5"><p class="text-muted mb-3">No pending items match this filter. Change the recovery route filter or view received packages.</p><a href="received.html" class="btn btn-primary">View Received</a></td></tr>');
                return;
            }

            this._pendingListFiltered = items;
            const pageSize = 20;
            this._pendingVisible = Math.min(pageSize, items.length);
            const toShow = items.slice(0, this._pendingVisible);
            toShow.forEach(item => {
                const qLabel = String(item.product || '') + ' · ref ' + String(item.reference || '');
                const qEsc = qLabel.replace(/"/g, '&quot;').replace(/</g, '&lt;');
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
                        <td class="text-end"><button type="button" class="btn btn-link btn-sm p-0 rp-query-item-btn" data-ctx-type="pending" data-ctx-id="${item.id != null ? item.id : ''}" data-ctx-label="${qEsc}">Query</button></td>
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
            $tbody.html('<tr><td colspan="9" class="text-center py-5"><p class="text-danger mb-2">' + msg + '</p><button type="button" class="btn btn-outline-primary btn-sm">Try again</button></td></tr>');
            $tbody.find('.btn').on('click', () => this.loadPending());
        }
    },

    // ─── INVOICES PAGE ───────────────────────────────────────
    async loadInvoices() {
        const $tbody = $('table tbody');
        if ($tbody.length) $tbody.html('<tr><td colspan="7" class="text-center py-5 text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</td></tr>');
        this.renderPayoutForecast($('#invoices-payout-forecast-body'));
        try {
            const data = await API.getInvoices();
            $tbody.empty();

            const rawInvoices = data.invoices || [];
            if (rawInvoices.length === 0) {
                $('.seco-title').text('0 invoices');
                $tbody.html('<tr><td colspan="7" class="text-center py-5"><p class="text-muted mb-3">No monthly statements yet. One appears for each <strong>completed</strong> calendar month where you have sales (by <strong>sold date</strong>) or applied returns. The <strong>current</strong> month is excluded until it ends. Future months are never shown.</p><a href="sold-items.html" class="btn btn-primary">View Sold Items</a></td></tr>');
                return;
            }

            // Group by month (one invoice per month): key = "YYYY-MM"
            const byMonth = {};
            for (const inv of rawInvoices) {
                let key = null;
                if (inv.period && /^\d{4}-\d{2}$/.test(String(inv.period))) {
                    key = String(inv.period);
                } else {
                    const rp = String(inv.invoice_number || '').match(/^RP-(\d{4}-\d{2})$/);
                    if (rp) key = rp[1];
                }
                if (!key) {
                    console.warn('loadInvoices: skipping invoice row without YYYY-MM period', inv && inv.invoice_number, inv && inv.date_issued);
                    continue;
                }
                if (!byMonth[key]) {
                    const [py, pm] = key.split('-').map(Number);
                    const payoutDate = inv.due_date
                        ? new Date(String(inv.due_date).replace(/-/g, '/') + ' 12:00:00')
                        : new Date(py, pm + 1, 0);
                    let issueY = py;
                    let issueM = pm + 1;
                    if (issueM > 12) {
                        issueM = 1;
                        issueY += 1;
                    }
                    const fallbackIssueStr = issueY + '-' + String(issueM).padStart(2, '0') + '-01';
                    byMonth[key] = {
                        key,
                        year: py,
                        month: pm - 1,
                        amount: 0,
                        items_count: 0,
                        vat_amount: 0,
                        status: inv.status,
                        date_issued: inv.date_issued || fallbackIssueStr,
                        payout_date: payoutDate
                    };
                }
                byMonth[key].amount += Number(inv.amount) || 0;
                byMonth[key].items_count += Number(inv.items_count) || 0;
                byMonth[key].vat_amount += Number(inv.vat_amount) || 0;
                if (inv.status === 'Pending' || inv.status === 'Overdue') byMonth[key].status = inv.status;
            }

            let monthly = Object.values(byMonth).sort((a, b) => {
                return (b.year - a.year) || (b.month - a.month);
            });

            let capKey = data.statement_period_cap_ym;
            if (!capKey) {
                const tz = String(data.statement_period_cap_tz || 'Europe/London').trim() || 'Europe/London';
                let currentYm;
                try {
                    currentYm = new Intl.DateTimeFormat('en-CA', {
                        timeZone: tz,
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit'
                    })
                        .format(new Date())
                        .slice(0, 7);
                } catch (e) {
                    const d = new Date();
                    currentYm = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
                }
                const pr = String(currentYm).split('-').map(Number);
                let cy = pr[0];
                let mo = pr[1];
                if (cy && mo >= 1 && mo <= 12) {
                    mo -= 1;
                    if (mo < 1) {
                        mo = 12;
                        cy -= 1;
                    }
                    capKey = cy + '-' + String(mo).padStart(2, '0');
                } else {
                    capKey = currentYm;
                }
            }
            monthly = monthly.filter((m) => m.key <= capKey);

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
                const periodLabel = m.key ? this.formatStatementPeriodLabel(m.key) : '-';
                $tbody.append(`
                    <tr>
                        <td><strong>${periodLabel}</strong></td>
                        <td>${this.formatDate(m.date_issued)}</td>
                        <td>${this.formatDate(m.payout_date)}</td>
                        <td class="text-success">£${Number(m.amount).toFixed(2)}</td>
                        <td>${m.items_count}</td>
                        <td>${this.statusBadge(m.status)}</td>
                        <td class="text-center">
                            <div class="dropdown d-inline-block">
                                <button type="button" class="btn btn-link btn-sm p-0 text-primary" data-bs-toggle="dropdown" data-period="${m.key}" aria-expanded="false" title="Print or save as PDF"><i class="ri-download-2-line fs-18"></i></button>
                                <ul class="dropdown-menu dropdown-menu-end">
                                    <li><a class="dropdown-item invoice-print-opt" href="#" data-period="${m.key}" data-kind="invoice"><i class="ri-file-text-line me-1"></i>Invoice (by product)</a></li>
                                    <li><a class="dropdown-item invoice-print-opt" href="#" data-period="${m.key}" data-kind="statement"><i class="ri-list-unordered me-1"></i>Statement (each line)</a></li>
                                </ul>
                            </div>
                        </td>
                    </tr>
                `);
            });
            $tbody.find('.invoice-print-opt').on('click', function (e) {
                e.preventDefault();
                const period = $(this).data('period');
                const kind = $(this).data('kind');
                if (period && kind) Dashboard.downloadInvoiceMonth.call(Dashboard, period, kind);
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
            const active = data.active_count != null ? Number(data.active_count) : list.filter(r => r.status === 'Active').length;
            const signedUpOnly = list.filter(r => r.status === 'Signed up').length;

            $('#referrals-total').text(list.length);
            $('#referrals-signed-up').text(signedUpOnly);
            $('#referrals-active').text(active);
            $('#referrals-earned').text('£' + Number(totalEarned).toFixed(2));
            const link = data.referral_link || '';
            const $input = $('#referral-link-input');
            if ($input.length && link) $input.val(link);

            const tiers = data.tiers || [
                { min_active: 1, max_active: 5, reward_per_referral: 10, label: 'Tier 1' },
                { min_active: 6, max_active: 10, reward_per_referral: 15, label: 'Tier 2' },
                { min_active: 11, max_active: null, reward_per_referral: 20, label: 'Tier 3' }
            ];
            const currentTier = data.current_tier || null;
            const nextTier = data.next_tier || null;
            const activeRequired = nextTier && nextTier.active_required != null ? Number(nextTier.active_required) : 0;

            $('#referrals-active-count').text(active);
            if (currentTier) {
                $('#referrals-tier-label').text(currentTier.label || '-');
                $('#referrals-tier-reward').text('£' + (currentTier.reward_per_referral || 0) + ' per active referral');
            } else {
                $('#referrals-tier-label').text('Unlock rewards');
                $('#referrals-tier-reward').text('Get your first active referral to earn (Tier 1: £' + (tiers[0] && tiers[0].reward_per_referral != null ? tiers[0].reward_per_referral : 10) + ' each)');
            }

            let pct = 100;
            let progLabel = 'Top tier';
            if (nextTier && nextTier.min_active != null) {
                const goal = Number(nextTier.min_active) || 1;
                pct = Math.min(100, Math.round((active / goal) * 100));
                progLabel = active + ' / ' + goal + ' active toward ' + (nextTier.label || 'next tier');
            }
            if (!nextTier && currentTier) {
                progLabel = 'Top tier — £' + (currentTier.reward_per_referral || 0) + ' per active referral';
            }
            $('#referrals-tier-progress').css('width', pct + '%').attr('aria-valuenow', pct);
            $('#referrals-tier-progress-label').text(progLabel);

            if (nextTier && activeRequired > 0) {
                $('#referrals-tier-next')
                    .text(
                        'Next: ' +
                            activeRequired +
                            ' more active referral' +
                            (activeRequired !== 1 ? 's' : '') +
                            ' to unlock ' +
                            (nextTier.label || 'the next tier') +
                            ' (£' +
                            (nextTier.reward_per_referral || 0) +
                            ' per active referral).'
                    )
                    .removeClass('d-none');
            } else if (currentTier && !nextTier) {
                $('#referrals-tier-next')
                    .text('You’re in the top tier. Each active referral earns £' + (currentTier.reward_per_referral || 0) + '.')
                    .removeClass('d-none');
            } else {
                $('#referrals-tier-next').addClass('d-none').text('');
            }

            const $breakdown = $('#referrals-tier-breakdown');
            if ($breakdown.length && tiers.length) {
                $breakdown.html(
                    tiers
                        .map((t) => {
                            const range = t.max_active != null ? t.min_active + '–' + t.max_active : t.min_active + '+';
                            return (
                                '<span class="d-inline-block me-3">' +
                                (t.label || '') +
                                ' (' +
                                range +
                                ' active): £' +
                                (t.reward_per_referral || 0) +
                                ' each</span>'
                            );
                        })
                        .join('')
                );
            }

            $tbody.empty();
            if (list.length === 0) {
                $tbody.html('<tr><td colspan="4" class="text-center py-5 text-muted">No referrals yet. Use "Refer a seller" or share your referral link.</td></tr>');
            } else {
                list.forEach(r => {
                    const date = r.referred_at ? RP_DATE.formatOrdinalEnGb(r.referred_at) : '-';
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
            params = { from: RP_DATE.formatIso(start), to: RP_DATE.formatIso(end) };
        } else if (range === 'custom') {
            const from = $('#roi-report-from').val();
            const to = $('#roi-report-to').val();
            if (from) params.from = from;
            if (to) params.to = to;
        }
        try {
            const data = await API.getRoiReport(params);
            const fmt = (n) => '£' + Number(n).toFixed(2);
            const periodStart = data.period_start ? RP_DATE.formatOrdinalEnGb(data.period_start) : '';
            const periodEnd = data.period_end ? RP_DATE.formatOrdinalEnGb(data.period_end) : '';
            $('#roi-period-text').text(
                periodStart && periodEnd
                    ? periodStart + ' – ' + periodEnd
                    : (data.period_start ? RP_DATE.formatOrdinalEnGb(data.period_start) : '') +
                          ' – ' +
                          (data.period_end ? RP_DATE.formatOrdinalEnGb(data.period_end) : '')
            );
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

    // ─── PAYOUT FORECAST, SEARCH, QUERIES, EXPORTS, SNAPSHOT ───
    _announcementsCache: null,
    _clientPrefsCache: null,

    async ensureClientPreferences(force) {
        if (!force && this._clientPrefsCache) return this._clientPrefsCache;
        try {
            const data = await API.getSettings();
            this._clientPrefsCache = (data.settings && data.settings.preferences) || {};
        } catch (e) {
            this._clientPrefsCache = this._clientPrefsCache || {};
        }
        return this._clientPrefsCache;
    },

    getBillingDetailsForPrint() {
        const p = this._clientPrefsCache || {};
        const user = API.getUser() || {};
        return {
            name: (p.billing_name || user.full_name || '').trim(),
            company: (p.billing_company || user.company_name || '').trim(),
            address: (p.billing_address || '').trim(),
            phone: (p.billing_phone || '').trim(),
            vat_number: (p.vat_number || '').trim(),
        };
    },

    async refreshClientAttentionBadges() {
        const $queriesLink = $('#navbar-nav a[href="queries.html"]').first();
        if (!$queriesLink.length) return;
        try {
            const data = await API.getQueries();
            const list = data.queries || [];
            const seenAt = localStorage.getItem('returnpal_queries_seen_at') || '';
            const withReply = list.filter((q) => String(q.admin_reply || '').trim());
            const unread = withReply.filter((q) => {
                const replied = String(q.replied_at || q.created_at || '');
                return !seenAt || (replied && replied > seenAt);
            });
            $queriesLink.find('.rp-nav-dot-queries').remove();
            if (unread.length > 0) {
                if (!$queriesLink.hasClass('position-relative')) $queriesLink.addClass('position-relative');
                $queriesLink.append(
                    '<span class="rp-nav-dot-queries position-absolute top-0 end-0 translate-middle badge rounded-pill bg-danger" style="font-size:9px;min-width:16px;">' +
                        (unread.length > 9 ? '9+' : String(unread.length)) +
                        '</span>'
                );
            }
        } catch (e) { /* ignore */ }
    },

    markQueriesSeen() {
        localStorage.setItem('returnpal_queries_seen_at', new Date().toISOString());
        $('#navbar-nav a[href="queries.html"] .rp-nav-dot-queries').remove();
    },

    async fetchAnnouncementsList(force) {
        if (!force && this._announcementsCache) return this._announcementsCache;
        try {
            const data = await API.getAnnouncements();
            this._announcementsCache = data.announcements || [];
            this._announcementsUnread = data.unread_count != null ? data.unread_count : this._announcementsCache.filter((a) => !a.read).length;
        } catch (e) {
            this._announcementsCache = [];
            this._announcementsUnread = 0;
        }
        return this._announcementsCache;
    },

    escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    },

    async renderPayoutForecast($el) {
        if (!$el || !$el.length) return;
        $el.html('<span class="spinner-border spinner-border-sm me-1"></span> Loading…');
        try {
            const f = await API.getPayoutForecast();
            const next = f.next_payout;
            let html = '';
            if (next) {
                html +=
                    '<div class="d-flex justify-content-between align-items-center flex-wrap gap-2">' +
                    '<span><strong>£' + Number(next.amount || 0).toFixed(2) + '</strong> · ' + this.escHtml(next.period || '') + '</span>' +
                    '<span class="badge bg-warning-subtle text-warning">' + this.escHtml(next.status || 'Pending') + '</span></div>';
                if (next.due_date) {
                    html += '<div class="small text-muted mt-1">Payout due ' + RP_DATE.formatOrdinalEnGb(next.due_date) + '</div>';
                }
            } else {
                html += '<p class="mb-0">No pending payout scheduled yet.</p>';
            }
            if (f.unpaid_count > 0) {
                html += '<div class="small mt-2">' + f.unpaid_count + ' pending statement' + (f.unpaid_count !== 1 ? 's' : '') + ' · £' + Number(f.unpaid_total || 0).toFixed(2) + ' total</div>';
            }
            if (f.pipeline_pending_count > 0) {
                html +=
                    '<div class="small text-muted mt-1">' +
                    f.pipeline_pending_count +
                    ' item' +
                    (f.pipeline_pending_count !== 1 ? 's' : '') +
                    ' still processing in pipeline</div>';
            }
            const schedule = (f.schedule || []).slice(0, 6);
            if (schedule.length > 1) {
                html += '<ul class="list-unstyled small mb-0 mt-2 border-top pt-2">';
                schedule.forEach((row) => {
                    const due = row.due_date ? RP_DATE.formatOrdinalEnGb(row.due_date) : '';
                    html +=
                        '<li class="d-flex justify-content-between py-1">' +
                        '<span>' +
                        this.escHtml(row.period_label || row.period || '') +
                        '</span>' +
                        '<span>£' +
                        Number(row.amount || 0).toFixed(2) +
                        ' <span class="text-muted">' +
                        this.escHtml(row.status || '') +
                        (due ? ' · ' + due : '') +
                        '</span></span></li>';
                });
                html += '</ul>';
            }
            $el.html(html);
        } catch (err) {
            $el.html(
                '<span class="text-danger small">' +
                    this.escHtml(err.error || 'Could not load forecast') +
                    '</span> <button type="button" class="btn btn-link btn-sm p-0 align-baseline" id="payout-forecast-retry">Try again</button>'
            );
            $el.find('#payout-forecast-retry').on('click', () => this.renderPayoutForecast($el));
        }
    },

    initGlobalSearch() {
        const $search = $('#dashboard-global-search');
        if (!$search.length || $search.data('rp-global-search')) return;
        $search.data('rp-global-search', 1);
        const $wrap = $search.parent();
        $wrap.css('position', 'relative');
        let $drop = $('#dashboard-global-search-results');
        if (!$drop.length) {
            $drop = $('<div id="dashboard-global-search-results" class="dropdown-menu shadow position-absolute w-100 d-none" style="top:100%;max-height:320px;overflow-y:auto;z-index:1050;"></div>');
            $wrap.append($drop);
        }
        const self = this;
        let timer = null;
        const runSearch = async function() {
            const q = $search.val().trim();
            if (q.length < 2) {
                $drop.addClass('d-none');
                return;
            }
            try {
                const data = await API.globalSearch(q);
                const results = data.results || [];
                if (!results.length) {
                    $drop.html('<div class="dropdown-item-text small text-muted py-2">No matches</div>').removeClass('d-none');
                    return;
                }
                const labels = { package: 'Package', sold: 'Sold', received: 'Received', pending: 'Pending' };
                $drop.html(
                    results
                        .map(function(r) {
                            let href = r.href || '#';
                            if (href.indexOf('/dashboard/') === 0) href = href.replace('/dashboard/', '');
                            return (
                                '<a class="dropdown-item py-2 small" href="' + self.escHtml(href) + '">' +
                                '<span class="badge bg-secondary-subtle text-secondary me-1">' + self.escHtml(labels[r.type] || r.type) + '</span>' +
                                self.escHtml(r.title || '') +
                                (r.subtitle ? '<br><small class="text-muted">' + self.escHtml(r.subtitle) + '</small>' : '') +
                                '</a>'
                            );
                        })
                        .join('')
                ).removeClass('d-none');
            } catch (e) {
                $drop.addClass('d-none');
            }
        };
        $search.on('input', function() {
            clearTimeout(timer);
            timer = setTimeout(runSearch, 280);
        });
        $search.on('keydown', function(e) {
            if (e.which === 13) {
                e.preventDefault();
                runSearch();
            }
            if (e.which === 27) $drop.addClass('d-none');
        });
        $(document).on('click.rpGlobalSearch', function(e) {
            if (!$(e.target).closest('#dashboard-global-search, #dashboard-global-search-results').length) {
                $drop.addClass('d-none');
            }
        });
    },

    initMonthlySnapshotButtons() {
        const self = this;
        $(document)
            .off('click', '#dashboard-monthly-snapshot-btn, #referrals-monthly-snapshot-btn')
            .on('click', '#dashboard-monthly-snapshot-btn, #referrals-monthly-snapshot-btn', function() {
                self.printMonthlySnapshot();
            });
    },

    async printMonthlySnapshot(periodYm) {
        try {
            const data = await API.getMonthlySnapshot(periodYm || '');
            const html =
                '<!DOCTYPE html><html><head><meta charset="utf-8"><title>ReturnPal snapshot ' + this.escHtml(data.period_label || data.period) + '</title>' +
                '<style>body{font-family:Segoe UI,sans-serif;padding:40px;color:#1a1a1a;} h1{font-size:22px;} table{width:100%;border-collapse:collapse;margin-top:24px;} td,th{padding:10px;border-bottom:1px solid #eee;text-align:left;} th{background:#f5f5f5;}</style></head><body>' +
                '<h1>ReturnPal — monthly snapshot</h1>' +
                '<p><strong>' + this.escHtml(data.client_name || '') + '</strong><br>' + this.escHtml(data.period_label || data.period || '') + '</p>' +
                '<table><tbody>' +
                '<tr><th>Items sold</th><td>' + (data.items_sold != null ? data.items_sold : '—') + '</td></tr>' +
                '<tr><th>Sales profit</th><td>£' + Number(data.sales_profit || 0).toFixed(2) + '</td></tr>' +
                '<tr><th>Returns / refunds</th><td>£' + Number(data.refunds_and_returns || 0).toFixed(2) + '</td></tr>' +
                '<tr><th>Payout amount</th><td><strong>£' + Number(data.payout_amount || 0).toFixed(2) + '</strong></td></tr>' +
                '<tr><th>Status</th><td>' + this.escHtml(data.status || '') + '</td></tr>' +
                '<tr><th>Due date</th><td>' + (data.due_date ? this.escHtml(RP_DATE.formatOrdinalEnGb(data.due_date)) : '—') + '</td></tr>' +
                '<tr><th>VAT registered</th><td>' + (data.vat_registered ? 'Yes' : 'No') + '</td></tr>' +
                '</tbody></table>' +
                '<p class="small" style="margin-top:32px;color:#666;">Generated ' + new Date().toLocaleString('en-GB') + '. For full line detail use Payouts &amp; Invoices.</p>' +
                '</body></html>';
            rpOpenInvoicePrintWindow(html);
        } catch (err) {
            alert((err && err.error) || err.message || 'Could not load snapshot');
        }
    },

    async loadQueries() {
        const $inbox = $('#queries-inbox');
        if (!$inbox.length) return;
        $inbox.html('<div class="text-center py-4 text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</div>');
        const self = this;
        try {
            const data = await API.getQueries();
            const list = data.queries || [];
            const seenAt = localStorage.getItem('returnpal_queries_seen_at') || '';
            const newReplies = list.filter((q) => {
                const msgs = Array.isArray(q.messages) ? q.messages : [];
                const adminMsgs = msgs.filter((m) => m && m.sender_role === 'admin');
                const lastAdmin = adminMsgs.length ? adminMsgs[adminMsgs.length - 1] : null;
                if (!lastAdmin && String(q.admin_reply || '').trim()) {
                    return !seenAt || String(q.replied_at || '') > seenAt;
                }
                if (!lastAdmin) return false;
                return !seenAt || String(lastAdmin.created_at || '') > seenAt;
            });
            if (newReplies.length) {
                const $banner = $('#queries-reply-banner');
                if ($banner.length) {
                    $banner
                        .removeClass('d-none')
                        .html(
                            '<i class="ri-mail-check-line me-2"></i><strong>' +
                                newReplies.length +
                                ' new ' +
                                (newReplies.length === 1 ? 'reply' : 'replies') +
                                '</strong> from ReturnPal below.'
                        );
                }
            }
            if (!list.length) {
                $inbox.html('<p class="text-muted text-center py-5 mb-0">No queries yet. Use the form to ask about a pending item or package.</p>');
            } else {
                let html = '<div class="rp-query-inbox">';
                list.forEach(function(q) {
                    const msgs =
                        Array.isArray(q.messages) && q.messages.length
                            ? q.messages
                            : [{ sender_role: 'client', body: q.message || '', created_at: q.created_at }];
                    const updatedLabel = q.updated_at || q.created_at;
                    const whenLabel =
                        updatedLabel && typeof RP_DATE !== 'undefined' && RP_DATE.formatOrdinalEnGb
                            ? RP_DATE.formatOrdinalEnGb(updatedLabel)
                            : '';
                    html +=
                        '<article class="rp-query-thread" data-query-id="' +
                        self.escHtml(String(q.id)) +
                        '">' +
                        '<div class="rp-query-thread-header">' +
                        '<span class="badge bg-light text-dark border">' +
                        self.escHtml(q.context_label || q.context_type || 'General') +
                        '</span>' +
                        (whenLabel ? '<small class="text-muted">' + self.escHtml(whenLabel) + '</small>' : '') +
                        '</div>' +
                        '<div class="rp-query-messages">';
                    msgs.forEach(function(m) {
                        const isAdmin = m.sender_role === 'admin';
                        const when =
                            m.created_at && typeof RP_DATE !== 'undefined' && RP_DATE.formatOrdinalEnGb
                                ? RP_DATE.formatOrdinalEnGb(m.created_at)
                                : '';
                        const delBtn =
                            !isAdmin && m.can_delete && m.id != null
                                ? '<button type="button" class="rp-query-msg-delete query-delete-msg-btn" data-query-id="' +
                                  self.escHtml(String(q.id)) +
                                  '" data-message-id="' +
                                  self.escHtml(String(m.id)) +
                                  '" title="Remove this message" aria-label="Remove this message"><i class="ri-delete-bin-line"></i></button>'
                                : '';
                        html +=
                            '<div class="rp-query-msg ' +
                            (isAdmin ? 'rp-query-msg--admin' : 'rp-query-msg--client') +
                            '">' +
                            '<div class="rp-query-msg-head">' +
                            '<span class="rp-query-msg-label">' +
                            (isAdmin ? 'ReturnPal' : 'You') +
                            '</span>' +
                            delBtn +
                            '</div>' +
                            (when ? '<span class="rp-query-msg-time">' + self.escHtml(when) + '</span>' : '') +
                            '<p class="rp-query-msg-body">' +
                            self.escHtml(m.body || '') +
                            '</p></div>';
                    });
                    html += '</div><div class="rp-query-actions">';
                    if (q.can_client_reply) {
                        html +=
                            '<form class="query-followup-form rp-query-followup-form" data-query-id="' +
                            self.escHtml(String(q.id)) +
                            '">' +
                            '<label class="form-label small mb-1 fw-semibold">Your follow-up</label>' +
                            '<textarea class="form-control form-control-sm mb-2 query-followup-input" rows="2" minlength="5" placeholder="Add more detail or ask a follow-up question…" required></textarea>' +
                            '<button type="submit" class="btn btn-primary btn-sm"><i class="ri-send-plane-line me-1"></i>Send follow-up</button>' +
                            '</form>';
                    } else if (String(q.last_sender || 'client') === 'client') {
                        html +=
                            '<span class="badge bg-warning-subtle text-warning border border-warning-subtle">Awaiting reply from ReturnPal</span>';
                    }
                    html += '</div>';
                    if (q.can_delete_thread) {
                        html +=
                            '<div class="rp-query-footer">' +
                            '<button type="button" class="btn rp-query-delete-thread query-delete-thread-btn" data-query-id="' +
                            self.escHtml(String(q.id)) +
                            '">' +
                            '<i class="ri-delete-bin-6-line" aria-hidden="true"></i>Delete conversation</button>' +
                            '<p class="rp-query-footer-hint">Removes this thread from your inbox. This cannot be undone.</p>' +
                            '</div>';
                    }
                    html += '</article>';
                });
                html += '</div>';
                $inbox.html(html);
            }
            this.markQueriesSeen();
            this.refreshClientAttentionBadges();
        } catch (err) {
            $inbox.html('<p class="text-danger text-center py-4">' + this.escHtml(err.error || 'Failed to load queries') + '</p>');
        }

        $('#query-new-form')
            .off('submit')
            .on('submit', async function(e) {
                e.preventDefault();
                const msg = ($('#query-message').val() || '').trim();
                const label = ($('#query-context-label').val() || '').trim();
                if (msg.length < 5) return alert('Please enter at least 5 characters.');
                try {
                    await API.submitItemQuery({
                        context_type: 'general',
                        context_label: label || 'General query',
                        message: msg,
                    });
                    $('#query-message').val('');
                    $('#query-context-label').val('');
                    Dashboard.showToast('Query sent');
                    Dashboard.loadQueries();
                } catch (err2) {
                    alert((err2 && err2.error) || err2.message || 'Failed to send');
                }
            });

        $inbox
            .off('click', '.query-delete-msg-btn')
            .on('click', '.query-delete-msg-btn', async function() {
                const qid = $(this).data('query-id');
                const mid = $(this).data('message-id');
                if (!confirm('Remove this message from the conversation?')) return;
                try {
                    await API.clientDeleteQueryMessage(qid, mid);
                    Dashboard.showToast('Message removed');
                    Dashboard.loadQueries();
                } catch (err2) {
                    alert((err2 && err2.error) || err2.message || 'Could not delete');
                }
            });

        $inbox
            .off('click', '.query-delete-thread-btn')
            .on('click', '.query-delete-thread-btn', async function() {
                const qid = $(this).data('query-id');
                if (!confirm('Delete this entire conversation? This cannot be undone.')) return;
                try {
                    await API.clientDeleteQuery(qid);
                    Dashboard.showToast('Conversation removed');
                    Dashboard.loadQueries();
                } catch (err2) {
                    alert((err2 && err2.error) || err2.message || 'Could not delete');
                }
            });

        $inbox
            .off('submit', '.query-followup-form')
            .on('submit', '.query-followup-form', async function(e) {
                e.preventDefault();
                const $form = $(this);
                const qid = $form.data('query-id');
                const msg = ($form.find('.query-followup-input').val() || '').trim();
                if (msg.length < 5) return alert('Please enter at least 5 characters.');
                const $btn = $form.find('button[type="submit"]');
                $btn.prop('disabled', true);
                try {
                    await API.clientReplyToQuery(qid, msg);
                    Dashboard.showToast('Follow-up sent');
                    Dashboard.loadQueries();
                } catch (err2) {
                    alert((err2 && err2.error) || err2.message || 'Failed to send');
                    $btn.prop('disabled', false);
                }
            });
    },

    async loadExportsHub() {
        const $grid = $('#exports-hub-grid');
        const $period = $('#exports-period-select');
        if (!$grid.length) return;
        try {
            const data = await API.getExportsHub();
            const periods = data.periods || [];
            window._exportsHubPeriods = periods;
            if ($period.length) {
                $period.empty();
                periods.forEach(function(p, i) {
                    $period.append('<option value="' + p.period + '">' + p.period + ' · £' + Number(p.amount || 0).toFixed(2) + ' (' + (p.status || '') + ')</option>');
                });
                if (!periods.length) $period.append('<option value="">No completed periods yet</option>');
            }
            const cards = [
                { title: 'Sold items CSV', desc: 'All sold lines for your records.', href: 'sold-items.html', action: 'link' },
                { title: 'Payouts & invoices', desc: 'Print statement or invoice per month.', href: 'invoices.html', action: 'link' },
                { title: 'Monthly snapshot', desc: 'One-page summary for the selected month.', action: 'snapshot' },
                { title: 'Statement month CSV', desc: 'Download payout row for the selected month.', action: 'period-csv' },
                { title: 'Print statement', desc: 'Full line-by-line statement for selected month.', action: 'period-statement' },
                { title: 'Print invoice', desc: 'Consolidated invoice PDF for selected month.', action: 'period-invoice' },
                { title: 'Analytics CSV', desc: 'Recovery over time from Analytics.', href: 'analytics.html', action: 'link' },
                { title: 'ROI report', desc: 'Printable ROI summary.', href: 'roi-report.html', action: 'link' },
                { title: 'All invoices CSV', desc: 'Every statement month in one spreadsheet.', href: 'invoices.html', action: 'link' },
            ];
            $grid.html(
                cards
                    .map(function(c) {
                        return (
                            '<div class="col-md-6 col-lg-4"><div class="rp-card card border-0 h-100"><div class="card-body">' +
                            '<h6 class="mb-1">' +
                            Dashboard.escHtml(c.title) +
                            '</h6><p class="small text-muted mb-3">' +
                            Dashboard.escHtml(c.desc) +
                            '</p>' +
                            (c.action === 'snapshot'
                                ? '<button type="button" class="btn btn-primary btn-sm exports-action-btn" data-action="snapshot"><i class="ri-printer-line me-1"></i>Print snapshot</button>'
                                : c.action === 'period-csv'
                                  ? '<button type="button" class="btn btn-outline-primary btn-sm exports-action-btn" data-action="period-csv"><i class="ri-download-2-line me-1"></i>Download CSV</button>'
                                  : c.action === 'period-statement'
                                    ? '<button type="button" class="btn btn-outline-primary btn-sm exports-action-btn" data-action="period-statement"><i class="ri-printer-line me-1"></i>Print statement</button>'
                                    : c.action === 'period-invoice'
                                      ? '<button type="button" class="btn btn-outline-primary btn-sm exports-action-btn" data-action="period-invoice"><i class="ri-printer-line me-1"></i>Print invoice</button>'
                                      : '<a href="' +
                                        Dashboard.escHtml(c.href) +
                                        '" class="btn btn-outline-primary btn-sm">Open</a>') +
                            '</div></div></div>'
                        );
                    })
                    .join('')
            );
            $grid.find('.exports-action-btn')
                .off('click')
                .on('click', function() {
                    const p = $period.val();
                    if (!p) {
                        Dashboard.showToast('Choose a statement month first', 'error');
                        return;
                    }
                    const act = $(this).data('action');
                    if (act === 'snapshot') Dashboard.printMonthlySnapshot(p);
                    else if (act === 'period-csv') Dashboard.exportExportsHubPeriodCsv(p);
                    else if (act === 'period-statement') Dashboard.downloadInvoiceMonth(p, 'statement');
                    else if (act === 'period-invoice') Dashboard.downloadInvoiceMonth(p, 'invoice');
                });
        } catch (err) {
            $grid.html(
                '<div class="col-12 text-danger">' +
                    this.escHtml(err.error || 'Failed to load exports') +
                    ' <button type="button" class="btn btn-sm btn-outline-primary" id="exports-hub-retry">Try again</button></div>'
            );
            $('#exports-hub-retry').on('click', () => this.loadExportsHub());
        }
    },

    exportExportsHubPeriodCsv(period) {
        const row = (window._exportsHubPeriods || []).find((p) => p.period === period);
        if (!row) {
            this.showToast('No data for that month', 'error');
            return;
        }
        const csv =
            'Sales month (YYYY-MM),Payout amount (£),Status,Due date\n' +
            period +
            ',' +
            Number(row.amount || 0).toFixed(2) +
            ',"' +
            String(row.status || '').replace(/"/g, '""') +
            '",' +
            (row.due_date || '');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'returnpal-payout-' + period + '.csv';
        a.click();
        URL.revokeObjectURL(a.href);
        this.showToast('Downloaded ' + period);
    },

    initReimbursementSubmit() {
        const $form = $('#reimbursement-submit-form');
        if (!$form.length || $form.data('rp-bound')) return;
        $form.data('rp-bound', 1);
        $form.on('submit', async function(e) {
            e.preventDefault();
            const $btn = $('#reimbursement-submit-btn');
            const fd = new FormData($form[0]);
            try {
                $btn.prop('disabled', true).text('Submitting…');
                await API.submitReimbursementClaim(fd);
                $form[0].reset();
                Dashboard.showToast('Claim submitted');
                Dashboard.loadReimbursementClaims();
            } catch (err) {
                alert((err && err.error) || err.message || 'Submit failed');
            } finally {
                $btn.prop('disabled', false).text('Submit claim');
            }
        });
    },

    applyClientPreferencesToForm(prefs) {
        const p = prefs || {};
        $('#settings-billing-name').val(p.billing_name || '');
        $('#settings-billing-company').val(p.billing_company || '');
        $('#settings-billing-address').val(p.billing_address || '');
        $('#settings-billing-phone').val(p.billing_phone || '');
        $('#settings-prep-name').val(p.prep_name || '');
        $('#settings-prep-address').val(p.prep_address || '');
        $('#settings-prep-contact').val(p.prep_contact || '');
        $('#settings-prep-phone').val(p.prep_phone || '');
        $('#settings-prep-email').val(p.prep_email || '');
        $('#settings-prep-reference').val(p.prep_reference || '');
        $('#settings-vat-number').val(p.vat_number || '');
        $('#email-package-delivered').prop('checked', p.email_package_delivered !== false);
        $('#email-item-sold').prop('checked', p.email_item_sold !== false);
        $('#email-payout-sent').prop('checked', p.email_payout_sent !== false);
        $('#email-monthly-invoice').prop('checked', !!p.email_monthly_invoice);
        if ($('#email-digest-preference').length && p.email_digest) {
            $('#email-digest-preference').val(p.email_digest);
        }
    },

    buildClientPreferencesFromForm() {
        return {
            billing_name: $('#settings-billing-name').val().trim(),
            billing_company: $('#settings-billing-company').val().trim(),
            billing_address: $('#settings-billing-address').val().trim(),
            billing_phone: $('#settings-billing-phone').val().trim(),
            prep_name: $('#settings-prep-name').val().trim(),
            prep_address: $('#settings-prep-address').val().trim(),
            prep_contact: $('#settings-prep-contact').val().trim(),
            prep_phone: $('#settings-prep-phone').val().trim(),
            prep_email: $('#settings-prep-email').val().trim(),
            prep_reference: $('#settings-prep-reference').val().trim(),
            vat_number: $('#settings-vat-number').val().trim(),
            email_package_delivered: $('#email-package-delivered').is(':checked'),
            email_item_sold: $('#email-item-sold').is(':checked'),
            email_payout_sent: $('#email-payout-sent').is(':checked'),
            email_monthly_invoice: $('#email-monthly-invoice').is(':checked'),
            email_digest: $('#email-digest-preference').val() || 'off',
        };
    },

    async saveClientPreferences() {
        const merged = await API.updatePreferences(this.buildClientPreferencesFromForm());
        this._clientPrefsCache = (merged && merged.preferences) || this.buildClientPreferencesFromForm();
        return merged;
    },

    // ─── ANNOUNCEMENTS ───────────────────────────────────────
    getAnnouncementsData() {
        return this._announcementsCache || [];
    },
    getUnreadAnnouncementsCount() {
        if (this._announcementsUnread != null) return this._announcementsUnread;
        return (this._announcementsCache || []).filter((a) => !a.read).length;
    },
    async markAllAnnouncementsRead() {
        try {
            await API.markAnnouncementsRead([]);
            this._announcementsUnread = 0;
            if (this._announcementsCache) {
                this._announcementsCache.forEach((a) => {
                    a.read = true;
                });
            }
        } catch (e) { /* ignore */ }
        this.updateNotificationDots();
    },
    async renderAnnouncementsWidget($el) {
        const announcements = (await this.fetchAnnouncementsList()).slice(0, 2);
        if (!announcements.length) {
            $el.html('<span class="text-muted small">No announcements</span>');
            return;
        }
        const html = announcements
            .map((a) => {
                const dateStr = a.date ? RP_DATE.formatOrdinalEnGb(a.date) : '';
                const sum = (a.summary || '').slice(0, 60) + ((a.summary || '').length > 60 ? '…' : '');
                return (
                    '<div class="mb-2"><a href="announcements.html" class="text-body small fw-medium">' +
                    this.escHtml(a.title || '') +
                    '</a><br><small class="text-muted">' +
                    dateStr +
                    ' – ' +
                    this.escHtml(sum) +
                    '</small></div>'
                );
            })
            .join('');
        $el.html(html);
        this.updateNotificationDots();
    },
    async loadAnnouncements() {
        const $feed = $('#announcements-feed');
        if (!$feed.length) return;
        $feed.html('<div class="list-group-item border-0 py-4 text-muted text-center"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</div>');
        const announcements = await this.fetchAnnouncementsList(true);
        await this.markAllAnnouncementsRead();
        $feed.empty();
        if (announcements.length === 0) {
            $feed.html('<div class="list-group-item border-0 py-5 text-center"><p class="text-muted mb-0">No announcements yet.</p></div>');
            return;
        }
        const self = this;
        announcements.forEach(function(a) {
            const dateStr = a.date ? RP_DATE.formatOrdinalEnGb(a.date) : '';
            const fullId = 'announcement-full-' + a.id;
            $feed.append(
                '<div class="list-group-item border-0 border-bottom py-3" data-announcement-id="' + a.id + '">' +
                '<div class="d-flex justify-content-between align-items-start flex-wrap gap-2">' +
                '<div><h6 class="mb-1">' +
                self.escHtml(a.title || '') +
                (!a.read ? ' <span class="badge bg-primary-subtle text-primary">New</span>' : '') +
                '</h6><small class="text-muted">' +
                dateStr +
                '</small></div>' +
                '<button type="button" class="btn btn-link btn-sm p-0 text-primary" data-bs-toggle="collapse" data-bs-target="#' +
                fullId +
                '" aria-expanded="false">View full</button>' +
                '</div>' +
                '<p class="mb-2 mt-1 small">' +
                self.escHtml(a.summary || '') +
                '</p>' +
                '<div class="collapse" id="' +
                fullId +
                '"><div class="small text-muted">' +
                self.escHtml(a.body || '') +
                '</div></div>' +
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
    _invEsc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    },

    _renderInventoryPipeline(data) {
        const p = data.pipeline || {};
        const stages = [
            {
                key: 'sent',
                label: 'Packages sent',
                sub: 'Shipped to ReturnPal',
                icon: 'ri-box-3-line',
                href: 'packages.html',
                count: Number(p.sent) || 0,
                empty: 'No packages logged yet — add one to start tracking intake.',
            },
            {
                key: 'received',
                label: 'Received',
                sub: 'Intake logged',
                icon: 'ri-import-line',
                href: 'received.html',
                count: Number(p.received) || 0,
                empty: 'Nothing received yet — log intake when stock arrives.',
            },
            {
                key: 'processing',
                label: 'Processing',
                sub: 'Inspection & prep',
                icon: 'ri-time-line',
                href: 'item-pending.html',
                count: Number(p.processing) || 0,
                empty: 'No items in processing.',
            },
            {
                key: 'listing',
                label: 'Listing',
                sub: 'Ready / listed',
                icon: 'ri-store-2-line',
                href: 'item-pending.html',
                count: (Number(p.listing) || 0) + (Number(p.ready) || 0),
                empty: 'No items in listing stages.',
            },
            {
                key: 'sold',
                label: 'Sold',
                sub: 'Completed sales',
                icon: 'ri-shopping-bag-3-line',
                href: 'sold-items.html',
                count: Number(p.sold) || 0,
                empty: 'No sales recorded yet.',
            },
        ];
        const journeyTotal = stages.reduce((sum, s) => sum + s.count, 0) || 1;
        const html = stages
            .map((s) => {
                const pct = Math.round((s.count / journeyTotal) * 100);
                const sub =
                    s.count === 0 && journeyTotal <= 1
                        ? s.empty
                        : s.count + ' · ' + pct + '% of journey';
                return (
                    '<a class="inv-pipeline-stage" href="' +
                    s.href +
                    '" title="Open ' +
                    this._invEsc(s.label) +
                    '">' +
                    '<div class="inv-pipeline-stage-inner">' +
                    '<i class="inv-pipeline-icon ' +
                    s.icon +
                    '"></i>' +
                    '<div class="inv-pipeline-count">' +
                    s.count +
                    '</div>' +
                    '<div class="inv-pipeline-label">' +
                    this._invEsc(s.label) +
                    '</div>' +
                    '<div class="inv-pipeline-sub">' +
                    this._invEsc(sub) +
                    '</div>' +
                    '<div class="inv-pipeline-bar"><div class="inv-pipeline-bar-fill" style="width:' +
                    pct +
                    '%"></div></div>' +
                    '</div></a>'
                );
            })
            .join('');
        $('#inv-pipeline').html(html);
    },

    _renderInventoryStageBar(data) {
        const sb = data.stage_breakdown || {};
        const segments = [
            { key: 'inspection', label: 'Inspection', cls: 'bg-warning', count: sb.inspection || 0 },
            { key: 'listing', label: 'Listing', cls: 'bg-info', count: sb.listing || 0 },
            { key: 'listed', label: 'Listed', cls: 'bg-primary', count: sb.listed || 0 },
            { key: 'sold', label: 'Sold', cls: 'bg-success', count: sb.sold || 0 },
            { key: 'storage', label: 'Storage', cls: 'bg-secondary', count: sb.storage || 0 },
        ];
        const total = segments.reduce((sum, s) => sum + s.count, 0);
        const $bar = $('#inventory-stage-bar');
        const $legend = $('#inventory-stage-legend');
        if (!$bar.length) return;
        if (!total) {
            $bar.html('<p class="text-muted small mb-0">No items in workflow stages right now.</p>');
            if ($legend.length) $legend.empty();
            return;
        }
        const pct = (v) => Math.round((v / total) * 100);
        $bar.html(
            '<div class="progress rounded" style="height:24px">' +
                segments
                    .filter((s) => s.count > 0)
                    .map(
                        (s) =>
                            '<div class="progress-bar ' +
                            s.cls +
                            ' inv-stage-segment" style="width:' +
                            pct(s.count) +
                            '%" data-stage="' +
                            s.key +
                            '" title="' +
                            this._invEsc(s.label) +
                            '">' +
                            this._invEsc(s.label) +
                            '</div>'
                    )
                    .join('') +
                '</div>'
        );
        $bar.find('.inv-stage-segment').on('click', () => {
            window.location.href = 'item-pending.html';
        });
        if ($legend.length) {
            $legend.html(
                segments
                    .map(
                        (s) =>
                            '<span class="inv-seg-' +
                            s.key +
                            '">' +
                            this._invEsc(s.label) +
                            ': ' +
                            s.count +
                            '</span>'
                    )
                    .join('')
            );
        }
    },

    async loadInventory() {
        const $hub = $('#inventory-hub');
        if (!$hub.length) return;
        const $stageBar = $('#inventory-stage-bar');
        if ($stageBar.length) $stageBar.html('<span class="spinner-border spinner-border-sm me-2"></span>Loading…');
        $('#inv-pipeline-updated').text('Loading…');
        try {
            const data = await API.getInventorySummary();

            const hints = Array.isArray(data.pipeline_hints) ? data.pipeline_hints : [];
            const $hints = $('#inv-hints');
            if (hints.length) {
                $hints.removeClass('d-none').html(hints.map((h) => this._invEsc(h)).join('<br>'));
            } else {
                $hints.addClass('d-none').empty();
            }

            this._renderInventoryPipeline(data);
            $('#inv-pipeline-updated').text('Updated just now');

            const profit = Number(data.recovered_profit) || 0;
            $('#inv-kpi-profit').text('£' + profit.toFixed(2));
            const st = Number(data.sell_through_pct);
            $('#inv-kpi-sellthrough').text(
                Number.isFinite(st) ? Math.round(st * 100) + '%' : '—'
            );
            const recv = Number(data.items_received) || 0;
            const sent = Number(data.packages_sent) || 0;
            $('#inv-kpi-sellthrough-sub').text(
                recv > 0
                    ? 'Sold vs received intake'
                    : sent > 0
                      ? 'Sold vs packages sent'
                      : 'Sold items on your account'
            );
            $('#inv-kpi-sold').text(String(data.items_sold ?? 0));

            const est = data.estimated_pipeline_value;
            const $estRow = $('#inv-estimate-row');
            if (est != null && Number(est) > 0) {
                $estRow.removeClass('d-none');
                $('#inv-estimate-value').text('£' + Number(est).toFixed(2));
                const rem = data.potential_remaining_value;
                $('#inv-potential-remaining').text(
                    rem != null ? '£' + Number(rem).toFixed(2) : '—'
                );
            } else {
                $estRow.addClass('d-none');
            }

            const attention = Array.isArray(data.attention_items) ? data.attention_items : [];
            const $att = $('#inv-attention-tbody');
            if (!attention.length) {
                $att.html(
                    '<tr><td colspan="3" class="text-muted small p-3">Nothing needs attention — no open pending items.</td></tr>'
                );
            } else {
                $att.html(
                    attention
                        .map((row) => {
                            const days =
                                row.days_in_stage != null ? String(row.days_in_stage) : '—';
                            return (
                                '<tr><td>' +
                                this._invEsc(row.product || '—') +
                                '</td><td><span class="badge bg-light text-dark">' +
                                this._invEsc(row.current_stage || '—') +
                                '</span></td><td class="text-end">' +
                                days +
                                '</td></tr>'
                            );
                        })
                        .join('')
                );
            }

            const recent = Array.isArray(data.recent_sold) ? data.recent_sold : [];
            const $recent = $('#inv-recent-sold-tbody');
            if (!recent.length) {
                $recent.html(
                    '<tr><td colspan="3" class="text-muted small p-3">No sold items yet.</td></tr>'
                );
            } else {
                $recent.html(
                    recent
                        .map((row) => {
                            const lab = this.soldDateDisplayValue(row);
                            const p = Number(row.profit) || 0;
                            return (
                                '<tr><td>' +
                                this._invEsc(row.product || '—') +
                                '</td><td class="small">' +
                                this._invEsc(lab) +
                                '</td><td class="text-end text-success">£' +
                                p.toFixed(2) +
                                '</td></tr>'
                            );
                        })
                        .join('')
                );
            }

            this._renderInventoryStageBar(data);

            const $topCats = $('#inventory-top-refund-categories');
            if ($topCats.length) {
                try {
                    const insights = await API.getInventoryRefundInsights();
                    const categories = Array.isArray(insights.top_categories) ? insights.top_categories : [];
                    if (!categories.length) {
                        $topCats.html(
                            '<tr><td colspan="2" class="text-muted small">No category data yet.</td></tr>'
                        );
                    } else {
                        $topCats.html(
                            categories
                                .map((c) => {
                                    const subs = Array.isArray(c.subcategories) ? c.subcategories : [];
                                    const subTxt = subs.length ? subs.join(', ') : 'General';
                                    return (
                                        '<tr><td>' +
                                        this._invEsc(c.name) +
                                        '</td><td>' +
                                        this._invEsc(subTxt) +
                                        '</td></tr>'
                                    );
                                })
                                .join('')
                        );
                    }
                } catch (insightErr) {
                    $topCats.html(
                        '<tr><td colspan="2" class="text-muted small">Unable to load category insights.</td></tr>'
                    );
                    console.error('Load inventory refund insights error:', insightErr);
                }
            }

            $('#inventory-csv-upload').off('click').on('click', async () => {
                const inp = document.getElementById('inventory-csv-input');
                const f = inp && inp.files && inp.files[0];
                if (!f) {
                    alert('Choose a CSV file first.');
                    return;
                }
                const text = await f.text();
                const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                if (lines.length < 2) {
                    alert('CSV needs a header row and at least one data row.');
                    return;
                }
                const headers = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
                const rows = [];
                for (let i = 1; i < lines.length; i++) {
                    const cols = lines[i].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
                    const o = {};
                    headers.forEach((h, idx) => { o[h] = cols[idx] != null ? cols[idx] : ''; });
                    rows.push(o);
                }
                try {
                    const r = await API.importInventoryRows(rows);
                    Dashboard.showToast((r && r.message) || 'Import complete');
                    inp.value = '';
                    this.loadInventory();
                } catch (e) {
                    alert((e && e.error) || e.message || 'Import failed');
                }
            });
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
            $('#kpi-sell-through').text(Number((data.sellThroughRate || data.recoveryRate || 0) * 100).toFixed(0) + '%');
            $('#kpi-avg-sale-price').text('£' + Number(data.averageSalePrice || 0).toFixed(2));
            $('#kpi-return-rate').text(Number((data.returnRate || 0) * 100).toFixed(1) + '%');
            $('#kpi-avg-recovery').text('£' + Number(data.avgRecoveryPerItem || 0).toFixed(2));
            const $top = $('#analytics-top-categories');
            if ($top.length) {
                const cats = data.top_categories || [];
                if (!cats.length) {
                    $top.html('<tr><td colspan="4" class="text-muted small">No sold data yet.</td></tr>');
                } else {
                    $top.empty();
                    cats.forEach((c) => {
                        $top.append(
                            '<tr><td>' + String(c.name || '').replace(/</g, '&lt;') + '</td>' +
                            '<td class="text-end">' + (c.units_sold || 0) + '</td>' +
                            '<td class="text-end">£' + Number(c.profit_sum || 0).toFixed(2) + '</td>' +
                            '<td class="text-end">£' + Number(c.avg_sale_price || 0).toFixed(2) + '</td></tr>'
                        );
                    });
                }
            }
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
        a.download = 'returnpal-analytics-' + RP_DATE.formatIso(new Date()) + '.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    },

    exportInvoicesCsv() {
        const monthly = window._lastInvoicesData || [];
        const rows = [['Sales month (YYYY-MM)', 'Date issued (YYYY-MM-DD)', 'Payout date (YYYY-MM-DD)', 'Amount', 'Items', 'Status']];
        monthly.forEach(m => {
            rows.push([
                m.key || '',
                this.formatDateIso(m.date_issued),
                this.formatDateIso(m.payout_date),
                '£' + Number(m.amount).toFixed(2),
                m.items_count,
                m.status || ''
            ]);
        });
        const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'returnpal-invoices-' + RP_DATE.formatIso(new Date()) + '.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    },

    async exportInvoicesForAccountant() {
        await this.ensureClientPreferences();
        const monthly = window._lastInvoicesData || [];
        const vatNumber = this.getBillingDetailsForPrint().vat_number;
        let csv = 'ReturnPal - Invoice summary for accountant\n';
        csv += 'Exported: ' + this.formatDateIso(new Date()) + '\n';
        if (vatNumber) csv += 'VAT number: ' + vatNumber + '\n';
        csv += '\nSales month (YYYY-MM),Date issued (YYYY-MM-DD),Payout date (YYYY-MM-DD),Amount (£),VAT (£),Items,Status\n';
        monthly.forEach(m => {
            csv +=
                (m.key || '') +
                ',' +
                this.formatDateIso(m.date_issued) +
                ',' +
                this.formatDateIso(m.payout_date) +
                ',' +
                Number(m.amount).toFixed(2) +
                ',' +
                Number(m.vat_amount || 0).toFixed(2) +
                ',' +
                m.items_count +
                ',"' +
                (m.status || '') +
                '"\n';
        });
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'returnpal-accountant-' + RP_DATE.formatIso(new Date()) + '.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    },
    exportInvoicesXero() {
        const monthly = window._lastInvoicesData || [];
        let csv = '*Date (YYYY-MM-DD),*Amount,*Description\n';
        monthly.forEach(m => {
            const label = (m.key || '') + ' - ReturnPal recovery';
            csv += this.formatDateIso(m.date_issued) + ',' + Number(m.amount).toFixed(2) + ',"' + label + '"\n';
        });
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'returnpal-xero-' + RP_DATE.formatIso(new Date()) + '.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    },
    exportInvoicesQuickBooks() {
        const monthly = window._lastInvoicesData || [];
        let csv = 'Date (YYYY-MM-DD),Amount,Description,Memo\n';
        monthly.forEach(m => {
            const label = (m.key || '') + ' - ReturnPal recovery';
            csv += this.formatDateIso(m.date_issued) + ',' + Number(m.amount).toFixed(2) + ',"' + label + '","Returns recovery payout"\n';
        });
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'returnpal-quickbooks-' + RP_DATE.formatIso(new Date()) + '.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    },
    exportSoldItemsCsv() {
        const items = this._soldListFiltered;
        if (!items || !items.length) {
            this.showToast('No sold items to export.', 'error');
            return;
        }
        const escCell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        const rows = [['Sold date (YYYY-MM-DD)', 'Item name', 'Quantity', 'Gross earnings (£)', 'Returns deducted (£)', 'Net after returns (£)']];
        items.forEach((item) => {
            const gross = Number(item.profit != null ? item.profit : 0);
            const ret = Number(item.returns_deducted != null ? item.returns_deducted : 0);
            const net = Number(item.net_after_returns != null ? item.net_after_returns : gross - ret);
            rows.push([
                this.formatDateIso(this._soldDateSortKey(item)),
                item.product || '',
                String(item.quantity != null ? item.quantity : ''),
                gross.toFixed(2),
                ret > 0 ? ret.toFixed(2) : '',
                net.toFixed(2)
            ]);
        });
        const csv = rows.map((r) => r.map((c) => escCell(c)).join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'returnpal-sold-items-' + RP_DATE.formatIso(new Date()) + '.csv';
        a.click();
        URL.revokeObjectURL(a.href);
        this.showToast('Sold items CSV downloaded');
    },
    /**
     * @param {string} period YYYY-MM
     * @param {'invoice'|'statement'} kind Invoice = consolidated by product; statement = each sale/return line
     */
    async downloadInvoiceMonth(period, kind) {
        try {
            await this.ensureClientPreferences();
            const docKind = kind === 'statement' ? 'statement' : 'invoice';
            const data = await API.getInvoiceDetail(period);
            const [y, m] = period.split('-').map(Number);
            const periodLabel =
                data.period_label ||
                (Number.isFinite(y) && Number.isFinite(m) ? y + '-' + String(m).padStart(2, '0') + '-01' : period);
            const periodDisplay =
                /^\d{4}-\d{2}$/.test(String(period || '').trim())
                    ? Dashboard.formatStatementPeriodLabel(String(period).trim())
                    : Dashboard.formatDateUK(periodLabel);

            const today = new Date();
            const [iy, im] = period.split('-').map(Number);
            const invoiceDate = data.date_issued
                ? Dashboard.formatDateUK(data.date_issued)
                : Dashboard.formatDateUK(today);
            const dueDate = data.due_date
                ? Dashboard.formatDateUK(data.due_date)
                : Number.isFinite(iy) && Number.isFinite(im)
                    ? Dashboard.formatDateUK(new Date(iy, im + 1, 0))
                    : Dashboard.formatDateUK(new Date(today.getFullYear(), today.getMonth() + 1, 0));

            let invoiceNum = sessionStorage.getItem('returnpal_invoice_num_' + period);
            if (!invoiceNum) {
                const r = Math.floor(1000 + Math.random() * 9000);
                invoiceNum = 'INV-' + (Number.isFinite(iy) ? iy : today.getFullYear()) + '-' + String(r);
                sessionStorage.setItem('returnpal_invoice_num_' + period, invoiceNum);
            }

            let statementNum = sessionStorage.getItem('returnpal_statement_num_' + period);
            if (!statementNum) {
                const r = Math.floor(1000 + Math.random() * 9000);
                statementNum = 'STMT-' + (Number.isFinite(iy) ? iy : today.getFullYear()) + '-' + String(r);
                sessionStorage.setItem('returnpal_statement_num_' + period, statementNum);
            }

            const billing = this.getBillingDetailsForPrint();
            const vatNumber = billing.vat_number;
            const isVatRegistered = !!(data.vat_registered);
            const lineItemsRaw = data.line_items || [];
            const subtotalNet = lineItemsRaw.reduce((s, i) => s + (Number(i.amount || 0) * (Number(i.quantity) || 1)), 0);
            const lineItemsForTable = rpConsolidateInvoiceLineItemsForPrint(lineItemsRaw);
            const summary = data.summary || {};
            let amountDue = Number(data.total);
            if (!Number.isFinite(amountDue)) {
                amountDue = Number(summary.net_payout_estimate);
            }
            if (!Number.isFinite(amountDue)) {
                const grossNet = Number(data.gross_net ?? summary.gross_net);
                amountDue = isVatRegistered
                    ? grossNet
                    : Math.round((Number.isFinite(grossNet) ? grossNet : subtotalNet) * 0.8 * 100) / 100;
            }
            const colSpan = 4;
            const fmtMoney = (n) => {
                const x = Number(n) || 0;
                const neg = x < 0;
                return (neg ? '−' : '') + '£' + Math.abs(x).toFixed(2);
            };
            const invoiceSubtotal = Math.round(subtotalNet * 100) / 100;
            let payoutTotalRows =
                '<tr class="totals-row"><td colspan="' +
                colSpan +
                '" class="num">Subtotal</td><td class="num">' +
                fmtMoney(invoiceSubtotal) +
                '</td></tr>' +
                '<tr class="totals-row final"><td colspan="' +
                colSpan +
                '" class="num">Amount due</td><td class="num">' +
                fmtMoney(amountDue) +
                '</td></tr>';

            const billingName = billing.name;
            const billingCompany = billing.company;
            const billingAddress = (billing.address || '').replace(/\n/g, '<br/>');
            const billingPhone = billing.phone;

            const sender = 'JR Liquidations Limited<br/>Co. Reg. No.: 16355878<br/>Email: invoice@returnpal.co.uk<br/>Phone: +447774904697<br/>Website: returnpal.co.uk';
            const billTo = (billingName ? billingName + '<br/>' : '') + (billingCompany ? billingCompany + '<br/>' : '') + (billingAddress || '') + (billingPhone ? '<br/>' + billingPhone : '');

            const escLite = function (t) {
                return String(t || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
            };

            const unitLabel = 'each';
            const tableRows = lineItemsForTable.map(i => {
                const qty = Number(i.quantity) || 1;
                const netPerUnit = Number(i.amount || 0);
                const lineTotal = netPerUnit * qty;
                return (
                    '<tr><td>' + escLite(i.description || '') + '</td><td class="num">' + qty + '</td><td>' + unitLabel + '</td><td class="num">' + fmtMoney(netPerUnit) + '</td><td class="num">' + fmtMoney(lineTotal) + '</td></tr>'
                );
            }).join('');

            const stmt = data.statement_lines || [];
            if (docKind === 'statement') {
                if (!stmt.length) {
                    alert('No statement lines for this period.');
                    return;
                }
                const sr = stmt.map((s) => {
                    const amt = Number(s.amount) || 0;
                    const neg = amt < 0;
                    const lab = escLite(s.label || '');
                    const ref = String(s.reference || '').trim();
                    const refHtml = ref ? ' <span style="color:#666;font-size:12px;">(' + escLite(ref) + ')</span>' : '';
                    const dateStr = s.date ? Dashboard.formatDateUK(s.date) : '—';
                    return (
                        '<tr><td style="white-space:nowrap;color:#555;font-size:12px;">' + dateStr + '</td><td>' + lab + refHtml + '</td><td class="num" style="color:' +
                        (neg ? '#b02a37' : '#0f5132') + '">' + (neg ? '−' : '+') + '£' + Math.abs(amt).toFixed(2) + '</td></tr>'
                    );
                }).join('');
                const stmtSummary =
                    '<p class="period-note small">Sales (your share): <strong>£' + Number(summary.sales_profit || 0).toFixed(2) + '</strong> · Returns &amp; clawbacks: <strong>£' + Number(summary.refunds_and_returns || 0).toFixed(2) + '</strong> · Processing fees: <strong>£' + Number(summary.fees_deducted || data.fees || 0).toFixed(2) + '</strong> · <strong>Net payout estimate: £' + Number(summary.net_payout_estimate != null ? summary.net_payout_estimate : data.total || 0).toFixed(2) + '</strong></p>';

                const htmlStmt =
                    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Statement ' + statementNum + '</title><style>' + rpInvoicePrintDocumentCss() + '</style></head><body>' +
                    '<div class="doc">' +
                    '<div class="brand">' +
                    '<div><div class="brand-name">ReturnPal</div><div class="invoice-title">Payout statement</div></div>' +
                    '<div class="from-block"><strong>From</strong>' + sender + '</div>' +
                    '</div>' +
                    '<div class="to-block"><div class="label">Account</div><div class="value">' + (billTo || '-') + '</div></div>' +
                    '<div class="meta-grid">' +
                    '<div class="meta-item"><div class="label">Statement ref</div><div class="value">' + statementNum + '</div></div>' +
                    '<div class="meta-item"><div class="label">Period</div><div class="value">' + periodDisplay + '</div></div>' +
                    '<div class="meta-item"><div class="label">Generated</div><div class="value">' + invoiceDate + '</div></div>' +
                    '</div>' +
                    '<p class="period-note">Account movements for <strong>' + periodDisplay + '</strong>. Positive amounts increase your balance; negative amounts reduce it.</p>' +
                    '<table class="items-table">' +
                    '<thead><tr><th style="width:110px;">Date</th><th>Line</th><th class="num">Amount</th></tr></thead><tbody>' + sr + '</tbody></table>' +
                    stmtSummary +
                    '<div class="terms-box">' +
                    '<p>This document is a <strong>statement of account</strong>, not a tax invoice. For a consolidated invoice by product and quantity, use <strong>Invoice (by product)</strong> from the payouts table.</p>' +
                    '</div></div></body></html>';
                rpOpenInvoicePrintWindow(htmlStmt);
                return;
            }

            const styles = rpInvoicePrintDocumentCss();
            const htmlInv =
                '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Invoice ' + invoiceNum + '</title><style>' + styles + '</style></head><body>' +
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
                '<p class="period-note">Payout for period: <strong>' + periodDisplay + '</strong> (items sold and recovered). Quantities and amounts are consolidated by product title.</p>' +
                '<table class="items-table">' +
                '<thead><tr><th>Description</th><th class="num">Quantity</th><th>Unit</th><th class="num">Price</th><th class="num">Amount</th></tr></thead><tbody>' +
                tableRows +
                payoutTotalRows +
                '</tbody></table>' +
                '<div class="terms-box">' +
                (isVatRegistered
                    ? (vatNumber
                        ? '<p><strong>VAT registered.</strong> VAT No. ' + escLite(vatNumber) + '. Amount due is your payout for this period (line items include returns as negative lines where applicable). No 20% withholding.</p>'
                        : '<p><strong>VAT registered.</strong> Amount due is your payout for this period. No 20% withholding is applied.</p>')
                    : '<p>Amount due is your payout for this period. A 20% deduction applies when you are not VAT registered (see Settings).</p>') +
                '<p>For a line-by-line breakdown of each sale and return, use <strong>Statement (each line)</strong> from the payouts table.</p>' +
                '<p>Payment is due by the date stated above. Thank you for selling with ReturnPal.</p>' +
                '</div></div></body></html>';
            rpOpenInvoicePrintWindow(htmlInv);
        } catch (err) {
            console.error('Download invoice error:', err);
            alert(err.error || err.message || 'Unable to load invoice.');
        }
    },
    formatDateUK(d) {
        if (!d) return '';
        return RP_DATE.formatOrdinalEnGb(d);
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
            const timeline = data.timeline || (data.journey && data.journey.events) || [];
            const $tl = $('#pkg-timeline');
            $tl.empty();
            if (!timeline.length) {
                $tl.html('<p class="text-muted small mb-0">No journey events yet.</p>');
            } else {
                timeline.forEach((t) => {
                    const icon = t.icon || 'ri-circle-line';
                    const msg = t.message || '';
                    const label = t.stage ? String(t.stage).replace(/_/g, ' ') : '';
                    const when = t.timestamp ? RP_DATE.formatOrdinalEnGb(t.timestamp) : '';
                    $tl.append(
                        '<div class="d-flex gap-2 mb-3 pb-2 border-bottom border-light-subtle">' +
                        '<i class="' +
                        icon +
                        ' fs-5 text-primary mt-1"></i>' +
                        '<div><div class="small fw-medium text-capitalize">' +
                        (label || 'Update') +
                        '</div>' +
                        '<div class="small">' +
                        msg +
                        '</div>' +
                        (when ? '<small class="text-muted">' + when + '</small>' : '') +
                        '</div></div>'
                    );
                });
            }
        } catch (err) {
            console.error('Load package detail error:', err);
            if ($card.length) this.showError($card, err.error || 'Unable to load package.', () => this.loadPackageDetail());
        }
    },

    // ─── SETTINGS PAGE ───────────────────────────────────────
    async loadSettings() {
        try {
            try {
                const me = await API.request('/auth/me', { skipAuthRedirect: true });
                if (me && me.user) {
                    if (API.getSessionToken()) API.setSessionUser(me.user);
                    else API.setUser(me.user);
                    this.updateUserIdentityUI(me.user);
                }
            } catch (e) { /* offline or 401 — use cached user */ }

            const data = await API.getSettings();
            if (data.settings) {
                $('#flexSwitchCheckDefault').prop('checked', !!data.settings.vat_registered);
                $('input[placeholder*="discord"]').val(data.settings.discord_webhook || '');
                const wd = data.settings.weekly_digest_email;
                const weeklyOn = wd === 1 || wd === '1' || wd === true;
                const $dig = $('#email-digest-preference');
                if ($dig.length) $dig.val(weeklyOn ? 'weekly' : 'off');
            }
            // Profile details (name, email from user; company from profile or billing)
            const user = API.getUser();
            const profileName = localStorage.getItem('returnpal_profile_name') || (user && user.full_name) || '';
            const profileEmail = (user && user.email) || '';
            const profileCompany = localStorage.getItem('returnpal_profile_company') || localStorage.getItem('returnpal_billing_company') || '';
            const legacyId = (user && user.legacy_client_id) || (data.settings && data.settings.legacy_client_id) || '';
            $('#settings-profile-name').val(profileName);
            $('#settings-profile-email').val(profileEmail);
            $('#settings-profile-company').val(profileCompany);
            $('#settings-legacy-client-id').val(legacyId);
            this.updateAvatarWidgets(user);

            $(document).off('change', '#settings-avatar-input').on('change', '#settings-avatar-input', async function() {
                const f = this.files && this.files[0];
                if (!f) return;
                try {
                    await API.uploadAvatar(f);
                    Dashboard.updateAvatarWidgets(API.getUser());
                    Dashboard.showToast('Photo updated');
                } catch (err) {
                    alert((err && err.error) || err.message || 'Upload failed');
                }
                $(this).val('');
            });
            $(document).off('click', '#settings-avatar-remove').on('click', '#settings-avatar-remove', async function() {
                try {
                    await API.deleteAvatar();
                    Dashboard.updateAvatarWidgets(API.getUser());
                    Dashboard.showToast('Photo removed');
                } catch (err) {
                    alert((err && err.error) || err.message || 'Could not remove photo');
                }
            });

            $(document).off('click', '#settings-profile-save').on('click', '#settings-profile-save', async function() {
                const $btn = $(this);
                const name = $('#settings-profile-name').val().trim();
                const company = $('#settings-profile-company').val().trim();
                const legacy = $('#settings-legacy-client-id').val().trim();
                try {
                    $btn.prop('disabled', true).text('Saving…');
                    await API.updateProfile({
                        full_name: name,
                        company_name: company,
                        legacy_client_id: legacy
                    });
                    localStorage.setItem('returnpal_profile_name', name);
                    localStorage.setItem('returnpal_profile_company', company);
                    try {
                        const me = await API.getProfile({ skipAuthRedirect: true });
                        if (me && me.user) {
                            if (API.getSessionToken()) API.setSessionUser(me.user);
                            else API.setUser(me.user);
                            Dashboard.updateUserIdentityUI(me.user);
                        }
                    } catch (e) { /* ignore */ }
                    Dashboard.showToast('Profile saved');
                    $btn.text('Saved!');
                    setTimeout(() => $btn.text('Save').prop('disabled', false), 1500);
                } catch (err) {
                    alert((err && err.error) || (err && err.errors && err.errors[0] && err.errors[0].msg) || 'Could not save profile.');
                    $btn.prop('disabled', false).text('Save');
                }
            });
            let prefs = (data.settings && data.settings.preferences) || {};
            const billingKeys = { name: 'returnpal_billing_name', company: 'returnpal_billing_company', address: 'returnpal_billing_address', phone: 'returnpal_billing_phone' };
            const prepKeys = { name: 'returnpal_prep_name', address: 'returnpal_prep_address', contact: 'returnpal_prep_contact', phone: 'returnpal_prep_phone', email: 'returnpal_prep_email', reference: 'returnpal_prep_reference' };
            const needsMigrate =
                !prefs.billing_name &&
                !prefs.billing_company &&
                (localStorage.getItem(billingKeys.name) || localStorage.getItem(prepKeys.name) || localStorage.getItem('returnpal_vat_number'));
            if (needsMigrate) {
                prefs = {
                    ...prefs,
                    billing_name: localStorage.getItem(billingKeys.name) || '',
                    billing_company: localStorage.getItem(billingKeys.company) || '',
                    billing_address: localStorage.getItem(billingKeys.address) || '',
                    billing_phone: localStorage.getItem(billingKeys.phone) || '',
                    prep_name: localStorage.getItem(prepKeys.name) || '',
                    prep_address: localStorage.getItem(prepKeys.address) || '',
                    prep_contact: localStorage.getItem(prepKeys.contact) || '',
                    prep_phone: localStorage.getItem(prepKeys.phone) || '',
                    prep_email: localStorage.getItem(prepKeys.email) || '',
                    prep_reference: localStorage.getItem(prepKeys.reference) || '',
                    vat_number: localStorage.getItem('returnpal_vat_number') || '',
                    email_monthly_invoice: localStorage.getItem('returnpal_email_monthly_invoice') === 'true',
                    email_digest: localStorage.getItem('returnpal_email_digest') || prefs.email_digest || 'off',
                };
                API.updatePreferences(prefs).catch(() => {});
            }
            this.applyClientPreferencesToForm(prefs);
            this._clientPrefsCache = prefs;

            const savePrefsClick = async function($btn, doneLabel, savingLabel) {
                try {
                    $btn.prop('disabled', true).text(savingLabel || 'Saving…');
                    await Dashboard.saveClientPreferences();
                    Dashboard.showToast('Saved to your account');
                    $btn.text(doneLabel || 'Saved!');
                    setTimeout(() => $btn.prop('disabled', false).text($btn.data('default-label') || 'Save'), 1500);
                } catch (err) {
                    alert((err && err.error) || err.message || 'Could not save');
                    $btn.prop('disabled', false).text($btn.data('default-label') || 'Save');
                }
            };

            $(document).off('click', '#settings-billing-save').on('click', '#settings-billing-save', function() {
                const $btn = $(this);
                $btn.data('default-label', 'Save billing details');
                savePrefsClick($btn, 'Saved!', 'Saving…');
            });
            $(document).off('click', '#settings-prep-save').on('click', '#settings-prep-save', function() {
                const $btn = $(this);
                $btn.data('default-label', 'Save prep centre details');
                savePrefsClick($btn, 'Saved!', 'Saving…');
            });

            $(document).off('blur', '#settings-vat-number').on('blur', '#settings-vat-number', function() {
                Dashboard.saveClientPreferences().catch(() => {});
            });

            $(document).off('click', '#settings-password-save').on('click', '#settings-password-save', async function() {
                const $btn = $(this);
                const cur = $('#settings-current-password').val();
                const neu = $('#settings-new-password').val();
                const conf = $('#settings-confirm-password').val();
                if (!cur || !neu) return alert('Enter current and new password.');
                if (neu.length < 8) return alert('New password must be at least 8 characters.');
                if (neu !== conf) return alert('New passwords do not match.');
                try {
                    $btn.prop('disabled', true).text('Updating…');
                    await API.changePassword(cur, neu);
                    $('#settings-current-password, #settings-new-password, #settings-confirm-password').val('');
                    Dashboard.showToast('Password updated');
                    $btn.text('Updated!');
                    setTimeout(() => $btn.prop('disabled', false).text('Update password'), 1500);
                } catch (err) {
                    alert((err && err.error) || err.message || 'Could not update password');
                    $btn.prop('disabled', false).text('Update password');
                }
            });

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

            $(document).off('click', '#settings-email-prefs-save').on('click', '#settings-email-prefs-save', async function() {
                const v = $('#email-digest-preference').val();
                const on = v === 'weekly' || v === 'monthly';
                const $btn = $(this);
                try {
                    $btn.prop('disabled', true).text('Saving…');
                    await Dashboard.saveClientPreferences();
                    await API.updateWeeklyDigest(on);
                    Dashboard.showToast('Email preferences saved');
                    $btn.text('Saved!');
                    setTimeout(() => $btn.text('Save email preferences').prop('disabled', false), 1500);
                } catch (err) {
                    alert((err && err.error) || err.message || 'Could not save preferences.');
                    $btn.prop('disabled', false).text('Save email preferences');
                }
            });
        } catch(err) {
            console.error('Load settings error:', err);
        }
    }
};

$(document).ready(function() {
    Dashboard.init();
});
