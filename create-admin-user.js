/**
 * Create a brand-new admin user with a random email and password.
 *
 * Run from the folder that contains THIS file and package.json (Render: ~/project/src):
 *   node create-admin-user.js
 *   npm run create-admin
 *
 * Do NOT use "node src/create-admin-user.js" on Render — that doubles the path and fails.
 */

require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb, saveDb } = require('./src/database');

function randomToken(bytes) {
    return crypto.randomBytes(bytes).toString('hex');
}

function randomPassword() {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@-_';
    const buf = crypto.randomBytes(24);
    let s = '';
    for (let i = 0; i < 20; i++) {
        s += chars[buf[i] % chars.length];
    }
    return s;
}

async function main() {
    const email = `admin-${randomToken(6)}@returnpal.invalid`;
    const plainPassword = randomPassword();
    const hash = await bcrypt.hash(plainPassword, 12);

    const db = await getDb();
    db.run(
        'INSERT INTO users (email, password, full_name, company_name, phone, is_admin) VALUES (?, ?, ?, ?, ?, 1)',
        [email, hash, 'Bootstrap Admin', '', '']
    );
    saveDb();

    const idRow = db.exec('SELECT id FROM users WHERE email = ?', [email]);
    const id = idRow[0] && idRow[0].values[0] ? idRow[0].values[0][0] : '?';

    console.log('');
    console.log('────────────────────────────────────────────────────────────');
    console.log('  New admin user created (save these — password cannot be recovered)');
    console.log('────────────────────────────────────────────────────────────');
    console.log('  Email:    ', email);
    console.log('  Password: ', plainPassword);
    console.log('  User id:  ', id);
    console.log('────────────────────────────────────────────────────────────');
    console.log('  Sign in at: /admin/login.html');
    console.log('  After deploy, clear site data or use a private window if old tokens conflict.');
    console.log('────────────────────────────────────────────────────────────');
    console.log('');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
