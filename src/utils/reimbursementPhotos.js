const path = require('path');
const fs = require('fs');

/**
 * Persist uploaded images for a reimbursement claim. Returns saved relative paths.
 * @param {import('sql.js').Database} db
 * @param {number} claimId
 * @param {Express.Multer.File[]} files
 * @param {string} uploadsBaseDir
 */
function saveReimbursementClaimPhotos(db, claimId, files, uploadsBaseDir) {
    const list = Array.isArray(files) ? files : [];
    if (!list.length) return [];

    const reimbursementUploadDir = path.join(uploadsBaseDir, 'reimbursement');
    const dir = path.join(reimbursementUploadDir, String(claimId));
    if (!fs.existsSync(reimbursementUploadDir)) fs.mkdirSync(reimbursementUploadDir, { recursive: true });
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const countRow = db.exec('SELECT COUNT(*) AS c FROM reimbursement_claim_photos WHERE claim_id = ?', [claimId]);
    let startIdx = Number(countRow[0]?.values[0]?.[0]) || 0;
    const saved = [];

    for (let i = 0; i < list.length; i++) {
        const f = list[i];
        const ext = path.extname(f.originalname || '') || '.jpg';
        const safeName = `photo-${startIdx + i + 1}${ext}`;
        fs.writeFileSync(path.join(dir, safeName), f.buffer);
        const relativePath = `reimbursement/${claimId}/${safeName}`;
        db.run('INSERT INTO reimbursement_claim_photos (claim_id, file_path) VALUES (?, ?)', [claimId, relativePath]);
        saved.push(relativePath);
    }
    return saved;
}

module.exports = { saveReimbursementClaimPhotos };
