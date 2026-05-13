/**
 * Explains which rows contribute each invoice calendar month (admin diagnostics).
 */

const { calendarIsoDateFromDbDate, calendarYearMonthFromDbDate } = require('./soldDateCalendar');

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

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @returns {{
 *   user_id: number,
 *   distinct_months: string[],
 *   months: Record<string, {
 *     sold_items: Array<{ id: number, reference: string, product: string, raw_sold_date: string, normalized_iso: string|null }>,
 *     return_linked_sale: Array<{ return_id: number, return_reference: string, sold_item_id: number, sale_reference: string, raw_sold_date_on_sale: string, normalized_iso: string|null }>,
 *     return_unlinked: Array<{ return_id: number, reference: string, raw_created_at: string, normalized_iso: string|null }>
 *   }>,
 *   unparseable: Array<{ kind: string, detail: object }>
 * }}
 */
function buildInvoiceMonthSourcesPayload(db, userId) {
    const sold = parseResults(
        db.exec(
            `SELECT id, reference, product, sold_date AS raw_sold_date
             FROM sold_items
             WHERE user_id = ?
               AND sold_date IS NOT NULL
               AND length(trim(sold_date)) > 0`,
            [userId]
        )
    );

    const linkedReturns = parseResults(
        db.exec(
            `SELECT r.id AS return_id, r.reference AS return_reference, r.linked_sold_item_id,
                    s.id AS sold_item_id, s.reference AS sale_reference, s.sold_date AS raw_sold_date_on_sale
             FROM return_adjustments r
             JOIN sold_items s ON s.id = r.linked_sold_item_id AND s.user_id = r.user_id
             WHERE r.user_id = ? AND r.status = 'applied' AND r.linked_sold_item_id IS NOT NULL
               AND s.sold_date IS NOT NULL AND length(trim(s.sold_date)) > 0`,
            [userId]
        )
    );

    const unlinkedReturns = parseResults(
        db.exec(
            `SELECT id AS return_id, reference, created_at AS raw_created_at
             FROM return_adjustments
             WHERE user_id = ? AND status = 'applied' AND linked_sold_item_id IS NULL
               AND created_at IS NOT NULL AND length(trim(created_at)) > 0`,
            [userId]
        )
    );

    /** @type {Record<string, { sold_items: object[], return_linked_sale: object[], return_unlinked: object[] }>} */
    const months = {};
    const unparseable = [];

    function ensureMonth(ym) {
        if (!months[ym]) {
            months[ym] = { sold_items: [], return_linked_sale: [], return_unlinked: [] };
        }
        return months[ym];
    }

    for (const r of sold) {
        const raw = r.raw_sold_date;
        const norm = calendarIsoDateFromDbDate(raw);
        const ym = calendarYearMonthFromDbDate(raw);
        if (!ym) {
            unparseable.push({
                kind: 'sold_item',
                detail: { id: r.id, reference: r.reference, raw_sold_date: raw, normalized_iso: norm }
            });
            continue;
        }
        ensureMonth(ym).sold_items.push({
            id: r.id,
            reference: r.reference || '',
            product: r.product || '',
            raw_sold_date: raw,
            normalized_iso: norm
        });
    }

    for (const r of linkedReturns) {
        const raw = r.raw_sold_date_on_sale;
        const norm = calendarIsoDateFromDbDate(raw);
        const ym = calendarYearMonthFromDbDate(raw);
        if (!ym) {
            unparseable.push({
                kind: 'return_adjustment_linked',
                detail: {
                    return_id: r.return_id,
                    sold_item_id: r.sold_item_id,
                    raw_sold_date_on_sale: raw,
                    normalized_iso: norm
                }
            });
            continue;
        }
        ensureMonth(ym).return_linked_sale.push({
            return_id: r.return_id,
            return_reference: r.return_reference || '',
            sold_item_id: r.sold_item_id,
            sale_reference: r.sale_reference || '',
            raw_sold_date_on_sale: raw,
            normalized_iso: norm
        });
    }

    for (const r of unlinkedReturns) {
        const raw = r.raw_created_at;
        const norm = calendarIsoDateFromDbDate(raw);
        const ym = calendarYearMonthFromDbDate(raw);
        if (!ym) {
            unparseable.push({
                kind: 'return_adjustment_unlinked',
                detail: { return_id: r.return_id, reference: r.reference || '', raw_created_at: raw, normalized_iso: norm }
            });
            continue;
        }
        ensureMonth(ym).return_unlinked.push({
            return_id: r.return_id,
            reference: r.reference || '',
            raw_created_at: raw,
            normalized_iso: norm
        });
    }

    const distinct_months = Object.keys(months).sort().reverse();

    return {
        user_id: userId,
        distinct_months,
        months,
        unparseable
    };
}

module.exports = { buildInvoiceMonthSourcesPayload };
