/**
 * Create a B2B partner API key and link client user IDs.
 * Usage: node scripts/create-partner-key.js "Agency Name" 12 34
 */
require('dotenv').config();
const crypto = require('crypto');
const path = require('path');

async function main() {
    const name = process.argv[2];
    const userIds = process.argv.slice(3).map((x) => parseInt(x, 10)).filter(Number.isFinite);
    if (!name) {
        console.error('Usage: node scripts/create-partner-key.js "Partner Name" [userId ...]');
        process.exit(1);
    }
    const { getDb, saveDb } = require(path.join(__dirname, '../src/database'));
    const { hashApiKey } = require(path.join(__dirname, '../src/middleware/partnerAuth'));
    const db = await getDb();
    const apiKey = 'rp_' + crypto.randomBytes(24).toString('hex');
    db.run('INSERT INTO partner_integrations (name, api_key_hash, is_active) VALUES (?, ?, 1)', [name, hashApiKey(apiKey)]);
    const partnerId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
    for (const uid of userIds) {
        db.run('INSERT OR IGNORE INTO partner_client_access (partner_id, user_id) VALUES (?, ?)', [partnerId, uid]);
    }
    saveDb();
    console.log('Partner:', name);
    console.log('Partner ID:', partnerId);
    console.log('API key (save now):', apiKey);
    console.log('Linked user IDs:', userIds.length ? userIds.join(', ') : '(none — add via admin API)');
    console.log('Embed URL example: /partner/embed.html?client_id=' + (userIds[0] || 'USER_ID'));
    console.log('API: GET /api/partner/v1/clients/:userId/status  Header: X-Partner-Key: <key>');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
