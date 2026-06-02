const path = require('path');
const fs = require('fs');

const MIME_BY_EXT = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
};

/**
 * Resolve a safe absolute path for a stored reimbursement photo.
 * @param {string} uploadsBaseDir
 * @param {string} filePath relative path from DB
 * @returns {string|null}
 */
function resolveReimbursementPhotoAbsPath(uploadsBaseDir, filePath) {
    const rel = String(filePath || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');
    if (!rel || rel.includes('..')) return null;
    const root = path.resolve(uploadsBaseDir);
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    if (!fs.existsSync(abs)) return null;
    return abs;
}

function mimeForPhotoPath(absPath) {
    const ext = path.extname(absPath).toLowerCase();
    return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function safeDownloadFilename(absPath, fallback) {
    const base = path.basename(absPath) || fallback || 'photo.jpg';
    return base.replace(/[^\w.\-()+ ]/g, '_').slice(0, 200) || 'photo.jpg';
}

module.exports = {
    resolveReimbursementPhotoAbsPath,
    mimeForPhotoPath,
    safeDownloadFilename,
};
