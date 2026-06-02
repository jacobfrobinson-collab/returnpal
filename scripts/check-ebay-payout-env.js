#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, 'ebay-payout-bot.env');
const examplePath = path.join(__dirname, 'ebay-payout-bot.env.example');

function loadEnvFile(filePath) {
    const out = {};
    if (!fs.existsSync(filePath)) return out;
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq < 1) continue;
        const key = t.slice(0, eq).trim();
        let val = t.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        out[key] = val;
    }
    return out;
}

function checkPath(label, p, { optional } = {}) {
    if (!p) {
        if (optional) return { ok: true, note: '(not set)' };
        return { ok: false, note: 'missing' };
    }
    const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
    if (fs.existsSync(abs)) return { ok: true, note: abs };
    if (optional) return { ok: true, note: `${abs} (will be created)` };
    return { ok: false, note: `not found: ${abs}` };
}

function main() {
    console.log('eBay payout bot — env check\n');

    if (!fs.existsSync(envPath)) {
        console.log(`✗ Missing ${envPath}`);
        console.log(`  Run: npm run ebay:env:init`);
        console.log(`  Or copy: ${examplePath}`);
        process.exit(1);
    }
    console.log(`✓ Using ${envPath}\n`);

    const env = loadEnvFile(envPath);
    const csvOnly = ['1', 'true', 'yes'].includes(String(env.EBAY_PAYOUT_NO_SHEET || '').trim().toLowerCase());
    const rows = [
        ['Postage queue CSV', env.RM_POSTAGE_QUEUE_CSV_PATH, { optional: false }],
        [
            'Payout output CSV',
            env.EBAY_PAYOUT_OUTPUT || env.EBAY_PAYOUT_OUTPUT_CSV,
            { optional: !csvOnly },
        ],
        ['Main payout sheet URL', env.GOOGLE_SHEET_URL, { optional: csvOnly, url: true }],
        ['Reconcile workbook', env.EBAY_RECONCILE_COMPARE_FILE, { optional: true }],
        ['Chrome profile dir', env.EBAY_CHROME_USER_DATA_DIR, { optional: true }],
        ['Service account JSON', env.GOOGLE_SERVICE_ACCOUNT_JSON, { optional: true }],
    ];

    let bad = 0;
    for (const [label, val, opts] of rows) {
        if (opts.url) {
            const ok = Boolean(val && /^https?:\/\//i.test(val));
            console.log(`${ok ? '✓' : '✗'} ${label}: ${val || '(empty)'}`);
            if (!ok) bad++;
            continue;
        }
        const r = checkPath(label, val, opts);
        console.log(`${r.ok ? '✓' : '✗'} ${label}: ${r.note}`);
        if (!r.ok) bad++;
    }

    if (env.RM_POSTAGE_QUEUE_SHEET_URL) {
        console.log(
            '\n⚠ RM_POSTAGE_QUEUE_SHEET_URL is set — postage queue may go to Google Sheets instead of CSV.',
        );
        console.log('  Remove that line from ebay-payout-bot.env to use Postage Queue.csv only.');
        bad++;
    }

    console.log('\nLoaded Seller Hub list:', env.EBAY_ORDERS_LIST_URL || '(script default)');
    console.log(
        'Payout mode:',
        csvOnly ? 'CSV only (EBAY_PAYOUT_NO_SHEET)' : 'Google Sheet (set EBAY_PAYOUT_NO_SHEET=1 to disable)',
    );

    if (bad) {
        console.log(`\n${bad} issue(s) — fix ebay-payout-bot.env and run again.`);
        process.exit(1);
    }
    console.log('\nAll checks passed. Typical flow:');
    console.log('  1) npm run ebay:chrome');
    console.log('  2) npm run ebay:payout:browser   (writes EBAY_PAYOUT_OUTPUT CSV; postage queue → Postage Queue.csv)');
}

main();
