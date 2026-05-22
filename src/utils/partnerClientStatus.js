/**
 * Aggregated client status for partner B2B API / embed.
 */

const { getComputedDashboardInvoiceAggregates } = require('./computedMonthlyStatements');
const { getRecoveryScorecard } = require('./recoveryScorecard');

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
function getPartnerClientStatus(db, userId) {
    const userRows = parseResults(
        db.exec(
            `SELECT id, email, full_name, company_name, COALESCE(legacy_client_id, '') AS legacy_client_id
             FROM users WHERE id = ?`,
            [userId]
        )
    );
    if (!userRows.length) return null;
    const u = userRows[0];

    const packages = parseResults(db.exec('SELECT COUNT(*) AS c FROM packages WHERE user_id = ?', [userId]));
    const pending = parseResults(db.exec('SELECT COUNT(*) AS c FROM pending_items WHERE user_id = ?', [userId]));
    const claimsOpen = parseResults(
        db.exec(
            `SELECT COUNT(*) AS c FROM reimbursement_claims WHERE user_id = ? AND case_status IN ('draft','ready','submitted')`,
            [userId]
        )
    );

    const invAgg = getComputedDashboardInvoiceAggregates(db, userId);
    const scorecard = getRecoveryScorecard(db, userId);

    return {
        client_id: u.id,
        client_code: 'RP' + u.id,
        name: u.full_name || u.company_name || u.email,
        email: u.email,
        legacy_client_id: u.legacy_client_id || '',
        packages_total: packages[0]?.c || 0,
        items_processing: pending[0]?.c || 0,
        reimbursement_claims_open: claimsOpen[0]?.c || 0,
        unpaid_invoices_count: invAgg.unpaid_invoices_count,
        unpaid_invoices_total: invAgg.unpaid_invoices_total,
        latest_payout: invAgg.latest_payout,
        scorecard_period: scorecard.period,
        recovery_total: scorecard.recovery.total_recovered,
        payout_pending: scorecard.payout.amount,
        payout_status: scorecard.payout.status,
        updated_at: new Date().toISOString(),
    };
}

module.exports = { getPartnerClientStatus };
