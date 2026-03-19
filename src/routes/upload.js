const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { getDb, saveDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Configure multer for file uploads
const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel',
            'text/csv'
        ];
        const allowedExts = ['.xlsx', '.xls', '.csv'];
        const ext = path.extname(file.originalname).toLowerCase();

        if (allowedTypes.includes(file.mimetype) || allowedExts.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Only Excel (.xlsx, .xls) and CSV files are allowed'));
        }
    }
});

// POST /api/upload/packages - Bulk upload packages from Excel/CSV
router.post('/packages', authMiddleware, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const workbook = XLSX.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet);

        if (rows.length === 0) {
            return res.status(400).json({ error: 'File is empty or has no valid data' });
        }

        const db = await getDb();
        let created = 0;
        let errors = [];

        const ALLOWED_CONDITIONS = ['New', 'Used', 'Return', 'Return Review'];
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const reference = (row['Reference'] || row['reference'] || row['Tracking Number'] || row['tracking_number'] || '').toString().trim();
            const productName = (row['Product'] || row['product'] || row['Product Name'] || row['product_name'] || row['SKU'] || row['sku'] || '').toString().trim();
            const quantity = Math.max(1, parseInt(row['Quantity'] || row['quantity'] || row['Qty'] || row['qty'] || 1, 10) || 1);
            const rawCondition = row['Condition'] || row['condition'] || 'New';
            const condition = ALLOWED_CONDITIONS.includes(rawCondition) ? rawCondition : 'New';
            const notes = (row['Notes'] || row['notes'] || '').toString().slice(0, 2000);

            if (!reference || !productName) {
                errors.push(`Row ${i + 2}: Missing reference or product name`);
                continue;
            }

            // Check if package with this reference already exists for user
            const existing = db.exec(
                'SELECT id FROM packages WHERE reference = ? AND user_id = ?',
                [reference, req.user.id]
            );

            let packageId;
            if (existing.length > 0 && existing[0].values.length > 0) {
                packageId = existing[0].values[0][0];
                // Update notes if provided
                if (notes) {
                    db.run('UPDATE packages SET notes = ? WHERE id = ?', [notes, packageId]);
                }
            } else {
                db.run(
                    'INSERT INTO packages (user_id, reference, notes) VALUES (?, ?, ?)',
                    [req.user.id, reference, notes]
                );
                const result = db.exec('SELECT last_insert_rowid() as id');
                packageId = result[0].values[0][0];
            }

            // Add product
            db.run(
                'INSERT INTO package_products (package_id, product_name, quantity, condition) VALUES (?, ?, ?, ?)',
                [packageId, productName, quantity, condition]
            );

            created++;
        }

        saveDb();

        // Clean up uploaded file
        fs.unlink(req.file.path, () => {});

        res.json({
            message: `Bulk upload complete. ${created} items processed.`,
            created,
            errors: errors.length > 0 ? errors : undefined,
            total_rows: rows.length
        });
    } catch (err) {
        console.error('Bulk upload error:', err);
        if (req.file) fs.unlink(req.file.path, () => {});
        res.status(500).json({ error: 'Failed to process file' });
    }
});

// GET /api/upload/template - Download Excel template
router.get('/template', async (req, res) => {
    // Allow auth via query param for direct download links
    if (req.query.token) {
        const jwt = require('jsonwebtoken');
        try {
            jwt.verify(req.query.token, process.env.JWT_SECRET || 'fallback-secret-change-me');
        } catch(e) {
            return res.status(401).json({ error: 'Invalid token' });
        }
    } else {
        // Fall back to header auth
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        const jwt = require('jsonwebtoken');
        try {
            jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET || 'fallback-secret-change-me');
        } catch(e) {
            return res.status(401).json({ error: 'Invalid token' });
        }
    }

    const wb = XLSX.utils.book_new();
    const templateData = [
        { Reference: 'TRACK-12345', 'Product Name': 'iPhone Case', Quantity: 2, Condition: 'New', Notes: 'Optional notes' },
        { Reference: 'TRACK-12345', 'Product Name': 'Screen Protector', Quantity: 5, Condition: 'Return', Notes: '' },
        { Reference: 'TRACK-67890', 'Product Name': 'MacBook Charger', Quantity: 1, Condition: 'Used', Notes: 'Damaged box' },
    ];
    const ws = XLSX.utils.json_to_sheet(templateData);

    // Set column widths
    ws['!cols'] = [
        { wch: 18 }, { wch: 25 }, { wch: 10 }, { wch: 15 }, { wch: 25 }
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Packages');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=ReturnPal-Upload-Template.xlsx');
    res.send(buffer);
});

module.exports = router;
