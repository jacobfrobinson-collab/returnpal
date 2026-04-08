/**
 * Parse .xlsx / .xls / .csv buffers and import rows for admin client bulk actions.
 */
const XLSX = require('xlsx');
const { saveDb, pushActivity } = require('../database');

const MAX_ROWS = 500;

const PENDING_STAGES = ['Initial Inspection', 'Quality Check', 'Return Verification', 'Listing', 'Ready for Sale'];
const REIMB_TYPES = [
    'Destroyed Inventory',
    'Damaged Inventory',
    'Misplaced and Lost Inventory',
    'Customer Returned Orders',
    'Missing FBA Shipment Units',
];

function parseResults(result) {
    if (!result || !result.length) return [];
    const cols = result[0].columns;
    return result[0].values.map((row) => {
        const obj = {};
        cols.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

function normalizeHeaderKey(s) {
    return String(s || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_]/g, '');
}

function aliasKey(k) {
    const m = {
        ref: 'reference',
        qty: 'quantity',
        unit: 'unit_price',
        price: 'unit_price',
        total: 'total_revenue',
        revenue: 'total_revenue',
        items: 'items_description',
        desc: 'items_description',
        description: 'items_description',
        stage: 'current_stage',
        est: 'est_completion',
        est_completion_date: 'est_completion',
        pkg_ref: 'package_reference',
        pkg: 'package_reference',
        package_ref: 'package_reference',
        type: 'reimbursement_type',
        reimb_type: 'reimbursement_type',
        pid: 'package_id',
        pkg_id: 'package_id',
        amount: 'amount',
        item_name: 'product',
    };
    return m[k] || k;
}

/**
 * @returns {Array<Record<string, unknown>>}
 */
function parseSpreadsheetBuffer(buffer) {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const arr = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    if (!arr.length) return [];

    const rawHeaders = arr[0];
    const headers = rawHeaders.map((h) => normalizeHeaderKey(String(h)));
    const rows = [];
    for (let r = 1; r < arr.length; r++) {
        const row = arr[r];
        if (!row || !row.some((c) => c !== '' && c != null && String(c).trim() !== '')) continue;
        const o = {};
        headers.forEach((h, i) => {
            if (!h) return;
            const key = aliasKey(h);
            const v = row[i];
            o[key] = v;
        });
        rows.push(o);
    }
    return rows;
}

function num(v, def = 0) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : def;
}

function str(v) {
    return v == null ? '' : String(v).trim();
}

function pad2(n) {
    return n < 10 ? '0' + n : String(n);
}

/**
 * Normalize sold_date from spreadsheet to YYYY-MM-DD (UK dd/mm/yyyy first).
 * @param {unknown} v
 * @returns {string|null}
 */
function normalizeSoldDateForDb(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && Number.isFinite(v) && v > 20000 && v < 120000) {
        const epochMs = Date.UTC(1899, 11, 30) + Math.round(v) * 86400000;
        const d = new Date(epochMs);
        if (!isNaN(d.getTime())) {
            return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
        }
    }
    if (v instanceof Date && !isNaN(v.getTime())) {
        return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
    }
    const s0 = str(v).split(/[T ]/)[0];
    const iso = s0.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return s0;
    const uk = s0.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
    if (uk) {
        const day = parseInt(uk[1], 10);
        const mo = parseInt(uk[2], 10);
        const y = parseInt(uk[3], 10);
        if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
            return y + '-' + pad2(mo) + '-' + pad2(day);
        }
    }
    return null;
}

function importSoldRow(db, userId, row) {
    const product = str(row.product);
    if (!product) throw new Error('item name (product) is required');
    const reference = str(row.reference);
    const qty = Math.max(1, parseInt(row.quantity, 10) || 1);
    const soldDateParam = normalizeSoldDateForDb(row.sold_date);

    const hasEarningsCol = Object.prototype.hasOwnProperty.call(row, 'earnings');
    const earningsStr = hasEarningsCol ? str(row.earnings) : '';
    const earningsNum = hasEarningsCol && earningsStr !== '' ? num(row.earnings, NaN) : NaN;

    let unit;
    let total;
    let profit;
    let margin;
    if (hasEarningsCol) {
        if (!Number.isFinite(earningsNum)) {
            throw new Error('earnings must be a number');
        }
        profit = earningsNum;
        total = earningsNum;
        unit = qty ? earningsNum / qty : 0;
        margin = 0;
    } else {
        unit = num(row.unit_price, 0);
        total = num(row.total_revenue, 0);
        if (!total && unit) total = unit * qty;
        profit = num(row.profit, 0);
        margin = num(row.margin, 0);
    }

    db.run(
        `INSERT INTO sold_items (user_id, reference, product, quantity, unit_price, total_revenue, profit, margin, sold_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
        [userId, reference, product, qty, unit, total, profit, margin, soldDateParam]
    );
    const id = parseResults(db.exec('SELECT last_insert_rowid() as id'))[0].id;
    const amount = total || unit * qty;
    const msg = 'Item "' + product + '" sold for £' + amount.toFixed(2);
    return { id, activity: () => pushActivity(userId, 'item_sold', msg, '/dashboard/sold-items.html') };
}

function importReceivedRow(db, userId, row) {
    const reference = str(row.reference);
    const desc = str(row.items_description);
    if (!reference || !desc) throw new Error('reference and items_description are required');
    const qty = Math.max(1, parseInt(row.quantity, 10) || 1);
    const notes = str(row.notes);
    const pkgMatch = parseResults(
        db.exec('SELECT id FROM packages WHERE user_id = ? AND reference = ? LIMIT 1', [userId, reference.slice(0, 255)])
    );
    const packageId = pkgMatch[0] ? pkgMatch[0].id : null;
    db.run(
        'INSERT INTO received_items (user_id, package_id, reference, items_description, quantity, notes) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, packageId, reference.slice(0, 255), desc.slice(0, 1000), qty, notes.slice(0, 2000)]
    );
    const id = parseResults(db.exec('SELECT last_insert_rowid() as id'))[0].id;
    const msg = 'Package received: ' + reference + (desc ? ' – ' + desc.slice(0, 80) : '');
    return { id, activity: () => pushActivity(userId, 'package_received', msg, '/dashboard/received.html') };
}

function importPendingRow(db, userId, row) {
    const product = str(row.product);
    if (!product) throw new Error('product is required');
    const reference = str(row.reference);
    const qty = Math.max(1, parseInt(row.quantity, 10) || 1);
    let stage = str(row.current_stage) || 'Initial Inspection';
    if (!PENDING_STAGES.includes(stage)) {
        const found = PENDING_STAGES.find((s) => s.toLowerCase() === stage.toLowerCase());
        stage = found || 'Initial Inspection';
    }
    const est = str(row.est_completion);
    const notes = str(row.notes);
    db.run(
        `INSERT INTO pending_items (user_id, reference, product, quantity, current_stage, est_completion, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, reference, product, qty, stage, est, notes]
    );
    const id = parseResults(db.exec('SELECT last_insert_rowid() as id'))[0].id;
    const msg = 'Item added to pending: ' + (product || reference || '');
    return { id, activity: () => pushActivity(userId, 'item_pending', msg, '/dashboard/item-pending.html') };
}

function importMarkDeliveredRow(db, userId, row) {
    const pid = row.package_id != null && row.package_id !== '' ? parseInt(row.package_id, 10) : NaN;
    const reference = str(row.reference);
    let pkg;
    if (Number.isFinite(pid)) {
        const rows = parseResults(db.exec('SELECT id, user_id, reference FROM packages WHERE id = ?', [pid]));
        pkg = rows[0];
        if (!pkg || pkg.user_id !== userId) throw new Error('package_id not found for this client');
    } else if (reference) {
        const rows = parseResults(
            db.exec('SELECT id, user_id, reference FROM packages WHERE user_id = ? AND reference = ? LIMIT 1', [userId, reference])
        );
        pkg = rows[0];
        if (!pkg) throw new Error('No package with that reference');
    } else {
        throw new Error('reference or package_id is required');
    }
    db.run(`UPDATE packages SET status = ?, updated_at = datetime('now') WHERE id = ?`, ['Delivered', pkg.id]);
    const msg = 'Package ' + (pkg.reference || '') + ' marked as delivered';
    return { id: pkg.id, activity: () => pushActivity(userId, 'package_delivered', msg, '/dashboard/packages.html') };
}

function importReimbursementRow(db, userId, row) {
    const packageReference = str(row.package_reference);
    const itemDescription = str(row.item_description);
    if (!packageReference || !itemDescription) throw new Error('package_reference and item_description are required');
    let reimbType = str(row.reimbursement_type) || 'Damaged Inventory';
    if (!REIMB_TYPES.includes(reimbType)) {
        const f = REIMB_TYPES.find((t) => t.toLowerCase() === reimbType.toLowerCase());
        reimbType = f || 'Damaged Inventory';
    }
    const notes = str(row.notes);
    db.run(
        'INSERT INTO reimbursement_claims (user_id, package_reference, item_description, reimbursement_type, notes) VALUES (?, ?, ?, ?, ?)',
        [userId, packageReference, itemDescription, reimbType, notes]
    );
    const claimId = parseResults(db.exec('SELECT last_insert_rowid() as id'))[0].id;
    return {
        id: claimId,
        activity: () =>
            pushActivity(
                userId,
                'info',
                `Reimbursement item added: ${itemDescription} (package ${packageReference}). View in Reimbursement claims.`,
                '/dashboard/reimbursement.html'
            ),
    };
}

function importReturnAdjustmentRow(db, userId, row) {
    const product = str(row.product);
    const amount = num(row.amount, NaN);
    if (!product || !Number.isFinite(amount) || amount <= 0) throw new Error('product and a positive amount are required');
    const reference = str(row.reference);
    const notes = str(row.notes);
    const status = str(row.status).toLowerCase() === 'pending' ? 'pending' : 'applied';
    db.run(
        `INSERT INTO return_adjustments (user_id, product, reference, amount, linked_sold_item_id, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, product, reference, amount, null, status, notes]
    );
    const id = parseResults(db.exec('SELECT last_insert_rowid() as id'))[0].id;
    if (status === 'applied') {
        return {
            id,
            activity: () =>
                pushActivity(
                    userId,
                    'return_deducted',
                    `Return / refund deducted: ${product} −£${amount.toFixed(2)}`,
                    '/dashboard/index.html'
                ),
        };
    }
    return { id, activity: null };
}

const IMPORTERS = {
    sold: importSoldRow,
    received: importReceivedRow,
    pending: importPendingRow,
    mark_delivered: importMarkDeliveredRow,
    reimbursement: importReimbursementRow,
    return_adjustment: importReturnAdjustmentRow,
};

/**
 * @param {import('sql.js').Database} db
 * @returns {{ imported: number, errors: Array<{ line: number, error: string }> }}
 */
async function runBulkImport(db, kind, userId, buffer) {
    const importer = IMPORTERS[kind];
    if (!importer) {
        return { imported: 0, errors: [{ line: 0, error: 'Unknown import type' }] };
    }

    let rows;
    try {
        rows = parseSpreadsheetBuffer(buffer);
    } catch (e) {
        return { imported: 0, errors: [{ line: 0, error: e.message || 'Could not read spreadsheet' }] };
    }

    if (rows.length > MAX_ROWS) {
        return { imported: 0, errors: [{ line: 0, error: `Too many rows (max ${MAX_ROWS})` }] };
    }

    const errors = [];
    let imported = 0;
    const activities = [];

    for (let i = 0; i < rows.length; i++) {
        const line = i + 2;
        try {
            const result = importer(db, userId, rows[i]);
            if (result && result.activity) activities.push(result.activity);
            imported++;
        } catch (err) {
            errors.push({ line, error: err.message || String(err) });
        }
    }

    if (imported > 0) {
        saveDb();
        for (const fn of activities) {
            try {
                await fn();
            } catch (e) {
                console.error('Bulk import activity error:', e);
            }
        }
    }

    return { imported, errors };
}

function templateSheetAoA(kind) {
    const T = {
        sold: [
            ['sold_date', 'item_name', 'quantity', 'earnings'],
            ['2026-03-01', 'Widget A', 1, 29.99],
        ],
        received: [
            ['reference', 'items_description', 'quantity', 'notes'],
            ['TRACK-001', 'Cable x2', 2, ''],
        ],
        pending: [
            ['reference', 'product', 'quantity', 'current_stage', 'est_completion', 'notes'],
            ['TRACK-001', 'Widget', 1, 'Listing', '2026-04-15', ''],
        ],
        mark_delivered: [
            ['reference', 'package_id'],
            ['TRACK-001', ''],
        ],
        reimbursement: [
            ['package_reference', 'item_description', 'reimbursement_type', 'notes'],
            ['TRACK-001', 'Damaged unit', 'Damaged Inventory', ''],
        ],
        return_adjustment: [
            ['product', 'amount', 'reference', 'notes', 'status'],
            ['Returned cable', 12.5, 'REF-1', '', 'applied'],
        ],
    };
    return T[kind] || null;
}

function buildTemplateBuffer(kind) {
    const aoa = templateSheetAoA(kind);
    if (!aoa) return null;
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, 'Import');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
    parseSpreadsheetBuffer,
    runBulkImport,
    buildTemplateBuffer,
    MAX_ROWS,
    KINDS: Object.keys(IMPORTERS),
};
