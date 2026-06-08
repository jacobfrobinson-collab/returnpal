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

function wasEmailSent(db, userId, kind, refKey) {
    const rows = parseResults(
        db.exec('SELECT id FROM email_log WHERE user_id = ? AND kind = ? AND ref_key = ? LIMIT 1', [
            userId,
            String(kind),
            String(refKey),
        ])
    );
    return rows.length > 0;
}

function recordEmailSent(db, userId, kind, refKey) {
    if (wasEmailSent(db, userId, kind, refKey)) return false;
    db.run('INSERT INTO email_log (user_id, kind, ref_key) VALUES (?, ?, ?)', [
        userId,
        String(kind),
        String(refKey),
    ]);
    saveDb();
    return true;
}

module.exports = { wasEmailSent, recordEmailSent };
