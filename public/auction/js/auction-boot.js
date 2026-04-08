/**
 * Global UI: dark mode, wallet pill, urgency ticker, exit-intent offer, toasts.
 */
(function () {
    const S = () => window.NgStore;

    function toast(msg, kind) {
        let host = document.getElementById('ng-toast-host');
        if (!host) {
            host = document.createElement('div');
            host.id = 'ng-toast-host';
            host.className = 'ng-toast-host';
            document.body.appendChild(host);
        }
        const t = document.createElement('div');
        t.className = 'ng-toast ng-toast-' + (kind || 'info');
        t.textContent = msg;
        host.appendChild(t);
        setTimeout(function () {
            t.classList.add('ng-toast-out');
            setTimeout(function () {
                t.remove();
            }, 300);
        }, 4200);
    }

    function applyTheme(dark) {
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
        if (S()) S().patch({ darkMode: dark });
    }

    function initWalletPill() {
        const el = document.getElementById('ng-wallet-pill');
        if (!el || !S() || !window.AuctionData) return;
        el.textContent = 'Wallet ' + window.AuctionData.formatMoney(S().get().wallet);
    }

    function initDarkToggle() {
        const btn = document.getElementById('ng-dark-toggle');
        if (!S()) return;
        if (S().get().darkMode) applyTheme(true);
        if (!btn) return;
        btn.addEventListener('click', function () {
            const dark = document.documentElement.getAttribute('data-theme') !== 'dark';
            applyTheme(dark);
        });
    }

    function initTicker() {
        const el = document.getElementById('ng-urgency-ticker');
        if (!el || !window.AuctionData) return;
        const lots = window.AuctionData.getLots().map((l) => window.AuctionUtils.mergeLot(l));
        const soon = window.AuctionData.sortLots(lots, 'endingsoon')[0];
        const msgs = [
            'Ending soon — don’t miss the hammer!',
            soon ? soon.title.slice(0, 48) + '… ends ' + window.AuctionUtils.formatTimeLeft(new Date(soon.endsAt) - Date.now()) : 'New lots daily',
            'Free shipping over £75 — demo threshold',
            'VIP Buyer Club — early access on select drops',
        ];
        let i = 0;
        el.textContent = msgs[0];
        setInterval(function () {
            i = (i + 1) % msgs.length;
            el.textContent = msgs[i];
        }, 6500);
    }

    function initExitIntent() {
        if (!S()) return;
        if (S().get().exitOfferShown) return;
        const modal = document.getElementById('ng-exit-modal');
        if (!modal) return;
        let shown = false;
        document.addEventListener('mouseout', function (e) {
            if (shown) return;
            if (!e.relatedTarget && e.clientY < 12) {
                shown = true;
                modal.hidden = false;
                S().patch({ exitOfferShown: true });
            }
        });
        modal.querySelector('[data-close-exit]')?.addEventListener('click', function () {
            modal.hidden = true;
        });
        modal.querySelector('[data-exit-cta]')?.addEventListener('click', function () {
            toast('Offer saved to this browser — check Wallet for +£5 demo credit', 'ok');
            if (S()) {
                S().adjustWallet(5);
                S().patch({ exitOfferShown: true });
            }
            modal.hidden = true;
        });
    }

    document.addEventListener('DOMContentLoaded', function () {
        initWalletPill();
        initDarkToggle();
        initTicker();
        initExitIntent();
    });

    window.NgBoot = { toast, applyTheme };
})();
