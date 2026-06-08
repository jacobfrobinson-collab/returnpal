'use strict';

const { parseClientPreferences } = require('./clientPreferences');

const STALE_PACKAGE_DAYS = Number(process.env.STALE_PACKAGE_DAYS) || 14;

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

function daysSince(dateStr) {
    if (!dateStr) return 0;
    const d = new Date(String(dateStr).replace(' ', 'T'));
    if (isNaN(d.getTime())) return 0;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @returns {Array<{ type: string, href: string, text: string, priority: number }>}
 */
function getClientActionItems(db, userId) {
    const items = [];

    const prefsRow = parseResults(
        db.exec(
            `SELECT client_preferences, COALESCE(payout_details_on_file, 0) AS payout_details_on_file
             FROM users WHERE id = ?`,
            [userId]
        )
    );
    const prefs = parseClientPreferences(prefsRow[0]?.client_preferences || '');
    const payoutOnFile =
        prefsRow[0]?.payout_details_on_file === 1 || prefsRow[0]?.payout_details_on_file === '1';

    const queries = parseResults(
        db.exec(
            `SELECT id, status, last_sender FROM item_queries
             WHERE user_id = ? AND status = 'open'`,
            [userId]
        )
    );
    const awaitingReply = queries.filter(
        (q) => String(q.last_sender || '') === 'admin'
    );
    if (awaitingReply.length) {
        items.push({
            type: 'query_reply',
            href: 'queries.html',
            text:
                awaitingReply.length === 1
                    ? 'ReturnPal replied to your query — read and follow up'
                    : awaitingReply.length + ' queries have replies from ReturnPal',
            priority: 1,
        });
    }

    const pendingLost = parseResults(
        db.exec(
            `SELECT COUNT(*) AS c FROM lost_item_enquiries WHERE user_id = ? AND status = 'pending'`,
            [userId]
        )
    );
    const lostCount = pendingLost[0]?.c || 0;
    if (lostCount > 0) {
        items.push({
            type: 'lost_items',
            href: 'lost-items.html',
            text:
                lostCount +
                ' missing-item ' +
                (lostCount === 1 ? 'enquiry' : 'enquiries') +
                ' under review',
            priority: 3,
        });
    }

    const readyClaims = parseResults(
        db.exec(
            `SELECT id FROM reimbursement_claims WHERE user_id = ? AND case_status = 'ready'`,
            [userId]
        )
    );
    if (readyClaims.length) {
        items.push({
            type: 'reimbursement_ready',
            href: 'reimbursement.html',
            text:
                readyClaims.length +
                ' reimbursement ' +
                (readyClaims.length === 1 ? 'claim is' : 'claims are') +
                ' ready to file in Seller Central',
            priority: 2,
        });
    }

    if (!payoutOnFile) {
        items.push({
            type: 'payout_bank',
            href: 'invoices.html',
            text: 'Add bank transfer details for payouts',
            priority: 3,
        });
    }

    const billingName = String(prefs.billing_name || '').trim();
    const billingAddr = String(prefs.billing_address || '').trim();
    if (!billingName || !billingAddr) {
        items.push({
            type: 'billing',
            href: 'settings.html',
            text: 'Add invoice billing details in Settings (name and address for statements)',
            priority: 4,
        });
    }

    const stalePackages = parseResults(
        db.exec(
            `SELECT id, reference, date_added FROM packages
             WHERE user_id = ? AND status = 'In Transit'
             AND date_added <= datetime('now', ?)`,
            [userId, '-' + STALE_PACKAGE_DAYS + ' days']
        )
    );
    for (const pkg of stalePackages) {
        const days = daysSince(pkg.date_added);
        items.push({
            type: 'stale_package',
            href: 'packages.html',
            text:
                'Package ' +
                (pkg.reference || '#' + pkg.id) +
                ' sent ' +
                days +
                ' days ago — not yet received',
            priority: 5,
            package_id: pkg.id,
        });
    }

    items.sort((a, b) => a.priority - b.priority);
    return items;
}

module.exports = { getClientActionItems, STALE_PACKAGE_DAYS };
