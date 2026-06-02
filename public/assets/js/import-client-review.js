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

    /** Prefer live local list; fall back to server preview resolution until Client ID is edited. */
    function clientResolvedForRow(r, specOverride) {
        var spec = specOverride != null ? specOverride : r && r.client_id;
        var local = resolveClientLocally(spec);
        if (local) return local;
        if (
            r &&
            r.resolve_ok === true &&
            r.resolved_user_id &&
            (specOverride == null ||
                String(specOverride || '')
                    .trim()
                    .toLowerCase() ===
                    String(r.client_id || '')
                        .trim()
                        .toLowerCase())
        ) {
            return {
                id: r.resolved_user_id,
                full_name: r.resolved_label || '',
                email: r.resolved_email || '',
                legacy_client_id: r.client_id || '',
            };
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

    function rowNeedsClient(r) {
        return !clientResolvedForRow(r);
    }

    function rowNoMatchingSale(r) {
        return !r.already_imported && clientResolvedForRow(r) && r.sale_match_ok === false;
    }

    function rowReadyToImport(r) {
        return !r.already_imported && clientResolvedForRow(r) && r.sale_match_ok !== false;
    }

    function countReviewBuckets(rows) {
        var imported = 0;
        var needClient = 0;
        var noSale = 0;
        var ready = 0;
        (rows || []).forEach(function (r) {
            if (r.already_imported) imported++;
            else if (rowNeedsClient(r)) needClient++;
            else if (r.sale_match_ok === false) noSale++;
            else ready++;
        });
        return { imported: imported, needClient: needClient, noSale: noSale, ready: ready };
    }

    /** What happens when you click Import reviewed rows. */
    function importOutcomeForRow(r) {
        if (r.already_imported) {
            return {
                code: 'duplicate',
                label: 'Already imported',
                badge: 'secondary',
                title: 'Duplicate refund — skipped',
            };
        }
        if (rowNeedsClient(r)) {
            if (getOrderNumberFromRow(r) && String(r.client_id || '').trim()) {
                return {
                    code: 'pending',
                    label: '→ Pending imports',
                    badge: 'info',
                    title: 'Unknown Client ID — saved for when that client exists',
                };
            }
            return {
                code: 'need_client',
                label: 'Need Client ID',
                badge: 'warning',
                title: 'Pick a Client ID that matches a ReturnPal account',
            };
        }
        if (rowNoMatchingSale(r)) {
            return {
                code: 'no_sale',
                label: 'Skipped — no sale',
                badge: 'danger',
                title:
                    r.sale_match_error ||
                    'No matching sale on this client dashboard — import the sale first',
            };
        }
        return {
            code: 'dashboard',
            label: '→ Client dashboard',
            badge: 'success',
            title: 'Refund will be applied to this client payout',
        };
    }

    function renderImportOutcomeBadge(r, esc) {
        var o = importOutcomeForRow(r);
        return (
            '<span class="badge text-bg-' +
            o.badge +
            '" title="' +
            esc(o.title) +
            '">' +
            esc(o.label) +
            '</span>'
        );
    }

    function renderSaleMatchBadge(r, esc) {
        if (r.already_imported) {
            return '<span class="text-muted small">—</span>';
        }
        if (!clientResolvedForRow(r)) {
            return '<span class="text-muted small">Set client first</span>';
        }
        if (r.sale_match_ok === false) {
            return '<span class="badge text-bg-danger" title="' + esc(r.sale_match_error || '') + '">No match</span>';
        }
        var preview = r.matched_sale_preview;
        if (preview && preview !== '—') {
            return '<span class="badge text-bg-success" title="Linked sold_items row">Sale ' + esc(preview) + '</span>';
        }
        return '<span class="badge text-bg-success">Matched</span>';
    }

    function applyRowStatusClasses($tr, r) {
        $tr.removeClass('table-success table-warning table-danger table-secondary table-info');
        var o = importOutcomeForRow(r);
        if (o.code === 'duplicate') $tr.addClass('table-secondary');
        else if (o.code === 'dashboard') $tr.addClass('table-success');
        else if (o.code === 'no_sale') $tr.addClass('table-danger');
        else if (o.code === 'pending') $tr.addClass('table-info');
        else if (o.code === 'need_client') $tr.addClass('table-warning');
    }

    function skuApi() {
        return root.EbayRefundReview || null;
    }

    function ImportClientReview(cfg) {
        this.cfg = cfg;
        this.prefix = cfg.prefix;
        this._saveTimers = Object.create(null);
        this._dupTimers = Object.create(null);
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
        if (filter === 'imported') return !!r.already_imported;
        if (filter === 'needs') return rowNeedsClient(r) && !r.already_imported;
        if (filter === 'no_sale') return rowNoMatchingSale(r);
        if (filter === 'ready') return rowReadyToImport(r);
        return true;
    };

    ImportClientReview.prototype.matchesScope = function (r, scope, filter, searchQ) {
        if (scope === 'all') return true;
        if (scope === 'needs') return rowNeedsClient(r) && !r.already_imported;
        if (scope === 'no_sale') return rowNoMatchingSale(r);
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
        var esc = escapeHtml;
        var refundCols = !!this.cfg.refundImport;
        var $m = $tr.find('.' + this.prefix + '-review-match');
        var $sale = $tr.find('.' + this.prefix + '-review-sale');
        var $outcome = $tr.find('.' + this.prefix + '-review-import-outcome');
        var $input = $tr.find('.' + this.prefix + '-review-client-id');
        if (refundCols) {
            applyRowStatusClasses($tr, row || {});
            if ($sale.length) $sale.html(renderSaleMatchBadge(row || {}, esc));
            if ($outcome.length) $outcome.html(renderImportOutcomeBadge(row || {}, esc));
        }
        if (row && row.already_imported) {
            if (!refundCols) $tr.addClass('table-secondary').removeClass('table-warning');
            $input.prop('disabled', true);
            var dupNote = row.duplicate_adjustment_id ? ' #' + row.duplicate_adjustment_id : '';
            $m.html('<span class="text-muted">Already imported' + esc(dupNote) + '</span>');
            return;
        }
        if (!refundCols) $tr.removeClass('table-secondary');
        $input.prop('disabled', false);
        var u = clientResolvedForRow(row, clientId);
        if (!refundCols) $tr.toggleClass('table-warning', !u && !!clientId);
        if (!clientId) {
            $m.html('<span class="text-warning">Pick Client ID</span>');
            return;
        }
        if (!u) {
            var onum = getOrderNumberFromRow(row);
            if (onum) {
                $m.html(
                    '<span class="text-info">Unknown ID <strong>' +
                        esc(clientId) +
                        '</strong> — order saved for Pending imports</span>'
                );
            } else {
                $m.html('<span class="text-danger">Unknown client</span>');
            }
            return;
        }
        if (refundCols) {
            $m.html(
                '<span class="text-success">' +
                    esc(u.full_name || u.email || 'Client') +
                    ' <span class="text-muted">(' +
                    String(u.id).padStart(4, '0') +
                    ')</span></span>'
            );
            return;
        }
        if (row && row.sale_match_ok === false) {
            $m.html(
                '<span class="text-danger">' +
                    esc(row.sale_match_error || 'No matching sale on dashboard — import the sale first') +
                    '</span>'
            );
            return;
        }
        var saleNote =
            row && row.matched_sale_preview && row.matched_sale_preview !== '—'
                ? ' · sale ' + esc(row.matched_sale_preview)
                : '';
        $m.html(
            '<span class="text-success">' +
                esc(u.full_name || u.email || 'Client') +
                ' (' +
                String(u.id).padStart(4, '0') +
                ')' +
                saleNote +
                '</span>'
        );
    };

    ImportClientReview.prototype.scheduleRecheckDuplicate = function (line) {
        var self = this;
        if (!this.cfg.checkDuplicate) return;
        if (this._dupTimers[line]) clearTimeout(this._dupTimers[line]);
        this._dupTimers[line] = setTimeout(function () {
            var row = null;
            self.getRows().forEach(function (r) {
                if (r.line === line) row = r;
            });
            if (!row) return;
            self.cfg.checkDuplicate(row).then(function (res) {
                row.already_imported = !!(res && res.already_imported);
                row.duplicate_adjustment_id = res && res.duplicate_adjustment_id ? res.duplicate_adjustment_id : null;
                var filter = $(self.sel('review-filter')).val() || 'all';
                if (filter === 'needs' && !row.already_imported) {
                    self.updateFilterHint();
                    return;
                }
                self.render();
            });
        }, 400);
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

    ImportClientReview.prototype.updateFilterHint = function () {
        var filter = $(this.sel('review-filter')).val() || 'all';
        var $hint = $(this.sel('review-filter-hint'));
        if (!$hint.length) return;
        var buckets = countReviewBuckets(this.getRows());
        if (filter === 'needs' && buckets.ready + buckets.noSale > 0) {
            var parts = [];
            if (buckets.ready)
                parts.push(
                    buckets.ready +
                        ' ready to import (hidden here — use <strong>Ready to import</strong>)'
                );
            if (buckets.noSale)
                parts.push(
                    buckets.noSale +
                        ' with no matching sale (use <strong>No matching sale</strong>)'
                );
            $hint.removeClass('d-none').html(parts.join('. ') + '.');
        } else if (filter === 'needs' && buckets.imported > 0) {
            $hint
                .removeClass('d-none')
                .html(
                    buckets.imported +
                        ' row(s) already in ReturnPal — use <strong>Already imported</strong> or <strong>All rows</strong>.'
                );
        } else if (filter === 'ready' && buckets.noSale > 0) {
            $hint
                .removeClass('d-none')
                .html(
                    buckets.ready +
                        ' row(s) will import. ' +
                        buckets.noSale +
                        ' more have a Client ID but <strong>no matching sale</strong> — switch <strong>Show</strong> to see them (they are skipped on import).'
                );
        } else if (filter === 'ready') {
            $hint
                .removeClass('d-none')
                .text(
                    buckets.ready +
                        ' row(s) will import to client dashboards when you click Import reviewed rows.'
                );
        } else if (filter === 'no_sale') {
            $hint
                .removeClass('d-none')
                .text(
                    buckets.noSale +
                        ' row(s) have a Client ID but no sale on that dashboard — import the sale first, or they will be skipped.'
                );
        } else {
            $hint.addClass('d-none');
        }
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
            var refundCols = !!self.cfg.refundImport;
            var tail =
                '<td><input type="text" class="form-control form-control-sm ' +
                self.prefix +
                '-review-client-id" list="' +
                self.prefix +
                '-client-datalist" value="' +
                escapeHtml(r.client_id || '') +
                '" /></td>';
            if (refundCols) {
                tail +=
                    '<td class="small text-nowrap ' +
                    self.prefix +
                    '-review-sale"></td>' +
                    '<td class="small text-nowrap ' +
                    self.prefix +
                    '-review-import-outcome"></td>' +
                    '<td class="small ' +
                    self.prefix +
                    '-review-match"></td>';
            } else {
                tail += '<td class="small ' + self.prefix + '-review-match"></td>';
            }
            $tr.append(
                '<td class="text-muted">' +
                    r.line +
                    '</td>' +
                    dataHtml +
                    '<td class="small text-muted">' +
                    escapeHtml(clientSourceLabel(r.client_source)) +
                    '</td>' +
                    tail
            );
            self.updateRowResolve($tr, r.client_id || '', r);
            $tb.append($tr);
        });
        $(this.sel('review-visible-count')).text(visible + ' row' + (visible === 1 ? '' : 's') + ' shown');
        var buckets = countReviewBuckets(this.getRows());
        var total = this.getRows().length;
        var summary =
            total +
            ' rows · ' +
            buckets.ready +
            ' ready to import';
        if (buckets.noSale) summary += ' · ' + buckets.noSale + ' no matching sale';
        if (buckets.needClient) summary += ' · ' + buckets.needClient + ' need Client ID';
        if (buckets.imported) summary += ' · ' + buckets.imported + ' already imported';
        $(this.sel('review-summary')).removeClass('d-none').text(summary);
        this.renderRefundLegend();
        this.updateFilterHint();
    };

    ImportClientReview.prototype.renderRefundLegend = function () {
        var $leg = $(this.sel('review-legend'));
        if (!$leg.length || !this.cfg.refundImport) return;
        var b = countReviewBuckets(this.getRows());
        $leg.removeClass('d-none').html(
            '<span class="badge text-bg-success me-1">→ Client dashboard</span> refund applies to payout · ' +
                '<span class="badge text-bg-danger me-1">Skipped — no sale</span> not imported · ' +
                '<span class="badge text-bg-info me-1">→ Pending imports</span> unknown client · ' +
                '<span class="badge text-bg-warning me-1">Need Client ID</span> · ' +
                '<span class="badge text-bg-secondary">Already imported</span>' +
                ' — <strong>' +
                b.ready +
                '</strong> will hit dashboards, <strong>' +
                b.noSale +
                '</strong> skipped (no sale), <strong>' +
                b.needClient +
                '</strong> need client.'
        );
    };

    ImportClientReview.prototype.open = function (rows, opts) {
        opts = opts || {};
        if (opts.refundImport != null) this.cfg.refundImport = !!opts.refundImport;
        var refundCols = !!this.cfg.refundImport;
        var $head = $(this.sel('review-wrap')).find('thead tr');
        if ($head.length) {
            if (refundCols) {
                $head.html(
                    '<th>#</th><th>Row</th><th>Auto</th><th style="min-width:120px">Client ID</th>' +
                        '<th>Sale on dashboard</th><th>On import</th><th>Client</th>'
                );
            } else {
                $head.html(
                    '<th>#</th><th>Row</th><th>Auto</th><th style="min-width:120px">Client ID</th><th>Client</th>'
                );
            }
        }
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
        this.renderRefundLegend();
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
                    r.resolve_ok = undefined;
                    r.resolved_user_id = null;
                    r.resolved_label = '';
                    r.resolved_email = '';
                    row = r;
                }
            });
            row.already_imported = false;
            row.duplicate_adjustment_id = null;
            self.updateRowResolve($tr, val, row);
            self.scheduleSaveOrderMapping(line);
            self.scheduleRecheckDuplicate(line);
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
        var buckets = countReviewBuckets(rows);
        var ready = buckets.ready;
        var already = buckets.imported;
        var needs = buckets.needClient + buckets.noSale;
        if (!this.cfg.onImport) return alert('Import not configured.');
        var $btn = $(this.sel('import-reviewed-btn'));
        $btn.prop('disabled', true).text('Importing…');
        var payloadRows =
            root.ImportClientReview.rowsForImportPayload(rows);
        if (!payloadRows.length) {
            alert(
                'No rows to import. Use Show → Ready to import (matching sale required for refunds), or fix Client IDs first.'
            );
            $btn.prop('disabled', false).text('Import reviewed rows');
            return;
        }
        try {
            await this.cfg.onImport(payloadRows, {
                ready: ready,
                needs: needs,
                total: rows.length,
                submitted: payloadRows.length,
                already_imported: already,
            });
        } catch (e) {
            alert((e && e.error) || e.message || 'Import failed');
        } finally {
            $btn.prop('disabled', false).text('Import reviewed rows');
        }
    };

    /** Rows sent on import: skip duplicates and no-matching-sale (still queue unknown clients). */
    function rowsForImportPayload(rows) {
        return (rows || []).filter(function (r) {
            if (r.already_imported) return false;
            if (rowNoMatchingSale(r)) return false;
            return true;
        });
    }

    root.ImportClientReview = {
        create: function (cfg) {
            var inst = new ImportClientReview(cfg);
            inst.bind();
            return inst;
        },
        resolveClientLocally: resolveClientLocally,
        rowsForImportPayload: rowsForImportPayload,
        importOutcomeForRow: importOutcomeForRow,
        renderSaleMatchBadge: renderSaleMatchBadge,
        renderImportOutcomeBadge: renderImportOutcomeBadge,
    };
})(typeof window !== 'undefined' ? window : globalThis);
