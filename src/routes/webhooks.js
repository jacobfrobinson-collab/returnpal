'use strict';

const express = require('express');
const crypto = require('crypto');
const { getDb, saveDb } = require('../database');
const {
    extractPayoutCodeFromJotformBody,
    recordPayoutDetailsFromWebhook,
} = require('../utils/payoutVerificationCode');

const router = express.Router();

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
router.post('/jotform-payout-bank', async (req, res) => {
    try {
        if (!validateWebhookSecret(req)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const code = extractPayoutCodeFromJotformBody(req.body);
        if (!code) {
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
