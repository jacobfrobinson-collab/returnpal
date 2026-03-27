/**
 * Reset a user's password (bcrypt hash in DB). Cannot read old password — only set a new one.
 * Run: node src/set-password.js <email> <new_password>
 * Example: node src/set-password.js user@example.com MyNewPass123
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { getDb, saveDb } = require('./database');

async function setPassword() {
    const email = process.argv[2];
    const newPassword = process.argv[3];
    if (!email || !newPassword) {
        console.error('Usage: node src/set-password.js <email> <new_password>');
        console.error('Example: node src/set-password.js david@returnpal.com MyNewPass123');
        process.exit(1);
    }
    if (newPassword.length < 6) {
        console.error('Password must be at least 6 characters (same rule as registration).');
        process.exit(1);
    }

    const db = await getDb();
    const result = db.exec('SELECT id, email FROM users WHERE email = ?', [email]);
    if (!result.length || !result[0].values.length) {
        console.error('User not found:', email);
        process.exit(1);
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    db.run("UPDATE users SET password = ?, updated_at = datetime('now') WHERE email = ?", [hashedPassword, email]);
    saveDb();
    console.log('Done. Password updated for', email);
    process.exit(0);
}

setPassword().catch((err) => {
    console.error(err);
    process.exit(1);
});
