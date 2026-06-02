/**
 * Client inventory summary — pipeline counts, recovery metrics, attention lists.
 */

const { normalizeSoldDateForDb } = require('./adminBulkImport');
const { mapSoldItemDatesForApi } = require('./soldDateDisplayRepair');
const { inferRefundCategory } = require('./refundInsights');
const { sortSoldItemsByDateDesc } = require('./sortSoldItemsByDateDesc');

const INSPECTION_STAGES = new Set(['Initial Inspection', 'Quality Check', 'Return Verification']);

function parseResults(result) {
    if (!result || result.length === 0) return [];
    const cols = result[0].columns;
    return result[0].values.map((row) => {
        const obj = {};
        cols.forEach((col, i) => {
            obj[col] = row[i];
        });
        return obj;
    });
}

/** @param {string|null|undefined} dateStr */
function daysSince(dateStr) {
    if (!dateStr || !String(dateStr).trim()) return null;
    let s = String(dateStr).trim();
    const t = s.indexOf('T');
    if (t !== -1) s = s.slice(0, t);
    else if (/^\d{4}-\d{2}-\d{2}\s/.test(s)) s = s.slice(0, 10);
    const d = new Date(s + 'T12:00:00Z');
    if (Number.isNaN(d.getTime())) return null;
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 */
function buildInventorySummaryPayload(db, userId) {
    const packagesSent = parseResults(
        db.exec('SELECT COUNT(*) AS c FROM packages WHERE user_id = ?', [userId])
    )[0]?.c || 0;

    const items_received = parseResults(
        db.exec('SELECT COUNT(*) AS c FROM received_items WHERE user_id = ?', [userId])
    )[0]?.c || 0;

    const items_sold = parseResults(
        db.exec('SELECT COUNT(*) AS c FROM sold_items WHERE user_id = ?', [userId])
    )[0]?.c || 0;

    const items_processing = parseResults(
        db.exec('SELECT COUNT(*) AS c FROM pending_items WHERE user_id = ?', [userId])
    )[0]?.c || 0;

    const profitRow = parseResults(
        db.exec(
            `SELECT COALESCE(SUM(profit), 0) AS p, COALESCE(SUM(total_revenue), 0) AS rev
             FROM sold_items WHERE user_id = ?`,
            [userId]
        )
    )[0];
    const recovered_profit = Math.round((Number(profitRow?.p) || 0) * 100) / 100;
    const recovered_revenue = Math.round((Number(profitRow?.rev) || 0) * 100) / 100;

    const avgSaleRow = parseResults(
        db.exec(
            `SELECT COALESCE(AVG(CASE WHEN total_revenue > 0 THEN total_revenue ELSE unit_price * quantity END), 0) AS a
             FROM sold_items WHERE user_id = ? AND (status IS NULL OR status != 'Refunded')`,
            [userId]
        )
    )[0];
    const avg_sale_price = Math.round((Number(avgSaleRow?.a) || 0) * 100) / 100;

    const pendingByStage = parseResults(
        db.exec(
            `SELECT current_stage, COUNT(*) AS c FROM pending_items WHERE user_id = ? GROUP BY current_stage`,
            [userId]
        )
    );

    let processingCount = 0;
    let listingCount = 0;
    let readyCount = 0;
    let storageCount = 0;

    pendingByStage.forEach((row) => {
        const stage = String(row.current_stage || '');
        const c = Number(row.c) || 0;
        if (INSPECTION_STAGES.has(stage)) processingCount += c;
        else if (stage === 'Listing') listingCount += c;
        else if (stage === 'Ready for Sale') readyCount += c;
        else storageCount += c;
    });

    const pipeline = {
        sent: Number(packagesSent) || 0,
        received: Number(items_received) || 0,
        processing: processingCount,
        listing: listingCount,
        ready: readyCount,
        sold: Number(items_sold) || 0,
    };

    const stage_breakdown = {
        inspection: processingCount,
        listing: listingCount,
        listed: readyCount,
        sold: Number(items_sold) || 0,
        storage: storageCount,
    };

    const intakeDenom = items_received > 0 ? items_received : packagesSent > 0 ? packagesSent : 0;
    const sell_through_pct =
        intakeDenom > 0 ? Math.round((items_sold / intakeDenom) * 1000) / 1000 : items_sold > 0 ? 1 : 0;

    let estimated_pipeline_value = null;
    if (items_processing > 0 && avg_sale_price > 0) {
        estimated_pipeline_value = Math.round(items_processing * avg_sale_price * 100) / 100;
    }

    let potential_remaining_value = null;
    if (estimated_pipeline_value != null) {
        potential_remaining_value = Math.max(
            0,
            Math.round((estimated_pipeline_value - recovered_profit) * 100) / 100
        );
    }

    const attentionRows = parseResults(
        db.exec(
            `SELECT id, product, current_stage, received_date
             FROM pending_items WHERE user_id = ?
             ORDER BY received_date ASC, id ASC
             LIMIT 10`,
            [userId]
        )
    );
    const attention_items = attentionRows.map((r) => ({
        id: r.id,
        product: r.product || '',
        current_stage: r.current_stage || '',
        received_date: r.received_date || '',
        days_in_stage: daysSince(r.received_date),
    }));

    const soldRows = parseResults(
        db.exec(
            `SELECT id, product, sold_date, profit, status
             FROM sold_items WHERE user_id = ?`,
            [userId]
        )
    );
    const recentSoldRows = sortSoldItemsByDateDesc(soldRows).slice(0, 8);
    const recent_sold = recentSoldRows.map((r) => {
        const dates = mapSoldItemDatesForApi(r.sold_date, normalizeSoldDateForDb);
        return {
            id: r.id,
            product: r.product || '',
            sold_date: dates.iso || r.sold_date || '',
            sold_date_label: dates.label || '',
            profit: Math.round((Number(r.profit) || 0) * 100) / 100,
            status: r.status || '',
        };
    });

    const refundProducts = parseResults(
        db.exec(
            `SELECT product, COUNT(*) AS c, COALESCE(SUM(amount), 0) AS total
             FROM return_adjustments
             WHERE user_id = ? AND status = 'applied'
             GROUP BY product
             ORDER BY c DESC, total DESC
             LIMIT 40`,
            [userId]
        )
    );
    const catMap = new Map();
    for (const row of refundProducts) {
        const name = inferRefundCategory(row.product || '');
        const prev = catMap.get(name) || { name, refund_count: 0, refund_total: 0 };
        prev.refund_count += Number(row.c) || 0;
        prev.refund_total += Number(row.total) || 0;
        catMap.set(name, prev);
    }
    const user_return_categories = Array.from(catMap.values())
        .sort((a, b) => b.refund_count - a.refund_count || b.refund_total - a.refund_total)
        .slice(0, 5)
        .map((c) => ({
            name: c.name,
            refund_count: c.refund_count,
            refund_total: Math.round(c.refund_total * 100) / 100,
        }));

    const pipeline_hints = [];
    if (pipeline.sent === 0 && pipeline.received === 0 && pipeline.sold > 0) {
        pipeline_hints.push(
            'Sales are recorded on your account. Add packages or received intake to track the full journey from shipment to sale.'
        );
    }
    if (pipeline.sent === 0 && pipeline.received === 0 && pipeline.sold === 0) {
        pipeline_hints.push('Send your first package to start tracking returns through ReturnPal.');
    }

    return {
        packages_sent: Number(packagesSent) || 0,
        pipeline,
        pipeline_hints,
        items_received,
        items_processing,
        items_sold,
        awaiting_inspection: processingCount,
        awaiting_listing: listingCount,
        recovered_profit,
        recovered_revenue,
        recovered_so_far: recovered_revenue,
        sell_through_pct,
        estimated_pipeline_value,
        estimated_resale_value: estimated_pipeline_value,
        potential_remaining_value,
        stage_breakdown,
        attention_items,
        recent_sold,
        user_return_categories,
    };
}

module.exports = { buildInventorySummaryPayload, daysSince };
