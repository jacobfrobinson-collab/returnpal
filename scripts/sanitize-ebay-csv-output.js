#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
    PAYOUT_IMPORT_CSV_HEADER,
    payoutRowToImportCsvLine,
    orderIdFromPayoutCsvLine,
    payoutCsvHeaderRecognized,
    isJunkPayoutCsvLine,
    readOrderIdsFromPayoutCsv,
} = require('./ebay-payout-import-csv');

try {
    const dotenv = require('dotenv');
    const localEnv = path.join(__dirname, 'ebay-payout-bot.env');
    if (fs.existsSync(localEnv)) dotenv.config({ path: localEnv });
} catch {
    /* optional */
}

const POSTAGE_QUEUE_CSV_HEADER_ORDER_ONLY = 'order_number';

function isJunk(line) {
    return isJunkPayoutCsvLine(line);
}

function extractIds(text) {
    const out = new Set();
    for (const line of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
        if (isJunk(line) || payoutCsvHeaderRecognized(line)) continue;
        const c = orderIdFromPayoutCsvLine(line);
        if (c) out.add(c);
    }
    return out;
}

function rebuildPayoutCsvFromJson(jsonPath, csvPath) {
    if (!fs.existsSync(jsonPath)) {
        console.log(`Payout JSON not found — ${jsonPath}`);
        return false;
    }
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const rows = Array.isArray(data.rows) ? data.rows : Array.isArray(data) ? data : [];
    if (!rows.length) {
        console.log(`Payout JSON has no rows — ${jsonPath}`);
        return false;
    }
    const lines = rows.map((r) => payoutRowToImportCsvLine(r));
    fs.writeFileSync(csvPath, '\uFEFF' + [PAYOUT_IMPORT_CSV_HEADER, ...lines].join('\n') + '\n', 'utf8');
    const bytes = fs.statSync(csvPath).size;
    console.log(
        `Rebuilt payout CSV from JSON: ${csvPath} — ${rows.length} row(s), ${bytes.toLocaleString()} bytes. Close Excel and reopen this file.`,
    );
    return true;
}

function main() {
    const rebuildOnly = process.argv.includes('--rebuild-payout');
    const payoutCsv =
        process.argv.find((a) => /\.csv$/i.test(a) && !a.startsWith('--')) ||
        process.env.EBAY_PAYOUT_OUTPUT ||
        'C:/Users/jacob/Downloads/Previous Year Payout.csv';
    const payoutJson = payoutCsv.replace(/\.csv$/i, '.json');
    const queue =
        process.env.RM_POSTAGE_QUEUE_CSV_PATH || 'C:/Users/jacob/Downloads/Postage Queue.csv';

    if (rebuildOnly) {
        rebuildPayoutCsvFromJson(payoutJson, payoutCsv);
        return;
    }

    for (const [label, filePath] of [
        ['Payout CSV', payoutCsv],
        ['Postage queue CSV', queue],
    ]) {
        if (!fs.existsSync(filePath)) {
            console.log(`${label}: not found — ${filePath}`);
            continue;
        }
        const bytes = fs.statSync(filePath).size;
        const text = fs.readFileSync(filePath, 'utf8');
        const ids = extractIds(text);
        const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim()).length;
        console.log(`${label}:`);
        console.log(`  ${filePath}`);
        console.log(`  ${bytes.toLocaleString()} bytes, ${lines} non-empty line(s), ${ids.size} eBay order id(s) detected`);
    }

    if (fs.existsSync(queue)) {
        const ids = extractIds(fs.readFileSync(queue, 'utf8'));
        fs.writeFileSync(queue, '\uFEFF' + [POSTAGE_QUEUE_CSV_HEADER_ORDER_ONLY, ...ids].join('\n') + '\n', 'utf8');
        console.log(`\nCleaned postage queue → ${ids.size} order id(s).`);
    }

    if (fs.existsSync(payoutJson)) {
        rebuildPayoutCsvFromJson(payoutJson, payoutCsv);
    }

    const payoutIds = fs.existsSync(payoutCsv) ? readOrderIdsFromPayoutCsv(payoutCsv).size : 0;
    const queueIds = fs.existsSync(queue) ? extractIds(fs.readFileSync(queue, 'utf8')).size : 0;
    console.log(
        `\nSummary: ${payoutIds} paid-out order row(s) in main CSV + ${queueIds} missing-postage order(s) in Postage Queue.csv.`,
    );
    console.log('If Excel still looks wrong: close the file completely, then reopen from Downloads (Excel does not live-refresh CSVs).');
}

main();
