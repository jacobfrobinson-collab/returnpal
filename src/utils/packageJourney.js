/**
 * Package journey timeline — aggregate milestones for a package reference.
 */

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
 * @param {number} packageId
 * @param {string} reference
 */
function buildPackageJourney(db, userId, packageId, reference) {
    const ref = String(reference || '').trim();
    const events = [];

    const pkgs = parseResults(
        db.exec('SELECT * FROM packages WHERE id = ? AND user_id = ?', [packageId, userId])
    );
    const pkg = pkgs[0];
    if (!pkg) return { reference: ref, events: [] };

    events.push({
        stage: 'sent',
        label: 'Package sent',
        message: 'Shipment logged with ReturnPal (' + (pkg.status || 'In Transit') + ').',
        timestamp: pkg.date_added || null,
        icon: 'ri-send-plane-line',
    });

    if (pkg.status === 'Delivered' || pkg.status === 'Processed') {
        events.push({
            stage: 'delivered',
            label: 'Delivered',
            message: 'Package received at ReturnPal facility.',
            timestamp: pkg.date_added || null,
            icon: 'ri-inbox-archive-line',
        });
    }

    const received = parseResults(
        db.exec(
            `SELECT * FROM received_items WHERE user_id = ? AND reference = ? ORDER BY date_received ASC`,
            [userId, ref]
        )
    );
    received.forEach((r) => {
        events.push({
            stage: 'received',
            label: 'Check-in',
            message: 'Received: ' + (r.items_description || r.reference || 'Item') + ' (' + (r.status || 'Processing') + ').',
            timestamp: r.date_received || null,
            icon: 'ri-import-line',
        });
    });

    const pending = parseResults(
        db.exec(
            `SELECT * FROM pending_items WHERE user_id = ? AND reference = ? ORDER BY received_date ASC`,
            [userId, ref]
        )
    );
    pending.forEach((p) => {
        events.push({
            stage: 'processing',
            label: 'Processing',
            message: (p.product || 'Item') + ' — ' + (p.current_stage || 'In progress') + '.',
            timestamp: p.received_date || null,
            icon: 'ri-time-line',
        });
    });

    const sold = parseResults(
        db.exec(
            `SELECT * FROM sold_items WHERE user_id = ? AND reference = ? ORDER BY sold_date ASC`,
            [userId, ref]
        )
    );
    sold.forEach((s) => {
        const profit = Number(s.profit);
        events.push({
            stage: 'sold',
            label: 'Sold',
            message:
                (s.product || 'Item') +
                ' sold' +
                (Number.isFinite(profit) ? ' · £' + profit.toFixed(2) + ' profit' : '') +
                '.',
            timestamp: s.sold_date || null,
            icon: 'ri-money-pound-circle-line',
        });
    });

    const claims = parseResults(
        db.exec(
            `SELECT * FROM reimbursement_claims WHERE user_id = ? AND package_reference = ? ORDER BY created_at ASC`,
            [userId, ref]
        )
    );
    claims.forEach((c) => {
        const st = String(c.case_status || 'draft');
        const recovered = Number(c.recovered_amount);
        let msg = 'Reimbursement claim: ' + (c.reimbursement_type || 'Claim') + ' (' + st + ').';
        if (Number.isFinite(recovered) && recovered > 0) msg += ' Recovered £' + recovered.toFixed(2) + '.';
        events.push({
            stage: 'reimbursement',
            label: 'Reimbursement',
            message: msg,
            timestamp: c.resolved_at || c.submitted_at || c.created_at || null,
            icon: 'ri-refund-line',
        });
    });

    const acts = parseResults(
        db.exec(
            `SELECT * FROM activities WHERE user_id = ? AND (message LIKE ? OR link LIKE ?) ORDER BY created_at ASC LIMIT 20`,
            [userId, '%' + ref + '%', '%' + ref + '%']
        )
    );
    acts.forEach((a) => {
        events.push({
            stage: 'activity',
            label: 'Update',
            message: a.message || 'Activity',
            timestamp: a.created_at || null,
            icon: 'ri-notification-3-line',
        });
    });

    events.sort((a, b) => {
        const ta = a.timestamp ? new Date(String(a.timestamp).replace(/-/g, '/')).getTime() : 0;
        const tb = b.timestamp ? new Date(String(b.timestamp).replace(/-/g, '/')).getTime() : 0;
        return ta - tb;
    });

    const deduped = [];
    const seen = new Set();
    for (const e of events) {
        const key = e.stage + '|' + e.message;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(e);
    }

    return {
        package_id: packageId,
        reference: ref,
        current_status: pkg.status || '',
        events: deduped,
    };
}

module.exports = { buildPackageJourney };
