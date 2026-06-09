/**
 * Client bulk package import from spreadsheet rows or pasted text.
 */

const ALLOWED_CONDITIONS = ['New', 'Used', 'Return', 'Return Review'];

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

function normalizeRow(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const reference = String(
        raw.Reference || raw.reference || raw['Tracking Number'] || raw.tracking_number || raw.ref || ''
    ).trim();
    const productName = String(
        raw.Product || raw.product || raw['Product Name'] || raw.product_name || raw.SKU || raw.sku || raw.name || ''
    ).trim();
    const quantity = Math.max(1, parseInt(raw.Quantity || raw.quantity || raw.Qty || raw.qty || 1, 10) || 1);
    const rawCondition = String(raw.Condition || raw.condition || 'New').trim();
    const condition = ALLOWED_CONDITIONS.includes(rawCondition) ? rawCondition : 'New';
    const notes = String(raw.Notes || raw.notes || '').trim().slice(0, 2000);
    if (!reference || !productName) return null;
    return { reference, productName, quantity, condition, notes };
}

function splitCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                cur += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if ((ch === ',' || ch === '\t') && !inQuotes) {
            out.push(cur.trim());
            cur = '';
        } else {
            cur += ch;
        }
    }
    out.push(cur.trim());
    return out;
}

/**
 * Parse pasted spreadsheet text (CSV or TSV, optional header row).
 * @param {string} text
 * @returns {object[]}
 */
function parsePackagePaste(text) {
    const lines = String(text || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    if (!lines.length) return [];

    const delim = lines[0].includes('\t') ? '\t' : ',';
    const firstCells = splitCsvLine(lines[0]).map((c) => c.toLowerCase().replace(/^\uFEFF/, ''));
    const hasHeader = firstCells.some((h) => h.includes('reference') || h.includes('product') || h.includes('tracking'));

    const rows = [];
    const dataLines = hasHeader ? lines.slice(1) : lines;
    const headers = hasHeader ? firstCells : ['reference', 'product', 'quantity', 'condition', 'notes'];

    for (let i = 0; i < dataLines.length; i++) {
        const cells = splitCsvLine(dataLines[i]);
        const raw = {};
        headers.forEach((h, idx) => {
            raw[h] = cells[idx] != null ? cells[idx] : '';
        });
        if (!hasHeader) {
            raw.reference = cells[0] || '';
            raw.product = cells[1] || '';
            raw.quantity = cells[2] || '1';
            raw.condition = cells[3] || 'New';
            raw.notes = cells[4] || '';
        }
        const norm = normalizeRow({
            Reference: raw.reference || raw.ref,
            Product: raw.product || raw['product name'] || raw.sku,
            Quantity: raw.quantity || raw.qty,
            Condition: raw.condition,
            Notes: raw.notes,
        });
        if (norm) rows.push(norm);
    }
    return rows;
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {object[]} normalizedRows from normalizeRow or parsePackagePaste
 */
function importPackageRowsForUser(db, userId, normalizedRows) {
    let created = 0;
    const errors = [];

    for (let i = 0; i < normalizedRows.length; i++) {
        const row = normalizedRows[i];
        const norm =
            row.reference && row.productName
                ? row
                : normalizeRow(row);
        if (!norm) {
            errors.push(`Row ${i + 1}: missing reference or product name`);
            continue;
        }

        const existing = parseResults(
            db.exec('SELECT id FROM packages WHERE reference = ? AND user_id = ? LIMIT 1', [
                norm.reference,
                userId,
            ])
        );

        let packageId;
        if (existing.length) {
            packageId = existing[0].id;
            if (norm.notes) {
                db.run('UPDATE packages SET notes = ? WHERE id = ?', [norm.notes, packageId]);
            }
        } else {
            db.run('INSERT INTO packages (user_id, reference, notes) VALUES (?, ?, ?)', [
                userId,
                norm.reference.slice(0, 255),
                norm.notes || '',
            ]);
            packageId = parseResults(db.exec('SELECT last_insert_rowid() AS id'))[0].id;
        }

        db.run(
            'INSERT INTO package_products (package_id, product_name, quantity, condition) VALUES (?, ?, ?, ?)',
            [packageId, norm.productName.slice(0, 500), norm.quantity, norm.condition]
        );
        created++;
    }

    return { created, errors, row_count: normalizedRows.length };
}

module.exports = {
    parsePackagePaste,
    normalizeRow,
    importPackageRowsForUser,
    ALLOWED_CONDITIONS,
};
