/**
 * Client-side “account” state for Northgate demo (localStorage).
 * Powers wallet, watchlist, VIP, trade gate, streak, notifications, etc.
 */
(function (global) {
    const KEY = 'ng-auction-store-v2';
    const LEGACY_BIDS = 'auction-demo-bids';

    const defaultStore = () => ({
        version: 2,
        bids: {},
        watchlist: [],
        wallet: 100,
        notifications: [],
        savedSearches: [],
        priceAlerts: {},
        vip: false,
        tradeUnlocked: false,
        stats: { wins: 0, losses: 0, streak: 0 },
        cart: [],
        darkMode: false,
        exitOfferShown: false,
        oneClickBid: false,
    });

    function load() {
        try {
            const raw = localStorage.getItem(KEY);
            if (raw) {
                const o = JSON.parse(raw);
                if (o && typeof o === 'object') return { ...defaultStore(), ...o, bids: o.bids || {} };
            }
        } catch (_) {}
        const s = defaultStore();
        migrateLegacy(s);
        return s;
    }

    function migrateLegacy(s) {
        try {
            const leg = localStorage.getItem(LEGACY_BIDS);
            if (!leg) return;
            const o = JSON.parse(leg);
            if (o && typeof o === 'object') {
                Object.keys(o).forEach((id) => {
                    const b = o[id];
                    if (b && typeof b.currentBid === 'number') {
                        s.bids[id] = {
                            currentBid: b.currentBid,
                            bidCount: b.bidCount || 0,
                            at: b.at,
                        };
                    }
                });
            }
        } catch (_) {}
    }

    function save(s) {
        localStorage.setItem(KEY, JSON.stringify(s));
    }

    function get() {
        return load();
    }

    function patch(partial) {
        const s = { ...load(), ...partial };
        save(s);
        return s;
    }

    function setBid(lotId, data) {
        const s = load();
        s.bids[lotId] = { ...s.bids[lotId], ...data };
        save(s);
        return s.bids[lotId];
    }

    function getBid(lotId) {
        return load().bids[lotId] || null;
    }

    function toggleWatchlist(lotId) {
        const s = load();
        const i = s.watchlist.indexOf(lotId);
        if (i >= 0) s.watchlist.splice(i, 1);
        else s.watchlist.push(lotId);
        save(s);
        return s.watchlist.includes(lotId);
    }

    function isWatched(lotId) {
        return load().watchlist.includes(lotId);
    }

    function addNotification(text, type) {
        const s = load();
        s.notifications.unshift({
            id: 'n' + Date.now(),
            text,
            type: type || 'info',
            at: Date.now(),
            read: false,
        });
        s.notifications = s.notifications.slice(0, 50);
        save(s);
    }

    function markAllRead() {
        const s = load();
        s.notifications.forEach((n) => {
            n.read = true;
        });
        save(s);
    }

    function addSavedSearch(q, filters) {
        const s = load();
        s.savedSearches.unshift({ q: q || '', filters: filters || {}, at: Date.now() });
        s.savedSearches = s.savedSearches.slice(0, 20);
        save(s);
    }

    function setPriceAlert(lotId, targetPrice) {
        const s = load();
        if (targetPrice == null || targetPrice <= 0) delete s.priceAlerts[lotId];
        else s.priceAlerts[lotId] = targetPrice;
        save(s);
    }

    function setVip(on) {
        patch({ vip: !!on });
    }

    function setTradeUnlocked(on) {
        patch({ tradeUnlocked: !!on });
    }

    function adjustWallet(delta) {
        const s = load();
        s.wallet = Math.round((s.wallet + delta) * 100) / 100;
        save(s);
        return s.wallet;
    }

    function recordWin() {
        const s = load();
        s.stats.wins += 1;
        s.stats.streak += 1;
        save(s);
    }

    function recordLoss() {
        const s = load();
        s.stats.losses += 1;
        s.stats.streak = 0;
        save(s);
    }

    function addToCart(lotId, maxBid) {
        const s = load();
        const ex = s.cart.find((c) => c.lotId === lotId);
        if (ex) ex.maxBid = maxBid;
        else s.cart.push({ lotId, maxBid });
        save(s);
    }

    global.NgStore = {
        get,
        patch,
        setBid,
        getBid,
        toggleWatchlist,
        isWatched,
        addNotification,
        markAllRead,
        addSavedSearch,
        setPriceAlert,
        setVip,
        setTradeUnlocked,
        adjustWallet,
        recordWin,
        recordLoss,
        addToCart,
    };
})(typeof window !== 'undefined' ? window : globalThis);
