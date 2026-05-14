const { saveDb } = require('../database');

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

/**
 * Normalise client specifier for grouping pending rows (match resolution style).
 * @param {string|number|null|undefined} spec
 */
function normalizePendingLegacyKey(spec) {
    if (spec == null || spec === '') return '';
    if (typeof spec === 'number' && Number.isFinite(spec)) return String(Math.floor(spec));
    const s = String(spec).trim();
    if (!s) return '';
    if (/^\d+$/.test(s)) return s;
    return s.toLowerCase();
}

/**
 * @param {import('sql.js').Database} db
 * @param {Array<{ line_number: number, specifier_raw: string, legacy_key: string, row_json: string }>} rows
 */
function insertPendingImportRows(db, meta, rows) {
    if (!rows || !rows.length) return 0;
    const adminId = meta.adminUserId;
    const kind = String(meta.kind || '').trim();
    const fn = String(meta.originalFilename || '').slice(0, 500);
    for (const r of rows) {
        db.run(
            `INSERT INTO bulk_import_pending_rows
             (admin_user_id, kind, original_filename, line_number, specifier_raw, legacy_key, row_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                adminId,
                kind,
                fn,
                r.line_number,
                String(r.specifier_raw || '').slice(0, 200),
                String(r.legacy_key || '').slice(0, 200),
                r.row_json,
            ]
        );
    }
    saveDb();
    return rows.length;
}

/**
 * Pending rows grouped by legacy_key + kind (not yet applied).
 */
function listPendingImportGroups(db, filter = {}) {
    const limit = Math.min(100, Math.max(1, parseInt(filter.limit, 10) || 40));
    const rows = parseResults(
        db.exec(
            `SELECT legacy_key, kind, COUNT(*) AS row_count, MIN(created_at) AS first_at,
                    MAX(original_filename) AS sample_filename
             FROM bulk_import_pending_rows
             WHERE applied_at IS NULL
             GROUP BY legacy_key, kind
             ORDER BY first_at DESC
             LIMIT ?`,
            [limit]
        )
    );
    return rows;
}

/**
 * @param {import('sql.js').Database} db
 * @param {{ userId: number, kind: string, legacyKey: string, applyImportRow: (db: import('sql.js').Database, kind: string, userId: number, row: Record<string, unknown>) => { table?: string, id?: number, activity?: () => Promise<void>, rollbackJson?: string } }} opts
 */
async function applyPendingRowsToUser(db, opts) {
    const userId = parseInt(opts.userId, 10);
    if (!Number.isFinite(userId) || userId < 1) {
        return { ok: false, error: 'Invalid user_id' };
    }
    const kind = String(opts.kind || '').trim();
    const legacyKey = opts.legacyKey != null ? String(opts.legacyKey) : '';
    const applyImportRow = opts.applyImportRow;
    if (typeof applyImportRow !== 'function') {
        return { ok: false, error: 'applyImportRow is required' };
    }

    const users = parseResults(db.exec('SELECT id FROM users WHERE id = ?', [userId]));
    if (!users.length) return { ok: false, error: 'User not found' };

    const pending = parseResults(
        db.exec(
            `SELECT id, row_json FROM bulk_import_pending_rows
             WHERE kind = ? AND applied_at IS NULL
               AND legacy_key = ?
             ORDER BY id ASC`,
            [kind, legacyKey]
        )
    );
    if (!pending.length) {
        return { ok: false, error: 'No pending rows for that import type and Client ID key' };
    }

    const errors = [];
    const inserted = [];
    const activities = [];
    let imported = 0;

    for (const pr of pending) {
        let rowObj;
        try {
            rowObj = JSON.parse(pr.row_json);
        } catch {
            errors.push({ pending_id: pr.id, error: 'Invalid stored row JSON' });
            continue;
        }
        try {
            const result = applyImportRow(db, kind, userId, rowObj);
            if (result && result.activity) activities.push(result.activity);
            imported++;
            if (result && result.table && result.id != null) {
                inserted.push({
                    entityTable: result.table,
                    entityId: result.id,
                    userId,
                    rollbackJson: result.rollbackJson || '',
                });
            }
            db.run(`UPDATE bulk_import_pending_rows SET applied_at = datetime('now'), applied_user_id = ? WHERE id = ?`, [
                userId,
                pr.id,
            ]);
        } catch (err) {
            errors.push({ pending_id: pr.id, line_hint: pr.id, error: err.message || String(err) });
        }
    }

    if (imported > 0) {
        saveDb();
        for (const fn of activities) {
            try {
                await fn();
            } catch (e) {
                console.error('Pending apply activity error:', e);
            }
        }
    }

    return {
        ok: true,
        imported,
        errors,
        inserted_count: inserted.length,
        inserted,
        pending_ids_touched: pending.length,
    };
}

module.exports = {
    normalizePendingLegacyKey,
    insertPendingImportRows,
    listPendingImportGroups,
    applyPendingRowsToUser,
};
