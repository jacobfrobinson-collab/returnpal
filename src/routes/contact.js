const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb, saveDb } = require('../database');

const router = express.Router();

// POST /api/contact - Public endpoint (no auth required)
router.post('/', [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('subject').trim().notEmpty().withMessage('Subject is required'),
    body('message').trim().notEmpty().withMessage('Message is required'),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const db = await getDb();
        const { name, email, subject, message } = req.body;

        db.run(
            'INSERT INTO contact_messages (name, email, subject, message) VALUES (?, ?, ?, ?)',
            [name, email, subject, message]
        );
        saveDb();

        res.status(201).json({ message: 'Message sent successfully. We will get back to you soon!' });
    } catch (err) {
        console.error('Contact form error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
