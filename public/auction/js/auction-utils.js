(function (global) {
    function formatTimeLeft(ms) {
        if (ms <= 0) return 'Ended';
        const s = Math.floor(ms / 1000);
        const d = Math.floor(s / 86400);
        const h = Math.floor((s % 86400) / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        if (d > 0) return `${d}d ${h}h ${m}m`;
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${sec}s`;
        return `${sec}s`;
    }

    /** Merge catalog lot with NgStore bid overrides (incl. soft-close extended end time). */
    function mergeLot(lot) {
        if (!lot) return null;
        const Store = global.NgStore;
        const out = { ...lot };
        if (Store) {
            const b = Store.getBid(lot.id);
            if (b) {
                if (typeof b.currentBid === 'number') out.currentBid = b.currentBid;
                if (typeof b.bidCount === 'number') out.bidCount = b.bidCount;
                if (b.endsAt) out.endsAt = b.endsAt;
                if (typeof b.maxProxy === 'number') out._maxProxy = b.maxProxy;
            }
        } else {
            try {
                const raw = localStorage.getItem('auction-demo-bids');
                if (raw) {
                    const o = JSON.parse(raw);
                    const x = o && o[lot.id];
                    if (x) {
                        out.currentBid = x.currentBid;
                        out.bidCount = x.bidCount;
                    }
                }
            } catch (_) {}
        }
        return out;
    }

    function setBidOverride(lotId, currentBid, bidCount, extra) {
        const Store = global.NgStore;
        if (Store) {
            Store.setBid(lotId, { currentBid, bidCount, at: Date.now(), ...extra });
        }
        try {
            const raw = localStorage.getItem('auction-demo-bids');
            const all = raw ? JSON.parse(raw) : {};
            all[lotId] = { currentBid, bidCount, at: Date.now() };
            localStorage.setItem('auction-demo-bids', JSON.stringify(all));
        } catch (_) {}
    }

    function getBidOverrides() {
        const Store = global.NgStore;
        if (Store) return Store.get().bids || {};
        try {
            const raw = localStorage.getItem('auction-demo-bids');
            return raw ? JSON.parse(raw) : {};
        } catch {
            return {};
        }
    }

    /** If bid placed in last {softMin} minutes, extend auction end (anti-sniping demo). */
    function maybeSoftClose(lot, softMinutes) {
        const Store = global.NgStore;
        if (!Store || !lot) return;
        const ends = new Date(lot.endsAt).getTime();
        const left = ends - Date.now();
        const windowMs = (softMinutes || 2) * 60 * 1000;
        if (left > 0 && left <= windowMs) {
            const newEnd = new Date(ends + 2 * 60 * 1000).toISOString();
            Store.setBid(lot.id, { endsAt: newEnd });
            Store.addNotification('Soft close: +2 min added — anti-sniping', 'auction');
            return newEnd;
        }
        return null;
    }

    global.AuctionUtils = {
        formatTimeLeft,
        getBidOverrides,
        setBidOverride,
        mergeLot,
        maybeSoftClose,
    };
})(typeof window !== 'undefined' ? window : globalThis);
