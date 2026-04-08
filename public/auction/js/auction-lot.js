(function () {
    const D = window.AuctionData;
    const U = window.AuctionUtils;
    const Store = window.NgStore;
    const C = window.NgComponents;
    if (!D || !U || !Store || !C) return;

    const STEP = 0.5;

    function qs(name) {
        return new URLSearchParams(window.location.search).get(name);
    }

    function renderError(msg) {
        const main = document.getElementById('lot-root');
        if (main) main.innerHTML = '<p class="empty-state">' + msg + '</p>';
    }

    const id = qs('id');
    if (!id) {
        renderError('Missing lot ID. <a href="browse.html">Browse lots</a>');
        return;
    }

    const base = D.getLotById(id);
    if (!base) {
        renderError('Lot not found. <a href="browse.html">Browse lots</a>');
        return;
    }

    let lot = U.mergeLot(base);

    const imgEl = document.getElementById('lot-image');
    const titleEl = document.getElementById('lot-title');
    const idEl = document.getElementById('lot-id');
    const cdEl = document.getElementById('lot-countdown');
    const curEl = document.getElementById('lot-current');
    const startEl = document.getElementById('lot-start');
    const bidsEl = document.getElementById('lot-bids');
    const descEl = document.getElementById('lot-description');
    const form = document.getElementById('bid-form');
    const input = document.getElementById('bid-amount');
    const proxyInput = document.getElementById('max-proxy');
    const submitBtn = document.getElementById('bid-submit');
    const buyBtn = document.getElementById('btn-buy-now');
    const btnWatch = document.getElementById('btn-watch');
    const btnOne = document.getElementById('btn-oneclick');
    const btnCart = document.getElementById('btn-add-cart');
    const tradeGate = document.getElementById('ng-trade-gate');
    const vipGate = document.getElementById('ng-vip-gate');
    const liveBanner = document.getElementById('ng-live-banner');
    const softHint = document.getElementById('ng-soft-hint');
    const rowRrp = document.getElementById('row-rrp');
    const lotRrp = document.getElementById('lot-rrp');
    const rowReserve = document.getElementById('row-reserve');
    const lotReserve = document.getElementById('lot-reserve');
    const rowMystery = document.getElementById('row-mystery');
    const lotMystery = document.getElementById('lot-mystery');
    const lotBadges = document.getElementById('lot-badges');
    const lotTrust = document.getElementById('lot-trust');
    const lotFaults = document.getElementById('lot-faults');
    const lotInspector = document.getElementById('lot-inspector');
    const lotInspectorText = document.getElementById('lot-inspector-text');
    const ngReturn = document.getElementById('ng-return-rate');
    const vidWrap = document.getElementById('lot-video-wrap');
    const vidFrame = document.getElementById('lot-video');
    const crossSell = document.getElementById('ng-cross-sell');
    const confWrap = document.getElementById('ng-confidence');
    const confFill = document.getElementById('ng-confidence-fill');
    const zoomTrig = document.getElementById('lot-zoom-trigger');
    const lightbox = document.getElementById('ng-lightbox');
    const lightboxImg = document.getElementById('ng-lightbox-img');

    function minBid() {
        return Math.round((lot.currentBid + STEP) * 100) / 100;
    }

    function gated() {
        const s = Store.get();
        if (lot.tradeOnly && !s.tradeUnlocked) {
            if (tradeGate) tradeGate.hidden = false;
            return true;
        }
        if (tradeGate) tradeGate.hidden = true;
        if (lot.vipEarlyAccess && !s.vip) {
            if (vipGate) vipGate.hidden = false;
            return true;
        }
        if (vipGate) vipGate.hidden = true;
        return false;
    }

    function syncDom() {
        lot = U.mergeLot(base);
        if (imgEl) {
            imgEl.src = D.lotImageUrl(lot, 900, 675);
            imgEl.alt = lot.title;
            if (lightboxImg) lightboxImg.src = imgEl.src;
        }
        if (titleEl) titleEl.textContent = lot.title;
        document.title = lot.title + ' — Northgate Auction House';
        if (idEl) idEl.textContent = 'Lot ' + lot.id + ' · ' + lot.category;
        if (curEl) curEl.textContent = D.formatMoney(lot.currentBid);
        if (startEl) startEl.textContent = D.formatMoney(lot.startingPrice);
        if (bidsEl) bidsEl.textContent = String(lot.bidCount);
        if (descEl) descEl.textContent = lot.description;

        if (lotBadges) lotBadges.innerHTML = C.badgesRow(lot) || '';

        if (lotTrust) {
            const parts = [];
            if (lot.inventorySource) parts.push('<span class="ng-trust-pill">' + C.escapeHtml(lot.inventorySource) + '</span>');
            if (lot.testedWorking) parts.push('<span class="ng-trust-pill tested">Tested &amp; working</span>');
            if (lot.authenticityGuarantee) parts.push('<span class="ng-trust-pill">Authenticity coverage</span>');
            lotTrust.innerHTML = parts.join(' ') || '';
        }

        if (rowRrp && lotRrp) {
            if (lot.rrp != null) {
                rowRrp.hidden = false;
                lotRrp.textContent = D.formatMoney(lot.rrp);
            } else rowRrp.hidden = true;
        }

        if (rowReserve && lotReserve) {
            if (lot.reservePrice != null) {
                rowReserve.hidden = false;
                const met = D.reserveMet(lot);
                lotReserve.textContent = D.formatMoney(lot.reservePrice) + (met ? ' (met)' : ' (not met)');
            } else rowReserve.hidden = true;
        }

        if (rowMystery && lotMystery) {
            if (lot.mysteryFloor != null) {
                rowMystery.hidden = false;
                lotMystery.textContent = D.formatMoney(lot.mysteryFloor) + '+ · ' + (lot.mysteryTeaser || '');
            } else rowMystery.hidden = true;
        }

        if (confWrap && confFill && lot.confidenceScore != null) {
            confWrap.hidden = false;
            confFill.style.width = Math.min(100, Math.max(0, lot.confidenceScore)) + '%';
        } else if (confWrap) confWrap.hidden = true;

        if (lotFaults) {
            if (lot.faultTags && lot.faultTags.length) {
                lotFaults.hidden = false;
                lotFaults.innerHTML =
                    '<h3>Fault disclosure</h3><ul>' +
                    lot.faultTags.map((t) => '<li>' + C.escapeHtml(t) + '</li>').join('') +
                    '</ul>';
            } else lotFaults.hidden = true;
        }

        if (lotInspector && lotInspectorText) {
            if (lot.inspectorNotes) {
                lotInspector.hidden = false;
                lotInspectorText.textContent = lot.inspectorNotes;
            } else lotInspector.hidden = true;
        }

        if (ngReturn) {
            ngReturn.innerHTML =
                '<p class="ng-muted">Typical category return rate (transparency): <strong>' +
                (lot.returnRatePct != null ? lot.returnRatePct + '%' : 'n/a') +
                '</strong> — demo benchmark.</p>';
        }

        if (vidWrap && vidFrame && lot.videoUrl) {
            vidWrap.hidden = false;
            vidFrame.src = lot.videoUrl;
        } else if (vidWrap) vidWrap.hidden = true;

        if (liveBanner) liveBanner.hidden = lot.auctionMode !== 'live';

        if (crossSell) {
            const rel = D.getRelatedLots(lot.id, 3);
            if (rel.length) {
                crossSell.innerHTML =
                    '<h3 class="ng-h3">Cross-sell &amp; similar lots</h3><div class="auction-grid ng-cross-grid">' +
                    rel.map((r) => C.cardHtml(r, {})).join('') +
                    '</div>';
                C.bindWatchButtons(crossSell);
            } else crossSell.innerHTML = '';
        }

        const b = Store.getBid(lot.id);
        if (proxyInput && b && typeof b.maxProxy === 'number') {
            proxyInput.value = String(b.maxProxy);
        }

        if (buyBtn) {
            const hasBn = lot.buyNowPrice != null;
            let flash = true;
            if (lot.buyNowFlashEndsAt) {
                flash = new Date(lot.buyNowFlashEndsAt).getTime() > Date.now();
            }
            buyBtn.hidden = !(hasBn && flash);
            buyBtn.textContent = 'Buy now ' + D.formatMoney(lot.buyNowPrice);
        }

        const ends = new Date(lot.endsAt).getTime();
        const left = ends - Date.now();
        const softMin = lot.softCloseMinutes || 2;

        if (input) {
            const min = minBid();
            input.min = String(min);
            input.step = '0.5';
            if (!input.dataset.touched) input.value = min.toFixed(2);
        }

        const block = gated();
        if (submitBtn) submitBtn.disabled = block;
        if (input) input.disabled = block;
        if (proxyInput) proxyInput.disabled = block;
        if (buyBtn) buyBtn.disabled = block;

        if (left <= 0) {
            if (cdEl) {
                cdEl.textContent = 'This auction has ended';
                cdEl.classList.add('ended');
            }
            if (submitBtn) submitBtn.disabled = true;
            if (input) input.disabled = true;
            if (buyBtn) buyBtn.disabled = true;
            if (softHint) softHint.hidden = true;
        } else {
            if (cdEl) {
                cdEl.classList.remove('ended');
                cdEl.textContent = 'Time left: ' + U.formatTimeLeft(left);
            }
            if (softHint) softHint.hidden = left > softMin * 60 * 1000;
        }

        if (btnWatch) {
            btnWatch.classList.toggle('is-on', Store.isWatched(lot.id));
        }
    }

    let timer = null;
    function tick() {
        syncDom();
        const ends = new Date(lot.endsAt).getTime();
        if (ends - Date.now() <= 0) {
            if (timer) clearInterval(timer);
            syncDom();
        }
    }

    syncDom();
    timer = setInterval(tick, 1000);

    function placeBid(amount, fromProxy) {
        const ends = new Date(lot.endsAt).getTime();
        if (ends - Date.now() <= 0) return;
        if (gated()) return;
        if (Number.isNaN(amount) || amount < minBid()) {
            window.NgBoot && window.NgBoot.toast('Bid at least ' + D.formatMoney(minBid()), 'warn');
            return;
        }
        const proxyVal = proxyInput && proxyInput.value ? parseFloat(proxyInput.value) : null;
        U.setBidOverride(lot.id, amount, lot.bidCount + 1, {
            maxProxy: !Number.isNaN(proxyVal) && proxyVal >= amount ? proxyVal : undefined,
        });
        U.maybeSoftClose(U.mergeLot(base), lot.softCloseMinutes);
        if (input) input.dataset.touched = '1';
        Store.addNotification('Bid placed on ' + lot.title.slice(0, 40), 'bid');
        syncDom();
        window.NgBoot && window.NgBoot.toast('Bid recorded — demo', 'ok');
    }

    form?.addEventListener('submit', function (e) {
        e.preventDefault();
        const raw = parseFloat(String(input.value).replace(',', '.'));
        placeBid(raw);
    });

    buyBtn?.addEventListener('click', function () {
        if (gated() || !lot.buyNowPrice) return;
        const price = lot.buyNowPrice;
        const w = Store.get().wallet;
        if (w < price) {
            window.NgBoot && window.NgBoot.toast('Add credits in Hub — wallet too low for Buy Now (demo)', 'warn');
            return;
        }
        Store.adjustWallet(-price);
        U.setBidOverride(lot.id, price, lot.bidCount + 1);
        Store.addNotification('Buy Now purchase (demo) — ' + D.formatMoney(price), 'ok');
        window.NgBoot && window.NgBoot.toast('Buy Now — demo wallet charged', 'ok');
        syncDom();
    });

    btnWatch?.addEventListener('click', function () {
        Store.toggleWatchlist(lot.id);
        syncDom();
    });

    btnOne?.addEventListener('click', function () {
        if (input) {
            input.value = minBid().toFixed(2);
            input.dataset.touched = '1';
        }
        placeBid(minBid());
    });

    btnCart?.addEventListener('click', function () {
        Store.addToCart(lot.id, parseFloat(proxyInput && proxyInput.value) || minBid());
        window.NgBoot && window.NgBoot.toast('Added to multi-lot list in Hub', 'ok');
    });

    zoomTrig?.addEventListener('click', function () {
        if (lightbox) lightbox.hidden = false;
    });
    lightbox?.addEventListener('click', function () {
        lightbox.hidden = true;
    });
})();
