/**
 * Payout forecast for client dashboard (computed statements + pipeline hint).
 */

const { getComputedMonthlyStatements } = require('./computedMonthlyStatements');
const { getUserVatRegistered } = require('./computedMonthlyStatements');

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
 */
function getPayoutForecast(db, userId) {
    const { invoices, statement_period_cap_ym } = getComputedMonthlyStatements(db, userId);
    const vatRegistered = getUserVatRegistered(db, userId);

    const schedule = invoices.slice(0, 12).map((inv) => ({
        period: inv.period,
        period_label: inv.period_label,
        amount: Number(inv.amount) || 0,
        status: inv.status,
        due_date: inv.due_date,
        date_issued: inv.date_issued,
        items_count: inv.items_count,
        vat_registered: !!inv.vat_registered,
    }));

    const pending = invoices.filter((i) => i.status === 'Pending');
    const nextPayout =
        pending.length > 0
            ? pending.sort((a, b) => String(a.due_date || '').localeCompare(String(b.due_date || '')))[0]
            : null;

    const pendingPipeline = parseResults(
        db.exec('SELECT COUNT(*) AS c FROM pending_items WHERE user_id = ?', [userId])
    );
    const pipelinePendingCount = Number(pendingPipeline[0]?.c) || 0;

    return {
        vat_registered: vatRegistered,
        statement_period_cap_ym,
        next_payout: nextPayout
            ? {
                  period: nextPayout.period,
                  amount: nextPayout.amount,
                  due_date: nextPayout.due_date,
                  status: nextPayout.status,
              }
            : null,
        unpaid_total: Math.round(pending.reduce((s, i) => s + (Number(i.amount) || 0), 0) * 100) / 100,
        unpaid_count: pending.length,
        pipeline_pending_count: pipelinePendingCount,
        pipeline_pending_profit: 0,
        schedule,
    };
}

module.exports = { getPayoutForecast };
