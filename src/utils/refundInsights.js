'use strict';

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

function inferRefundCategory(productName) {
    const p = String(productName || '').toLowerCase();
    if (!p) return 'Other';
    if (/(air fryer|coffee|kettle|toaster|vacuum|cleaner|dehumidifier|blender|iron|washer|dishwasher)/.test(p)) return 'Home Appliances';
    if (/(ps5|xbox|nintendo|gaming|headset|keyboard|mouse|monitor|console|sat nav|gps|router|wifi|printer|chromebook|laptop)/.test(p)) return 'Electronics & Gaming';
    if (/(perfume|eau de|fragrance|cream|serum|shampoo|conditioner|skincare|lipstick|beauty|collagen|niacinamide)/.test(p)) return 'Beauty & Personal Care';
    if (/(pokemon|tcg|booster|trainer box|funko|toy|figure|game)/.test(p)) return 'Toys & Collectibles';
    if (/(tool|drill|wrench|jigsaw|stihl|milwaukee|bosch)/.test(p)) return 'DIY & Tools';
    if (/(toothbrush|water flosser|health|supplement|vitamin)/.test(p)) return 'Health & Wellness';
    if (/(pool|outdoor|garden|camp|sports|cycling)/.test(p)) return 'Outdoor & Leisure';
    return 'Other';
}

function ensureInsightTables(db) {
    db.run(
        `CREATE TABLE IF NOT EXISTS refund_insight_category_stats (
            category TEXT PRIMARY KEY,
            refund_count INTEGER NOT NULL DEFAULT 0,
            refund_total REAL NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
    );
    db.run(
        `CREATE TABLE IF NOT EXISTS refund_insight_product_stats (
            product TEXT PRIMARY KEY,
            category TEXT NOT NULL,
            refund_count INTEGER NOT NULL DEFAULT 0,
            refund_total REAL NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
    );
}

function buildRowsFromAdjustments(db) {
    return parseResults(
        db.exec(
            `SELECT r.product, COALESCE(r.amount, 0) AS amount
             FROM return_adjustments r
             LEFT JOIN users u ON u.id = r.user_id
             WHERE r.status = 'applied'
               AND COALESCE(u.is_admin, 0) = 0
               AND TRIM(COALESCE(r.product, '')) <> ''`
        )
    );
}

function rebuildRefundInsightsCache(db) {
    ensureInsightTables(db);
    const rows = buildRowsFromAdjustments(db);
    const byCategory = new Map();
    const byProduct = new Map();
    let totalRefundRows = 0;

    for (const row of rows) {
        const product = String(row.product || '').trim();
        if (!product) continue;
        const amount = Number(row.amount) || 0;
        const category = inferRefundCategory(product);
        totalRefundRows++;

        const c = byCategory.get(category) || { category, refund_count: 0, refund_total: 0 };
        c.refund_count += 1;
        c.refund_total += amount;
        byCategory.set(category, c);

        const p = byProduct.get(product) || { product, category, refund_count: 0, refund_total: 0 };
        p.refund_count += 1;
        p.refund_total += amount;
        byProduct.set(product, p);
    }

    db.run('DELETE FROM refund_insight_category_stats');
    db.run('DELETE FROM refund_insight_product_stats');

    for (const c of byCategory.values()) {
        db.run(
            `INSERT INTO refund_insight_category_stats (category, refund_count, refund_total, updated_at)
             VALUES (?, ?, ?, datetime('now'))`,
            [c.category, c.refund_count, c.refund_total]
        );
    }
    for (const p of byProduct.values()) {
        db.run(
            `INSERT INTO refund_insight_product_stats (product, category, refund_count, refund_total, updated_at)
             VALUES (?, ?, ?, ?, datetime('now'))`,
            [p.product, p.category, p.refund_count, p.refund_total]
        );
    }

    return {
        total_refund_rows: totalRefundRows,
        categories_written: byCategory.size,
        products_written: byProduct.size,
    };
}

function getRefundInsightsFromCache(db, limit = 5) {
    ensureInsightTables(db);
    const lim = Math.max(1, parseInt(limit, 10) || 5);
    const top_categories = parseResults(
        db.exec(
            `SELECT category AS name, refund_count, refund_total
             FROM refund_insight_category_stats
             ORDER BY refund_count DESC, refund_total DESC
             LIMIT ?`,
            [lim]
        )
    );
    const top_products = parseResults(
        db.exec(
            `SELECT product AS name, refund_count, refund_total
             FROM refund_insight_product_stats
             ORDER BY refund_count DESC, refund_total DESC
             LIMIT ?`,
            [lim]
        )
    );
    const totalRowsRes = parseResults(
        db.exec(
            `SELECT COALESCE(SUM(refund_count), 0) AS total_refund_rows
             FROM refund_insight_product_stats`
        )
    );
    return {
        total_refund_rows: Number(totalRowsRes[0]?.total_refund_rows) || 0,
        top_categories,
        top_products,
    };
}

function cacheIsStale(db, maxAgeHours) {
    ensureInsightTables(db);
    const age = Math.max(1, parseInt(maxAgeHours, 10) || 6);
    const r = parseResults(
        db.exec(
            `SELECT MAX(updated_at) AS updated_at FROM refund_insight_category_stats`
        )
    );
    const ts = r[0] && r[0].updated_at ? String(r[0].updated_at) : '';
    if (!ts) return true;
    const date = new Date(ts.replace(' ', 'T') + 'Z');
    if (Number.isNaN(date.getTime())) return true;
    return Date.now() - date.getTime() > age * 60 * 60 * 1000;
}

module.exports = {
    inferRefundCategory,
    rebuildRefundInsightsCache,
    getRefundInsightsFromCache,
    cacheIsStale,
};

