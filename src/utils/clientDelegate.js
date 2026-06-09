/**
 * Client hub / delegate access — prep-centre owners viewing linked client accounts.
 */

const { getPartnerClientStatus } = require('./partnerClientStatus');
const { calendarYearMonthFromDbDate } = require('./soldDateCalendar');

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

function hubCanAccessClient(db, hubUserId, clientUserId) {
    const hubId = parseInt(hubUserId, 10);
    const clientId = parseInt(clientUserId, 10);
    if (!Number.isFinite(hubId) || !Number.isFinite(clientId) || hubId === clientId) return false;
    const rows = parseResults(
        db.exec(
            'SELECT 1 AS ok FROM client_delegate_access WHERE hub_user_id = ? AND client_user_id = ? LIMIT 1',
            [hubId, clientId]
        )
    );
    return rows.length > 0;
}

function countLinkedClients(db, hubUserId) {
    const rows = parseResults(
        db.exec('SELECT COUNT(*) AS c FROM client_delegate_access WHERE hub_user_id = ?', [hubUserId])
    );
    return rows[0]?.c || 0;
}

function listLinkedClients(db, hubUserId) {
    return parseResults(
        db.exec(
            `SELECT u.id, u.email, u.full_name, u.company_name, COALESCE(u.legacy_client_id, '') AS legacy_client_id
             FROM client_delegate_access cda
             JOIN users u ON u.id = cda.client_user_id
             WHERE cda.hub_user_id = ?
             ORDER BY u.full_name, u.company_name, u.email`,
            [hubUserId]
        )
    );
}

function listHubsForClient(db, clientUserId) {
    return parseResults(
        db.exec(
            `SELECT u.id, u.email, u.full_name, u.company_name
             FROM client_delegate_access cda
             JOIN users u ON u.id = cda.hub_user_id
             WHERE cda.client_user_id = ?
             ORDER BY u.full_name, u.company_name, u.email`,
            [clientUserId]
        )
    );
}

function setHubLinksForClient(db, clientUserId, hubUserIds) {
    const clientId = parseInt(clientUserId, 10);
    if (!Number.isFinite(clientId)) return;
    const hubs = [...new Set(hubUserIds.map((x) => parseInt(x, 10)).filter((id) => Number.isFinite(id) && id > 0 && id !== clientId))];
    db.run('DELETE FROM client_delegate_access WHERE client_user_id = ?', [clientId]);
    for (const hubId of hubs) {
        db.run('INSERT OR IGNORE INTO client_delegate_access (hub_user_id, client_user_id) VALUES (?, ?)', [
            hubId,
            clientId,
        ]);
    }
}

function setClientLinksForHub(db, hubUserId, clientUserIds) {
    const hubId = parseInt(hubUserId, 10);
    if (!Number.isFinite(hubId)) return;
    const clients = [...new Set(clientUserIds.map((x) => parseInt(x, 10)).filter((id) => Number.isFinite(id) && id > 0 && id !== hubId))];
    db.run('DELETE FROM client_delegate_access WHERE hub_user_id = ?', [hubId]);
    for (const clientId of clients) {
        db.run('INSERT OR IGNORE INTO client_delegate_access (hub_user_id, client_user_id) VALUES (?, ?)', [
            hubId,
            clientId,
        ]);
    }
}

function listHubAccountsSummary(db) {
    return parseResults(
        db.exec(
            `SELECT u.id AS hub_user_id, u.email, u.full_name, u.company_name,
                    COUNT(cda.client_user_id) AS linked_clients_count
             FROM client_delegate_access cda
             JOIN users u ON u.id = cda.hub_user_id
             GROUP BY cda.hub_user_id
             ORDER BY u.full_name, u.company_name, u.email`
        )
    );
}

function getHubOverview(db, hubUserId) {
    const clients = listLinkedClients(db, hubUserId);
    const summaries = clients.map((c) => {
        const status = getPartnerClientStatus(db, c.id) || {};
        return {
            client_id: c.id,
            client_code: 'RP' + c.id,
            name: c.full_name || c.company_name || c.email,
            email: c.email,
            legacy_client_id: c.legacy_client_id || '',
            packages_total: status.packages_total || 0,
            items_processing: status.items_processing || 0,
            reimbursement_claims_open: status.reimbursement_claims_open || 0,
            recovery_total: status.recovery_total || 0,
            payout_pending: status.payout_pending || 0,
            payout_status: status.payout_status || '',
            unpaid_invoices_count: status.unpaid_invoices_count || 0,
        };
    });
    const totals = summaries.reduce(
        (acc, s) => {
            acc.packages_total += s.packages_total;
            acc.items_processing += s.items_processing;
            acc.reimbursement_claims_open += s.reimbursement_claims_open;
            acc.recovery_total += s.recovery_total;
            acc.payout_pending += s.payout_pending;
            return acc;
        },
        {
            packages_total: 0,
            items_processing: 0,
            reimbursement_claims_open: 0,
            recovery_total: 0,
            payout_pending: 0,
        }
    );
    return { clients: summaries, totals, client_count: summaries.length };
}

/**
 * Combined monthly client earnings (profit) across all linked hub clients.
 * @param {import('sql.js').Database} db
 * @param {number} hubUserId
 */
function getHubMonthlySales(db, hubUserId) {
    const clients = listLinkedClients(db, hubUserId);
    if (!clients.length) {
        return { months: [], client_count: 0, grand_total: 0 };
    }

    const clientMeta = new Map();
    for (const c of clients) {
        clientMeta.set(c.id, {
            client_id: c.id,
            name: c.full_name || c.company_name || c.email,
            legacy_client_id: c.legacy_client_id || '',
            client_code: 'RP' + c.id,
        });
    }

    const ids = clients.map((c) => c.id);
    const placeholders = ids.map(() => '?').join(',');
    const soldRows = parseResults(
        db.exec(
            `SELECT user_id, sold_date, profit, quantity
             FROM sold_items WHERE user_id IN (${placeholders})`,
            ids
        )
    );

    const monthMap = new Map();
    let grandTotal = 0;

    for (const row of soldRows) {
        const period = calendarYearMonthFromDbDate(row.sold_date);
        if (!period) continue;
        const profit = Number(row.profit) || 0;
        const qty = Number(row.quantity) > 0 ? Number(row.quantity) : 1;

        if (!monthMap.has(period)) {
            monthMap.set(period, { profit_total: 0, item_count: 0, byClient: new Map() });
        }
        const m = monthMap.get(period);
        m.profit_total += profit;
        m.item_count += qty;
        grandTotal += profit;

        const uid = Number(row.user_id);
        if (!m.byClient.has(uid)) {
            m.byClient.set(uid, { profit: 0, item_count: 0 });
        }
        const bc = m.byClient.get(uid);
        bc.profit += profit;
        bc.item_count += qty;
    }

    const round2 = (n) => Math.round(n * 100) / 100;

    const months = [...monthMap.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([period, data]) => {
            const by_client = [...data.byClient.entries()]
                .map(([clientId, stats]) => {
                    const meta = clientMeta.get(clientId) || {
                        client_id: clientId,
                        name: 'Client ' + clientId,
                        legacy_client_id: '',
                        client_code: 'RP' + clientId,
                    };
                    return {
                        client_id: meta.client_id,
                        name: meta.name,
                        legacy_client_id: meta.legacy_client_id,
                        client_code: meta.client_code,
                        profit: round2(stats.profit),
                        item_count: stats.item_count,
                    };
                })
                .sort((a, b) => b.profit - a.profit);

            return {
                period,
                profit_total: round2(data.profit_total),
                item_count: data.item_count,
                clients_with_sales: by_client.length,
                by_client,
            };
        });

    return {
        client_count: clients.length,
        months,
        grand_total: round2(grandTotal),
    };
}

module.exports = {
    hubCanAccessClient,
    countLinkedClients,
    listLinkedClients,
    listHubsForClient,
    setHubLinksForClient,
    setClientLinksForHub,
    listHubAccountsSummary,
    getHubOverview,
    getHubMonthlySales,
};
