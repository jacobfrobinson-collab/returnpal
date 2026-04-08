(function () {
    const S = window.NgStore;
    const D = window.AuctionData;
    if (!S || !D) return;

    function render() {
        const st = S.get();
        const w = document.getElementById('hub-wallet');
        if (w) w.textContent = D.formatMoney(st.wallet);
        const stEl = document.getElementById('hub-stats');
        if (stEl) {
            stEl.innerHTML =
                '<li>Wins: <strong>' +
                st.stats.wins +
                '</strong></li><li>Losses: <strong>' +
                st.stats.losses +
                '</strong></li><li>Win streak: <strong>' +
                st.stats.streak +
                '</strong> 🔥</li>';
        }
        const vip = document.getElementById('hub-vip-toggle');
        if (vip) vip.checked = !!st.vip;
        const trade = document.getElementById('hub-trade-status');
        if (trade) trade.textContent = st.tradeUnlocked ? 'Unlocked' : 'Locked';
        const list = document.getElementById('hub-notifications');
        if (list) {
            list.innerHTML = st.notifications
                .slice(0, 12)
                .map(function (n) {
                    return '<li>' + (n.read ? '' : '● ') + escapeHtml(n.text) + '</li>';
                })
                .join('');
        }
        const ss = document.getElementById('hub-saved');
        if (ss) {
            ss.innerHTML = st.savedSearches
                .slice(0, 8)
                .map(function (x) {
                    return '<li>' + escapeHtml(x.q || '(filters)') + '</li>';
                })
                .join('');
        }
        const cart = document.getElementById('hub-cart');
        if (cart) {
            cart.innerHTML =
                st.cart.length === 0
                    ? '<li>Empty — add from any lot page.</li>'
                    : st.cart
                          .map(function (c) {
                              return (
                                  '<li>Lot ' +
                                  escapeHtml(c.lotId) +
                                  ' — max bid ' +
                                  D.formatMoney(c.maxBid) +
                                  '</li>'
                              );
                          })
                          .join('');
        }
    }

    function escapeHtml(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    document.getElementById('hub-vip-toggle')?.addEventListener('change', function () {
        S.setVip(this.checked);
        render();
    });

    document.getElementById('hub-trade-unlock')?.addEventListener('submit', function (e) {
        e.preventDefault();
        const pw = (document.getElementById('hub-trade-pw') || {}).value || '';
        if (pw.toLowerCase() === 'trade' || pw === 'demo') {
            S.setTradeUnlocked(true);
            S.addNotification('Trade floor unlocked (demo password)', 'ok');
        } else {
            S.addNotification('Invalid demo password — try: demo', 'warn');
        }
        render();
    });

    document.getElementById('hub-save-search')?.addEventListener('click', function () {
        const q = (document.getElementById('hub-search-q') || {}).value || '';
        S.addSavedSearch(q, {});
        S.addNotification('Saved search stored in this browser', 'info');
        render();
    });

    document.getElementById('hub-mark-read')?.addEventListener('click', function () {
        S.markAllRead();
        render();
    });

    document.getElementById('hub-add-credit')?.addEventListener('click', function () {
        S.adjustWallet(25);
        S.addNotification('+£25 demo credit', 'ok');
        render();
    });

    render();
})();
