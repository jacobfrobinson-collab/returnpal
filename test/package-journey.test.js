'use strict';

const assert = require('assert');
const initSqlJs = require('sql.js');
const { buildReferenceJourney } = require('../src/utils/packageJourney');

(async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE packages (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        reference TEXT,
        status TEXT,
        date_added TEXT
    )`);
    db.run(`CREATE TABLE received_items (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        reference TEXT,
        items_description TEXT,
        status TEXT,
        date_received TEXT
    )`);
    db.run(`CREATE TABLE pending_items (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        reference TEXT,
        product TEXT,
        current_stage TEXT,
        received_date TEXT
    )`);
    db.run(`CREATE TABLE sold_items (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        reference TEXT,
        product TEXT,
        profit REAL,
        sold_date TEXT,
        match_status TEXT,
        received_item_id INTEGER
    )`);
    db.run(`CREATE TABLE reimbursement_claims (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        package_reference TEXT,
        reimbursement_type TEXT,
        case_status TEXT,
        recovered_amount REAL,
        created_at TEXT
    )`);
    db.run(`CREATE TABLE activities (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        message TEXT,
        link TEXT,
        created_at TEXT
    )`);

    const uid = 1;
    const ref = 'PKG-REF-1';

    db.run(
        `INSERT INTO received_items (user_id, reference, items_description, status, date_received)
         VALUES (?, ?, 'Widget', 'Processing', '2026-04-01')`,
        [uid, ref]
    );
    db.run(
        `INSERT INTO pending_items (user_id, reference, product, current_stage, received_date)
         VALUES (?, ?, 'Widget', 'Listing', '2026-04-02')`,
        [uid, ref]
    );

    const journey = buildReferenceJourney(db, uid, ref, { clientFacing: true, focusPendingId: 1 });
    assert.strictEqual(journey.reference, ref);
    assert.ok(journey.events.length >= 2, 'received + pending without package');
    const processing = journey.events.find((e) => e.stage === 'processing');
    assert.ok(processing, 'processing event');
    assert.ok(processing.message.includes('Being listed'), 'client-facing status');
    assert.strictEqual(processing.focus_pending_id, true);

    db.run(
        `INSERT INTO packages (user_id, reference, status, date_added) VALUES (?, ?, 'Delivered', '2026-03-28')`,
        [uid, ref]
    );
    const withPkg = buildReferenceJourney(db, uid, ref, { clientFacing: true });
    assert.ok(withPkg.events.some((e) => e.stage === 'sent'), 'package sent when package exists');

    console.log('package-journey.test.js: ok');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
