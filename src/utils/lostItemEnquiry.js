/**
 * Missing / lost item enquiries — eligibility and sold-item linkage.
 */
const { normalizeSoldDateForDb } = require('./adminBulkImport');

const STATUSES = ['pending', 'confirmed', 'denied'];
const OUTCOMES = ['received', 'in_stock', 'sold', 'not_found', 'never_received', ''];

function parseResults(result) {
    if (!result || !result.length) return [];
    const cols = result[0].columns;
    return result[0].values.map((row) => {
        const obj = {};
        cols.forEach((col, i) => {
            obj[col] = row[i];
        });
        return obj;
    });
}

/** YYYY-MM-DD today in Europe/London. */
function todayYmdInTz(tz = process.env.WEEKLY_DIGEST_TZ || 'Europe/London') {
    const d = new Date();
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(d);
    } catch {
        return (
            d.getFullYear() +
            '-' +
            String(d.getMonth() + 1).padStart(2, '0') +
            '-' +
            String(d.getDate()).padStart(2, '0')
        );
    }
}

/** Latest date_sent (YYYY-MM-DD) allowed: at least 2 full calendar months ago. */
function earliestEligibleDateSentYmd(tz) {
    const today = todayYmdInTz(tz);
    const [y, m, d] = today.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setMonth(dt.getMonth() - 2);
    return (
        dt.getFullYear() +
        '-' +
        String(dt.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(dt.getDate()).padStart(2, '0')
    );
}

function normalizeDateSentYmd(raw) {
    const s = String(raw || '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    return s;
}

/** Client may enquire only if date_sent is on or before (today − 2 months). */
function isDateSentEligible(dateSentYmd, tz) {
    const sent = normalizeDateSentYmd(dateSentYmd);
    if (!sent) return { ok: false, error: 'Enter the date you sent this to ReturnPal (YYYY-MM-DD).' };
    const today = todayYmdInTz(tz);
    if (sent > today) {
        return { ok: false, error: 'Send date cannot be in the future.' };
    }
    const cutoff = earliestEligibleDateSentYmd(tz);
    if (sent > cutoff) {
        return {
            ok: false,
            error: `You can only enquire about items sent at least 2 months ago. Earliest eligible send date: ${cutoff}.`,
            earliest_eligible: cutoff,
        };
    }
    return { ok: true, date_sent: sent, earliest_eligible: cutoff };
}

function mapEnquiryRow(row) {
    if (!row) return row;
    return {
        ...row,
        quantity: Number(row.quantity) || 1,
        linked_sold_item_id: row.linked_sold_item_id != null ? Number(row.linked_sold_item_id) : null,
    };
}

function insertSoldItemFromEnquiry(db, userId, enquiry, { earnings, sold_date, order_number }) {
    const qty = Number(enquiry.quantity) || 1;
    const earningsNum = Number(earnings);
    if (!Number.isFinite(earningsNum) || earningsNum < 0) {
        throw new Error('Earnings amount is required when recording a sale.');
    }
    const product = String(enquiry.item_name || '').trim();
    if (!product) throw new Error('Item name missing on enquiry.');
    const ref = String(enquiry.tracking_number || enquiry.package_reference || '').trim();
    const p = earningsNum;
    const total = earningsNum;
    const u = qty ? earningsNum / qty : earningsNum;
    const soldRaw = sold_date != null && String(sold_date).trim() !== '' ? String(sold_date).trim() : null;
    const soldNorm = soldRaw ? normalizeSoldDateForDb(soldRaw) : null;
    const soldDateStr = soldNorm != null ? soldNorm : soldRaw;
    const onum = order_number != null ? String(order_number).trim().slice(0, 200) : '';

    db.run(
        `INSERT INTO sold_items (user_id, reference, product, quantity, unit_price, total_revenue, profit, margin, sold_date, order_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, COALESCE(?, datetime('now')), ?)`,
        [userId, ref, product, qty, u, total, p, soldDateStr, onum]
    );
    const id = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
    return { soldItemId: id, amount: earningsNum };
}

module.exports = {
    STATUSES,
    OUTCOMES,
    todayYmdInTz,
    earliestEligibleDateSentYmd,
    isDateSentEligible,
    normalizeDateSentYmd,
    mapEnquiryRow,
    insertSoldItemFromEnquiry,
    parseResults,
};
