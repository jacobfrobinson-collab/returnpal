'use strict';

const fs = require('fs');
const { normalizeSoldDateForDb } = require('../src/utils/adminBulkImport');

/** ReturnPal multi-client sales import + SKU for Client ID review / Fill from SKU. */
const PAYOUT_IMPORT_CSV_HEADER = 'Client ID,sold_date,order_number,item_name,SKU,quantity,earnings';

function csvCellEscape(v) {
    const s = String(v ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

/** Calendar UK sold_date for CSV (YYYY-MM-DD). */
function formatSoldDateForImportCsv(soldDateStr) {
    return normalizeSoldDateForDb(soldDateStr) || String(soldDateStr || '').trim();
}

function payoutRowToImportCsvLine(r) {
    const qty = Number(r.quantity);
    const quantity = Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 1;
    return [
        csvCellEscape(r.clientId || ''),
        csvCellEscape(formatSoldDateForImportCsv(r.soldDate)),
        csvCellEscape(r.orderNumber || ''),
        csvCellEscape(r.itemTitle || ''),
        csvCellEscape(r.customSku || ''),
        quantity,
        r.clientPayout,
    ].join(',');
}

function payoutCsvHeaderRecognized(firstLine) {
    const h = String(firstLine || '')
        .trim()
        .toLowerCase()
        .replace(/^\uFEFF/, '');
    return /^client id,/.test(h) || /^order_number,/.test(h);
}

function orderIdFromPayoutCsvLine(line) {
    const m = String(line || '').match(/\b(\d{2}-\d{4,6}-\d{4,6})\b/);
    return m ? m[1] : '';
}

function isJunkPayoutCsvLine(line) {
    const t = String(line || '').trim();
    if (!t) return true;
    const first = t.split(',')[0].replace(/^"|"$/g, '').trim();
    if (/^column\s+\d+/i.test(first)) return true;
    if (!first && /^,+$/.test(t.replace(/\s/g, ''))) return true;
    return false;
}

function extractPayoutCsvDataLines(text) {
    const out = [];
    for (const line of String(text || '')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)) {
        if (isJunkPayoutCsvLine(line) || payoutCsvHeaderRecognized(line)) continue;
        if (orderIdFromPayoutCsvLine(line)) out.push(line.trim());
    }
    return out;
}

function readOrderIdsFromPayoutCsv(csvPath) {
    const out = new Set();
    if (!csvPath || !fs.existsSync(csvPath)) return out;
    for (const line of extractPayoutCsvDataLines(fs.readFileSync(csvPath, 'utf8'))) {
        const id = orderIdFromPayoutCsvLine(line);
        if (id) out.add(id);
    }
    return out;
}

module.exports = {
    PAYOUT_IMPORT_CSV_HEADER,
    csvCellEscape,
    formatSoldDateForImportCsv,
    payoutRowToImportCsvLine,
    payoutCsvHeaderRecognized,
    orderIdFromPayoutCsvLine,
    isJunkPayoutCsvLine,
    extractPayoutCsvDataLines,
    readOrderIdsFromPayoutCsv,
};
