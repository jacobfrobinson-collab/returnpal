const express = require('express');
const { getDb, saveDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const {
    ensureQueryThreadSchema,
    backfillLegacyQueryMessages,
    appendQueryMessage,
    deleteClientMessage,
    deleteQueryThread,
    listQueriesForUser,
    listMessagesForQuery,
    enrichMessagesForClientView,
    tableHasColumn,
} = require('../utils/itemQueryThread');

const router = express.Router();

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

// POST /api/queries — client starts a new query thread
router.post('/', authMiddleware, async (req, res) => {
    try {
        const { context_type, context_id, context_label, message } = req.body;
        const msg = message != null ? String(message).trim() : '';
        if (!msg || msg.length < 5) {
            return res.status(400).json({ error: 'Please enter a message (at least 5 characters).' });
        }
        const ctx = String(context_type || 'general').slice(0, 40);
        const cid = context_id != null ? parseInt(context_id, 10) : null;
        const label = context_label != null ? String(context_label).slice(0, 500) : '';

        const db = await getDb();
        ensureQueryThreadSchema(db);
        if (tableHasColumn(db, 'item_queries', 'last_sender')) {
            db.run(
                `INSERT INTO item_queries (user_id, context_type, context_id, context_label, message, status, last_sender)
                 VALUES (?, ?, ?, ?, ?, 'open', 'client')`,
                [req.user.id, ctx, Number.isFinite(cid) ? cid : null, label, msg]
            );
        } else {
            db.run(
                `INSERT INTO item_queries (user_id, context_type, context_id, context_label, message, status)
                 VALUES (?, ?, ?, ?, ?, 'open')`,
                [req.user.id, ctx, Number.isFinite(cid) ? cid : null, label, msg]
            );
        }
        const rid = db.exec('SELECT last_insert_rowid() as id');
        const id = rid[0].values[0][0];
        db.run(
            `INSERT INTO item_query_messages (query_id, sender_role, body) VALUES (?, 'client', ?)`,
            [id, msg]
        );
        saveDb();
        try {
            const { notifyAdminClientQuery } = require('../utils/adminQueryNotification');
            await notifyAdminClientQuery(db, {
                queryId: id,
                clientUserId: req.user.id,
                message: msg,
                contextLabel: label,
                contextType: ctx,
                isFollowUp: false,
            });
        } catch (e) {
            console.error('[admin-query-notify] new query:', e.message || e);
        }
        res.status(201).json({ id, message: 'Query submitted. We will get back to you.' });
    } catch (err) {
        console.error('Create query error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/queries — my query threads with messages
router.get('/', authMiddleware, async (req, res) => {
    try {
        const db = await getDb();
        ensureQueryThreadSchema(db);
        if (backfillLegacyQueryMessages(db)) {
            saveDb();
        }
        const queries = listQueriesForUser(db, req.user.id);
        res.json({ queries });
    } catch (err) {
        console.error('List queries error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/queries/:id/messages — client follow-up in an existing thread
router.post('/:id/messages', authMiddleware, async (req, res) => {
    try {
        const queryId = parseInt(req.params.id, 10);
        if (!Number.isFinite(queryId)) {
            return res.status(400).json({ error: 'Invalid query id' });
        }
        const body = String(req.body.message || req.body.body || '').trim();
        if (body.length < 5) {
            return res.status(400).json({ error: 'Please enter at least 5 characters.' });
        }

        const db = await getDb();
        const rows = parseResults(
            db.exec(
                `SELECT id, user_id, context_type, context_label, status, COALESCE(last_sender, 'client') AS last_sender
                 FROM item_queries WHERE id = ?`,
                [queryId]
            )
        );
        if (!rows.length) return res.status(404).json({ error: 'Query not found' });
        const q = rows[0];
        if (Number(q.user_id) !== Number(req.user.id)) {
            return res.status(403).json({ error: 'Not your query' });
        }
        if (String(q.status) !== 'open') {
            return res.status(400).json({ error: 'This conversation is closed.' });
        }
        if (String(q.last_sender) !== 'admin') {
            return res.status(400).json({
                error: 'You can add a follow-up after ReturnPal has replied. If you have a new topic, start a new query.',
            });
        }

        appendQueryMessage(db, queryId, 'client', body);
        const msgIdRow = parseResults(db.exec('SELECT last_insert_rowid() AS id'));
        const messageId = msgIdRow[0]?.id;
        saveDb();

        try {
            const { notifyAdminClientQuery } = require('../utils/adminQueryNotification');
            await notifyAdminClientQuery(db, {
                queryId,
                clientUserId: req.user.id,
                message: body,
                contextLabel: q.context_label || '',
                contextType: q.context_type || 'general',
                isFollowUp: true,
                messageId,
            });
        } catch (e) {
            console.error('[admin-query-notify] follow-up:', e.message || e);
        }

        const qRow = parseResults(db.exec('SELECT status, last_sender FROM item_queries WHERE id = ?', [queryId]))[0];
        const msgs = listMessagesForQuery(db, queryId);
        res.json({
            message: 'Follow-up sent',
            messages: enrichMessagesForClientView(qRow || { status: 'open' }, msgs),
            can_client_reply: false,
        });
    } catch (err) {
        console.error('Client query follow-up error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/queries/:id/messages/:messageId — remove one of your messages (after ReturnPal has replied)
router.delete('/:id/messages/:messageId', authMiddleware, async (req, res) => {
    try {
        const queryId = parseInt(req.params.id, 10);
        const messageId = parseInt(req.params.messageId, 10);
        if (!Number.isFinite(queryId) || !Number.isFinite(messageId)) {
            return res.status(400).json({ error: 'Invalid id' });
        }
        const db = await getDb();
        ensureQueryThreadSchema(db);
        const result = deleteClientMessage(db, req.user.id, queryId, messageId);
        if (result.error === 'not_found') {
            return res.status(404).json({ error: 'Query or message not found' });
        }
        if (result.error === 'closed') {
            return res.status(400).json({ error: 'This conversation is closed.' });
        }
        if (result.error === 'admin_not_replied') {
            return res.status(400).json({
                error: 'You can remove messages after ReturnPal has replied to this thread.',
            });
        }
        if (result.error === 'not_yours') {
            return res.status(403).json({ error: 'You can only delete your own messages.' });
        }
        if (result.error === 'message_not_found') {
            return res.status(404).json({ error: 'Message not found' });
        }
        saveDb();
        if (result.deleted === 'thread') {
            return res.json({ message: 'Conversation removed', deleted: 'thread' });
        }
        const qRow = parseResults(db.exec('SELECT status, last_sender FROM item_queries WHERE id = ?', [queryId]))[0];
        res.json({
            message: 'Message removed',
            deleted: 'message',
            messages: enrichMessagesForClientView(qRow || { status: 'open' }, result.messages),
            can_client_reply: qRow && String(qRow.last_sender) === 'admin',
        });
    } catch (err) {
        console.error('Delete query message error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/queries/:id — remove entire conversation
router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const queryId = parseInt(req.params.id, 10);
        if (!Number.isFinite(queryId)) {
            return res.status(400).json({ error: 'Invalid query id' });
        }
        const db = await getDb();
        const result = deleteQueryThread(db, req.user.id, queryId);
        if (result.error === 'not_found') {
            return res.status(404).json({ error: 'Query not found' });
        }
        saveDb();
        res.json({ message: 'Conversation removed', deleted: 'thread' });
    } catch (err) {
        console.error('Delete query thread error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
