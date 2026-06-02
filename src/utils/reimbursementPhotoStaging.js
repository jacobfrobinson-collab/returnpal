const { saveDb, pushActivity } = require('../database');
const { buildCaseText, enrichClaimRow } = require('./reimbursementCase');
const { resolveUserIdFromClientSpecifier, lookupUserBrief } = require('./adminBulkImport');
const { writeStagingFile, moveStagingPhotosToClaim, deleteStagingFile } = require('./reimbursementPhotos');

const MAX_BATCH_PHOTOS = 200;
const MAX_ASSIGN_PHOTOS = 50;

const REIMB_TYPES = [
    'Destroyed Inventory',
    'Damaged Inventory',
    'Misplaced and Lost Inventory',
    'Customer Returned Orders',
    'Missing FBA Shipment Units',
];

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

function mapStagingPhoto(row) {
    const r = { ...row };
    r.url = '/uploads/' + String(r.file_path || '').replace(/\\/g, '/');
    return r;
}

function getOpenBatch(db, batchId) {
    const rows = parseResults(
        db.exec(
            "SELECT * FROM reimbursement_photo_batches WHERE id = ? AND status = 'open'",
            [batchId]
        )
    );
    return rows[0] || null;
}

function countUnassignedInBatch(db, batchId) {
    const r = parseResults(
        db.exec(
            'SELECT COUNT(*) AS c FROM reimbursement_photo_staging WHERE batch_id = ? AND assigned_claim_id IS NULL',
            [batchId]
        )
    );
    return Number(r[0]?.c) || 0;
}

function countAllInBatch(db, batchId) {
    const r = parseResults(
        db.exec('SELECT COUNT(*) AS c FROM reimbursement_photo_staging WHERE batch_id = ?', [batchId])
    );
    return Number(r[0]?.c) || 0;
}

function createBatch(db, adminUserId, label = '') {
    db.run(
        "INSERT INTO reimbursement_photo_batches (admin_user_id, status, label) VALUES (?, 'open', ?)",
        [adminUserId, String(label || '').slice(0, 200)]
    );
    const id = parseResults(db.exec('SELECT last_insert_rowid() AS id'))[0].id;
    saveDb();
    return id;
}

function addPhotosToBatch(db, batchId, files, uploadsBaseDir) {
    const batch = getOpenBatch(db, batchId);
    if (!batch) throw new Error('Batch not found or not open');

    const list = Array.isArray(files) ? files : [];
    const current = countAllInBatch(db, batchId);
    if (current + list.length > MAX_BATCH_PHOTOS) {
        throw new Error(`Batch limit is ${MAX_BATCH_PHOTOS} photos (${current} already in batch)`);
    }

    const added = [];
    for (let i = 0; i < list.length; i++) {
        const f = list[i];
        const orig = String(f.originalname || '').slice(0, 500);
        db.run(
            'INSERT INTO reimbursement_photo_staging (batch_id, file_path, original_filename) VALUES (?, ?, ?)',
            [batchId, '', orig]
        );
        const stagingId = parseResults(db.exec('SELECT last_insert_rowid() AS id'))[0].id;
        const filePath = writeStagingFile(uploadsBaseDir, batchId, stagingId, f);
        db.run('UPDATE reimbursement_photo_staging SET file_path = ? WHERE id = ?', [filePath, stagingId]);
        added.push(mapStagingPhoto({ id: stagingId, batch_id: batchId, file_path: filePath, original_filename: orig }));
    }
    saveDb();
    return added;
}

function listOpenBatches(db, adminUserId) {
    const batches = parseResults(
        db.exec(
            `SELECT b.*,
              (SELECT COUNT(*) FROM reimbursement_photo_staging s
               WHERE s.batch_id = b.id AND s.assigned_claim_id IS NULL) AS unassigned_count,
              (SELECT COUNT(*) FROM reimbursement_photo_staging s WHERE s.batch_id = b.id) AS total_count
             FROM reimbursement_photo_batches b
             WHERE b.admin_user_id = ? AND b.status = 'open'
             ORDER BY b.created_at DESC`,
            [adminUserId]
        )
    );
    return batches;
}

function listBatch(db, batchId) {
    const batches = parseResults(db.exec('SELECT * FROM reimbursement_photo_batches WHERE id = ?', [batchId]));
    if (!batches.length) return null;
    const batch = batches[0];
    const photos = parseResults(
        db.exec(
            'SELECT * FROM reimbursement_photo_staging WHERE batch_id = ? ORDER BY id',
            [batchId]
        )
    ).map(mapStagingPhoto);
    const unassigned = photos.filter((p) => p.assigned_claim_id == null || p.assigned_claim_id === '');
    const assigned = photos.filter((p) => p.assigned_claim_id != null && p.assigned_claim_id !== '');
    return {
        batch,
        unassigned_count: unassigned.length,
        total_count: photos.length,
        unassigned,
        assigned,
    };
}

function resolveClientId(db, opts) {
    if (opts.user_id != null && opts.user_id !== '') {
        const userId = parseInt(opts.user_id, 10);
        if (!isNaN(userId) && userId > 0) {
            const brief = lookupUserBrief(db, userId);
            if (!brief) throw new Error('User not found');
            return { userId, brief };
        }
    }
    const spec = opts.client_specifier != null ? opts.client_specifier : opts.client_id;
    const res = resolveUserIdFromClientSpecifier(db, spec);
    if (res.error) throw new Error(res.error);
    const brief = lookupUserBrief(db, res.userId);
    if (!brief) throw new Error('User not found');
    return { userId: res.userId, brief };
}

function normalizeReimbType(raw) {
    let reimbType = String(raw || 'Damaged Inventory').trim();
    if (!REIMB_TYPES.includes(reimbType)) {
        const f = REIMB_TYPES.find((t) => t.toLowerCase() === reimbType.toLowerCase());
        reimbType = f || 'Damaged Inventory';
    }
    return reimbType;
}

function loadUnassignedStagingRows(db, batchId, stagingPhotoIds) {
    const ids = [...new Set((stagingPhotoIds || []).map((x) => parseInt(x, 10)).filter((n) => !isNaN(n) && n > 0))];
    if (!ids.length) throw new Error('Select at least one photo');
    if (ids.length > MAX_ASSIGN_PHOTOS) {
        throw new Error(`At most ${MAX_ASSIGN_PHOTOS} photos per assignment`);
    }
    const placeholders = ids.map(() => '?').join(',');
    const rows = parseResults(
        db.exec(
            `SELECT * FROM reimbursement_photo_staging
             WHERE batch_id = ? AND id IN (${placeholders}) AND assigned_claim_id IS NULL`,
            [batchId, ...ids]
        )
    );
    if (rows.length !== ids.length) {
        throw new Error('One or more photos are invalid, already assigned, or not in this batch');
    }
    return rows;
}

function markStagingAssigned(db, stagingIds, claimId) {
    const now = new Date().toISOString();
    for (const sid of stagingIds) {
        db.run(
            'UPDATE reimbursement_photo_staging SET assigned_claim_id = ?, assigned_at = ? WHERE id = ?',
            [claimId, now, sid]
        );
    }
}

function maybeCloseBatch(db, batchId) {
    const unassigned = countUnassignedInBatch(db, batchId);
    if (unassigned === 0) {
        db.run("UPDATE reimbursement_photo_batches SET status = 'committed' WHERE id = ?", [batchId]);
    }
}

async function assignStagingPhotos(db, uploadsBaseDir, batchId, opts) {
    const batch = getOpenBatch(db, batchId);
    if (!batch) throw new Error('Batch not found or not open');

    const stagingRows = loadUnassignedStagingRows(db, batchId, opts.staging_photo_ids);
    const { userId, brief } = resolveClientId(db, opts);
    const mode = String(opts.mode || 'new_claim').trim();

    let claimId;
    let itemDescription;
    let packageReference;

    if (mode === 'existing_claim') {
        claimId = parseInt(opts.claim_id, 10);
        if (isNaN(claimId)) throw new Error('claim_id is required for existing claim');
        const claims = parseResults(db.exec('SELECT * FROM reimbursement_claims WHERE id = ?', [claimId]));
        if (!claims.length) throw new Error('Claim not found');
        const claim = claims[0];
        if (Number(claim.user_id) !== Number(userId)) {
            throw new Error('Claim does not belong to this client');
        }
        itemDescription = claim.item_description;
        packageReference = claim.package_reference;
        moveStagingPhotosToClaim(db, claimId, stagingRows, uploadsBaseDir);
        const st = String(claim.case_status || 'draft').toLowerCase();
        if (st === 'draft' || !st) {
            db.run('UPDATE reimbursement_claims SET case_status = ? WHERE id = ?', ['ready', claimId]);
        }
        markStagingAssigned(
            db,
            stagingRows.map((r) => r.id),
            claimId
        );
        maybeCloseBatch(db, batchId);
        saveDb();
        await pushActivity(
            userId,
            'info',
            `New photos for reimbursement claim: ${itemDescription || 'item'}. Download from Reimbursement claims.`,
            '/dashboard/reimbursement.html'
        );
    } else if (mode === 'new_claim') {
        packageReference = String(opts.package_reference || '').trim();
        itemDescription = String(opts.item_description || '').trim();
        const reimbursementType = normalizeReimbType(opts.reimbursement_type);
        const notes = String(opts.notes || '').trim();
        const orderNumber = String(opts.order_number == null ? '' : opts.order_number).trim().slice(0, 200);
        if (!packageReference || !itemDescription) {
            throw new Error('package_reference and item_description are required');
        }
        const caseText = buildCaseText({
            package_reference: packageReference,
            item_description: itemDescription,
            reimbursement_type: reimbursementType,
            notes,
            order_number: orderNumber,
        });
        db.run(
            `INSERT INTO reimbursement_claims (user_id, package_reference, item_description, reimbursement_type, notes, order_number, case_status, case_text)
             VALUES (?, ?, ?, ?, ?, ?, 'ready', ?)`,
            [userId, packageReference, itemDescription, reimbursementType, notes, orderNumber, caseText]
        );
        claimId = parseResults(db.exec('SELECT last_insert_rowid() AS id'))[0].id;
        moveStagingPhotosToClaim(db, claimId, stagingRows, uploadsBaseDir);
        markStagingAssigned(
            db,
            stagingRows.map((r) => r.id),
            claimId
        );
        maybeCloseBatch(db, batchId);
        saveDb();
        await pushActivity(
            userId,
            'info',
            `Reimbursement claim ready: ${itemDescription}. Download photos and file in Seller Central.`,
            '/dashboard/reimbursement.html'
        );
    } else {
        throw new Error('mode must be new_claim or existing_claim');
    }

    const claim = enrichClaimRow(parseResults(db.exec('SELECT * FROM reimbursement_claims WHERE id = ?', [claimId]))[0]);
    claim.photos = parseResults(
        db.exec('SELECT id, file_path FROM reimbursement_claim_photos WHERE claim_id = ? ORDER BY id', [claimId])
    );
    return { claim, client: brief, photos_moved: stagingRows.length };
}

function deleteStagingPhoto(db, photoId, uploadsBaseDir) {
    const rows = parseResults(db.exec('SELECT * FROM reimbursement_photo_staging WHERE id = ?', [photoId]));
    if (!rows.length) throw new Error('Photo not found');
    const row = rows[0];
    if (row.assigned_claim_id != null && row.assigned_claim_id !== '') {
        throw new Error('Cannot delete an assigned photo');
    }
    deleteStagingFile(uploadsBaseDir, row.file_path);
    db.run('DELETE FROM reimbursement_photo_staging WHERE id = ?', [photoId]);
    saveDb();
    return { batch_id: row.batch_id };
}

function discardBatch(db, batchId, uploadsBaseDir) {
    const batch = parseResults(db.exec('SELECT * FROM reimbursement_photo_batches WHERE id = ?', [batchId]));
    if (!batch.length) throw new Error('Batch not found');
    const unassigned = parseResults(
        db.exec(
            'SELECT * FROM reimbursement_photo_staging WHERE batch_id = ? AND assigned_claim_id IS NULL',
            [batchId]
        )
    );
    for (const row of unassigned) {
        deleteStagingFile(uploadsBaseDir, row.file_path);
        db.run('DELETE FROM reimbursement_photo_staging WHERE id = ?', [row.id]);
    }
    db.run("UPDATE reimbursement_photo_batches SET status = 'discarded' WHERE id = ?", [batchId]);
    saveDb();
    return { removed: unassigned.length };
}

module.exports = {
    MAX_BATCH_PHOTOS,
    MAX_ASSIGN_PHOTOS,
    createBatch,
    addPhotosToBatch,
    listOpenBatches,
    listBatch,
    loadUnassignedStagingRows,
    assignStagingPhotos,
    deleteStagingPhoto,
    discardBatch,
};
