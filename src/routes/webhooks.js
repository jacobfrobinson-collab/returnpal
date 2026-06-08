'use strict';

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { getDb, saveDb } = require('../database');
const {
    extractPayoutCodeFromJotformBody,
    recordPayoutDetailsFromWebhook,
} = require('../utils/payoutVerificationCode');

const router = express.Router();

// Jotform webhooks send multipart/form-data; express.json/urlencoded leave req.body empty without this.
const jotformMultipart = multer().none();

function getWebhookSecret() {
    return String(process.env.PAYOUT_JOTFORM_WEBHOOK_SECRET || '').trim();
}

function secretsMatch(provided, expected) {
    if (!expected || !provided) return false;
    const a = Buffer.from(String(provided));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function validateWebhookSecret(req) {
    const expected = getWebhookSecret();
    if (!expected) return false;
    const fromQuery = req.query && req.query.secret;
    const fromHeader = req.get('X-ReturnPal-Webhook-Secret');
    return secretsMatch(fromQuery, expected) || secretsMatch(fromHeader, expected);
}

// POST /api/webhooks/jotform-payout-bank — Jotform submission (no bank data stored)
router.post('/jotform-payout-bank', jotformMultipart, async (req, res) => {
    try {
        if (!getWebhookSecret()) {
            console.warn('[jotform-payout-webhook] PAYOUT_JOTFORM_WEBHOOK_SECRET is not set');
            return res.status(503).json({ error: 'Webhook not configured' });
        }
        if (!validateWebhookSecret(req)) {
            console.warn('[jotform-payout-webhook] Rejected: invalid or missing secret');
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const payload = req.body && typeof req.body === 'object' ? req.body : {};
        const code = extractPayoutCodeFromJotformBody(payload);
        if (!code) {
            const keys = Object.keys(payload).slice(0, 12);
            const ct = req.get('content-type') || '';
            console.warn(
                '[jotform-payout-webhook] Missing code in payload; keys:',
                keys.join(', ') || '(none)',
                'content-type:',
                ct.slice(0, 40)
            );
            return res.status(400).json({ error: 'Missing payout verification code' });
        }

        const db = await getDb();
        const result = recordPayoutDetailsFromWebhook(db, code);
        if (!result) {
            console.warn('[jotform-payout-webhook] No client for code:', code.slice(0, 6) + '…');
            return res.status(404).json({ error: 'No client for code' });
        }

        saveDb();
        console.log('[jotform-payout-webhook] Bank details on file for user', result.userId);
        res.json({ ok: true, user_id: result.userId });
    } catch (err) {
        console.error('Jotform payout webhook error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
