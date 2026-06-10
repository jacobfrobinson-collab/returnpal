const express = require('express');
const { getDb, saveDb, pushActivity } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { computeMonthlyFreeProcessing } = require('../utils/monthlyFreeProcessing');
const { clientIsAdmin, redactOrderNumberForClientRow, redactOrderNumberForClientRows } = require('../utils/internalFields');
const { normalizeSoldDateForDb } = require('../utils/adminBulkImport');
const { mapSoldItemDatesForApi } = require('../utils/soldDateDisplayRepair');
const { soldDatesCanonicalStorage } = require('../utils/soldDateStorageMode');
const { sortSoldItemsByDateDesc } = require('../utils/sortSoldItemsByDateDesc');
const {
    buildClawbackContext,
    clientClawbackMapForAdjustments,
    clientClawbackFromContext,
    roundMoney,
} = require('../utils/returnAdjustmentClawback');
const { logClientAudit } = require('../utils/clientAudit');
const { FEE_TIERS } = require('../utils/clientFeeTiers');
const { computeClientResaleNetEarnings } = require('../utils/clientNetEarnings');

const router = express.Router();

function parseResults(result) {
    if (!result || result.length === 0) return [];
    const cols = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        cols.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

function loadAppliedReturnAdjustments(db, userId) {
    return parseResults(
        db.exec(
            `SELECT id, linked_sold_item_id, product, amount, order_number, refund_date, created_at, status
             FROM return_adjustments
             WHERE user_id = ? AND status = 'applied'
             ORDER BY COALESCE(NULLIF(refund_date, ''), created_at), id`,
            [userId]
        )
    );
}

/** Sum of client clawbacks per sold_items.id (not gross eBay refund). */
function computeReturnsBySoldId(appliedReturns, clawbackContext) {
    const clawMap = clientClawbackMapForAdjustments(appliedReturns, clawbackContext);
    const map = Object.create(null);
    for (const r of appliedReturns) {
        if (r.linked_sold_item_id == null) continue;
        const key = String(r.linked_sold_item_id);
        const claw = clawMap.get(r.id) || 0;
        map[key] = roundMoney((map[key] || 0) + claw);
    }
    return map;
}

function computeLinkedReturnDetailsBySoldId(appliedReturns, clawbackContext) {
    const clawMap = clientClawbackMapForAdjustments(appliedReturns, clawbackContext);
    const map = Object.create(null);
    for (const r of appliedReturns) {
        if (r.linked_sold_item_id == null) continue;
        const key = String(r.linked_sold_item_id);
        if (!map[key]) map[key] = [];
        const gross = Number(r.amount) || 0;
        const claw = clawMap.get(r.id) || clientClawbackFromContext(r, clawbackContext, clawMap);
        map[key].push({
            id: r.id,
            product: r.product,
            amount: gross,
            client_clawback: claw,
            order_number: r.order_number,
            refund_date: r.refund_date,
        });
    }
    for (const key of Object.keys(map)) {
        map[key].sort((a, b) => String(b.refund_date || '').localeCompare(String(a.refund_date || '')));
    }
    return map;
}

function totalAppliedClawback(appliedReturns, clawbackContext) {
    const clawMap = clientClawbackMapForAdjustments(appliedReturns, clawbackContext);
    let total = 0;
    for (const r of appliedReturns) {
        total += clawMap.get(r.id) || clientClawbackFromContext(r, clawbackContext, clawMap);
    }
    return roundMoney(total);
}

// GET /api/sold/returns — list refund/return adjustments (define before /:id routes)
router.get('/returns', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const rows = parseResults(
            db.exec(
                `SELECT r.id, r.product, r.reference, r.amount, r.status, r.notes, r.created_at, r.refund_date,
                        r.order_number, r.linked_sold_item_id, s.product AS sold_product, s.sold_date
                 FROM return_adjustments r
                 LEFT JOIN sold_items s ON s.id = r.linked_sold_item_id
                 WHERE r.user_id = ?
                 ORDER BY COALESCE(NULLIF(r.refund_date, ''), r.created_at) DESC, r.id DESC`,
                [req.user.id]
            )
        );
        const { mapReturnAdjustmentRowForApi } = require('../utils/returnAdjustmentDateDisplay');
        const allSold = parseResults(db.exec('SELECT * FROM sold_items WHERE user_id = ?', [req.user.id]));
        const clawbackContext = buildClawbackContext(db, req.user.id, allSold);
        const clawMap = clientClawbackMapForAdjustments(rows, clawbackContext);
        let items = clientIsAdmin(req) ? rows : redactOrderNumberForClientRows(rows);
        let datesFixed = 0;
        items = items.map((r) => {
            const before = String(r.refund_date || '').trim();
            const out = mapReturnAdjustmentRowForApi(db, r);
            if (out.refund_date && out.refund_date !== before) datesFixed++;
            const gross = Number(out.amount) || 0;
            const claw = clawMap.get(out.id) || clientClawbackFromContext(out, clawbackContext, clawMap);
            out.client_clawback = claw;
            out.gross_refund = gross;
            return out;
        });
        if (datesFixed) saveDb();
        res.json({ items, total: items.length });
    } catch (err) {
        console.error('Get sold returns error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/sold - List sold items with summary stats
router.get('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        let items = parseResults(
            db.exec('SELECT * FROM sold_items WHERE user_id = ? ORDER BY id DESC', [req.user.id])
        );
        items = sortSoldItemsByDateDesc(items);

        const appliedReturns = loadAppliedReturnAdjustments(db, req.user.id);
        const clawbackContext = buildClawbackContext(db, req.user.id, items);
        const returnsBySold = computeReturnsBySoldId(appliedReturns, clawbackContext);
        const linkedReturnDetails = computeLinkedReturnDetailsBySoldId(appliedReturns, clawbackContext);

        const earnings = computeClientResaleNetEarnings(db, req.user.id);
        const marginResult = parseResults(
            db.exec(
                `SELECT COALESCE(AVG(margin), 0) as avg_margin FROM sold_items WHERE user_id = ?`,
                [req.user.id]
            )
        );
        const stats = {
            total_earnings: earnings.gross_profit,
            items_sold: earnings.items_sold,
            avg_earnings: earnings.items_sold > 0 ? earnings.gross_profit / earnings.items_sold : 0,
            avg_margin: marginResult[0]?.avg_margin || 0,
            total_returns_applied: earnings.returns_applied,
            net_earnings_after_returns: earnings.net_earnings_after_returns,
            avg_earnings_net: earnings.avg_earnings_net,
        };

        const receivedRows = parseResults(
            db.exec('SELECT id, items_description, reference, package_id FROM received_items WHERE user_id = ?', [
                req.user.id,
            ])
        );
        const receivedById = new Map(receivedRows.map((r) => [r.id, r]));

        const promo = computeMonthlyFreeProcessing(items);
        const itemsWithPromo = items.map((row) => {
            const w = promo.winner_by_item_id[String(row.id)];
            const ret = returnsBySold[String(row.id)] || 0;
            const profit = Number(row.profit) || 0;
            const linkedAdj = linkedReturnDetails[String(row.id)] || [];
            const grossRefunds = linkedAdj.reduce((s, a) => s + (Number(a.amount) || 0), 0);
            const dates = mapSoldItemDatesForApi(row.sold_date, normalizeSoldDateForDb);
            const rec = row.received_item_id ? receivedById.get(row.received_item_id) : null;
            const matchSt = String(row.match_status || '').trim();
            return {
                ...row,
                sold_date_stored: dates.stored,
                sold_date: dates.iso || row.sold_date,
                sold_date_display: dates.iso || row.sold_date,
                sold_date_label: dates.label,
                is_monthly_free_processing: !!w,
                monthly_free_processing_month: w ? w.year_month : null,
                returns_deducted: ret,
                net_after_returns: roundMoney(profit - ret),
                linked_return_adjustments: linkedAdj,
                returns_exceed_sale: grossRefunds > profit + 0.01,
                received_description: rec ? rec.items_description : null,
                matched_package_id: rec ? rec.package_id : null,
                matched_reference: rec ? rec.reference : row.reference || null,
                match_pending: matchSt === 'pending_review' || !matchSt,
            };
        });

        const outItems = clientIsAdmin(req) ? itemsWithPromo : itemsWithPromo.map((row) => redactOrderNumberForClientRow(row));
        const soldDatesCanonical = soldDatesCanonicalStorage();
        res.json({
            sold_dates_canonical: soldDatesCanonical,
            sold_date_display_version: soldDatesCanonical ? 'calendar-api-label-2026-06d' : 'legacy-ydm-2026-06b',
            items: outItems,
            stats,
            total: items.length,
            monthly_free_processing: {
                fee_percent: promo.fee_percent,
                revenue_interpreted_as_net: promo.revenue_interpreted_as_net,
                months: promo.months
            },
            fee_tiers: FEE_TIERS
        });
    } catch (err) {
        console.error('Get sold items error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/sold (admin can pass user_id to record sale for client)
router.post('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        const { reference, product, quantity, unit_price, total_revenue, profit, margin, user_id, sold_date, earnings, order_number } = req.body;

        let targetUserId = user_id != null ? parseInt(user_id, 10) : req.user.id;
        if (targetUserId !== req.user.id && !req.user.is_admin) {
            return res.status(403).json({ error: 'Only admins can record sales for another user' });
        }
        if (isNaN(targetUserId)) targetUserId = req.user.id;

        if (product == null || String(product).trim() === '') {
            return res.status(400).json({ error: 'Product is required' });
        }

        const qty = quantity || 1;
        const earningsNum = earnings !== undefined && earnings !== null && String(earnings).trim() !== '' ? Number(earnings) : NaN;
        let ref = reference != null ? String(reference).trim() : '';
        let u = unit_price != null ? Number(unit_price) : 0;
        let total = total_revenue != null ? Number(total_revenue) : 0;
        let p = profit != null ? Number(profit) : 0;
        let m = margin != null ? Number(margin) : 0;
        if (Number.isFinite(earningsNum)) {
            p = earningsNum;
            total = earningsNum;
            u = qty ? earningsNum / qty : 0;
            m = 0;
        }
        const soldRaw =
            sold_date != null && String(sold_date).trim() !== '' ? String(sold_date).trim() : null;
        const soldNorm = soldRaw ? normalizeSoldDateForDb(soldRaw) : null;
        const soldDateStr = soldNorm != null ? soldNorm : soldRaw;
        const orderNumber =
            clientIsAdmin(req) && order_number != null && String(order_number).trim() !== ''
                ? String(order_number).trim().slice(0, 200)
                : '';

        db.run(
            `INSERT INTO sold_items (user_id, reference, product, quantity, unit_price, total_revenue, profit, margin, sold_date, order_number)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?)`,
            [targetUserId, ref, product, qty, u || 0, total || 0, p || 0, m || 0, soldDateStr, orderNumber]
        );
        const result = db.exec('SELECT last_insert_rowid() as id');
        const id = result[0].values[0][0];

        try {
            const { applySaleReceivedMatch } = require('../utils/saleReceivedMatch');
            applySaleReceivedMatch(db, id);
        } catch (e) {
            console.error('[sale-received-match]', e.message || e);
        }
        saveDb();

        const amount =
            Number.isFinite(earningsNum)
                ? earningsNum
                : total_revenue != null
                  ? Number(total_revenue)
                  : unit_price != null
                    ? Number(unit_price) * (quantity || 1)
                    : 0;
        const msg = 'Item "' + (product || '') + '" sold for £' + amount.toFixed(2);
        await pushActivity(targetUserId, 'item_sold', msg, '/dashboard/sold-items.html');
        try {
            const { sendItemSoldEmail } = require('../utils/sendTransactionalEmail');
            await sendItemSoldEmail(db, targetUserId, id, product, amount);
        } catch (e) {
            console.error('[email] item sold:', e.message || e);
        }

        if (targetUserId === req.user.id) {
            logClientAudit(db, req, {
                category: 'create',
                action: 'sold_item_create',
                resource: ref || product,
                path: '/api/sold',
                detail: { product, quantity: qty, profit: p },
            });
        }

        res.status(201).json({ message: 'Sold item recorded', id });
    } catch (err) {
        console.error('Create sold item error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

function canAccessSoldRow(db, req, id) {
    const rows = parseResults(db.exec('SELECT * FROM sold_items WHERE id = ?', [id]));
    if (!rows.length) return null;
    const row = rows[0];
    if (row.user_id !== req.user.id && !req.user.is_admin) return false;
    return row;
}

// PUT /api/sold/:id — owner or admin
router.put('/:id', authMiddleware, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const db = await getDb();
        const row = canAccessSoldRow(db, req, id);
        if (row === null) return res.status(404).json({ error: 'Not found' });
        if (row === false) return res.status(403).json({ error: 'Not authorized' });

        const { reference, product, quantity, unit_price, total_revenue, profit, margin, sold_date, earnings, order_number } = req.body;
        if (product != null && String(product).trim() === '') {
            return res.status(400).json({ error: 'Product cannot be empty' });
        }

        const qty = quantity != null ? Math.max(1, parseInt(quantity, 10) || 1) : row.quantity || 1;
        const earningsNum = earnings !== undefined && earnings !== null && String(earnings).trim() !== '' ? Number(earnings) : NaN;

        let ref = reference !== undefined ? String(reference || '').trim() : row.reference;
        let u;
        let total;
        let p;
        let m;
        if (Number.isFinite(earningsNum)) {
            p = earningsNum;
            total = earningsNum;
            u = qty ? earningsNum / qty : 0;
            m = 0;
        } else {
            u = unit_price != null ? Number(unit_price) : row.unit_price;
            total = total_revenue != null ? Number(total_revenue) : row.total_revenue;
            if (!total && u) total = u * qty;
            p = profit != null ? Number(profit) : row.profit;
            m = margin != null ? Number(margin) : row.margin;
        }

        const prod = product != null ? String(product).trim() : row.product;
        let soldDateVal;
        if (sold_date !== undefined) {
            const raw =
                sold_date != null && String(sold_date).trim() !== '' ? String(sold_date).trim() : '';
            if (raw) {
                const n = normalizeSoldDateForDb(raw);
                soldDateVal = n != null ? n : raw;
            } else {
                soldDateVal = row.sold_date;
            }
        } else {
            soldDateVal = row.sold_date;
        }
        const orderUpd =
            clientIsAdmin(req) && Object.prototype.hasOwnProperty.call(req.body, 'order_number')
                ? String(order_number == null ? '' : order_number).trim().slice(0, 200)
                : null;

        if (orderUpd !== null) {
            db.run(
                `UPDATE sold_items SET reference = ?, product = ?, quantity = ?, unit_price = ?, total_revenue = ?, profit = ?, margin = ?, sold_date = ?, order_number = ?
                 WHERE id = ?`,
                [ref, prod, qty, u || 0, total || 0, p || 0, m || 0, soldDateVal, orderUpd, id]
            );
        } else {
            db.run(
                `UPDATE sold_items SET reference = ?, product = ?, quantity = ?, unit_price = ?, total_revenue = ?, profit = ?, margin = ?, sold_date = ?
                 WHERE id = ?`,
                [ref, prod, qty, u || 0, total || 0, p || 0, m || 0, soldDateVal, id]
            );
        }
        saveDb();
        if (row.user_id === req.user.id) {
            logClientAudit(db, req, {
                category: 'update',
                action: 'sold_item_update',
                resource: ref || prod,
                path: '/api/sold/' + id,
                detail: { product: prod, quantity: qty },
            });
        }
        res.json({ message: 'Sold item updated' });
    } catch (err) {
        console.error('Update sold item error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/sold/:id — owner or admin
router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const db = await getDb();
        const row = canAccessSoldRow(db, req, id);
        if (row === null) return res.status(404).json({ error: 'Not found' });
        if (row === false) return res.status(403).json({ error: 'Not authorized' });

        db.run('DELETE FROM sold_items WHERE id = ?', [id]);
        saveDb();
        if (row.user_id === req.user.id) {
            logClientAudit(db, req, {
                category: 'delete',
                action: 'sold_item_delete',
                resource: row.reference || row.product,
                path: '/api/sold/' + id,
            });
        }
        res.json({ message: 'Sold item removed' });
    } catch (err) {
        console.error('Delete sold item error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
