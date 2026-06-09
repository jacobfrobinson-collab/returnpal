'use strict';

const { parseClientPreferences } = require('./clientPreferences');

const TEMPLATES = {
    item_sold: (p) => ({
        content: `**Item sold** — ${p.product || 'Item'} for ${p.amount_label || '£0.00'}`,
    }),
    payout_paid: (p) => ({
        content: `**Payout sent** — ${p.period_label || p.period} ${p.amount_label || ''}${p.bank_reference ? ` (ref: ${p.bank_reference})` : ''}`,
    }),
    query_reply: (p) => ({
        content: `**Query reply** — ReturnPal replied to your item query${p.subject ? `: ${p.subject}` : ''}`,
    }),
    package_delivered: (p) => ({
        content: `**Package delivered** — ${p.reference || 'Package'} received at ReturnPal`,
    }),
    package_received: (p) => ({
        content: `**Package checked in** — ${p.reference || 'Package'}${p.description ? `: ${p.description}` : ''}`,
    }),
    high_value_received: (p) => ({
        content: `**High-value item received** — ${p.product || 'Item'} (${p.amount_label || ''})`,
    }),
};

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

function webhookEnabled(prefs, event) {
    const key = 'webhook_' + event;
    if (prefs[key] === false) return false;
    return true;
}

async function postWebhook(url, body, isSlack) {
    if (!url || !url.startsWith('http')) return false;
    try {
        const payload = isSlack
            ? { text: body.content }
            : { content: body.content };
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        return res.ok;
    } catch (e) {
        console.error('[webhook]', e.message || e);
        return false;
    }
}

/**
 * @param {import('sql.js').Database} db
 * @param {number} userId
 * @param {string} event
 * @param {object} payload
 */
async function dispatchClientWebhook(db, userId, event, payload) {
    const rows = parseResults(
        db.exec('SELECT discord_webhook, slack_webhook, client_preferences FROM users WHERE id = ?', [
            userId,
        ])
    );
    if (!rows.length) return;
    const u = rows[0];
    const prefs = parseClientPreferences(u.client_preferences || '');
    if (!webhookEnabled(prefs, event)) return;

    const tmpl = TEMPLATES[event];
    if (!tmpl) return;
    const body = tmpl(payload || {});

    const tasks = [];
    if (u.discord_webhook) tasks.push(postWebhook(u.discord_webhook, body, false));
    if (u.slack_webhook) tasks.push(postWebhook(u.slack_webhook, body, true));
    await Promise.all(tasks);
}

module.exports = { dispatchClientWebhook, TEMPLATES };
