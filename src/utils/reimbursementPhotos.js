const path = require('path');
const fs = require('fs');

const STAGING_SUBDIR = 'reimbursement-staging';

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

/**
 * Write one staged file after DB row exists (file name = staging row id).
 * @returns {string} relative path under UPLOAD_DIR
 */
function writeStagingFile(uploadsBaseDir, batchId, stagingDbId, file) {
    const stagingRoot = path.join(uploadsBaseDir, STAGING_SUBDIR, String(batchId));
    if (!fs.existsSync(stagingRoot)) fs.mkdirSync(stagingRoot, { recursive: true });
    const ext = path.extname(file.originalname || '') || '.jpg';
    const safeName = `${stagingDbId}${ext}`;
    const relativePath = `${STAGING_SUBDIR}/${batchId}/${safeName}`;
    fs.writeFileSync(path.join(uploadsBaseDir, relativePath), file.buffer);
    return relativePath;
}

/**
 * Move staged files into a claim folder and insert reimbursement_claim_photos rows.
 * @param {import('sql.js').Database} db
 * @param {number} claimId
 * @param {Array<{ id: number, file_path: string }>} stagingRows
 * @param {string} uploadsBaseDir
 */
function moveStagingPhotosToClaim(db, claimId, stagingRows, uploadsBaseDir) {
    const rows = Array.isArray(stagingRows) ? stagingRows : [];
    if (!rows.length) return [];

    const reimbursementUploadDir = path.join(uploadsBaseDir, 'reimbursement');
    const claimDir = path.join(reimbursementUploadDir, String(claimId));
    if (!fs.existsSync(reimbursementUploadDir)) fs.mkdirSync(reimbursementUploadDir, { recursive: true });
    if (!fs.existsSync(claimDir)) fs.mkdirSync(claimDir, { recursive: true });

    const countRow = db.exec('SELECT COUNT(*) AS c FROM reimbursement_claim_photos WHERE claim_id = ?', [claimId]);
    let startIdx = Number(countRow[0]?.values[0]?.[0]) || 0;
    const saved = [];

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rel = String(row.file_path || '').replace(/\\/g, '/');
        const srcAbs = path.join(uploadsBaseDir, rel);
        if (!fs.existsSync(srcAbs)) {
            throw new Error(`Staging file missing: ${rel}`);
        }
        const ext = path.extname(rel) || '.jpg';
        const safeName = `photo-${startIdx + i + 1}${ext}`;
        const destAbs = path.join(claimDir, safeName);
        fs.renameSync(srcAbs, destAbs);
        const relativePath = `reimbursement/${claimId}/${safeName}`;
        db.run('INSERT INTO reimbursement_claim_photos (claim_id, file_path) VALUES (?, ?)', [claimId, relativePath]);
        saved.push(relativePath);
    }
    return saved;
}

function deleteStagingFile(uploadsBaseDir, relativePath) {
    const rel = String(relativePath || '').replace(/\\/g, '/');
    if (!rel) return;
    const abs = path.join(uploadsBaseDir, rel);
    if (fs.existsSync(abs)) {
        try {
            fs.unlinkSync(abs);
        } catch (e) {
            console.error('deleteStagingFile:', abs, e);
        }
    }
}

module.exports = {
    STAGING_SUBDIR,
    saveReimbursementClaimPhotos,
    writeStagingFile,
    moveStagingPhotosToClaim,
    deleteStagingFile,
};
