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
 * @param {number} adminUserId
 * @param {string} action
 * @param {Record<string, unknown>} [detail]
 */
function logAdminAudit(db, adminUserId, action, detail) {
    try {
        const detailStr =
            detail && typeof detail === 'object' ? JSON.stringify(detail).slice(0, 4000) : String(detail || '');
        db.run('INSERT INTO admin_audit_log (admin_user_id, action, detail) VALUES (?, ?, ?)', [
            adminUserId,
            String(action || '').slice(0, 200),
            detailStr,
        ]);
        saveDb();
    } catch (e) {
        console.error('admin_audit_log insert failed:', e);
    }
}

/**
 * @param {import('sql.js').Database} db
 * @param {{ limit?: number, offset?: number }} [opts]
 */
function listAdminAudit(db, opts = {}) {
    const limit = Math.min(200, Math.max(1, parseInt(opts.limit, 10) || 80));
    const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
    const rows = parseResults(
        db.exec(
            `SELECT a.id, a.admin_user_id, a.action, a.detail, a.created_at,
                    u.email AS admin_email
             FROM admin_audit_log a
             LEFT JOIN users u ON u.id = a.admin_user_id
             ORDER BY a.id DESC LIMIT ? OFFSET ?`,
            [limit, offset]
        )
    );
    return rows;
}

module.exports = { logAdminAudit, listAdminAudit };
