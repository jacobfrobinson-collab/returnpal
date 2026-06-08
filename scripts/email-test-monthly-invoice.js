#!/usr/bin/env node
/**
 * Send previous month invoice email for one user (operator smoke test).
 * Usage: node scripts/email-test-monthly-invoice.js userId
 */
require('dotenv').config();

const { getDb } = require('../src/database');
const { sendMonthlyInvoiceForUser } = require('../src/jobs/monthlyInvoiceEmail');
const { isMonthlyInvoiceEmailEnabled } = require('../src/utils/emailTransport');
const { maxInvoicablePeriodYm } = require('../src/utils/computedMonthlyStatements');

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

async function main() {
    const userId = parseInt(process.argv[2], 10);
    if (!Number.isFinite(userId)) {
        console.error('Usage: node scripts/email-test-monthly-invoice.js userId');
        process.exit(1);
    }
    if (!isMonthlyInvoiceEmailEnabled()) {
        console.error('Set EMAIL_ENABLED=1, SMTP_HOST, and MONTHLY_INVOICE_EMAIL_ENABLED=1');
        process.exit(1);
    }
    const db = await getDb();
    const rows = parseResults(
        db.exec(
            `SELECT id, email, full_name, client_preferences, weekly_digest_email FROM users WHERE id = ?`,
            [userId]
        )
    );
    if (!rows.length) {
        console.error('User not found:', userId);
        process.exit(1);
    }
    const u = rows[0];
    if (!u.email) {
        console.error('User has no email');
        process.exit(1);
    }
    const periodYm = maxInvoicablePeriodYm();
    await sendMonthlyInvoiceForUser(db, u, periodYm);
    console.log('Monthly invoice email attempted for user', userId, 'period', periodYm);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
