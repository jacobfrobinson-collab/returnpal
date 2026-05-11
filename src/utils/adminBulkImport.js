/**
 * Parse .xlsx / .xls / .csv buffers and import rows for admin client bulk actions.
 */
const XLSX = require('xlsx');
const { saveDb, pushActivity } = require('../database');

/** Large multi-client marketplace sheets (e.g. eBay exports) — keep bounded for sql.js memory. */
const MAX_ROWS = 15000;

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

/** Headers (after normalizeHeaderKey) that identify which client a row belongs to. */
const CLIENT_SPECIFIER_KEYS = [
    'client_id',
    'returnpal_client_id',
    'legacy_client_id',
    'old_client_id',
    'oldclientid',
    'clientid',
    'dashboard_client_id',
    'ebay_client_id',
    'client_code',
];

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
        item_nam: 'product',
        order_no: 'order_number',
        order_num: 'order_number',
        orderid: 'order_number',
        date_sold: 'sold_date',
        datesold: 'sold_date',
        saledate: 'sold_date',
        sale_date: 'sold_date',
    };
    return m[k] || k;
}

function isZipBasedSpreadsheet(buf) {
    return (
        buf.length >= 4 &&
        buf[0] === 0x50 &&
        buf[1] === 0x4b &&
        (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07 || buf[2] === 0x09)
    );
}

function isOleCompoundFile(buf) {
    return buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0;
}

/** Pick CSV field separator when SheetJS would otherwise treat ";" files as one column. */
function inferCsvFieldSeparator(buf) {
    const str = buf.toString('utf8');
    const firstNl = str.search(/\r?\n/);
    const firstLine = (firstNl === -1 ? str : str.slice(0, firstNl)).trim();
    if (/^sep=/i.test(firstLine) && firstLine.length > 4) {
        return firstLine.charAt(4);
    }
    const commas = (firstLine.match(/,/g) || []).length;
    const semis = (firstLine.match(/;/g) || []).length;
    const tabs = (firstLine.match(/\t/g) || []).length;
    if (semis > commas && semis > 0) return ';';
    if (tabs > commas && tabs > semis && tabs > 0) return '\t';
    return ',';
}

function readSpreadsheetWorkbook(buf) {
    const base = { type: 'buffer', cellDates: true };
    if (isZipBasedSpreadsheet(buf) || isOleCompoundFile(buf)) {
        return XLSX.read(buf, base);
    }
    return XLSX.read(buf, { ...base, FS: inferCsvFieldSeparator(buf) });
}

/**
 * @returns {Array<Record<string, unknown>>}
 */
function parseSpreadsheetBuffer(buffer) {
    const wb = readSpreadsheetWorkbook(buffer);
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

/**
 * Parse currency cells: £1.79, -£6.43, –£7.09 (unicode minus), 36.31, bare Excel numbers.
 * @param {unknown} v
 * @returns {number} NaN if not parseable
 */
function parseMoney(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    let s = String(v).trim();
    if (!s) return NaN;
    // Unicode minus / dashes used by Excel & locales → ASCII minus (before and after strip)
    s = s.replace(/[\u2212\u2013\u2014\u2012]/g, '-');
    // Strip currency symbols and spaces (keep digits, dot, comma, minus)
    s = s.replace(/[£$€\s]/gi, '');
    s = s.replace(/[\u2212\u2013\u2014\u2012]/g, '-');
    // UK-style thousands: 1,234.56 → remove commas
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) || /^-?\d+,\d{3}/.test(s)) {
        s = s.replace(/,/g, '');
    } else {
        // lone comma as decimal (1,79) rare in UK exports; if one comma and no dot, treat as decimal
        const commaDec = /^-?\d+,\d{1,2}$/.test(s);
        if (commaDec) s = s.replace(',', '.');
        else s = s.replace(/,/g, '');
    }
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
}

function str(v) {
    return v == null ? '' : String(v).trim();
}

function lookupUserBrief(db, userId) {
    const r = parseResults(
        db.exec(
            "SELECT id, email, full_name, COALESCE(legacy_client_id, '') AS legacy_client_id FROM users WHERE id = ?",
            [userId]
        )
    );
    if (!r.length) return null;
    return {
        user_id: r[0].id,
        email: r[0].email,
        name: r[0].full_name,
        legacy_client_id: r[0].legacy_client_id,
    };
}

function summarizeRow(kind, row) {
    switch (kind) {
        case 'sold': {
            const p = str(row.product) || '(product)';
            const o = str(row.order_number);
            return o ? p + ' (order ' + o + ')' : p;
        }
        case 'received':
            return (str(row.reference) || '(ref)') + ' — ' + (str(row.items_description).slice(0, 60) || '(desc)');
        case 'pending':
            return str(row.product) || str(row.reference) || '(pending)';
        case 'mark_delivered':
            return str(row.reference) || ('pkg#' + str(row.package_id));
        case 'reimbursement':
            return (str(row.package_reference) || '(pkg)') + ' — ' + (str(row.item_description).slice(0, 50) || '');
        case 'return_adjustment':
        case 'refunds':
            return (str(row.product) || '(product)') + ' £' + str(row.amount);
        default:
            return '';
    }
}

function pad2(n) {
    return n < 10 ? '0' + n : String(n);
}

const SOLD_DATE_MONTHS = {
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

/** Two-digit calendar years in spreadsheets (e.g. 26 → 2026, 99 → 1999). */
function expandTwoDigitYear(yy) {
    const n = parseInt(String(yy), 10);
    if (!Number.isFinite(n) || n < 0 || n > 99) return null;
    return n < 70 ? 2000 + n : 1900 + n;
}

/** Trim Excel text marker, NBSP, optional clock time (e.g. "05/02/2026 00:00:00"). */
function preprocessSoldDateString(s) {
    let s0 = String(s || '')
        .replace(/^\uFEFF/, '')
        .trim()
        .replace(/\u00A0/g, ' ')
        .replace(/\u2007/g, ' ');
    if (s0.startsWith("'")) s0 = s0.slice(1).trim();
    if (s0.length >= 2 && s0.startsWith('"') && s0.endsWith('"')) s0 = s0.slice(1, -1).trim();
    const tIdx = s0.indexOf('T');
    if (tIdx !== -1) s0 = s0.slice(0, tIdx).trim();
    else if (/^\d{4}-\d{2}-\d{2}\s/.test(s0)) s0 = s0.match(/^(\d{4}-\d{2}-\d{2})/)[1];
    if (/\d{1,2}:\d{2}/.test(s0)) {
        s0 = s0.replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(\s*[AaPp][Mm])?.*$/, '').trim();
    }
    return s0;
}

/**
 * Normalize sold_date from spreadsheet to YYYY-MM-DD.
 * UK-first: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (day before month when both parts ≤ 12).
 * If the middle value is > 12, treat as M/D/Y (e.g. 03/25/2026 → 25 Mar) so the date is still valid.
 * Also accepts two-digit years (e.g. 1/15/26, 15/1/26) with the same UK-first rules.
 * @param {unknown} v
 * @returns {string|null}
 */
function normalizeSoldDateForDb(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && Number.isFinite(v) && v > 20000 && v < 120000) {
        const serial = Math.floor(v);
        const epochMs = Date.UTC(1899, 11, 30) + serial * 86400000;
        const d = new Date(epochMs);
        if (!isNaN(d.getTime())) {
            return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
        }
    }
    if (v instanceof Date && !isNaN(v.getTime())) {
        return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
    }
    let s0 = preprocessSoldDateString(str(v));
    if (!s0) return null;

    const serialFloat = parseFloat(s0);
    if (
        Number.isFinite(serialFloat) &&
        serialFloat > 20000 &&
        serialFloat < 120000 &&
        /^-?\d{5,6}(\.\d+)?$/.test(s0.trim())
    ) {
        const serial = Math.floor(serialFloat);
        const epochMs = Date.UTC(1899, 11, 30) + serial * 86400000;
        const d = new Date(epochMs);
        if (!isNaN(d.getTime())) {
            return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
        }
    }

    const iso = s0.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return s0;

    const ymd = s0.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/);
    if (ymd) {
        const y = parseInt(ymd[1], 10);
        const mo = parseInt(ymd[2], 10);
        const day = parseInt(ymd[3], 10);
        if (y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
            return y + '-' + pad2(mo) + '-' + pad2(day);
        }
    }

    const dmy = s0.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (dmy) {
        const a = parseInt(dmy[1], 10);
        const b = parseInt(dmy[2], 10);
        const y = parseInt(dmy[3], 10);
        let day;
        let mo;
        if (b > 12) {
            mo = a;
            day = b;
        } else if (a > 12) {
            day = a;
            mo = b;
        } else {
            day = a;
            mo = b;
        }
        if (y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
            return y + '-' + pad2(mo) + '-' + pad2(day);
        }
    }

    const dmyShort = s0.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2})$/);
    if (dmyShort) {
        const a = parseInt(dmyShort[1], 10);
        const b = parseInt(dmyShort[2], 10);
        const y = expandTwoDigitYear(dmyShort[3]);
        if (y != null) {
            let day;
            let mo;
            if (b > 12) {
                mo = a;
                day = b;
            } else if (a > 12) {
                day = a;
                mo = b;
            } else {
                day = a;
                mo = b;
            }
            if (y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
                return y + '-' + pad2(mo) + '-' + pad2(day);
            }
        }
    }

    const txt = s0.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
    if (txt) {
        const day = parseInt(txt[1], 10);
        const monKey = txt[2].toLowerCase().slice(0, 3);
        const mo = SOLD_DATE_MONTHS[monKey];
        const y = parseInt(txt[3], 10);
        if (mo && y >= 1900 && y <= 2100 && day >= 1 && day <= 31) {
            return y + '-' + pad2(mo) + '-' + pad2(day);
        }
    }

    const usTxt = s0.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/);
    if (usTxt) {
        const monKey = usTxt[1].toLowerCase().slice(0, 3);
        const mo = SOLD_DATE_MONTHS[monKey];
        const day = parseInt(usTxt[2], 10);
        const y = parseInt(usTxt[3], 10);
        if (mo && y >= 1900 && y <= 2100 && day >= 1 && day <= 31) {
            return y + '-' + pad2(mo) + '-' + pad2(day);
        }
    }

    return null;
}

/**
 * Label for admin preview “Sold date” column (Record sales).
 * @param {Record<string, unknown>} dataRow
 * @returns {string}
 */
function soldDatePreviewLabel(dataRow) {
    const n = normalizeSoldDateForDb(dataRow.sold_date);
    if (n) return n;
    const raws = str(dataRow.sold_date);
    if (!raws) return 'empty → today on import';
    return raws.length > 44 ? raws.slice(0, 44) + '…' : raws;
}

/** @returns {{ reference: string, product: string, qty: number, soldDateParam: string|null, unit: number, total: number, profit: number, margin: number, orderNumber: string }} */
function parseSoldRowFields(row) {
    const product = str(row.product);
    if (!product) throw new Error('item name (product) is required');
    const reference = str(row.reference);
    const qty = Math.max(1, parseInt(row.quantity, 10) || 1);
    const soldDateParam = normalizeSoldDateForDb(row.sold_date);

    const hasEarningsCol = Object.prototype.hasOwnProperty.call(row, 'earnings');
    const earningsStr = hasEarningsCol ? str(row.earnings) : '';
    const earningsNum = hasEarningsCol && earningsStr !== '' ? parseMoney(row.earnings) : NaN;

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
    const orderNumber = str(row.order_number).slice(0, 200);
    return { reference, product, qty, soldDateParam, unit, total, profit, margin, orderNumber };
}

function importSoldRow(db, userId, row) {
    const { reference, product, qty, soldDateParam, unit, total, profit, margin, orderNumber } = parseSoldRowFields(row);

    db.run(
        `INSERT INTO sold_items (user_id, reference, product, quantity, unit_price, total_revenue, profit, margin, sold_date, order_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?)`,
        [userId, reference, product, qty, unit, total, profit, margin, soldDateParam, orderNumber]
    );
    const id = parseResults(db.exec('SELECT last_insert_rowid() as id'))[0].id;
    const amount = total || unit * qty;
    const msg = 'Item "' + product + '" sold for £' + amount.toFixed(2);
    return {
        id,
        table: 'sold_items',
        rollbackJson: '',
        activity: () => pushActivity(userId, 'item_sold', msg, '/dashboard/sold-items.html'),
    };
}

function importReceivedRow(db, userId, row) {
    const reference = str(row.reference);
    const desc = str(row.items_description);
    if (!reference || !desc) throw new Error('reference and items_description are required');
    const qty = Math.max(1, parseInt(row.quantity, 10) || 1);
    const notes = str(row.notes);
    const onum = str(row.order_number).slice(0, 200);
    const pkgMatch = parseResults(
        db.exec('SELECT id FROM packages WHERE user_id = ? AND reference = ? LIMIT 1', [userId, reference.slice(0, 255)])
    );
    const packageId = pkgMatch[0] ? pkgMatch[0].id : null;
    db.run(
        'INSERT INTO received_items (user_id, package_id, reference, items_description, quantity, notes, order_number) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, packageId, reference.slice(0, 255), desc.slice(0, 1000), qty, notes.slice(0, 2000), onum]
    );
    const id = parseResults(db.exec('SELECT last_insert_rowid() as id'))[0].id;
    const msg = 'Package received: ' + reference + (desc ? ' – ' + desc.slice(0, 80) : '');
    return {
        id,
        table: 'received_items',
        rollbackJson: '',
        activity: () => pushActivity(userId, 'package_received', msg, '/dashboard/received.html'),
    };
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
    const onum = str(row.order_number).slice(0, 200);
    db.run(
        `INSERT INTO pending_items (user_id, reference, product, quantity, current_stage, est_completion, notes, order_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, reference, product, qty, stage, est, notes, onum]
    );
    const id = parseResults(db.exec('SELECT last_insert_rowid() as id'))[0].id;
    const msg = 'Item added to pending: ' + (product || reference || '');
    return {
        id,
        table: 'pending_items',
        rollbackJson: '',
        activity: () => pushActivity(userId, 'item_pending', msg, '/dashboard/item-pending.html'),
    };
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
    const statusRows = parseResults(db.exec('SELECT status FROM packages WHERE id = ?', [pkg.id]));
    const previousStatus = statusRows[0] && statusRows[0].status ? String(statusRows[0].status) : 'In Transit';
    const onum = str(row.order_number).slice(0, 200);
    if (onum) {
        db.run(`UPDATE packages SET status = ?, updated_at = datetime('now'), order_number = ? WHERE id = ?`, [
            'Delivered',
            onum,
            pkg.id,
        ]);
    } else {
        db.run(`UPDATE packages SET status = ?, updated_at = datetime('now') WHERE id = ?`, ['Delivered', pkg.id]);
    }
    const msg = 'Package ' + (pkg.reference || '') + ' marked as delivered';
    return {
        id: pkg.id,
        table: 'packages',
        rollbackJson: JSON.stringify({ type: 'package_status', package_id: pkg.id, previous_status: previousStatus }),
        activity: () => pushActivity(userId, 'package_delivered', msg, '/dashboard/packages.html'),
    };
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
    const onum = str(row.order_number).slice(0, 200);
    db.run(
        'INSERT INTO reimbursement_claims (user_id, package_reference, item_description, reimbursement_type, notes, order_number) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, packageReference, itemDescription, reimbType, notes, onum]
    );
    const claimId = parseResults(db.exec('SELECT last_insert_rowid() as id'))[0].id;
    return {
        id: claimId,
        table: 'reimbursement_claims',
        rollbackJson: '',
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
    const onum = str(row.order_number).slice(0, 200);
    const status = str(row.status).toLowerCase() === 'pending' ? 'pending' : 'applied';
    let linkedSoldItemId = null;
    if (row.linked_sold_item_id != null && row.linked_sold_item_id !== '') {
        const parsed = parseInt(row.linked_sold_item_id, 10);
        if (Number.isFinite(parsed)) linkedSoldItemId = parsed;
    }
    if (!linkedSoldItemId && onum) {
        const matchByOn = parseResults(
            db.exec(
                `SELECT id FROM sold_items
                 WHERE user_id = ? AND order_number = ?
                 ORDER BY sold_date DESC, id DESC
                 LIMIT 1`,
                [userId, onum]
            )
        );
        if (matchByOn.length) linkedSoldItemId = matchByOn[0].id;
    }
    if (!linkedSoldItemId && reference) {
        const match = parseResults(
            db.exec(
                `SELECT id FROM sold_items
                 WHERE user_id = ? AND reference = ?
                 ORDER BY sold_date DESC, id DESC
                 LIMIT 1`,
                [userId, reference]
            )
        );
        if (match.length) linkedSoldItemId = match[0].id;
    }
    db.run(
        `INSERT INTO return_adjustments (user_id, product, reference, amount, linked_sold_item_id, status, notes, order_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, product, reference, amount, linkedSoldItemId, status, notes, onum]
    );
    const id = parseResults(db.exec('SELECT last_insert_rowid() as id'))[0].id;
    if (status === 'applied') {
        return {
            id,
            table: 'return_adjustments',
            rollbackJson: '',
            activity: () =>
                pushActivity(
                    userId,
                    'return_deducted',
                    `Return / refund deducted: ${product} −£${amount.toFixed(2)}`,
                    '/dashboard/index.html'
                ),
        };
    }
    return { id, table: 'return_adjustments', rollbackJson: '', activity: null };
}

const IMPORTERS = {
    sold: importSoldRow,
    received: importReceivedRow,
    pending: importPendingRow,
    mark_delivered: importMarkDeliveredRow,
    reimbursement: importReimbursementRow,
    return_adjustment: importReturnAdjustmentRow,
    refunds: importReturnAdjustmentRow,
};

/**
 * First non-empty client specifier from a row (Client ID, Old Client ID, etc.).
 * @param {Record<string, unknown>} row
 * @returns {string|number|null}
 */
function extractClientSpecifier(row) {
    for (const key of CLIENT_SPECIFIER_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
        const v = row[key];
        if (v == null || v === '') continue;
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        const s = str(v);
        if (s) return s;
    }
    return null;
}

/**
 * Strip client-routing columns so importers only see data fields.
 * @param {Record<string, unknown>} row
 */
function rowWithoutClientSpecifier(row) {
    const o = { ...row };
    for (const key of CLIENT_SPECIFIER_KEYS) delete o[key];
    return o;
}

/**
 * Resolve dashboard client: numeric id (14, "0014") or legacy / old client id string.
 * @param {import('sql.js').Database} db
 * @param {string|number} raw
 * @returns {{ userId: number } | { error: string }}
 */
function resolveUserIdFromClientSpecifier(db, raw) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        const intId = Math.floor(raw);
        const byId = parseResults(db.exec('SELECT id FROM users WHERE id = ?', [intId]));
        if (byId.length) return { userId: intId };
        const leg = parseResults(
            db.exec('SELECT id FROM users WHERE TRIM(legacy_client_id) = ?', [String(intId)])
        );
        if (leg.length === 1) return { userId: leg[0].id };
        if (leg.length > 1) return { error: 'Multiple clients share that legacy Client ID' };
        return { error: 'No client with that Client ID' };
    }

    const s = str(raw);
    if (!s) return { error: 'Missing Client ID' };

    if (/^\d+$/.test(s)) {
        const intId = parseInt(s, 10);
        const byId = parseResults(db.exec('SELECT id FROM users WHERE id = ?', [intId]));
        if (byId.length) return { userId: intId };
    }

    const legacyRows = parseResults(
        db.exec(
            `SELECT id FROM users
             WHERE legacy_client_id IS NOT NULL AND TRIM(legacy_client_id) <> ''
               AND LOWER(TRIM(legacy_client_id)) = LOWER(TRIM(?))`,
            [s]
        )
    );
    if (legacyRows.length === 1) return { userId: legacyRows[0].id };
    if (legacyRows.length > 1) return { error: 'Multiple clients share that Old Client ID' };

    if (/^\d+$/.test(s)) {
        return { error: 'No client with that Client ID' };
    }
    return { error: 'No client with that Old Client ID' };
}

/**
 * Same validation as importers without writing (except mark_delivered reads package row).
 * @param {import('sql.js').Database} db
 */
function dryValidateRow(db, kind, userId, row) {
    if (kind === 'sold') {
        parseSoldRowFields(row);
        return;
    }
    if (kind === 'received') {
        const reference = str(row.reference);
        const desc = str(row.items_description);
        if (!reference || !desc) throw new Error('reference and items_description are required');
        return;
    }
    if (kind === 'pending') {
        const product = str(row.product);
        if (!product) throw new Error('product is required');
        return;
    }
    if (kind === 'mark_delivered') {
        const pid = row.package_id != null && row.package_id !== '' ? parseInt(row.package_id, 10) : NaN;
        const reference = str(row.reference);
        let pkg;
        if (Number.isFinite(pid)) {
            const rows = parseResults(db.exec('SELECT id, user_id, reference FROM packages WHERE id = ?', [pid]));
            pkg = rows[0];
            if (!pkg || pkg.user_id !== userId) throw new Error('package_id not found for this client');
        } else if (reference) {
            const rows = parseResults(
                db.exec('SELECT id, user_id, reference FROM packages WHERE user_id = ? AND reference = ? LIMIT 1', [
                    userId,
                    reference,
                ])
            );
            pkg = rows[0];
            if (!pkg) throw new Error('No package with that reference');
        } else {
            throw new Error('reference or package_id is required');
        }
        return;
    }
    if (kind === 'reimbursement') {
        const packageReference = str(row.package_reference);
        const itemDescription = str(row.item_description);
        if (!packageReference || !itemDescription) throw new Error('package_reference and item_description are required');
        return;
    }
    if (kind === 'return_adjustment' || kind === 'refunds') {
        const product = str(row.product);
        const amount = num(row.amount, NaN);
        if (!product || !Number.isFinite(amount) || amount <= 0) throw new Error('product and a positive amount are required');
        return;
    }
    throw new Error('Unknown import type');
}

/**
 * @param {import('sql.js').Database} db
 * @param {{ kind: string, userId: number, buffer: Buffer, multi: boolean }} opts
 */
function previewBulkImport(db, opts) {
    const { kind, userId, buffer, multi } = opts;
    const importer = IMPORTERS[kind];
    if (!importer) {
        return { rows: [], summary: { error: 'Unknown import type' } };
    }
    let rows;
    try {
        rows = parseSpreadsheetBuffer(buffer);
    } catch (e) {
        return { rows: [], summary: { error: e.message || 'Could not read spreadsheet' } };
    }
    if (rows.length > MAX_ROWS) {
        return { rows: [], summary: { error: `Too many rows (max ${MAX_ROWS})` } };
    }
    const out = [];
    let ok = 0;
    let bad = 0;
    let rowsWithWarnings = 0;
    for (let i = 0; i < rows.length; i++) {
        const line = i + 2;
        let effUser = userId;
        let resolved = null;
        let dataRow = rows[i];
        if (multi) {
            const spec = extractClientSpecifier(rows[i]);
            if (spec == null || spec === '') {
                out.push({
                    line,
                    ok: false,
                    error: 'Missing Client ID or Old Client ID column for this row',
                    summary: '',
                    ...(kind === 'sold' ? { sold_date_preview: soldDatePreviewLabel(rows[i]) } : {}),
                });
                bad++;
                continue;
            }
            const res = resolveUserIdFromClientSpecifier(db, spec);
            if (res.error) {
                out.push({
                    line,
                    ok: false,
                    error: res.error,
                    specifier: String(spec),
                    summary: '',
                    ...(kind === 'sold' ? { sold_date_preview: soldDatePreviewLabel(rows[i]) } : {}),
                });
                bad++;
                continue;
            }
            effUser = res.userId;
            resolved = lookupUserBrief(db, effUser);
            dataRow = rowWithoutClientSpecifier(rows[i]);
        } else {
            resolved = lookupUserBrief(db, userId);
        }
        const warnings = [];
        if (kind === 'sold' && dataRow.sold_date != null && dataRow.sold_date !== '' && !normalizeSoldDateForDb(dataRow.sold_date)) {
            const rawShow = str(dataRow.sold_date).replace(/\s+/g, ' ').slice(0, 48);
            warnings.push(
                'sold_date not recognised (use UK DD/MM/YYYY or DD/MM/YY, DD-MM-YYYY, YYYY-MM-DD, or e.g. 5 Feb 2026); if imported, today’s date will be used' +
                    (rawShow ? ` — cell was: ${rawShow}` : '')
            );
        }
        try {
            dryValidateRow(db, kind, effUser, dataRow);
            ok++;
            if (warnings.length) rowsWithWarnings++;
            out.push({
                line,
                ok: true,
                warnings,
                user_id: effUser,
                resolved_email: resolved ? resolved.email : null,
                resolved_name: resolved ? resolved.name : null,
                legacy_client_id: resolved ? resolved.legacy_client_id : null,
                summary: summarizeRow(kind, dataRow),
                ...(kind === 'sold' ? { sold_date_preview: soldDatePreviewLabel(dataRow) } : {}),
            });
        } catch (e) {
            bad++;
            out.push({
                line,
                ok: false,
                error: e.message || String(e),
                user_id: effUser,
                resolved_email: resolved ? resolved.email : null,
                resolved_name: resolved ? resolved.name : null,
                summary: summarizeRow(kind, dataRow),
                ...(kind === 'sold' ? { sold_date_preview: soldDatePreviewLabel(dataRow) } : {}),
            });
        }
    }
    return { rows: out, summary: { total: rows.length, ok, bad, rows_with_warnings: rowsWithWarnings } };
}

/**
 * @param {import('sql.js').Database} db
 * @returns {{ imported: number, errors: Array<{ line: number, error: string, user_id?: number }>, inserted: Array<{ entityTable: string, entityId: number, userId: number, rollbackJson: string }> }}
 */
async function runBulkImport(db, kind, userId, buffer, options = {}) {
    const importer = IMPORTERS[kind];
    if (!importer) {
        return { imported: 0, errors: [{ line: 0, error: 'Unknown import type' }], inserted: [], row_count: 0 };
    }

    let rows;
    try {
        rows = parseSpreadsheetBuffer(buffer);
    } catch (e) {
        return { imported: 0, errors: [{ line: 0, error: e.message || 'Could not read spreadsheet' }], inserted: [], row_count: 0 };
    }

    if (rows.length > MAX_ROWS) {
        return { imported: 0, errors: [{ line: 0, error: `Too many rows (max ${MAX_ROWS})` }], inserted: [], row_count: rows.length };
    }

    const errors = [];
    let imported = 0;
    const activities = [];
    const inserted = [];

    for (let i = 0; i < rows.length; i++) {
        const line = i + 2;
        try {
            const result = importer(db, userId, rows[i]);
            if (result && result.activity) activities.push(result.activity);
            imported++;
            if (result && result.table) {
                inserted.push({
                    entityTable: result.table,
                    entityId: result.id,
                    userId,
                    rollbackJson: result.rollbackJson || '',
                });
            }
        } catch (err) {
            errors.push({ line, error: err.message || String(err), user_id: userId });
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

    return { imported, errors, inserted, row_count: rows.length };
}

/**
 * Same as runBulkImport but each row must include Client ID or Old Client ID; rows are routed to that user.
 * @param {import('sql.js').Database} db
 * @returns {{ imported: number, errors: Array<{ line: number, error: string }>, by_user?: Record<string, number> }}
 */
async function runBulkImportMulti(db, kind, buffer) {
    const importer = IMPORTERS[kind];
    if (!importer) {
        return { imported: 0, errors: [{ line: 0, error: 'Unknown import type' }], inserted: [], by_user: {}, row_count: 0 };
    }

    let rows;
    try {
        rows = parseSpreadsheetBuffer(buffer);
    } catch (e) {
        return { imported: 0, errors: [{ line: 0, error: e.message || 'Could not read spreadsheet' }], inserted: [], by_user: {}, row_count: 0 };
    }

    if (rows.length > MAX_ROWS) {
        return { imported: 0, errors: [{ line: 0, error: `Too many rows (max ${MAX_ROWS})` }], inserted: [], by_user: {}, row_count: rows.length };
    }

    const errors = [];
    let imported = 0;
    const activities = [];
    const byUser = {};
    const inserted = [];

    for (let i = 0; i < rows.length; i++) {
        const line = i + 2;
        const spec = extractClientSpecifier(rows[i]);
        if (spec == null || spec === '') {
            errors.push({ line, error: 'Missing Client ID or Old Client ID column for this row' });
            continue;
        }
        const resolved = resolveUserIdFromClientSpecifier(db, spec);
        if (resolved.error) {
            errors.push({ line, error: resolved.error });
            continue;
        }
        const userId = resolved.userId;
        const dataRow = rowWithoutClientSpecifier(rows[i]);
        try {
            const result = importer(db, userId, dataRow);
            if (result && result.activity) activities.push(result.activity);
            imported++;
            const k = String(userId);
            byUser[k] = (byUser[k] || 0) + 1;
            if (result && result.table) {
                inserted.push({
                    entityTable: result.table,
                    entityId: result.id,
                    userId,
                    rollbackJson: result.rollbackJson || '',
                });
            }
        } catch (err) {
            errors.push({ line, error: err.message || String(err), user_id: userId });
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

    return { imported, errors, by_user: byUser, inserted, row_count: rows.length };
}

function templateSheetAoA(kind, options = {}) {
    const multi = !!(options && options.multi);
    const T = {
        sold: [
            ['sold_date', 'order_number', 'item_name', 'quantity', 'earnings'],
            ['2026-03-01', 'ORD-1001', 'Widget A', 1, 29.99],
        ],
        received: [
            ['reference', 'order_number', 'items_description', 'quantity', 'notes'],
            ['TRACK-001', 'ORD-1001', 'Cable x2', 2, ''],
        ],
        pending: [
            ['reference', 'order_number', 'product', 'quantity', 'current_stage', 'est_completion', 'notes'],
            ['TRACK-001', 'ORD-1001', 'Widget', 1, 'Listing', '2026-04-15', ''],
        ],
        mark_delivered: [
            ['reference', 'package_id', 'order_number'],
            ['TRACK-001', '', 'ORD-1001'],
        ],
        reimbursement: [
            ['package_reference', 'order_number', 'item_description', 'reimbursement_type', 'notes'],
            ['TRACK-001', 'ORD-1001', 'Damaged unit', 'Damaged Inventory', ''],
        ],
        return_adjustment: [
            ['order_number', 'product', 'amount', 'reference', 'linked_sold_item_id', 'notes', 'status'],
            ['ORD-1001', 'Returned cable', 12.5, 'REF-1', '', '', 'applied'],
        ],
        refunds: [
            ['order_number', 'product', 'amount', 'reference', 'linked_sold_item_id', 'notes', 'status'],
            ['ORD-1001', 'Returned cable', 12.5, 'REF-1', '', '', 'applied'],
        ],
    };
    const base = T[kind] || null;
    if (!base) return null;
    if (!multi) return base;
    return base.map((row, i) => {
        if (i === 0) return ['Client ID', ...row];
        if (i === 1) return ['0014', ...row];
        return ['', ...row];
    });
}

function buildTemplateBuffer(kind, options) {
    const aoa = templateSheetAoA(kind, options);
    if (!aoa) return null;
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, 'Import');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
    parseSpreadsheetBuffer,
    runBulkImport,
    runBulkImportMulti,
    previewBulkImport,
    buildTemplateBuffer,
    resolveUserIdFromClientSpecifier,
    extractClientSpecifier,
    normalizeSoldDateForDb,
    MAX_ROWS,
    KINDS: Object.keys(IMPORTERS),
};
