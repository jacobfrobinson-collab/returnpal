/**
 * One-off / reusable: map EVERY EBAY ORDER SHEET layout → ReturnPal multi-client sold import.
 *
 * ReturnPal template row: A=Client ID, B=sold_date, C=item_name, D=quantity, E=earnings.
 * eBay order sheet row: A=sold date ("5 Feb 2026" → YYYY-MM-DD for template column B), B=order id, C=title,
 *   D=sku line, E=qty, F=?, G=earnings, H=client id (maps to template column A).
 */
const XLSX = require('xlsx');
const fs = require('fs');

const MONTHS = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
};

function pad2(n) {
    return n < 10 ? '0' + n : String(n);
}

function parseEbayDate(cell) {
    let s = String(cell == null ? '' : cell)
        .replace(/^\uFEFF/, '')
        .trim();
    if (!s) return null;
    const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const monKey = m[2].toLowerCase();
    const mo = MONTHS[monKey.slice(0, 3)];
    const y = parseInt(m[3], 10);
    if (!mo || !y || day < 1 || day > 31) return null;
    return `${y}-${pad2(mo)}-${pad2(day)}`;
}

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

function rowToCsvLine(cells) {
    return cells
        .map((c) => {
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

    const wb = XLSX.readFile(ebayPath);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

    const header = ['Client ID', 'sold_date', 'item_name', 'quantity', 'earnings'];
    const out = [header];
    let skipped = 0;
    const skipReasons = { noClient: 0, noDate: 0, noProduct: 0, badQty: 0 };

    for (let i = 0; i < aoa.length; i++) {
        const row = aoa[i];
        if (!row || !row.some((c) => c !== '' && c != null && String(c).trim() !== '')) {
            skipped++;
            continue;
        }
        const clientId = String(row[7] == null ? '' : row[7])
            .replace(/^\uFEFF/, '')
            .trim();
        const soldDate = parseEbayDate(row[0]);
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

        out.push([sanitizeCell(clientId), soldDate, sanitizeCell(product), qty, earnings]);
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
