/** Client-facing labels for pending_items.current_stage (Your stock page). */

const PREPARING_STAGES = ['Initial Inspection', 'Quality Check', 'Return Verification'];
const LISTING_STAGE = 'Listing';
const LIVE_STAGE = 'Ready for Sale';

const STOCK_STAGE_GROUPS = {
    preparing: PREPARING_STAGES,
    listing: [LISTING_STAGE],
    live: [LIVE_STAGE],
};

const GROUP_SORT_ORDER = { live: 0, listing: 1, preparing: 2, other: 3 };

/** Items with us this many days or more appear in "Needs attention". */
const STOCK_ATTENTION_DAYS = 60;

/**
 * @param {number|null|undefined} daysWithUs
 */
function stockNeedsAttention(daysWithUs) {
    return daysWithUs != null && daysWithUs >= STOCK_ATTENTION_DAYS;
}

/**
 * @param {string|null|undefined} stage
 * @returns {{ label: string, group: string, badge_class: string }}
 */
function clientStatusFromStage(stage) {
    const s = String(stage || '').trim();
    if (s === LIVE_STAGE) {
        return { label: 'Live', group: 'live', badge_class: 'bg-success' };
    }
    if (s === LISTING_STAGE) {
        return { label: 'Being listed', group: 'listing', badge_class: 'bg-info text-dark' };
    }
    if (PREPARING_STAGES.includes(s)) {
        return { label: 'Being prepared', group: 'preparing', badge_class: 'bg-warning text-dark' };
    }
    return { label: 'Being prepared', group: 'preparing', badge_class: 'bg-secondary' };
}

/**
 * @param {string} group - all | preparing | listing | live
 * @returns {string[]|null} null = no stage filter (all)
 */
function stagesForGroup(group) {
    const g = String(group || 'all').toLowerCase();
    if (g === 'all' || !g) return null;
    return STOCK_STAGE_GROUPS[g] || null;
}

/**
 * @param {{ current_stage?: string, received_date?: string }} row
 */
function stockItemSortKey(row) {
    const status = clientStatusFromStage(row.current_stage);
    const groupOrder = GROUP_SORT_ORDER[status.group] ?? GROUP_SORT_ORDER.other;
    const date = row.received_date ? String(row.received_date) : '';
    return { groupOrder, date };
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {{ group?: string, search?: string }} [opts]
 */
function buildClientStockPayload(db, userId, opts = {}) {
    const result = db.exec(
        'SELECT * FROM pending_items WHERE user_id = ? ORDER BY received_date DESC, id DESC',
        [userId]
    );
    if (!result.length) {
        return {
            summary: {
                total_items: 0,
                total_quantity: 0,
                preparing: 0,
                listing: 0,
                live: 0,
                attention_count: 0,
            },
            attention_items: [],
            items: [],
        };
    }
    const cols = result[0].columns;
    let rows = result[0].values.map((row) => {
        const obj = {};
        cols.forEach((col, i) => {
            obj[col] = row[i];
        });
        return obj;
    });

    const search = String(opts.search || '')
        .trim()
        .toLowerCase();
    if (search) {
        rows = rows.filter((r) => {
            const hay = (String(r.product || '') + ' ' + String(r.reference || '')).toLowerCase();
            return hay.includes(search);
        });
    }

    const groupFilter = stagesForGroup(opts.group);
    if (groupFilter && groupFilter.length) {
        rows = rows.filter((r) => groupFilter.includes(String(r.current_stage || '')));
    }

    const now = Date.now();
    const enriched = rows.map((r) => {
        const status = clientStatusFromStage(r.current_stage);
        let daysWithUs = null;
        if (r.received_date) {
            const d = new Date(String(r.received_date).slice(0, 10) + 'T12:00:00Z');
            if (!Number.isNaN(d.getTime())) {
                daysWithUs = Math.max(0, Math.floor((now - d.getTime()) / 86400000));
            }
        }
        return {
            id: r.id,
            product: r.product || '',
            quantity: Number(r.quantity) || 1,
            reference: r.reference || '',
            received_date: r.received_date || '',
            current_stage: r.current_stage || '',
            client_status: status.label,
            client_status_group: status.group,
            client_status_badge: status.badge_class,
            days_with_us: daysWithUs,
            needs_attention: stockNeedsAttention(daysWithUs),
            notes: r.notes || '',
        };
    });

    enriched.sort((a, b) => {
        const ka = stockItemSortKey(a);
        const kb = stockItemSortKey(b);
        if (ka.groupOrder !== kb.groupOrder) return ka.groupOrder - kb.groupOrder;
        return String(kb.date).localeCompare(String(ka.date));
    });

    const allRows = result[0].values.map((row) => {
        const obj = {};
        cols.forEach((col, i) => {
            obj[col] = row[i];
        });
        return obj;
    });

    let preparing = 0;
    let listing = 0;
    let live = 0;
    let totalQty = 0;
    allRows.forEach((r) => {
        const qty = Number(r.quantity) || 1;
        totalQty += qty;
        const g = clientStatusFromStage(r.current_stage).group;
        if (g === 'live') live += qty;
        else if (g === 'listing') listing += qty;
        else preparing += qty;
    });

    const attentionCandidates = allRows
        .map((r) => {
            const status = clientStatusFromStage(r.current_stage);
            let daysWithUs = null;
            if (r.received_date) {
                const d = new Date(String(r.received_date).slice(0, 10) + 'T12:00:00Z');
                if (!Number.isNaN(d.getTime())) {
                    daysWithUs = Math.max(0, Math.floor((now - d.getTime()) / 86400000));
                }
            }
            return {
                id: r.id,
                product: r.product || '',
                reference: r.reference || '',
                client_status: status.label,
                days_with_us: daysWithUs,
                received_date: r.received_date || '',
                needs_attention: stockNeedsAttention(daysWithUs),
            };
        })
        .filter((r) => r.needs_attention)
        .sort((a, b) => {
            const da = a.received_date ? String(a.received_date) : '';
            const db = b.received_date ? String(b.received_date) : '';
            return da.localeCompare(db) || Number(a.id) - Number(b.id);
        });

    const attention_items = attentionCandidates.slice(0, 10).map((r) => ({
        id: r.id,
        product: r.product,
        reference: r.reference,
        client_status: r.client_status,
        days_with_us: r.days_with_us,
    }));

    return {
        summary: {
            total_items: allRows.length,
            total_quantity: totalQty,
            preparing,
            listing,
            live,
            attention_count: attentionCandidates.length,
        },
        attention_items,
        items: enriched,
    };
}

module.exports = {
    PREPARING_STAGES,
    LISTING_STAGE,
    LIVE_STAGE,
    STOCK_STAGE_GROUPS,
    STOCK_ATTENTION_DAYS,
    clientStatusFromStage,
    stagesForGroup,
    stockNeedsAttention,
    buildClientStockPayload,
};
