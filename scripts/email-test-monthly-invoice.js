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

function reportEmailEnv() {
    const need = ['EMAIL_ENABLED', 'SMTP_HOST', 'MONTHLY_INVOICE_EMAIL_ENABLED'];
    const missing = need.filter((k) => !(process.env[k] || '').trim());
    console.error('Email env not ready. Missing or empty:', missing.join(', ') || '(check values are 1 / set)');
    console.error('Render Shell may not load Web Service env — run: echo $EMAIL_ENABLED $SMTP_HOST');
}

async function main() {
    const arg = process.argv[2];
    if (!arg) {
        console.error('Usage: node scripts/email-test-monthly-invoice.js userId-or-email');
        process.exit(1);
    }
    if (!isMonthlyInvoiceEmailEnabled()) {
        reportEmailEnv();
        process.exit(1);
    }
    const db = await getDb();
    let rows;
    if (String(arg).includes('@')) {
        rows = parseResults(
            db.exec(
                `SELECT id, email, full_name, client_preferences, weekly_digest_email FROM users WHERE LOWER(email) = LOWER(?)`,
                [String(arg).trim()]
            )
        );
    } else {
        const userId = parseInt(arg, 10);
        if (!Number.isFinite(userId)) {
            console.error('Usage: node scripts/email-test-monthly-invoice.js userId-or-email');
            process.exit(1);
        }
        rows = parseResults(
            db.exec(
                `SELECT id, email, full_name, client_preferences, weekly_digest_email FROM users WHERE id = ?`,
                [userId]
            )
        );
    }
    if (!rows.length) {
        console.error('User not found:', arg);
        process.exit(1);
    }
    const u = rows[0];
    if (!u.email) {
        console.error('User has no email');
        process.exit(1);
    }
    const periodYm = maxInvoicablePeriodYm();
    await sendMonthlyInvoiceForUser(db, u, periodYm);
    console.log('Monthly invoice email attempted for user', u.id, u.email, 'period', periodYm);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
