/**
 * Shared card HTML + badges for Northgate auction UI.
 */
(function (global) {
    const D = () => global.AuctionData;
    const U = () => global.AuctionUtils;
    const Store = () => global.NgStore;

    function escapeHtml(s) {
        const d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function badgesRow(lot) {
        const tags = [];
        if (lot.auctionMode === 'live') tags.push('<span class="ng-badge ng-badge-live">Live auction</span>');
        if (lot.stealOfWeek) tags.push('<span class="ng-badge ng-badge-steal">Steal of the Week</span>');
        if (lot.featured) tags.push('<span class="ng-badge ng-badge-featured">Featured</span>');
        if (lot.housePick) tags.push('<span class="ng-badge ng-badge-pick">House Pick</span>');
        if (lot.refined) tags.push('<span class="ng-badge ng-badge-refined">Refined</span>');
        if (lot.mysteryFloor != null) tags.push('<span class="ng-badge ng-badge-mystery">Mystery lot</span>');
        if (lot.tradeOnly) tags.push('<span class="ng-badge ng-badge-trade">Trade only</span>');
        if (lot.testedWorking) tags.push('<span class="ng-badge ng-badge-tested">Tested &amp; working</span>');
        if (lot.authenticityGuarantee) tags.push('<span class="ng-badge ng-badge-auth">Authenticity</span>');
        if (lot.buyNowPrice && lot.buyNowFlashEndsAt) {
            const t = new Date(lot.buyNowFlashEndsAt).getTime();
            if (t > Date.now()) tags.push('<span class="ng-badge ng-badge-flash">Buy Now flash</span>');
        }
        if (lot.conditionGrade) {
            tags.push(
                '<span class="ng-badge ng-grade-' +
                    escapeHtml(lot.conditionGrade.toLowerCase()) +
                    '">Grade ' +
                    escapeHtml(lot.conditionGrade) +
                    '</span>'
            );
        }
        if (lot.inventorySource) {
            tags.push('<span class="ng-badge ng-badge-source">' + escapeHtml(lot.inventorySource) + '</span>');
        }
        if (!tags.length) return '';
        return '<div class="ng-card-badges">' + tags.join('') + '</div>';
    }

    function watchBtn(lotId) {
        const on = Store() && Store().isWatched(lotId);
        return (
            '<button type="button" class="ng-watch' +
            (on ? ' is-on' : '') +
            '" data-watch="' +
            escapeHtml(lotId) +
            '" title="Watchlist" aria-pressed="' +
            (on ? 'true' : 'false') +
            '">♥</button>'
        );
    }

    function cardHtml(lot, opts) {
        opts = opts || {};
        const merged = U().mergeLot(lot);
        const Dd = D();
        const ends = new Date(merged.endsAt).getTime();
        const left = ends - Date.now();
        const img = Dd.lotImageUrl(merged, 400, 300);
        const timeStr = left <= 0 ? 'Ended' : U().formatTimeLeft(left);
        const reserveOk = Dd.reserveMet(merged);
        const reserveLine =
            merged.reservePrice != null
                ? reserveOk
                    ? '<span class="ng-reserve ok">Reserve met</span>'
                    : '<span class="ng-reserve no">Reserve not met</span>'
                : '';
        const rrpLine =
            merged.rrp != null
                ? '<span class="ng-rrp">RRP ' + Dd.formatMoney(merged.rrp) + '</span>'
                : '';
        const conf =
            merged.confidenceScore != null
                ? '<span class="ng-confidence" title="Condition confidence score">Score ' +
                  escapeHtml(String(merged.confidenceScore)) +
                  '</span>'
                : '';

        return (
            '<article class="auction-card">' +
            (opts.showWatch !== false ? '<div class="ng-card-actions">' + watchBtn(merged.id) + '</div>' : '') +
            '<a class="card-link" href="lot.html?id=' +
            encodeURIComponent(merged.id) +
            '">' +
            '<div class="auction-card-img">' +
            badgesRow(merged) +
            '<img src="' +
            img +
            '" alt="" loading="lazy" width="400" height="300" /></div>' +
            '<div class="auction-card-body">' +
            '<h3 class="auction-card-title">' +
            escapeHtml(merged.title) +
            '</h3>' +
            '<div class="auction-card-meta">' +
            '<span>Current <strong>' +
            Dd.formatMoney(merged.currentBid) +
            '</strong></span>' +
            '<span class="time-left">' +
            escapeHtml(timeStr) +
            '</span>' +
            '</div>' +
            '<div class="ng-card-extra">' +
            reserveLine +
            rrpLine +
            conf +
            '</div>' +
            '</div></a></article>'
        );
    }

    function bindWatchButtons(root) {
        const el = root || document;
        el.querySelectorAll('[data-watch]').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                const id = btn.getAttribute('data-watch');
                if (!Store()) return;
                const on = Store().toggleWatchlist(id);
                btn.classList.toggle('is-on', on);
                btn.setAttribute('aria-pressed', on ? 'true' : 'false');
                Store().addNotification(on ? 'Added to watchlist' : 'Removed from watchlist', 'watch');
            });
        });
    }

    global.NgComponents = {
        escapeHtml,
        badgesRow,
        cardHtml,
        bindWatchButtons,
    };
})(typeof window !== 'undefined' ? window : globalThis);
