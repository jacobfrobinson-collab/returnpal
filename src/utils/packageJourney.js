/**
 * Package journey timeline — aggregate milestones for a package reference.
 */

const { clientStatusFromStage } = require('./clientStockStatus');

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

function sortAndDedupeEvents(events) {
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
    return deduped;
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {string} reference
 * @param {{ clientFacing?: boolean, focusPendingId?: number, packageId?: number }} [opts]
 */
function buildReferenceJourney(db, userId, reference, opts = {}) {
    const ref = String(reference || '').trim();
    const events = [];
    const clientFacing = !!opts.clientFacing;
    const focusPendingId =
        opts.focusPendingId != null && !Number.isNaN(Number(opts.focusPendingId))
            ? Number(opts.focusPendingId)
            : null;

    let pkg = null;
    if (opts.packageId) {
        pkg = parseResults(
            db.exec('SELECT * FROM packages WHERE id = ? AND user_id = ?', [opts.packageId, userId])
        )[0];
    } else if (ref) {
        pkg = parseResults(
            db.exec(
                'SELECT * FROM packages WHERE user_id = ? AND reference = ? ORDER BY id DESC LIMIT 1',
                [userId, ref]
            )
        )[0];
    }

    if (pkg) {
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
    }

    if (ref) {
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
                message:
                    'Received: ' +
                    (r.items_description || r.reference || 'Item') +
                    ' (' +
                    (r.status || 'Processing') +
                    ').',
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
            const statusMsg = clientFacing
                ? clientStatusFromStage(p.current_stage).label
                : p.current_stage || 'In progress';
            const ev = {
                stage: 'processing',
                label: clientFacing ? 'Your stock' : 'Processing',
                message: (p.product || 'Item') + ' — ' + statusMsg + '.',
                timestamp: p.received_date || null,
                icon: 'ri-time-line',
                pending_id: p.id,
            };
            if (focusPendingId != null && Number(p.id) === focusPendingId) {
                ev.focus_pending_id = true;
            }
            events.push(ev);
        });

        const sold = parseResults(
            db.exec(
                `SELECT * FROM sold_items WHERE user_id = ? AND reference = ? ORDER BY sold_date ASC`,
                [userId, ref]
            )
        );
        sold.forEach((s) => {
            const profit = Number(s.profit);
            const st = String(s.match_status || '').trim();
            let matchNote = '';
            if (s.received_item_id && (st === 'linked' || st === 'manual')) {
                matchNote = ' · Matched to your checked-in stock';
            } else if (st === 'pending_review' || !st) {
                matchNote = ' · Matching to received line in progress';
            }
            events.push({
                stage: 'sold',
                label: 'Sold',
                message:
                    (s.product || 'Item') +
                    ' sold' +
                    (Number.isFinite(profit) ? ' · £' + profit.toFixed(2) + ' your share' : '') +
                    matchNote +
                    '.',
                timestamp: s.sold_date || null,
                icon: 'ri-money-pound-circle-line',
                sold_item_id: s.id,
                received_item_id: s.received_item_id || null,
                match_status: st || null,
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
    }

    return {
        reference: ref,
        package_id: pkg ? pkg.id : null,
        current_status: pkg ? pkg.status || '' : '',
        events: sortAndDedupeEvents(events),
    };
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {number} packageId
 * @param {string} reference
 */
function buildPackageJourney(db, userId, packageId, reference) {
    const ref = String(reference || '').trim();
    const pkgs = parseResults(
        db.exec('SELECT * FROM packages WHERE id = ? AND user_id = ?', [packageId, userId])
    );
    const pkg = pkgs[0];
    if (!pkg) return { reference: ref, events: [] };

    const journey = buildReferenceJourney(db, userId, ref, { packageId: pkg.id });
    return {
        package_id: packageId,
        reference: ref,
        current_status: pkg.status || '',
        events: journey.events,
    };
}

module.exports = { buildPackageJourney, buildReferenceJourney };
