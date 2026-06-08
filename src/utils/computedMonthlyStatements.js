/**
 * Single source of truth for computed monthly statements (sales month period,
 * issue first of next month, payout end of issue month, cap TZ).
 */

const { feesDeductedForCalendarMonth } = require('./monthlyFreeProcessing');
const { effectiveDateForReturnAdjustment } = require('./returnAdjustmentDates');
const { calendarYearMonthFromDbDate, calendarIsoDateFromDbDate } = require('./soldDateCalendar');
const {
    isClientVatRegistered,
    clientPayoutFromGrossNet,
} = require('./clientVatPayout');
const {
    getPayoutEventsMap,
    resolveStatementStatus,
    payoutEtaFields,
} = require('./payoutEvents');
const { getPendingReferralCreditsForPeriod, applyPendingReferralCredits } = require('./referralCredits');

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

/** @param {string} periodYm "YYYY-MM" */
function parsePeriodYm(periodYm) {
    const parts = String(periodYm || '')
        .split('-')
        .map(Number);
    const y = parts[0];
    const m = parts[1];
    if (!y || !m || m < 1 || m > 12) return null;
    const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
    const monthEnd = new Date(y, m, 0);
    const monthEndStr =
        monthEnd.getFullYear() +
        '-' +
        String(monthEnd.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(monthEnd.getDate()).padStart(2, '0');
    return { y, m, monthStart, monthEndStr, periodYm: `${y}-${String(m).padStart(2, '0')}` };
}

/** @param {string} ym "YYYY-MM" */
function previousCalendarPeriodYm(ym) {
    const parts = String(ym || '')
        .split('-')
        .map(Number);
    let y = parts[0];
    let mo = parts[1];
    if (!y || !mo || mo < 1 || mo > 12) return ym;
    mo -= 1;
    if (mo < 1) {
        mo = 12;
        y -= 1;
    }
    return `${y}-${String(mo).padStart(2, '0')}`;
}

function getInvoiceCapTz() {
    return String(process.env.RETURNPAL_INVOICE_CAP_TZ || 'Europe/London').trim() || 'Europe/London';
}

/**
 * Latest calendar YYYY-MM that may appear as a completed monthly statement (sales month).
 */
function maxInvoicablePeriodYm() {
    const tz = getInvoiceCapTz();
    const d = new Date();
    let currentYm;
    try {
        const s = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(d);
        currentYm = s.slice(0, 7);
    } catch {
        currentYm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    return previousCalendarPeriodYm(currentYm);
}

/** YYYY-MM-DD for "today" in the given IANA timezone. */
function calendarTodayYmdInTz(tz) {
    const d = new Date();
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
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

/** @param {string} dueYmd due_date YYYY-MM-DD */
function computeStatementStatus(dueYmd, tz) {
    if (!dueYmd || String(dueYmd).length < 10) return 'Pending';
    const today = calendarTodayYmdInTz(tz);
    const due = String(dueYmd).slice(0, 10);
    return today > due ? 'Paid' : 'Pending';
}

/** First day of the calendar month *after* sales month (1–12). */
function statementIssueDateStr(y, m) {
    if (m === 12) return `${y + 1}-01-01`;
    return `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** Last day of the calendar month in which the statement is issued (= payout month). */
function statementPayoutEndDate(y, m) {
    if (m === 12) return new Date(y + 1, 1, 0);
    return new Date(y, m + 1, 0);
}

function statementPayoutEndDateStr(y, m) {
    const d = statementPayoutEndDate(y, m);
    return (
        d.getFullYear() +
        '-' +
        String(d.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(d.getDate()).padStart(2, '0')
    );
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {{ y: number, m: number, monthStart: string, monthEndStr: string, periodYm: string }} p
 * @param {object[]|null} [allSoldCache]
 */
function getUserVatRegistered(db, userId) {
    const urow = parseResults(db.exec('SELECT vat_registered FROM users WHERE id = ?', [userId]));
    return isClientVatRegistered(urow[0] && urow[0].vat_registered);
}

function buildInvoicePeriodPayload(db, userId, p, allSoldCache = null) {
    const { y, m, monthStart, monthEndStr, periodYm } = p;
    const vatRegistered = getUserVatRegistered(db, userId);

    const allSold =
        allSoldCache != null
            ? allSoldCache
            : parseResults(db.exec('SELECT * FROM sold_items WHERE user_id = ?', [userId]));

    const items = allSold
        .filter((row) => {
            if (Number(row.user_id) !== Number(userId)) return false;
            const calIso = calendarIsoDateFromDbDate(row.sold_date);
            return !!(calIso && calIso >= monthStart && calIso <= monthEndStr);
        })
        .sort((a, b) => {
            const na = calendarIsoDateFromDbDate(a.sold_date) || '';
            const nb = calendarIsoDateFromDbDate(b.sold_date) || '';
            const c = na.localeCompare(nb);
            return c !== 0 ? c : (Number(a.id) || 0) - (Number(b.id) || 0);
        })
        .map((row) => ({
            id: row.id,
            description: row.product,
            quantity: row.quantity,
            unit_price: row.unit_price,
            total_revenue: row.total_revenue,
            profit: row.profit,
            status: row.status,
            sold_date: calendarIsoDateFromDbDate(row.sold_date) || row.sold_date,
            reference: row.reference
        }));

    for (const row of allSold) {
        if (Number(row.user_id) !== Number(userId)) continue;
        const calIso = calendarIsoDateFromDbDate(row.sold_date);
        if (!calIso || calIso < monthStart || calIso > monthEndStr) continue;
        const ym = calendarYearMonthFromDbDate(row.sold_date);
        if (ym !== periodYm) {
            console.error(
                `[invoice] Period ${periodYm} consistency failed: sold_item id=${row.id} raw=${JSON.stringify(row.sold_date)} calendar_ym=${ym}`
            );
            return null;
        }
    }

    const fees = feesDeductedForCalendarMonth(allSold, periodYm);

    const returnCandidates = parseResults(
        db.exec(
            `SELECT r.id, r.product, r.reference, r.amount, r.status, r.notes, r.created_at, r.refund_date,
                    r.linked_sold_item_id, s.sold_date AS linked_sold_date
             FROM return_adjustments r
             LEFT JOIN sold_items s ON s.id = r.linked_sold_item_id AND s.user_id = r.user_id
             WHERE r.user_id = ? AND r.status = 'applied'
             ORDER BY r.created_at`,
            [userId]
        )
    );
    const returnRows = returnCandidates
        .filter((r) => {
            const n = effectiveDateForReturnAdjustment(r);
            return !!(n && n >= monthStart && n <= monthEndStr);
        })
        .map((r) => ({
            id: r.id,
            product: r.product,
            reference: r.reference,
            amount: r.amount,
            status: r.status,
            notes: r.notes,
            created_at: r.created_at,
            linked_sold_item_id: r.linked_sold_item_id
        }));

    /** Invoice / payout lines: sales (positive), refunds and clawbacks (negative). No separate fee rows. */
    const line_items = [];
    items.forEach((i) => {
        const qty = Number(i.quantity) || 1;
        const lineProfit = Number(i.profit) || 0;
        const isRefunded = i.status === 'Refunded';
        const profitPerUnit = (isRefunded ? -Math.abs(lineProfit) : lineProfit) / qty;
        line_items.push({
            description: (i.description || 'Item') + (isRefunded ? ' (returned)' : ''),
            quantity: qty,
            unit_price: Number(i.unit_price) || 0,
            amount: profitPerUnit,
            status: i.status || 'Completed',
            sold_item_id: i.id,
            reference: i.reference || ''
        });
    });
    returnRows.forEach((r) => {
        const amt = Number(r.amount) || 0;
        if (amt <= 0) return;
        line_items.push({
            description: (r.product || 'Item') + ' (return / clawback)',
            quantity: 1,
            unit_price: 0,
            amount: -Math.abs(amt),
            status: r.status || 'applied',
            sold_item_id: r.linked_sold_item_id,
            reference: r.reference || ''
        });
    });

    const statement_lines = [];
    items.forEach((i) => {
        const qty = Number(i.quantity) || 1;
        const lineProfit = Number(i.profit) || 0;
        const isRefunded = i.status === 'Refunded';
        statement_lines.push({
            kind: isRefunded ? 'return' : 'sale',
            label: (i.description || 'Item') + (isRefunded ? ' → Returned (refund)' : ' → Sold'),
            reference: i.reference || '',
            amount: isRefunded ? -Math.abs(lineProfit) : lineProfit,
            date: i.sold_date
        });
    });
    returnRows.forEach((r) => {
        const amt = Number(r.amount) || 0;
        statement_lines.push({
            kind: 'return_adjustment',
            label: (r.product || 'Item') + ' → Return / clawback' + (r.status === 'pending' ? ' (pending)' : ''),
            reference: r.reference || '',
            amount: -Math.abs(amt),
            date: effectiveDateForReturnAdjustment(r) || r.created_at,
            status: r.status
        });
    });
    statement_lines.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

    const salesProfit = items.filter((i) => i.status !== 'Refunded').reduce((s, i) => s + (Number(i.profit) || 0), 0);
    const refundedProfit = items.filter((i) => i.status === 'Refunded').reduce((s, i) => s + (Number(i.profit) || 0), 0);
    const adjustmentsApplied = returnRows.filter((r) => r.status === 'applied').reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const subtotal = Math.round(line_items.reduce((s, i) => s + i.amount * i.quantity, 0) * 100) / 100;
    const net_after_returns = Math.round((salesProfit - refundedProfit - adjustmentsApplied) * 100) / 100;
    /** Client payout: sales/returns only (fees already reflected in per-line profit). */
    let gross_net = Math.round(net_after_returns * 100) / 100;
    const issueStr = statementIssueDateStr(y, m);
    const dueStr = statementPayoutEndDateStr(y, m);
    const tz = getInvoiceCapTz();
    const today = calendarTodayYmdInTz(tz);
    let referralCredit = 0;
    if (today >= issueStr.slice(0, 10)) {
        referralCredit = applyPendingReferralCredits(db, userId, periodYm);
    } else {
        referralCredit = getPendingReferralCreditsForPeriod(db, userId, periodYm);
    }
    if (referralCredit > 0) {
        gross_net = Math.round((gross_net - referralCredit) * 100) / 100;
        line_items.push({
            description: 'Referral credit',
            quantity: 1,
            unit_price: 0,
            amount: -referralCredit,
            status: 'credit',
            sold_item_id: null,
            reference: '',
        });
        statement_lines.push({
            kind: 'referral_credit',
            label: 'Referral credit',
            reference: '',
            amount: -referralCredit,
            date: issueStr,
        });
    }
    const total = clientPayoutFromGrossNet(gross_net, vatRegistered);
    const vat_amount = 0;

    const status = resolveStatementStatus(db, userId, periodYm, dueStr, tz);

    return {
        period: periodYm,
        period_label: monthStart,
        date_issued: issueStr,
        due_date: dueStr,
        line_items,
        statement_lines,
        summary: {
            sales_profit: Math.round(salesProfit * 100) / 100,
            refunds_and_returns: Math.round((refundedProfit + adjustmentsApplied) * 100) / 100,
            fees_deducted: fees,
            referral_credit: referralCredit,
            gross_net,
            net_payout_estimate: total
        },
        return_lines: returnRows,
        subtotal,
        fees,
        gross_net,
        vat_registered: vatRegistered,
        vat_amount,
        total,
        status,
        _items_count: items.length,
        _returns_count: returnRows.length,
        refund_only_period: items.length === 0 && returnRows.length > 0
    };
}

/** Payout month is shown only when it has sales and/or applied returns in that calendar month. */
function periodQualifiesForPayoutStatement(detail) {
    const salesN = detail._items_count || 0;
    const returnsN = detail._returns_count || 0;
    if (salesN === 0 && returnsN === 0) return false;
    return !!(detail.statement_lines && detail.statement_lines.length > 0);
}

/**
 * Distinct YYYY-MM values with invoice activity.
 * Sales → sold_items.sold_date (same calendar rules as client sold dashboard).
 * Returns → refund_date (or created_at when unlinked), not the linked sale’s sold month.
 */
function listDistinctInvoiceMonths(db, userId) {
    const rows = parseResults(
        db.exec(
            `SELECT DISTINCT trim(sold_date) AS d
             FROM sold_items
             WHERE user_id = ?
               AND sold_date IS NOT NULL
               AND length(trim(sold_date)) > 0
             UNION
             SELECT DISTINCT trim(r.refund_date) AS d
             FROM return_adjustments r
             WHERE r.user_id = ? AND r.status = 'applied'
               AND r.refund_date IS NOT NULL AND length(trim(r.refund_date)) > 0
             UNION
             SELECT DISTINCT trim(r.created_at) AS d
             FROM return_adjustments r
             WHERE r.user_id = ? AND r.status = 'applied' AND r.linked_sold_item_id IS NULL
               AND (r.refund_date IS NULL OR length(trim(r.refund_date)) = 0)
               AND r.created_at IS NOT NULL AND length(trim(r.created_at)) > 0`,
            [userId, userId, userId]
        )
    );
    const yms = new Set();
    for (const row of rows) {
        const ym = calendarYearMonthFromDbDate(row.d);
        if (ym) yms.add(ym);
    }
    return Array.from(yms).sort().reverse();
}

/**
 * Same payload as GET /api/invoices (computed list + cap metadata).
 * @param {import('sql.js').Database} db
 * @param {number} userId
 */
function getComputedMonthlyStatements(db, userId) {
    const allSold = parseResults(db.exec('SELECT * FROM sold_items WHERE user_id = ?', [userId]));
    const urow = parseResults(
        db.exec('SELECT full_name, company_name, vat_registered FROM users WHERE id = ?', [userId])
    );
    const customerName = (urow[0] && (urow[0].full_name || urow[0].company_name)) || 'Client';
    const vatRegistered = isClientVatRegistered(urow[0] && urow[0].vat_registered);

    const months = listDistinctInvoiceMonths(db, userId);
    const capYm = maxInvoicablePeriodYm();
    const tz = getInvoiceCapTz();
    const capped = months.filter((ym) => ym <= capYm);
    const maxMonths = 60;
    const slice = capped.slice(0, maxMonths);
    const payoutMap = getPayoutEventsMap(db, userId);

    const invoices = slice
        .map((ym) => {
            const p = parsePeriodYm(ym);
            if (!p) return null;
            const detail = buildInvoicePeriodPayload(db, userId, p, allSold);
            if (!detail || !periodQualifiesForPayoutStatement(detail)) {
                return null;
            }
            const dueStr = statementPayoutEndDateStr(p.y, p.m);
            const issueStr = statementIssueDateStr(p.y, p.m);
            const status = resolveStatementStatus(db, userId, ym, dueStr, tz);
            const eta = payoutEtaFields(dueStr, tz);
            const pe = payoutMap[ym] || null;
            return {
                id: null,
                user_id: userId,
                invoice_number: `RP-${ym}`,
                customer_name: customerName,
                date_issued: issueStr,
                due_date: dueStr,
                amount: detail.total,
                items_count: detail._items_count,
                status,
                pdf_path: '',
                vat_amount: detail.vat_amount,
                vat_registered: vatRegistered,
                period: ym,
                period_label: detail.period_label,
                net_payout_estimate: detail.summary.net_payout_estimate,
                gross_net: detail.gross_net,
                referral_credit: detail.summary.referral_credit || 0,
                refund_only_period: !!detail.refund_only_period,
                sales_in_period: detail._items_count || 0,
                returns_in_period: detail._returns_count || 0,
                days_until_due: eta.days_until_due,
                payout_date_label: eta.payout_date_label,
                is_overdue: eta.is_overdue,
                bank_reference: pe?.bank_reference || '',
                client_bank_note: pe?.client_bank_note || '',
                paid_at: pe?.paid_at || '',
                source: 'computed'
            };
        })
        .filter(Boolean);

    return {
        invoices,
        total: invoices.length,
        source: 'computed',
        statement_period_cap_ym: capYm,
        statement_period_cap_tz: tz
    };
}

/**
 * Dashboard aggregates: unpaid = pending statements; latest_payout = most recent paid (by due_date).
 * @param {import('sql.js').Database} db
 * @param {number} userId
 */
function getComputedDashboardInvoiceAggregates(db, userId) {
    const { invoices } = getComputedMonthlyStatements(db, userId);
    const pending = invoices.filter((i) => i.status === 'Pending');
    const unpaid_invoices_count = pending.length;
    const unpaid_invoices_total = Math.round(pending.reduce((s, i) => s + (Number(i.amount) || 0), 0) * 100) / 100;

    const paid = invoices.filter((i) => i.status === 'Paid');
    paid.sort((a, b) => String(b.due_date || '').localeCompare(String(a.due_date || '')));
    const latest = paid[0] || null;
    const latest_payout = latest
        ? {
              amount: latest.amount,
              status: 'Paid',
              date: latest.due_date
          }
        : null;

    return { unpaid_invoices_count, unpaid_invoices_total, latest_payout };
}

module.exports = {
    getComputedMonthlyStatements,
    getComputedDashboardInvoiceAggregates,
    getUserVatRegistered,
    buildInvoicePeriodPayload,
    parsePeriodYm,
    maxInvoicablePeriodYm,
    getInvoiceCapTz,
    calendarTodayYmdInTz,
    computeStatementStatus,
    statementIssueDateStr,
    statementPayoutEndDateStr,
    statementPayoutEndDate,
    listDistinctInvoiceMonths
};
