/**
 * Monthly recovery scorecard for client dashboard.
 */

const { getComputedMonthlyStatements } = require('./computedMonthlyStatements');

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

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {string} [periodYm] YYYY-MM — defaults to latest invoiced month
 */
function getRecoveryScorecard(db, userId, periodYm) {
    const { invoices } = getComputedMonthlyStatements(db, userId);
    let period = periodYm;
    if (!period && invoices.length) period = invoices[0].period;
    if (!period) {
        const now = new Date();
        period = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    }

    const inv = invoices.find((i) => i.period === period) || null;

    const soldRows = parseResults(
        db.exec(
            `SELECT COALESCE(SUM(profit), 0) AS profit, COALESCE(SUM(total_revenue), 0) AS revenue, COUNT(*) AS c
             FROM sold_items WHERE user_id = ? AND sold_date LIKE ?`,
            [userId, period + '%']
        )
    );
    const soldProfit = Number(soldRows[0]?.profit) || 0;
    const soldCount = soldRows[0]?.c || 0;

    const reimbRows = parseResults(
        db.exec(
            `SELECT COALESCE(SUM(recovered_amount), 0) AS total, COUNT(*) AS c
             FROM reimbursement_claims WHERE user_id = ? AND (
                created_at LIKE ? OR submitted_at LIKE ? OR resolved_at LIKE ?
             )`,
            [userId, period + '%', period + '%', period + '%']
        )
    );
    const reimbRecovered = Number(reimbRows[0]?.total) || 0;
    const reimbCount = reimbRows[0]?.c || 0;

    const pendingClaims = parseResults(
        db.exec(
            `SELECT COUNT(*) AS c FROM reimbursement_claims WHERE user_id = ? AND case_status IN ('draft','ready','submitted')`,
            [userId]
        )
    );

    const pipeline = parseResults(
        db.exec('SELECT COUNT(*) AS c FROM pending_items WHERE user_id = ?', [userId])
    );

    const openQueries = parseResults(
        db.exec(`SELECT COUNT(*) AS c FROM item_queries WHERE user_id = ? AND status = 'open'`, [userId])
    );

    const payoutAmount = inv ? Number(inv.amount) || 0 : 0;
    const resaleRecovered = Math.round(soldProfit * 100) / 100;
    const reimbursementRecovered = Math.round(reimbRecovered * 100) / 100;
    const totalRecovered = Math.round((resaleRecovered + reimbursementRecovered) * 100) / 100;

    const prevIdx = invoices.findIndex((i) => i.period === period);
    const prev = prevIdx >= 0 && invoices[prevIdx + 1] ? invoices[prevIdx + 1] : null;
    const prevPayout = prev ? Number(prev.amount) || 0 : null;
    const payoutDelta =
        prevPayout != null ? Math.round((payoutAmount - prevPayout) * 100) / 100 : null;

    return {
        period,
        period_label: inv?.period_label || period,
        payout: {
            amount: payoutAmount,
            status: inv?.status || '—',
            due_date: inv?.due_date || null,
            items_count: inv?.items_count || soldCount,
            delta_vs_prior_month: payoutDelta,
        },
        recovery: {
            total_recovered: totalRecovered,
            resale_profit: resaleRecovered,
            reimbursement_recovered: reimbursementRecovered,
            items_sold: soldCount,
            reimbursement_claims_closed: reimbCount,
        },
        pipeline: {
            items_processing: pipeline[0]?.c || 0,
            reimbursement_claims_open: pendingClaims[0]?.c || 0,
            open_queries: openQueries[0]?.c || 0,
        },
        available_periods: invoices.slice(0, 24).map((i) => ({
            period: i.period,
            amount: i.amount,
            status: i.status,
        })),
    };
}

module.exports = { getRecoveryScorecard };
