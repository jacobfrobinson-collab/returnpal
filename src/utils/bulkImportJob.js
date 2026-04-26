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
 * @param {import('sql.js').Database} db
 * @param {{
 *   adminUserId: number,
 *   kind: string,
 *   isMulti: boolean,
 *   originalFilename: string,
 *   targetUserId: number | null,
 *   rowCount: number,
 *   importedCount: number,
 *   errorCount: number,
 * }} meta
 */
function createBulkImportJob(db, meta) {
    db.run(
        `INSERT INTO bulk_import_jobs
         (admin_user_id, kind, is_multi, original_filename, target_user_id, row_count, imported_count, error_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            meta.adminUserId,
            meta.kind,
            meta.isMulti ? 1 : 0,
            String(meta.originalFilename || '').slice(0, 500),
            meta.targetUserId != null ? meta.targetUserId : null,
            meta.rowCount,
            meta.importedCount,
            meta.errorCount,
        ]
    );
    const id = parseResults(db.exec('SELECT last_insert_rowid() as id'))[0].id;
    saveDb();
    return id;
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} jobId
 * @param {Array<{ entityTable: string, entityId: number, userId: number, rollbackJson?: string }>} entries
 */
function addBulkImportEntries(db, jobId, entries) {
    for (const e of entries) {
        db.run(
            `INSERT INTO bulk_import_job_entries (job_id, entity_table, entity_id, user_id, rollback_json)
             VALUES (?, ?, ?, ?, ?)`,
            [jobId, e.entityTable, e.entityId, e.userId, e.rollbackJson || '']
        );
    }
    saveDb();
}

/**
 * @param {import('sql.js').Database} db
 * @param {{ clientId?: number, limit?: number }} [filter]
 */
function listBulkImportJobs(db, filter = {}) {
    const limit = Math.min(100, Math.max(1, parseInt(filter.limit, 10) || 40));
    let sql = `SELECT j.id, j.admin_user_id, j.kind, j.is_multi, j.original_filename, j.target_user_id,
                      j.row_count, j.imported_count, j.error_count, j.created_at, j.rolled_back_at,
                      ua.email AS admin_email
               FROM bulk_import_jobs j
               LEFT JOIN users ua ON ua.id = j.admin_user_id`;
    const params = [];
    if (filter.clientId != null && !isNaN(parseInt(filter.clientId, 10))) {
        const cid = parseInt(filter.clientId, 10);
        sql += ` WHERE j.target_user_id = ? OR j.id IN (
            SELECT job_id FROM bulk_import_job_entries WHERE user_id = ?
        )`;
        params.push(cid, cid);
    }
    sql += ' ORDER BY j.id DESC LIMIT ?';
    params.push(limit);
    return parseResults(db.exec(sql, params));
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} jobId
 * @param {number} adminUserId
 */
function rollbackBulkImportJob(db, jobId, adminUserId) {
    const jobs = parseResults(
        db.exec('SELECT * FROM bulk_import_jobs WHERE id = ?', [jobId])
    );
    if (!jobs.length) return { ok: false, error: 'Job not found' };
    const job = jobs[0];
    if (job.rolled_back_at) return { ok: false, error: 'Already rolled back' };

    const entries = parseResults(
        db.exec('SELECT * FROM bulk_import_job_entries WHERE job_id = ? ORDER BY id DESC', [jobId])
    );
    if (!entries.length) {
        return { ok: false, error: 'This job has no recorded rows to undo (or it was only validation errors).' };
    }

    for (const ent of entries) {
        const rb = (ent.rollback_json && String(ent.rollback_json).trim()) || '';
        if (rb) {
            try {
                const o = JSON.parse(rb);
                if (o && o.type === 'package_status' && o.package_id != null && o.previous_status) {
                    db.run('UPDATE packages SET status = ?, updated_at = datetime(\'now\') WHERE id = ?', [
                        String(o.previous_status).slice(0, 32),
                        o.package_id,
                    ]);
                    continue;
                }
            } catch {
                /* fall through to delete */
            }
        }
        const table = String(ent.entity_table || '');
        const id = parseInt(ent.entity_id, 10);
        const allowed = ['sold_items', 'received_items', 'pending_items', 'reimbursement_claims', 'return_adjustments'];
        if (!allowed.includes(table) || !Number.isFinite(id)) continue;
        if (table === 'reimbursement_claims') {
            db.run('DELETE FROM reimbursement_claim_photos WHERE claim_id = ?', [id]);
        }
        db.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
    }

    db.run(`UPDATE bulk_import_jobs SET rolled_back_at = datetime('now') WHERE id = ?`, [jobId]);
    saveDb();
    return { ok: true, job_id: jobId, entries_rolled: entries.length, admin_user_id: adminUserId };
}

module.exports = {
    createBulkImportJob,
    addBulkImportEntries,
    listBulkImportJobs,
    rollbackBulkImportJob,
};
