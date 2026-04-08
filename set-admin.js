/**
 * Promote a user to admin by email.
 * Run from the folder that contains package.json:
 *   Repo root:  node set-admin.js you@gmail.com
 *   Render:     cd ~/project/src && node set-admin.js you@gmail.com
 *   npm run set-admin -- you@gmail.com
 *
 * Uses the same email normalisation as login/register so the row is found.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const validator = require('validator');
const dbRel = fs.existsSync(path.join(__dirname, 'database.js'))
    ? './database'
    : './src/database';
const { getDb, saveDb, DB_PATH } = require(dbRel);

function parseResults(result) {
    if (!result || result.length === 0) return [];
    const cols = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        cols.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

function emailCandidates(input) {
    const raw = String(input || '').trim();
    const set = new Set();
    if (!raw) return [];
    set.add(raw);
    set.add(raw.toLowerCase());
    const n = validator.normalizeEmail(raw);
    if (n) set.add(n);
    const n2 = validator.normalizeEmail(raw, { gmail_remove_dots: false });
    if (n2) set.add(n2);
    return [...set];
}

async function setAdmin() {
    const input = process.argv[2];
    if (!input) {
        console.error('Usage: node set-admin.js <email>');
        console.error('Example: node set-admin.js jacobrliquidations@gmail.com');
        process.exit(1);
    }

    console.log('Database file:', DB_PATH);

    const db = await getDb();
    const candidates = emailCandidates(input);

    let found = null;
    for (const em of candidates) {
        const rows = parseResults(db.exec('SELECT id, email, is_admin FROM users WHERE email = ?', [em]));
        if (rows.length) {
            found = rows[0];
            break;
        }
    }

    if (!found) {
        const rowsCi = parseResults(
            db.exec('SELECT id, email, is_admin FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))', [input.trim()])
        );
        if (rowsCi.length) found = rowsCi[0];
    }

    if (!found) {
        const part = input.trim().replace(/%/g, '').split('@')[0] || input.trim();
        const fuzzy = parseResults(
            db.exec('SELECT id, email, is_admin FROM users WHERE email LIKE ? LIMIT 15', ['%' + part + '%'])
        );
        console.error('User not found for:', input.trim());
        console.error('Tried:', candidates.join(', '));
        if (fuzzy.length) {
            console.error('Possible matches:');
            fuzzy.forEach((r) => console.error('  ', r.email, 'id=' + r.id, 'is_admin=' + r.is_admin));
        } else {
            const sample = parseResults(db.exec('SELECT email FROM users ORDER BY id LIMIT 20'));
            console.error('Sample emails in this database:');
            sample.forEach((r) => console.error('  ', r.email));
        }
        process.exit(1);
    }

    db.run('UPDATE users SET is_admin = 1 WHERE id = ?', [found.id]);
    saveDb();

    const verify = parseResults(db.exec('SELECT id, email, is_admin FROM users WHERE id = ?', [found.id]))[0];
    console.log('OK — is_admin =', verify.is_admin, 'for', verify.email, '(id ' + verify.id + ')');
    console.log('Open /admin/login.html and sign in (or sign out in the browser first so a fresh JWT is issued).');
    console.log('The live server reloads the DB file when it changes; if login still fails, restart the web service once.');
    // database.js registers setInterval(saveDb); without exit the process would never finish (breaks execFileSync / CI).
    process.exit(0);
}

setAdmin().catch((err) => {
    console.error(err);
    process.exit(1);
});
