(function () {
    const D = window.AuctionData;
    const U = window.AuctionUtils;
    const C = window.NgComponents;
    if (!D || !U || !C) return;

    function renderSection(elId, lots) {
        const el = document.getElementById(elId);
        if (!el) return;
        if (!lots.length) {
            el.innerHTML = '<p class="empty-state">Nothing here yet.</p>';
            return;
        }
        el.innerHTML = '<div class="auction-grid">' + lots.map((l) => C.cardHtml(l, {})).join('') + '</div>';
        C.bindWatchButtons(el);
    }

    function renderSteal() {
        const el = document.getElementById('section-steal');
        if (!el) return;
        const lot = U.mergeLot(D.getStealOfWeek());
        el.innerHTML =
            '<div class="ng-steal-banner"><div class="ng-steal-copy">' +
            '<h3>Steal of the Week</h3><p>Hand-picked value spotlight — compare to RRP and bid.</p></div>' +
            '<div class="ng-steal-card">' +
            C.cardHtml(lot, {}) +
            '</div></div>';
        C.bindWatchButtons(el);
    }

    function renderFeatured() {
        const lots = D.getFeaturedLots().map((l) => U.mergeLot(l));
        renderSection('section-featured', lots);
    }

    function renderPicks() {
        const lots = D.getHousePicks().map((l) => U.mergeLot(l));
        renderSection('section-picks', lots);
    }

    function renderSold() {
        const el = document.getElementById('section-sold');
        if (!el) return;
        const rows = D.soldLots
            .map(function (s) {
                return (
                    '<li><span class="ng-sold-title">' +
                    C.escapeHtml(s.title) +
                    '</span> <span class="ng-sold-price">' +
                    D.formatMoney(s.soldPrice) +
                    '</span> <span class="ng-sold-meta">' +
                    C.escapeHtml(s.bidders + ' bidders · ' + s.endedAgo) +
                    '</span></li>'
                );
            })
            .join('');
        el.innerHTML = '<ul class="ng-sold-list">' + rows + '</ul>';
    }

    function renderBundle() {
        const el = document.getElementById('section-bundle');
        if (!el || !D.bundles.length) return;
        const b = D.bundles[0];
        el.innerHTML =
            '<div class="ng-bundle-banner">' +
            '<strong>Bundle discount</strong> — Buy ' +
            b.lotIds.length +
            ' linked LEGO lots and save ' +
            b.discountPct +
            '% at checkout (demo). ' +
            '<a href="browse.html?q=LEGO">View bundle lots</a>' +
            '</div>';
    }

    function renderDropsTeaser() {
        const el = document.getElementById('section-drops-teaser');
        if (!el) return;
        const drops = D.dropSchedule
            .map(function (d) {
                const when = new Date(d.opensAt);
                return (
                    '<div class="ng-drop-chip">' +
                    '<strong>' +
                    C.escapeHtml(d.name) +
                    '</strong> · ' +
                    when.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) +
                    ' — ' +
                    C.escapeHtml(d.blurb) +
                    '</div>'
                );
            })
            .join('');
        el.innerHTML =
            '<div class="ng-drop-teaser">' +
            drops +
            ' <a class="ng-drop-more" href="drops.html">Full drop calendar →</a></div>';
    }

    function renderRecs() {
        const el = document.getElementById('section-recs');
        if (!el) return;
        const all = D.getLots().map((l) => U.mergeLot(l));
        const pick = all.filter((l) => l.category === 'Electronics').slice(0, 4);
        renderSection('section-recs', pick.length ? pick : all.slice(0, 4));
    }

    function refresh() {
        const all = D.getLots().map((l) => U.mergeLot(l));
        renderSection('section-ending', D.sortLots(all, 'endingsoon').slice(0, 8));
        renderSection('section-popular', D.sortLots(all, 'mostpopular').slice(0, 8));
        renderSection('section-new', D.sortLots(all, 'newlylisted').slice(0, 8));
    }

    renderSteal();
    renderFeatured();
    renderPicks();
    renderSold();
    renderBundle();
    renderDropsTeaser();
    renderRecs();
    refresh();
    setInterval(refresh, 30000);
})();
