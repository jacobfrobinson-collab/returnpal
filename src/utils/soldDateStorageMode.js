/**
 * Sold date storage/read mode (single switch for the whole app).
 *
 * Production DB was migrated to calendar YYYY-MM-DD (2026-06). Canonical read is the default.
 * Set RETURNPAL_SOLD_DATES_LEGACY=1 only for an unmigrated local copy of the old DB.
 */

/** @returns {boolean} true when sold_items.sold_date is calendar YYYY-MM-DD */
function soldDatesCanonicalStorage() {
    return String(process.env.RETURNPAL_SOLD_DATES_LEGACY || '').trim() !== '1';
}

module.exports = { soldDatesCanonicalStorage };
