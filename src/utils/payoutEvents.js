'use strict';

function getInvoiceCapTz() {
    return String(process.env.RETURNPAL_INVOICE_CAP_TZ || 'Europe/London').trim() || 'Europe/London';
}

function calendarTodayYmdInTz(tz) {
    const d = new Date();
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
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
 * @param {string} periodYm
 */
function getPayoutEvent(db, userId, periodYm) {
    const rows = parseResults(
        db.exec('SELECT * FROM payout_events WHERE user_id = ? AND period_ym = ?', [userId, periodYm])
    );
    return rows[0] || null;
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 */
function getPayoutEventsMap(db, userId) {
    const rows = parseResults(
        db.exec('SELECT * FROM payout_events WHERE user_id = ?', [userId])
    );
    const map = {};
    for (const r of rows) map[r.period_ym] = r;
    return map;
}

/**
 * Resolve statement status: admin-marked paid overrides date inference.
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {string} periodYm
 * @param {string} dueYmd
 * @param {string} [tz]
 */
function resolveStatementStatus(db, userId, periodYm, dueYmd, tz) {
    const ev = getPayoutEvent(db, userId, periodYm);
    if (ev && ev.status === 'paid') return 'Paid';
    const capTz = tz || getInvoiceCapTz();
    if (!dueYmd || String(dueYmd).length < 10) return 'Pending';
    const today = calendarTodayYmdInTz(capTz);
    const due = String(dueYmd).slice(0, 10);
    return today > due ? 'Paid' : 'Pending';
}

/**
 * @param {string} dueYmd YYYY-MM-DD
 * @param {string} [tz]
 */
function payoutEtaFields(dueYmd, tz) {
    const capTz = tz || getInvoiceCapTz();
    const today = calendarTodayYmdInTz(capTz);
    const due = String(dueYmd || '').slice(0, 10);
    if (!due || due.length < 10) {
        return { days_until_due: null, payout_date_label: '', is_overdue: false };
    }
    const todayD = new Date(today + 'T12:00:00');
    const dueD = new Date(due + 'T12:00:00');
    const diffMs = dueD.getTime() - todayD.getTime();
    const days = Math.round(diffMs / 86400000);
    const d = new Date(due + 'T12:00:00');
    const day = d.getDate();
    const suffix =
        day % 10 === 1 && day !== 11
            ? 'st'
            : day % 10 === 2 && day !== 12
              ? 'nd'
              : day % 10 === 3 && day !== 13
                ? 'rd'
                : 'th';
    const payout_date_label =
        d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }).replace(
            String(day),
            day + suffix
        ) || d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    return {
        days_until_due: days,
        payout_date_label,
        is_overdue: days < 0,
    };
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {string} periodYm
 * @param {{ amount: number, due_date: string, bank_reference: string, adminId: number }} data
 */
function markPayoutPaid(db, userId, periodYm, data) {
    const existing = getPayoutEvent(db, userId, periodYm);
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    if (existing) {
        db.run(
            `UPDATE payout_events SET status = 'paid', amount = ?, due_date = ?, bank_reference = ?,
             paid_at = ?, marked_by_admin_id = ?, updated_at = datetime('now')
             WHERE user_id = ? AND period_ym = ?`,
            [
                data.amount || 0,
                data.due_date || '',
                data.bank_reference || '',
                now,
                data.adminId || null,
                userId,
                periodYm,
            ]
        );
    } else {
        db.run(
            `INSERT INTO payout_events (user_id, period_ym, status, amount, due_date, bank_reference, paid_at, marked_by_admin_id)
             VALUES (?, ?, 'paid', ?, ?, ?, ?, ?)`,
            [
                userId,
                periodYm,
                data.amount || 0,
                data.due_date || '',
                data.bank_reference || '',
                now,
                data.adminId || null,
            ]
        );
    }
    return getPayoutEvent(db, userId, periodYm);
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {string} periodYm
 * @param {string} note
 */
function setClientPayoutNote(db, userId, periodYm, note) {
    const existing = getPayoutEvent(db, userId, periodYm);
    if (existing) {
        db.run(
            `UPDATE payout_events SET client_bank_note = ?, updated_at = datetime('now') WHERE user_id = ? AND period_ym = ?`,
            [note || '', userId, periodYm]
        );
    } else {
        db.run(
            `INSERT INTO payout_events (user_id, period_ym, status, client_bank_note) VALUES (?, ?, 'pending', ?)`,
            [userId, periodYm, note || '']
        );
    }
}

module.exports = {
    getPayoutEvent,
    getPayoutEventsMap,
    resolveStatementStatus,
    payoutEtaFields,
    markPayoutPaid,
    setClientPayoutNote,
};
