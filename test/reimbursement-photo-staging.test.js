/**
 * Unit tests for reimbursement photo staging (move + assign validation).
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { moveStagingPhotosToClaim, writeStagingFile, deleteStagingFile } = require('../src/utils/reimbursementPhotos');
const {
    loadUnassignedStagingRows,
    MAX_ASSIGN_PHOTOS,
} = require('../src/utils/reimbursementPhotoStaging');

function makeMemoryDb() {
    const initSqlJs = require('sql.js');
    return initSqlJs().then((SQL) => {
        const db = new SQL.Database();
        db.run(`
            CREATE TABLE reimbursement_claims (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                package_reference TEXT,
                item_description TEXT,
                case_status TEXT DEFAULT 'draft'
            );
            CREATE TABLE reimbursement_claim_photos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                claim_id INTEGER NOT NULL,
                file_path TEXT NOT NULL
            );
            CREATE TABLE reimbursement_photo_batches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                admin_user_id INTEGER NOT NULL,
                status TEXT DEFAULT 'open'
            );
            CREATE TABLE reimbursement_photo_staging (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_id INTEGER NOT NULL,
                file_path TEXT NOT NULL,
                original_filename TEXT,
                assigned_claim_id INTEGER,
                assigned_at TEXT
            );
        `);
        db.run("INSERT INTO reimbursement_claims (user_id, package_reference, item_description) VALUES (1, 'PKG1', 'Item A')");
        db.run("INSERT INTO reimbursement_photo_batches (admin_user_id, status) VALUES (1, 'open')");
        return db;
    });
}

function parseResults(db, sql, params = []) {
    const result = db.exec(sql, params);
    if (!result.length) return [];
    const cols = result[0].columns;
    return result[0].values.map((row) => {
        const o = {};
        cols.forEach((c, i) => {
            o[c] = row[i];
        });
        return o;
    });
}

async function testMoveStagingPhotosToClaim() {
    const db = await makeMemoryDb();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-staging-'));
    const batchId = 1;
    const fakeFile = { originalname: 'a.jpg', buffer: Buffer.from('fake-jpeg') };
    db.run(
        'INSERT INTO reimbursement_photo_staging (batch_id, file_path, original_filename) VALUES (1, ?, ?)',
        ['', 'a.jpg']
    );
    const stagingId = parseResults(db, 'SELECT last_insert_rowid() AS id')[0].id;
    const rel = writeStagingFile(tmp, batchId, stagingId, fakeFile);
    db.run('UPDATE reimbursement_photo_staging SET file_path = ? WHERE id = ?', [rel, stagingId]);

    const claimId = 1;
    const rows = parseResults(db, 'SELECT id, file_path FROM reimbursement_photo_staging WHERE id = ?', [stagingId]);
    moveStagingPhotosToClaim(db, claimId, rows, tmp);

    const photos = parseResults(db, 'SELECT file_path FROM reimbursement_claim_photos WHERE claim_id = ?', [claimId]);
    assert.strictEqual(photos.length, 1);
    assert.ok(photos[0].file_path.startsWith('reimbursement/1/photo-1'));
    const dest = path.join(tmp, photos[0].file_path);
    assert.ok(fs.existsSync(dest), 'file moved to claim folder');
    assert.ok(!fs.existsSync(path.join(tmp, rel)), 'staging file removed');
    console.log('  ✓ moveStagingPhotosToClaim moves file and inserts row');
}

async function testLoadUnassignedStagingRows() {
    const db = await makeMemoryDb();
    db.run(
        "INSERT INTO reimbursement_photo_staging (batch_id, file_path, assigned_claim_id) VALUES (1, 'reimbursement-staging/1/1.jpg', NULL)"
    );
    db.run(
        "INSERT INTO reimbursement_photo_staging (batch_id, file_path, assigned_claim_id) VALUES (1, 'reimbursement-staging/1/2.jpg', 1)"
    );
    const id1 = parseResults(db, 'SELECT id FROM reimbursement_photo_staging WHERE file_path LIKE ?', [
        '%1.jpg',
    ])[0].id;

    const rows = loadUnassignedStagingRows(db, 1, [id1]);
    assert.strictEqual(rows.length, 1);

    assert.throws(() => loadUnassignedStagingRows(db, 1, []), /at least one photo/i);
    assert.throws(
        () => loadUnassignedStagingRows(db, 1, Array.from({ length: MAX_ASSIGN_PHOTOS + 1 }, (_, i) => i + 1)),
        /At most/
    );
    console.log('  ✓ loadUnassignedStagingRows validates selection');
}

async function testDeleteStagingFile() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-staging-del-'));
    const rel = 'reimbursement-staging/9/99.jpg';
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'x');
    deleteStagingFile(tmp, rel);
    assert.ok(!fs.existsSync(abs));
    console.log('  ✓ deleteStagingFile removes file');
}

(async function main() {
    await testMoveStagingPhotosToClaim();
    await testLoadUnassignedStagingRows();
    await testDeleteStagingFile();
    console.log('reimbursement-photo-staging: all checks passed');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
