#!/usr/bin/env node
'use strict';

/**
 * Build/refresh cross-client refund insight rollups.
 *
 * Usage:
 *   npm run refund-insights:refresh
 */

const { getDb, saveDb } = require('../src/database');
const { rebuildRefundInsightsCache } = require('../src/utils/refundInsights');

async function main() {
    const db = await getDb();
    const result = rebuildRefundInsightsCache(db);
    await saveDb(db);
    console.log(
        `Refund insights refreshed: ${result.total_refund_rows} refunds, ` +
        `${result.categories_written} categories, ${result.products_written} products.`
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

