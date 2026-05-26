/**
 * Editable Client ID review table with bulk SKU rules (admin bulk import + eBay refunds).
 */
(function (root) {
    'use strict';

    function escapeHtml(s) {
        if (root.escapeHtml) return root.escapeHtml(s);
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function resolveClientLocally(spec, users) {
        var s = String(spec || '')
            .trim()
            .toLowerCase();
        if (!s) return null;
        users = users || root._adminUsersList || [];
        for (var i = 0; i < users.length; i++) {
            var u = users[i];
            if (u.is_admin === true || u.is_admin === 1 || u.is_admin === '1') continue;
            if (String(u.id) === s || String(u.id).padStart(4, '0') === s) return u;
            if (u.legacy_client_id && String(u.legacy_client_id).trim().toLowerCase() === s) return u;
        }
        return null;
    }

    function clientSourceLabel(src) {
        if (src === 'orders_map') return 'Orders sheet';
        if (src === 'custom_label') return 'SKU label';
        if (src === 'column') return 'Column';
        if (src === 'bulk') return 'Bulk rule';
        if (src === 'sku_detect') return 'SKU detect';
        if (src === 'saved_order') return 'Saved order';
        return '—';
    }

    function getOrderNumberFromRow(r) {
        if (!r) return '';
        if (r.order_number) return String(r.order_number).trim();
        if (r.row_data && r.row_data.order_number) return String(r.row_data.order_number).trim();
        return '';
    }

    function skuApi() {
        return root.EbayRefundReview || null;
    }

    function ImportClientReview(cfg) {
        this.cfg = cfg;
        this.prefix = cfg.prefix;
        this._saveTimers = Object.create(null);
    }

    ImportClientReview.prototype.sel = function (id) {
        return '#' + this.prefix + '-' + id;
    };

    ImportClientReview.prototype.getRows = function () {
        return this.cfg.getRows() || [];
    };

    ImportClientReview.prototype.rebuildDatalist = function () {
        var $dl = $(this.sel('client-datalist')).empty();
        (root._adminUsersList || []).forEach(function (u) {
            if (u.is_admin === true || u.is_admin === 1 || u.is_admin === '1') return;
            var leg = (u.legacy_client_id && String(u.legacy_client_id).trim()) || '';
            var label = String(u.id).padStart(4, '0') + ' — ' + (u.full_name || u.email || '');
            $dl.append($('<option></option>').attr('value', leg || String(u.id)).text(label));
            if (leg) $dl.append($('<option></option>').attr('value', String(u.id)).text(label));
        });
    };

    ImportClientReview.prototype.rowHaystack = function (r) {
        if (this.cfg.rowHaystack) return this.cfg.rowHaystack(r);
        return [r.custom_label, r.product, r.notes, r.client_id, r.summary].filter(Boolean).join(' ');
    };

    ImportClientReview.prototype.rowMatchesFilter = function (r, filter, searchQ) {
        if (searchQ) {
            var hay = this.rowHaystack(r).toLowerCase();
            if (hay.indexOf(searchQ) < 0) return false;
        }
        if (filter === 'needs') return !resolveClientLocally(r.client_id);
        if (filter === 'ready') return !!resolveClientLocally(r.client_id);
        return true;
    };

    ImportClientReview.prototype.matchesScope = function (r, scope, filter, searchQ) {
        if (scope === 'all') return true;
        if (scope === 'needs') return !resolveClientLocally(r.client_id);
        return this.rowMatchesFilter(r, filter, searchQ);
    };

    ImportClientReview.prototype.bulkChangedCount = function (updater, scope) {
        var filter = $(this.sel('review-filter')).val() || 'all';
        var searchQ = ($(this.sel('review-search')).val() || '').trim().toLowerCase();
        var n = 0;
        var self = this;
        this.getRows().forEach(function (r) {
            if (!self.matchesScope(r, scope, filter, searchQ)) return;
            var prev = r.client_id;
            updater(r);
            if (String(r.client_id || '') !== String(prev || '')) n++;
        });
        return n;
    };

    ImportClientReview.prototype.updateRowResolve = function ($tr, clientId, row) {
        var u = resolveClientLocally(clientId);
        var $m = $tr.find('.' + this.prefix + '-review-match');
        $tr.toggleClass('table-warning', !u);
        if (!clientId) {
            $m.html('<span class="text-warning">Pick Client ID</span>');
            return;
        }
        if (!u) {
            var onum = getOrderNumberFromRow(row);
            if (onum) {
                $m.html(
                    '<span class="text-info">Unknown — order → <strong>' +
                        escapeHtml(clientId) +
                        '</strong> saved for future imports</span>'
                );
            } else {
                $m.html('<span class="text-danger">Unknown client (add order # to save mapping)</span>');
            }
            return;
        }
        $m.html(
            '<span class="text-success">' +
                escapeHtml(u.full_name || u.email || 'Client') +
                ' <span class="text-muted">(ID ' +
                String(u.id).padStart(4, '0') +
                ')</span></span>'
        );
    };

    ImportClientReview.prototype.scheduleSaveOrderMapping = function (line) {
        var self = this;
        if (!this.cfg.saveOrderMapping) return;
        if (this._saveTimers[line]) clearTimeout(this._saveTimers[line]);
        this._saveTimers[line] = setTimeout(function () {
            var row = null;
            self.getRows().forEach(function (r) {
                if (r.line === line) row = r;
            });
            if (!row) return;
            var onum = getOrderNumberFromRow(row);
            var cid = String(row.client_id || '').trim();
            if (!onum || !cid) return;
            self.cfg.saveOrderMapping([{ order_number: onum, client_specifier: cid }]);
        }, 500);
    };

    ImportClientReview.prototype.render = function () {
        var self = this;
        var filter = $(this.sel('review-filter')).val() || 'all';
        var searchQ = ($(this.sel('review-search')).val() || '').trim().toLowerCase();
        var $tb = $(this.sel('review-tbody')).empty();
        var visible = 0;
        this.getRows().forEach(function (r) {
            if (!self.rowMatchesFilter(r, filter, searchQ)) return;
            visible++;
            var $tr = $('<tr></tr>').addClass(self.prefix + '-review-row').attr('data-line', r.line);
            var dataHtml = self.cfg.renderDataCells ? self.cfg.renderDataCells(r, escapeHtml) : '';
            $tr.append(
                '<td class="text-muted">' +
                    r.line +
                    '</td>' +
                    dataHtml +
                    '<td class="small text-muted">' +
                    escapeHtml(clientSourceLabel(r.client_source)) +
                    '</td>' +
                    '<td><input type="text" class="form-control form-control-sm ' +
                    self.prefix +
                    '-review-client-id" list="' +
                    self.prefix +
                    '-client-datalist" value="' +
                    escapeHtml(r.client_id || '') +
                    '" /></td>' +
                    '<td class="small ' +
                    self.prefix +
                    '-review-match"></td>'
            );
            self.updateRowResolve($tr, r.client_id || '', r);
            $tb.append($tr);
        });
        $(this.sel('review-visible-count')).text(visible + ' row' + (visible === 1 ? '' : 's') + ' shown');
        var ready = 0;
        this.getRows().forEach(function (r) {
            if (resolveClientLocally(r.client_id)) ready++;
        });
        var total = this.getRows().length;
        $(this.sel('review-summary'))
            .removeClass('d-none')
            .text(total + ' rows · ' + ready + ' ready · ' + (total - ready) + ' need attention');
    };

    ImportClientReview.prototype.open = function (rows, opts) {
        opts = opts || {};
        this.cfg.setRows((rows || []).map(function (r) {
            return Object.assign({}, r);
        }));
        $(this.sel('bulk-set-client')).val('').removeData('userEdited');
        $(this.sel('bulk-contains')).val('');
        $(this.sel('review-wrap')).removeClass('d-none');
        $(this.sel('import-reviewed-btn')).removeClass('d-none');
        if (opts.filter) $(this.sel('review-filter')).val(opts.filter);
        this.rebuildDatalist();
        this.render();
        if (opts.message && this.cfg.showMessage) this.cfg.showMessage(opts.message);
    };

    ImportClientReview.prototype.bind = function () {
        var self = this;
        var p = this.prefix;

        $(document).on('input', '.' + p + '-review-client-id', function () {
            var $tr = $(this).closest('tr');
            var line = parseInt($tr.attr('data-line'), 10);
            var val = $(this).val();
            var row = null;
            self.getRows().forEach(function (r) {
                if (r.line === line) {
                    r.client_id = val;
                    row = r;
                }
            });
            self.updateRowResolve($tr, val, row);
            self.scheduleSaveOrderMapping(line);
        });

        $(this.sel('review-filter') + ', ' + this.sel('review-search')).on('input change', function () {
            self.render();
        });

        $(this.sel('bulk-contains')).on('input', function () {
            var api = skuApi();
            if (!api) return;
            var $set = $(self.sel('bulk-set-client'));
            if ($set.data('userEdited')) return;
            var detected = api.extractLegacyClientIdFromText($(this).val());
            if (detected) $set.val(detected);
        });
        $(this.sel('bulk-set-client')).on('input', function () {
            $(this).data('userEdited', true);
        });

        $(this.sel('bulk-apply-btn')).on('click', function () {
            var api = skuApi();
            if (!api) return alert('SKU helpers failed to load — refresh the page.');
            var contains = ($(self.sel('bulk-contains')).val() || '').trim();
            var setRaw = ($(self.sel('bulk-set-client')).val() || '').trim();
            if (!contains) return alert('Enter text to match (e.g. PPF081 or PPF-081).');
            if (!setRaw) return alert('Enter the Client ID to apply.');
            var setVal = api.bulkSetClientIdValue(setRaw);
            var scope = $(self.sel('bulk-scope')).val() || 'visible';
            var changed = self.bulkChangedCount(function (r) {
                if (!api.textMatchesBulkContains(self.rowHaystack(r), contains)) return;
                r.client_id = setVal;
                r.client_source = 'bulk';
            }, scope);
            self.render();
            if (self.cfg.showMessage) self.cfg.showMessage('Bulk rule: set Client ID to ' + setVal + ' on ' + changed + ' row(s).');
        });

        $(this.sel('fill-sku-btn')).on('click', function () {
            var api = skuApi();
            if (!api) return alert('SKU helpers failed to load — refresh the page.');
            var scope = $(self.sel('bulk-scope')).val() || 'needs';
            var changed = self.bulkChangedCount(function (r) {
                var detected = api.extractLegacyClientIdFromText(self.rowHaystack(r));
                if (!detected) return;
                r.client_id = detected;
                r.client_source = 'sku_detect';
            }, scope);
            self.render();
            if (self.cfg.showMessage) self.cfg.showMessage('Fill from SKU: updated Client ID on ' + changed + ' row(s).');
        });

        $(this.sel('normalize-ppf-btn')).on('click', function () {
            var api = skuApi();
            if (!api) return alert('SKU helpers failed to load — refresh the page.');
            var scope = $(self.sel('bulk-scope')).val() || 'all';
            var changed = self.bulkChangedCount(function (r) {
                var cur = String(r.client_id || '').trim();
                if (!cur) return;
                var norm = api.normalizeClientIdSpecifier(cur);
                if (norm && norm !== cur) {
                    r.client_id = norm;
                    if (r.client_source === 'none') r.client_source = 'bulk';
                }
            }, scope);
            self.render();
            if (self.cfg.showMessage) self.cfg.showMessage('Normalize PPF IDs: updated ' + changed + ' row(s).');
        });

        $(this.sel('import-reviewed-btn')).on('click', function () {
            return self.runImport();
        });
    };

    ImportClientReview.prototype.runImport = async function () {
        var rows = this.getRows();
        if (!rows.length) return alert('Load rows for review first.');
        var ready = 0;
        rows.forEach(function (r) {
            if (resolveClientLocally(r.client_id)) ready++;
        });
        if (!this.cfg.onImport) return alert('Import not configured.');
        var $btn = $(this.sel('import-reviewed-btn'));
        $btn.prop('disabled', true).text('Importing…');
        try {
            await this.cfg.onImport(rows, { ready: ready, total: rows.length });
        } catch (e) {
            alert((e && e.error) || e.message || 'Import failed');
        } finally {
            $btn.prop('disabled', false).text('Import reviewed rows');
        }
    };

    root.ImportClientReview = {
        create: function (cfg) {
            var inst = new ImportClientReview(cfg);
            inst.bind();
            return inst;
        },
        resolveClientLocally: resolveClientLocally,
    };
})(typeof window !== 'undefined' ? window : globalThis);
