/**
 * Link hub (prep centre) user IDs to client user IDs they may view in the dashboard.
 * Usage: node scripts/grant-hub-access.js <hubUserId> <clientUserId> [clientUserId ...]
 *
 * Replaces all links for that hub with the listed clients (same as admin PUT delegate-clients).
 */
require('dotenv').config();
const path = require('path');

async function main() {
    const hubId = parseInt(process.argv[2], 10);
    const clientIds = process.argv.slice(3).map((x) => parseInt(x, 10)).filter(Number.isFinite);
    if (!Number.isFinite(hubId)) {
        console.error('Usage: node scripts/grant-hub-access.js <hubUserId> <clientUserId> [clientUserId ...]');
        process.exit(1);
    }
    const { getDb, saveDb } = require(path.join(__dirname, '../src/database'));
    const { setClientLinksForHub } = require(path.join(__dirname, '../src/utils/clientDelegate'));
    const db = await getDb();
    setClientLinksForHub(db, hubId, clientIds);
    saveDb();
    console.log('Hub user', hubId, 'can now view client IDs:', clientIds.length ? clientIds.join(', ') : '(none)');
    console.log('They should log in and open /dashboard/my-clients.html');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
