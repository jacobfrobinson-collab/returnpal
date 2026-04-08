(function () {
    const D = window.AuctionData;
    const U = window.AuctionUtils;
    const C = window.NgComponents;
    if (!D || !U || !C) return;

    function params() {
        const q = new URLSearchParams(window.location.search);
        return {
            order: q.get('order') || 'endingsoon',
            category: q.get('category') || 'all',
            q: (q.get('q') || '').trim(),
            grade: q.get('grade') || 'all',
            auctionMode: q.get('mode') || 'all',
            tradeOnly: q.get('trade') || '',
            mysteryOnly: q.get('mystery') || '',
            refinedOnly: q.get('refined') || '',
        };
    }

    function render() {
        const p = params();
        let lots = D.getLots().map((l) => U.mergeLot(l));
        const store = window.NgStore;
        if (store && store.get().vip === false) {
            lots = lots.filter(function (l) {
                if (!l.vipEarlyAccess) return true;
                return false;
            });
        }
        lots = D.filterLots(lots, {
            category: p.category === 'all' ? '' : p.category,
            q: p.q,
            grade: p.grade || 'all',
            auctionMode: p.auctionMode || 'all',
            tradeOnly: p.tradeOnly === '1' ? true : '',
            mysteryOnly: p.mysteryOnly === '1' ? true : '',
            refinedOnly: p.refinedOnly === '1' ? true : '',
        });
        lots = D.sortLots(lots, p.order);

        document.querySelectorAll('[data-cat-link]').forEach(function (a) {
            const cat = a.getAttribute('data-cat-link');
            const active = (p.category === 'all' && cat === 'all') || p.category === cat;
            a.classList.toggle('active', active);
            const np = new URLSearchParams();
            np.set('order', p.order);
            if (cat !== 'all') np.set('category', cat);
            if (p.q) np.set('q', p.q);
            if (p.grade && p.grade !== 'all') np.set('grade', p.grade);
            if (p.auctionMode && p.auctionMode !== 'all') np.set('mode', p.auctionMode);
            if (p.tradeOnly) np.set('trade', p.tradeOnly);
            if (p.mysteryOnly) np.set('mystery', p.mysteryOnly);
            if (p.refinedOnly) np.set('refined', p.refinedOnly);
            a.href = 'browse.html?' + np.toString();
        });

        document.querySelectorAll('[data-quick-filter]').forEach(function (a) {
            const f = a.getAttribute('data-quick-filter');
            const np = new URLSearchParams(window.location.search);
            np.delete('trade');
            np.delete('mystery');
            np.delete('refined');
            np.delete('mode');
            if (f === 'timed') np.set('mode', 'timed');
            if (f === 'live') np.set('mode', 'live');
            if (f === 'mystery') np.set('mystery', '1');
            if (f === 'trade') np.set('trade', '1');
            if (f === 'refined') np.set('refined', '1');
            if (f === 'all') {
                np.delete('mode');
                np.delete('mystery');
                np.delete('trade');
                np.delete('refined');
            }
            a.href = 'browse.html?' + np.toString();
            const active =
                (f === 'all' &&
                    p.auctionMode === 'all' &&
                    !p.tradeOnly &&
                    !p.mysteryOnly &&
                    !p.refinedOnly) ||
                (f === 'timed' && p.auctionMode === 'timed') ||
                (f === 'live' && p.auctionMode === 'live') ||
                (f === 'mystery' && p.mysteryOnly === '1') ||
                (f === 'trade' && p.tradeOnly === '1') ||
                (f === 'refined' && p.refinedOnly === '1');
            a.classList.toggle('active', !!active);
        });

        const sortEl = document.getElementById('sort-select');
        if (sortEl) sortEl.value = p.order;

        const gradeEl = document.getElementById('grade-select');
        if (gradeEl) gradeEl.value = p.grade;

        const countEl = document.getElementById('result-count');
        if (countEl) countEl.textContent = lots.length + ' lot' + (lots.length !== 1 ? 's' : '');

        const grid = document.getElementById('browse-grid');
        if (!grid) return;
        if (!lots.length) {
            grid.innerHTML = '<p class="empty-state">No lots match your filters. VIP-only lots are hidden until you enable VIP in Hub.</p>';
            return;
        }
        grid.innerHTML = '<div class="auction-grid">' + lots.map((l) => C.cardHtml(l, {})).join('') + '</div>';
        C.bindWatchButtons(grid);
    }

    document.getElementById('sort-select')?.addEventListener('change', function () {
        const p = new URLSearchParams(window.location.search);
        p.set('order', this.value);
        window.location.search = p.toString();
    });

    document.getElementById('grade-select')?.addEventListener('change', function () {
        const p = new URLSearchParams(window.location.search);
        if (this.value === 'all') p.delete('grade');
        else p.set('grade', this.value);
        window.location.search = p.toString();
    });

    document.getElementById('browse-search-form')?.addEventListener('submit', function () {
        const sel = document.getElementById('sort-select');
        const hid = document.getElementById('browse-order-hidden');
        if (sel && hid) hid.value = sel.value;
    });

    render();
    setInterval(render, 30000);
})();
