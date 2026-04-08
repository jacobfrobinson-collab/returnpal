/**
 * Northgate catalog — enriched for 50-feature demo (client-side).
 */
(function (global) {
    const CATEGORIES = [
        'Toys & Games',
        'Home & Garden',
        'Health & Beauty',
        'Clothing & Accessories',
        'Electronics',
        'Office Supplies',
        'Arts & Entertainment',
        'Collectibles',
    ];

    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;

    /** Defaults merged into every lot (features 1–20, 41–46). */
    const DEFAULT_LOT = {
        auctionMode: 'timed',
        softCloseMinutes: 2,
        reservePrice: null,
        buyNowPrice: null,
        buyNowFlashEndsAt: null,
        mysteryFloor: null,
        mysteryTeaser: null,
        conditionGrade: 'B',
        inspectorNotes: '',
        testedWorking: false,
        faultTags: [],
        videoUrl: null,
        returnRatePct: 11,
        inventorySource: 'Mixed wholesale',
        authenticityGuarantee: false,
        rrp: null,
        confidenceScore: 70,
        refined: false,
        featured: false,
        stealOfWeek: false,
        housePick: false,
        tradeOnly: false,
        vipEarlyAccess: false,
        dropId: null,
        bundleId: null,
        crossSellIds: [],
        priceDropFrom: null,
    };

    const rawLots = [
        {
            id: 'A9QTPQPC',
            slug: '3-pole-rf-cavitation-probe',
            title: '3-Pole RF Cavitation Probe Handpiece – 4-Pin Connector',
            category: 'Health & Beauty',
            startingPrice: 2,
            currentBid: 2,
            bidCount: 3,
            listedAt: new Date(now - 2 * day).toISOString(),
            endsAt: new Date(now + 18 * hour + 11 * 60 * 1000).toISOString(),
            imageSeed: 'cavitation',
            description:
                'Replacement slimming machine spare. Untested; sold as seen. Please check compatibility with your device before bidding.',
            conditionGrade: 'C',
            faultTags: ['Untested', 'Cosmetic wear possible'],
            inspectorNotes: 'Visual inspection only — plug not tested on device.',
            inventorySource: 'Amazon Returns',
            returnRatePct: 14,
            confidenceScore: 62,
            rrp: 45,
            reservePrice: 5,
        },
        {
            id: 'CVXAPK3Q',
            slug: 'lot-6-remote-controls',
            title: 'Lot 6 Remote Controls — Philips, Ferguson, Toshiba RMD+',
            category: 'Electronics',
            startingPrice: 3,
            currentBid: 5.5,
            bidCount: 12,
            listedAt: new Date(now - 1 * day).toISOString(),
            endsAt: new Date(now + 1 * day + 16 * hour).toISOString(),
            imageSeed: 'remotes',
            description: 'Mixed lot of vintage and modern remotes. Some may need batteries; cosmetic wear possible.',
            testedWorking: false,
            conditionGrade: 'B',
            inventorySource: 'Customer returns pallet',
            returnRatePct: 9,
            rrp: 48,
            videoUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
            crossSellIds: ['N7XK2M91'],
        },
        {
            id: 'B7R4Z75V',
            slug: 'lego-windows-doors-panes',
            title: 'LEGO Windows, Doors & Panes Lot (9x)',
            category: 'Toys & Games',
            startingPrice: 2,
            currentBid: 2,
            bidCount: 1,
            listedAt: new Date(now - 3 * day).toISOString(),
            endsAt: new Date(now + 1 * day + 16 * hour).toISOString(),
            imageSeed: 'lego1',
            description: 'Assorted genuine LEGO window and door elements from various sets.',
            conditionGrade: 'A',
            testedWorking: true,
            inspectorNotes: 'All elements present per weight check.',
            confidenceScore: 91,
            inventorySource: 'Wholesale clearance',
            bundleId: 'BND-LEGO',
        },
        {
            id: 'CY75VV38',
            slug: 'lego-windows-parts-lot',
            title: 'LEGO Windows & Doors Parts Lot (8x)',
            category: 'Toys & Games',
            startingPrice: 2,
            currentBid: 4,
            bidCount: 7,
            listedAt: new Date(now - 2 * day).toISOString(),
            endsAt: new Date(now + 1 * day + 17 * hour).toISOString(),
            imageSeed: 'lego2',
            description: 'Spare parts bundle; ideal for MOC builders.',
            conditionGrade: 'A',
            bundleId: 'BND-LEGO',
            crossSellIds: ['B7R4Z75V'],
        },
        {
            id: 'VBQU87XT',
            slug: 'marvel-eaglemoss-figurines',
            title: 'NEW Marvel Classic Figurine Collection — Eaglemoss',
            category: 'Collectibles',
            startingPrice: 1,
            currentBid: 8.25,
            bidCount: 22,
            listedAt: new Date(now - 5 * day).toISOString(),
            endsAt: new Date(now + 1 * day + 17 * hour).toISOString(),
            imageSeed: 'marvel',
            description: 'Sealed where stated; minor box wear on some issues.',
            featured: true,
            buyNowPrice: 35,
            conditionGrade: 'A',
            authenticityGuarantee: true,
            rrp: 120,
            confidenceScore: 88,
            inventorySource: 'Wholesale liquidation',
        },
        {
            id: 'DMAPWEWW',
            slug: 'lotr-chess-eaglemoss-1',
            title: 'NEW Lord of the Rings Eaglemoss Chess Collection',
            category: 'Collectibles',
            startingPrice: 1,
            currentBid: 15,
            bidCount: 31,
            listedAt: new Date(now - 4 * day).toISOString(),
            endsAt: new Date(now + 1 * day + 17 * hour).toISOString(),
            imageSeed: 'lotr1',
            description: 'Collector chess series pieces; packaging may vary.',
            vipEarlyAccess: true,
            refined: true,
            housePick: true,
            rrp: 199,
            confidenceScore: 93,
        },
        {
            id: 'TY6XV9BV',
            slug: 'lotr-chess-eaglemoss-2',
            title: 'Lord of the Rings Eaglemoss Chess — duplicate listing check photos',
            category: 'Collectibles',
            startingPrice: 1,
            currentBid: 3.5,
            bidCount: 9,
            listedAt: new Date(now - 4 * day).toISOString(),
            endsAt: new Date(now + 1 * day + 17 * hour).toISOString(),
            imageSeed: 'lotr2',
            description: 'See images for exact piece numbers included.',
            faultTags: ['Box damage'],
            conditionGrade: 'B',
        },
        {
            id: 'FBHSQ73E',
            slug: 'carlsberg-beer-mats',
            title: 'NEW Carlsberg Export Beer Mats — Set of 10',
            category: 'Home & Garden',
            startingPrice: 1,
            currentBid: 2.5,
            bidCount: 5,
            listedAt: new Date(now - 1 * day).toISOString(),
            endsAt: new Date(now + 1 * day + 17 * hour).toISOString(),
            imageSeed: 'beermats',
            description: 'Promotional beer mats; new old stock.',
            buyNowPrice: 8,
            buyNowFlashEndsAt: new Date(now + 6 * hour).toISOString(),
            priceDropFrom: 12,
        },
        {
            id: 'A8PJQWHR',
            slug: 'whos-your-llama-plush',
            title: "Who's Your Llama Plush — Twirly x2 (Jakks Pacific Series 1)",
            category: 'Toys & Games',
            startingPrice: 2,
            currentBid: 2,
            bidCount: 0,
            listedAt: new Date(now - 6 * hour).toISOString(),
            endsAt: new Date(now + 2 * day + 17 * hour).toISOString(),
            imageSeed: 'llama',
            description: 'New with tags where applicable.',
            testedWorking: true,
            conditionGrade: 'A',
            dropId: 'DROP-TOYS-JAN',
        },
        {
            id: 'W6L2UJFA',
            slug: 'lotr-chess-haradrim-1',
            title: 'LOTR Eaglemoss Chess — Haradrim Archer Black Pawn',
            category: 'Collectibles',
            startingPrice: 2,
            currentBid: 6,
            bidCount: 11,
            listedAt: new Date(now - 1 * day).toISOString(),
            endsAt: new Date(now + 2 * day + 17 * hour).toISOString(),
            imageSeed: 'chess1',
            description: 'Boxed figure; see photos for condition.',
            auctionMode: 'live',
        },
        {
            id: 'D9DMRDXK',
            slug: 'lotr-ringwraith-horse',
            title: 'LOTR Eaglemoss — Ringwraith on Horse (boxed figure)',
            category: 'Collectibles',
            startingPrice: 2,
            currentBid: 11,
            bidCount: 18,
            listedAt: new Date(now - 2 * day).toISOString(),
            endsAt: new Date(now + 2 * day + 16 * hour).toISOString(),
            imageSeed: 'ringwraith',
            description: 'Display piece; box may show shelf wear.',
            auctionMode: 'live',
        },
        {
            id: 'DLPES4MN',
            slug: 'france-travel-maps-postcards',
            title: 'Lot 15 — France Travel Guides, Maps, Vintage Postcards',
            category: 'Arts & Entertainment',
            startingPrice: 3,
            currentBid: 3,
            bidCount: 2,
            listedAt: new Date(now - 12 * hour).toISOString(),
            endsAt: new Date(now + 2 * day + 16 * hour).toISOString(),
            imageSeed: 'france',
            description: 'Michelin, Berlitz, and assorted ephemera.',
            conditionGrade: 'B',
        },
        {
            id: 'Z2YYK52A',
            slug: 'cookery-health-books-15',
            title: 'Mixed Lot of 15 Cookery, Diet & Health Books',
            category: 'Arts & Entertainment',
            startingPrice: 3,
            currentBid: 4.5,
            bidCount: 6,
            listedAt: new Date(now - 8 * hour).toISOString(),
            endsAt: new Date(now + 2 * day + 16 * hour).toISOString(),
            imageSeed: 'books',
            description: 'Includes matching Liz Earle set per listing photos.',
            faultTags: ['Shelf wear'],
        },
        {
            id: 'K9LDZ4GL',
            slug: 'ward-lock-highlands-guide',
            title: 'Ward & Lock Illustrated Guide — Highlands of Scotland (9th Ed.)',
            category: 'Arts & Entertainment',
            startingPrice: 2,
            currentBid: 2,
            bidCount: 1,
            listedAt: new Date(now - 3 * day).toISOString(),
            endsAt: new Date(now + 2 * day + 16 * hour).toISOString(),
            imageSeed: 'scotland',
            description: 'Vintage travel guide; spine and corners per photos.',
            conditionGrade: 'C',
            confidenceScore: 58,
        },
        {
            id: 'GTQPLMD2',
            slug: 'golden-retriever-figurine',
            title: 'Regency Fine Arts Golden Retriever Figurine — Resin Ornament',
            category: 'Home & Garden',
            startingPrice: 3,
            currentBid: 9,
            bidCount: 14,
            listedAt: new Date(now - 4 * day).toISOString(),
            endsAt: new Date(now + 2 * day + 15 * hour).toISOString(),
            imageSeed: 'dog',
            description: 'Very good condition; no chips visible in listing images.',
            housePick: true,
            refined: true,
            testedWorking: true,
            authenticityGuarantee: true,
            rrp: 34.99,
            confidenceScore: 95,
        },
        {
            id: 'N7XK2M91',
            slug: 'vintage-typewriter-ribbon',
            title: 'Vintage Typewriter Ribbon Lot — Mixed Brands',
            category: 'Office Supplies',
            startingPrice: 4,
            currentBid: 4,
            bidCount: 0,
            listedAt: new Date(now - 2 * hour).toISOString(),
            endsAt: new Date(now + 3 * day + 9 * hour).toISOString(),
            imageSeed: 'ribbon',
            description: 'Compatibility not guaranteed; sold as collector lot.',
            conditionGrade: 'C',
        },
        {
            id: 'P4HJ8WQ2',
            slug: 'leather-jacket-m',
            title: 'Leather Jacket — Size M (see measurements)',
            category: 'Clothing & Accessories',
            startingPrice: 25,
            currentBid: 42,
            bidCount: 27,
            listedAt: new Date(now - 6 * day).toISOString(),
            endsAt: new Date(now + 20 * hour).toISOString(),
            imageSeed: 'jacket',
            description: 'Genuine leather; lining intact. Measurements in photos.',
            stealOfWeek: true,
            reservePrice: 35,
            buyNowPrice: 95,
            rrp: 189,
            confidenceScore: 86,
            inventorySource: 'Amazon Returns',
        },
        {
            id: 'MYSTERY01',
            slug: 'mystery-electronics-box',
            title: 'Mystery Electronics Box — Guaranteed Value Floor',
            category: 'Electronics',
            startingPrice: 15,
            currentBid: 15,
            bidCount: 8,
            listedAt: new Date(now - 1 * day).toISOString(),
            endsAt: new Date(now + 4 * day + 10 * hour).toISOString(),
            imageSeed: 'mysterybox',
            description:
                'Contents are a surprise — minimum resale value £40 (audited). May include accessories, cables, or small devices.',
            mysteryFloor: 40,
            mysteryTeaser: 'At least 4 items inside · no empty boxes',
            conditionGrade: 'B',
            inventorySource: 'Liquidation manifest',
            confidenceScore: 78,
        },
        {
            id: 'TRADE01',
            slug: 'bulk-pallet-home-assorted',
            title: 'Trade Pallet — Home & Kitchen Assorted (48 units)',
            category: 'Home & Garden',
            startingPrice: 320,
            currentBid: 320,
            bidCount: 2,
            listedAt: new Date(now - 2 * day).toISOString(),
            endsAt: new Date(now + 5 * day + 12 * hour).toISOString(),
            imageSeed: 'pallet',
            description: 'Manifest available after verification. Forklift collection. Trade buyers only.',
            tradeOnly: true,
            reservePrice: 400,
            conditionGrade: 'B',
            inventorySource: 'Wholesale pallet',
            returnRatePct: 7,
        },
    ];

    const soldLots = [
        { title: 'Sony WH-1000XM4 (graded B)', soldPrice: 112, bidders: 34, endedAgo: '2h ago' },
        { title: 'Dyson V15 Detect — Refurb', soldPrice: 289, bidders: 56, endedAgo: '5h ago' },
        { title: 'LEGO Ideas — Sealed', soldPrice: 44, bidders: 19, endedAgo: 'Yesterday' },
        { title: 'Apple Watch Series 8 (tested)', soldPrice: 178, bidders: 41, endedAgo: 'Yesterday' },
    ];

    const dropSchedule = [
        {
            id: 'DROP-TOYS-JAN',
            name: 'Toy Box Tuesday',
            theme: 'Toys & Games',
            opensAt: new Date(now + 2 * day).toISOString(),
            blurb: 'Scheduled themed drop — early access for VIP Buyer Club.',
        },
        {
            id: 'DROP-ELEC-Flash',
            name: 'Electronics Flash Friday',
            theme: 'Electronics',
            opensAt: new Date(now + 5 * day).toISOString(),
            blurb: 'Limited slots · live host commentary on stream.',
        },
        {
            id: 'DROP-COLLECT',
            name: 'Collectibles Vault',
            theme: 'Collectibles',
            opensAt: new Date(now + 9 * day).toISOString(),
            blurb: 'Curated premium lots — Auction House Picks preview.',
        },
    ];

    const bundles = [{ id: 'BND-LEGO', title: 'LEGO bundle', discountPct: 10, lotIds: ['B7R4Z75V', 'CY75VV38'] }];

    function enrichLot(l) {
        const merged = { ...DEFAULT_LOT, ...l };
        if (!merged.crossSellIds || merged.crossSellIds.length === 0) {
            merged.crossSellIds = rawLots
                .filter((x) => x.id !== merged.id && x.category === merged.category)
                .slice(0, 2)
                .map((x) => x.id);
        }
        return merged;
    }

    function lotImageUrl(lot, w, h) {
        const seed = lot.imageSeed || lot.id;
        return `https://picsum.photos/seed/${encodeURIComponent(seed)}/${w}/${h}`;
    }

    function getLots() {
        return rawLots.map((l) => enrichLot(l));
    }

    function getLotById(id) {
        const f = rawLots.find((l) => l.id === id);
        return f ? enrichLot(f) : null;
    }

    function reserveMet(lot) {
        if (lot.reservePrice == null) return true;
        return lot.currentBid >= lot.reservePrice;
    }

    function sortLots(lots, order) {
        const copy = lots.slice();
        const end = (x) => new Date(x.endsAt).getTime();
        const listed = (x) => new Date(x.listedAt).getTime();
        switch (order) {
            case 'endingsoon':
                return copy.sort((a, b) => end(a) - end(b));
            case 'mostpopular':
                return copy.sort((a, b) => b.bidCount - a.bidCount || end(a) - end(b));
            case 'newlylisted':
                return copy.sort((a, b) => listed(b) - listed(a));
            case 'featured':
                return copy.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
            default:
                return copy;
        }
    }

    function filterLots(lots, filters) {
        let out = lots;
        const { category, q, grade, auctionMode, tradeOnly, mysteryOnly, refinedOnly } = filters;
        if (category && category !== 'all') {
            out = out.filter((l) => l.category === category);
        }
        if (q && String(q).trim()) {
            const needle = String(q).trim().toLowerCase();
            out = out.filter(
                (l) =>
                    l.title.toLowerCase().includes(needle) ||
                    l.description.toLowerCase().includes(needle) ||
                    l.id.toLowerCase().includes(needle)
            );
        }
        if (grade && grade !== 'all') {
            out = out.filter((l) => l.conditionGrade === grade);
        }
        if (auctionMode && auctionMode !== 'all') {
            out = out.filter((l) => l.auctionMode === auctionMode);
        }
        if (tradeOnly === '1' || tradeOnly === true) {
            out = out.filter((l) => l.tradeOnly);
        }
        if (mysteryOnly === '1' || mysteryOnly === true) {
            out = out.filter((l) => l.mysteryFloor != null);
        }
        if (refinedOnly === '1' || refinedOnly === true) {
            out = out.filter((l) => l.refined);
        }
        return out;
    }

    function formatMoney(n) {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);
    }

    function getStealOfWeek() {
        return enrichLot(rawLots.find((l) => l.stealOfWeek) || rawLots[0]);
    }

    function getFeaturedLots() {
        return rawLots.filter((l) => l.featured).map(enrichLot);
    }

    function getHousePicks() {
        return rawLots.filter((l) => l.housePick).map(enrichLot);
    }

    function getRelatedLots(lotId, limit) {
        const lot = getLotById(lotId);
        if (!lot) return [];
        const ids = new Set(lot.crossSellIds || []);
        rawLots.forEach((x) => {
            if (x.category === lot.category && x.id !== lotId) ids.add(x.id);
        });
        return Array.from(ids)
            .slice(0, limit || 4)
            .map((id) => getLotById(id))
            .filter(Boolean);
    }

    function getBundleForLot(lotId) {
        const lot = rawLots.find((l) => l.id === lotId);
        if (!lot || !lot.bundleId) return null;
        return bundles.find((b) => b.id === lot.bundleId) || null;
    }

    function getDropById(id) {
        return dropSchedule.find((d) => d.id === id) || null;
    }

    global.AuctionData = {
        CATEGORIES,
        DEFAULT_LOT,
        enrichLot,
        getLots,
        getLotById,
        sortLots,
        filterLots,
        lotImageUrl,
        formatMoney,
        reserveMet,
        soldLots,
        dropSchedule,
        bundles,
        getStealOfWeek,
        getFeaturedLots,
        getHousePicks,
        getRelatedLots,
        getBundleForLot,
        getDropById,
    };
})(typeof window !== 'undefined' ? window : globalThis);
