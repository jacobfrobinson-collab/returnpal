/**
 * Client hub / delegate access — prep-centre owners viewing linked client accounts.
 */

const { getPartnerClientStatus } = require('./partnerClientStatus');

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

module.exports = {
    hubCanAccessClient,
    countLinkedClients,
    listLinkedClients,
    listHubsForClient,
    setHubLinksForClient,
    setClientLinksForHub,
    listHubAccountsSummary,
    getHubOverview,
};
