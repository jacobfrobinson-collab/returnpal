/**
 * Threaded item queries — client ↔ admin messages on a single query.
 */

/** Apply migrations needed for threaded queries (safe after reload from disk). */
function ensureQueryThreadSchema(db) {
    if (!db) return;
    const addCol = (sql) => {
        try {
            db.run(sql);
        } catch (e) {
            /* column exists or unsupported default — handled below */
        }
    };
    addCol("ALTER TABLE item_queries ADD COLUMN admin_reply TEXT DEFAULT ''");
    addCol("ALTER TABLE item_queries ADD COLUMN replied_at TEXT DEFAULT ''");
    addCol("ALTER TABLE item_queries ADD COLUMN last_sender TEXT DEFAULT 'client'");
    addCol("ALTER TABLE item_queries ADD COLUMN updated_at TEXT DEFAULT ''");
    if (!tableHasColumn(db, 'item_queries', 'updated_at')) {
        try {
            db.run('ALTER TABLE item_queries ADD COLUMN updated_at TEXT');
        } catch (e) {
            console.error('[queries] could not add updated_at:', e.message);
        }
    }
    if (tableHasColumn(db, 'item_queries', 'updated_at')) {
        try {
            db.run(
                `UPDATE item_queries SET updated_at = COALESCE(NULLIF(updated_at, ''), created_at, datetime('now'))
                 WHERE updated_at IS NULL OR updated_at = ''`
            );
        } catch (e) {
            /* ignore */
        }
    }
    if (!tableHasColumn(db, 'item_queries', 'last_sender')) {
        try {
            db.run("UPDATE item_queries SET last_sender = 'client' WHERE last_sender IS NULL OR last_sender = ''");
        } catch (e) {
            /* ignore */
        }
    }
    try {
        db.run(`
            CREATE TABLE IF NOT EXISTS item_query_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                query_id INTEGER NOT NULL,
                sender_role TEXT NOT NULL CHECK(sender_role IN ('client', 'admin')),
                body TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (query_id) REFERENCES item_queries(id) ON DELETE CASCADE
            )
        `);
        db.run('CREATE INDEX IF NOT EXISTS idx_item_query_messages_query ON item_query_messages(query_id)');
    } catch (e) {
        console.error('[queries] item_query_messages schema:', e.message);
        throw e;
    }
}

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

/** @returns {boolean} */
function tableHasColumn(db, table, column) {
    const info = parseResults(db.exec('PRAGMA table_info(' + table + ')'));
    return info.some((row) => String(row.name) === column);
}

/**
 * One-time backfill: legacy message + admin_reply → item_query_messages rows.
 * @param {import('sql.js').Database} db
 */
/**
 * @returns {boolean} true if any rows were written
 */
function backfillLegacyQueryMessages(db) {
    ensureQueryThreadSchema(db);
    if (!tableHasColumn(db, 'item_queries', 'last_sender')) {
        return false;
    }
    const hasTable = parseResults(
        db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='item_query_messages'")
    );
    if (!hasTable.length) return false;

    const hasUpdatedAt = tableHasColumn(db, 'item_queries', 'updated_at');
    let changed = false;
    const queries = parseResults(
        db.exec(
            `SELECT id, message, COALESCE(admin_reply, '') AS admin_reply, created_at, replied_at
             FROM item_queries`
        )
    );

    for (const q of queries) {
        const existing = parseResults(
            db.exec('SELECT COUNT(*) AS c FROM item_query_messages WHERE query_id = ?', [q.id])
        )[0];
        if (Number(existing?.c) > 0) continue;

        const initial = String(q.message || '').trim();
        if (initial) {
            db.run(
                `INSERT INTO item_query_messages (query_id, sender_role, body, created_at)
                 VALUES (?, 'client', ?, ?)`,
                [q.id, initial, q.created_at || null]
            );
            changed = true;
        }
        const adminBody = String(q.admin_reply || '').trim();
        if (adminBody) {
            db.run(
                `INSERT INTO item_query_messages (query_id, sender_role, body, created_at)
                 VALUES (?, 'admin', ?, ?)`,
                [q.id, adminBody, q.replied_at || q.created_at || null]
            );
            if (hasUpdatedAt) {
                db.run(
                    `UPDATE item_queries SET last_sender = 'admin', status = 'open', updated_at = datetime('now') WHERE id = ?`,
                    [q.id]
                );
            } else {
                db.run(
                    `UPDATE item_queries SET last_sender = 'admin', status = 'open' WHERE id = ?`,
                    [q.id]
                );
            }
            changed = true;
        } else if (initial) {
            if (hasUpdatedAt) {
                db.run(
                    `UPDATE item_queries SET last_sender = 'client', status = 'open', updated_at = datetime('now') WHERE id = ?`,
                    [q.id]
                );
            } else {
                db.run(
                    `UPDATE item_queries SET last_sender = 'client', status = 'open' WHERE id = ?`,
                    [q.id]
                );
            }
            changed = true;
        }
    }
    return changed;
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} queryId
 */
function listMessagesForQuery(db, queryId) {
    return parseResults(
        db.exec(
            `SELECT id, query_id, sender_role, body, created_at
             FROM item_query_messages
             WHERE query_id = ?
             ORDER BY datetime(created_at) ASC, id ASC`,
            [queryId]
        )
    );
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} queryId
 * @param {'client'|'admin'} senderRole
 * @param {string} body
 */
function appendQueryMessage(db, queryId, senderRole, body) {
    ensureQueryThreadSchema(db);
    const text = String(body || '').trim();
    if (text.length < 2) {
        throw new Error('Message too short');
    }
    const hasUpdatedAt = tableHasColumn(db, 'item_queries', 'updated_at');
    db.run(
        `INSERT INTO item_query_messages (query_id, sender_role, body) VALUES (?, ?, ?)`,
        [queryId, senderRole, text]
    );
    if (senderRole === 'admin') {
        if (hasUpdatedAt) {
            db.run(
                `UPDATE item_queries
                 SET last_sender = 'admin', status = 'open', updated_at = datetime('now'),
                     admin_reply = ?, replied_at = datetime('now')
                 WHERE id = ?`,
                [text, queryId]
            );
        } else {
            db.run(
                `UPDATE item_queries
                 SET last_sender = 'admin', status = 'open',
                     admin_reply = ?, replied_at = datetime('now')
                 WHERE id = ?`,
                [text, queryId]
            );
        }
    } else if (hasUpdatedAt) {
        db.run(
            `UPDATE item_queries
             SET last_sender = 'client', status = 'open', updated_at = datetime('now')
             WHERE id = ?`,
            [queryId]
        );
    } else {
        db.run(
            `UPDATE item_queries SET last_sender = 'client', status = 'open' WHERE id = ?`,
            [queryId]
        );
    }
    const rid = db.exec('SELECT last_insert_rowid() AS id');
    const messageId = rid[0]?.values?.[0]?.[0];
    return { messageId, lastSender: senderRole === 'admin' ? 'admin' : 'client' };
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 */
function listQueriesForUser(db, userId) {
    ensureQueryThreadSchema(db);
    backfillLegacyQueryMessages(db);
    const orderCol = tableHasColumn(db, 'item_queries', 'updated_at')
        ? 'datetime(COALESCE(updated_at, created_at))'
        : 'datetime(created_at)';
    const rows = parseResults(
        db.exec(
            `SELECT id, context_type, context_id, context_label, message, status,
                    COALESCE(last_sender, 'client') AS last_sender,
                    created_at,
                    COALESCE(admin_reply, '') AS admin_reply, COALESCE(replied_at, '') AS replied_at
             FROM item_queries WHERE user_id = ?
             ORDER BY ${orderCol} DESC
             LIMIT 100`,
            [userId]
        )
    );
    return rows.map((q) => ({
        ...q,
        messages: listMessagesForQuery(db, q.id),
        can_client_reply: String(q.last_sender) === 'admin' && String(q.status) === 'open',
    }));
}

/**
 * Admin inbox: threads waiting on ReturnPal (client spoke last).
 * @param {import('sql.js').Database} db
 */
function listOpenQueriesForAdmin(db) {
    ensureQueryThreadSchema(db);
    backfillLegacyQueryMessages(db);
    const orderCol = tableHasColumn(db, 'item_queries', 'updated_at')
        ? 'datetime(COALESCE(q.updated_at, q.created_at))'
        : 'datetime(q.created_at)';
    const rows = parseResults(
        db.exec(
            `SELECT q.id, q.user_id, q.context_type, q.context_id, q.context_label, q.message, q.status,
                    COALESCE(q.last_sender, 'client') AS last_sender,
                    q.created_at,
                    u.email, u.full_name
             FROM item_queries q
             JOIN users u ON u.id = q.user_id
             WHERE q.status = 'open'
               AND COALESCE(q.last_sender, 'client') = 'client'
             ORDER BY ${orderCol} DESC`
        )
    );
    return rows.map((q) => ({
        ...q,
        messages: listMessagesForQuery(db, q.id),
    }));
}

module.exports = {
    ensureQueryThreadSchema,
    tableHasColumn,
    backfillLegacyQueryMessages,
    listMessagesForQuery,
    appendQueryMessage,
    listQueriesForUser,
    listOpenQueriesForAdmin,
};
