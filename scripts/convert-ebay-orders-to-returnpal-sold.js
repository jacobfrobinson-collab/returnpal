/**
 * One-off / reusable: map EVERY EBAY ORDER SHEET layout → ReturnPal multi-client sold import.
 *
 * ReturnPal template row: Client ID, sold_date, order_number, item_name, quantity, earnings.
 * eBay order sheet row: A=sold date (any format accepted by bulk import → column B as YYYY-MM-DD), B=order id, C=title,
 *   D=sku line, E=qty, F=?, G=earnings, H=client id (maps to template column A).
 *
 * Ambiguous numeric dates (both parts ≤12, e.g. 04/12/2026): server default is UK DMY unless
 * process.env.RETURNPAL_AMBIGUOUS_DATE_ORDER=MDY (US MM/DD). Set before running if your sheet is US-style.
 */
const XLSX = require('xlsx');
const fs = require('fs');
const { normalizeSoldDateForDb } = require('../src/utils/adminBulkImport');

function parseMoney(v) {
    if (v == null || v === '') return 0;
    const s = String(v).trim().replace(/,/g, '');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
}

/** Strip control chars that can corrupt OOXML and confuse Excel rendering. */
function sanitizeCell(v) {
    if (v == null) return '';
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return String(v).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').trim();
}

/**
 * Emit sold_date as quoted YYYY-MM-DD so Excel “Save As CSV” and the importer
 * always see an unambiguous literal (matches normalizeSoldDateForDb on upload).
 */
function rowToCsvLine(cells) {
    return cells
        .map((c, i) => {
            if ((i === 1 || i === 2) && /^\d{4}-\d{2}-\d{2}$/.test(String(c == null ? '' : c).trim())) {
                return '"' + String(c).trim() + '"';
            }
            const s = String(c == null ? '' : c);
            if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
            return s;
        })
        .join(',');
}

function main() {
    const ebayPath =
        process.argv[2] || 'C:/Users/jacob/Downloads/EVERY EBAY ORDER SHEET 2026 (1).xlsx';
    const outPath =
        process.argv[3] ||
        'C:/Users/jacob/Downloads/returnpal-import-sold-from-ebay-2026-generated.xlsx';

    if (!fs.existsSync(ebayPath)) {
        console.error('Input not found:', ebayPath);
        process.exit(1);
    }

    const wb = XLSX.readFile(ebayPath, { cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });

    const header = ['Client ID', 'sold_date', 'order_number', 'item_name', 'quantity', 'earnings'];
    const out = [header];
    let skipped = 0;
    const skipReasons = { empty: 0, noClient: 0, noDate: 0, noProduct: 0, badQty: 0 };

    for (let i = 0; i < aoa.length; i++) {
        const row = aoa[i];
        if (!row || !row.some((c) => c !== '' && c != null && String(c).trim() !== '')) {
            skipReasons.empty++;
            skipped++;
            continue;
        }
        const clientId = String(row[7] == null ? '' : row[7])
            .replace(/^\uFEFF/, '')
            .trim();
        const soldDate = normalizeSoldDateForDb(row[0]);
        const orderNumber = String(row[1] == null ? '' : row[1]).trim();
        const product = String(row[2] == null ? '' : row[2]).trim();
        const qtyRaw = row[4];
        const qty = Math.max(1, parseInt(String(qtyRaw).trim(), 10) || 0);
        const earnings = parseMoney(row[6]);

        if (!clientId) {
            skipReasons.noClient++;
            skipped++;
            continue;
        }
        if (!soldDate) {
            skipReasons.noDate++;
            skipped++;
            continue;
        }
        if (!product) {
            skipReasons.noProduct++;
            skipped++;
            continue;
        }
        if (!qty) {
            skipReasons.badQty++;
            skipped++;
            continue;
        }

        out.push([
            sanitizeCell(clientId),
            soldDate,
            sanitizeCell(orderNumber),
            sanitizeCell(product),
            qty,
            earnings,
        ]);
    }

    const outWb = XLSX.utils.book_new();
    const outWs = XLSX.utils.aoa_to_sheet(out);
    XLSX.utils.book_append_sheet(outWb, outWs, 'Import');
    XLSX.writeFile(outWb, outPath, { compression: true });

    const csvPath = outPath.replace(/\.xlsx?$/i, '.csv');
    const csvBody = out.map((row) => rowToCsvLine(row)).join('\r\n');
    fs.writeFileSync(csvPath, '\uFEFF' + csvBody, 'utf8');

    console.log('Wrote', outPath);
    console.log('Wrote', csvPath, '(use this if Excel shows black blocks)');
    console.log('Output rows (incl. header):', out.length);
    console.log('Data rows:', out.length - 1);
    console.log('Skipped source rows:', skipped, skipReasons);
}

main();
