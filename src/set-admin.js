/**
 * Set a user as admin by email.
 * Run: node src/set-admin.js <email>
 * Example: node src/set-admin.js david@returnpal.com
 */

require('dotenv').config();
const { getDb, saveDb } = require('./database');

async function setAdmin() {
    const email = process.argv[2];
    if (!email) {
        console.error('Usage: node src/set-admin.js <email>');
        console.error('Example: node src/set-admin.js david@returnpal.com');
        process.exit(1);
    }

    const db = await getDb();
    const result = db.exec('SELECT id, email FROM users WHERE email = ?', [email]);
    if (!result.length || !result[0].values.length) {
        console.error('User not found:', email);
        process.exit(1);
    }

    db.run('UPDATE users SET is_admin = 1 WHERE email = ?', [email]);
    saveDb();
    console.log('Done.', email, 'is now an admin.');
    process.exit(0);
}

setAdmin().catch(err => {
    console.error(err);
    process.exit(1);
});
