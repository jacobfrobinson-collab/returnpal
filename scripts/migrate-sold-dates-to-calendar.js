/**
 * Migrate sold_items.sold_date to canonical calendar YYYY-MM-DD.
 *
 * Usage:
 *   node scripts/migrate-sold-dates-to-calendar.js
 *   node scripts/migrate-sold-dates-to-calendar.js --user-id 14
 *   node scripts/migrate-sold-dates-to-calendar.js --apply
 *   node scripts/migrate-sold-dates-to-calendar.js --apply --ambiguous-csv data/sold-date-ambiguous.csv
 *
 * Stop the app before --apply on production. Back up DB_PATH first.
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { computeCanonicalSoldDate } = require('../src/utils/soldDateMigration');
const { calendarYearMonthFromDbDate } = require('../src/utils/soldDateCalendar');
const { mapSoldItemDatesForApi } = require('../src/utils/soldDateDisplayRepair');
const { normalizeSoldDateForDb } = require('../src/utils/adminBulkImport');

const DB_PATH = path.resolve(process.env.DB_PATH || './data/returnpal.db');

function arg(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
}

function hasFlag(name) {
    return process.argv.includes(name);
}

function csvEscape(s) {
    const t = String(s == null ? '' : s);
    if (/[",\n\r]/.test(t)) return '"' + t.replace(/"/g, '""') + '"';
    return t;
}

async function main() {
    const apply = hasFlag('--apply');
    const userId = arg('--user-id');
    const ambiguousCsv =
        arg('--ambiguous-csv') ||
        path.join(process.cwd(), 'data', 'sold-date-migration-ambiguous.csv');

    if (!fs.existsSync(DB_PATH)) {
        console.error('Database not found:', DB_PATH);
        console.error('Set DB_PATH to your returnpal.db (e.g. production disk path).');
        process.exit(1);
    }

    console.log('Database:', DB_PATH);
    console.log('Mode:', apply ? 'APPLY (writes)' : 'DRY RUN');
    if (!apply) {
        console.log('Back up the database before running with --apply.');
        console.log('Stop the Node app while applying on production.\n');
    }

    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB_PATH));

    let sql = 'SELECT id, user_id, sold_date, product FROM sold_items WHERE sold_date IS NOT NULL AND length(trim(sold_date)) > 0';
    const bind = [];
    if (userId) {
        sql += ' AND user_id = ?';
        bind.push(parseInt(userId, 10));
    }
    sql += ' ORDER BY user_id, id';

    const stmt = db.prepare(sql);
    if (bind.length) stmt.bind(bind);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();

    let wouldUpdate = 0;
    let unchanged = 0;
    let unparseable = 0;
    const ambiguousRows = [];
    const changes = [];

    for (const row of rows) {
        const raw = String(row.sold_date || '').trim();
        const conv = computeCanonicalSoldDate(raw);
        const newIso = conv.iso;

        if (!newIso) {
            unparseable++;
            continue;
        }

        const beforeYm = calendarYearMonthFromDbDate(raw);
        const afterYm = newIso.slice(0, 7);
        const displayBefore = mapSoldItemDatesForApi(raw, normalizeSoldDateForDb).label || raw;

        if (conv.ambiguous) {
            ambiguousRows.push({
                id: row.id,
                user_id: row.user_id,
                product: row.product,
                sold_date_raw: raw,
                legacy_iso: conv.legacyIso,
                direct_iso: conv.directIso,
                legacy_ym: conv.legacyYm,
                direct_ym: conv.directYm,
                chosen_iso: newIso,
                strategy: conv.strategy,
            });
        }

        if (newIso === raw) {
            unchanged++;
            continue;
        }

        wouldUpdate++;
        changes.push({
            id: row.id,
            user_id: row.user_id,
            product: String(row.product || '').slice(0, 60),
            raw,
            newIso,
            displayBefore,
            beforeYm,
            afterYm,
            ambiguous: conv.ambiguous,
            strategy: conv.strategy,
        });

        if (apply) {
            db.run('UPDATE sold_items SET sold_date = ? WHERE id = ?', [newIso, row.id]);
        }
    }

    if (ambiguousRows.length) {
        const header =
            'id,user_id,product,sold_date_raw,legacy_iso,direct_iso,legacy_ym,direct_ym,chosen_iso,strategy';
        const lines = [header];
        for (const a of ambiguousRows) {
            lines.push(
                [
                    a.id,
                    a.user_id,
                    csvEscape(a.product),
                    a.sold_date_raw,
                    a.legacy_iso,
                    a.direct_iso,
                    a.legacy_ym,
                    a.direct_ym,
                    a.chosen_iso,
                    a.strategy,
                ].join(',')
            );
        }
        fs.mkdirSync(path.dirname(ambiguousCsv), { recursive: true });
        fs.writeFileSync(ambiguousCsv, lines.join('\n') + '\n', 'utf8');
        console.log('Ambiguous rows written:', ambiguousCsv, '(' + ambiguousRows.length + ')');
    }

    console.log('\nSummary:');
    console.log('  Rows scanned:', rows.length);
    console.log('  Would update:', wouldUpdate);
    console.log('  Already canonical:', unchanged);
    console.log('  Unparseable:', unparseable);
    console.log('  Ambiguous (legacy chosen):', ambiguousRows.length);

    const show = Math.min(25, changes.length);
    if (show) {
        console.log('\nSample changes (first ' + show + '):');
        for (const c of changes.slice(0, show)) {
            console.log(
                '  id',
                c.id,
                'user',
                c.user_id,
                '|',
                c.raw,
                '→',
                c.newIso,
                '| invoice month',
                c.beforeYm || '?',
                '→',
                c.afterYm,
                c.ambiguous ? '(ambiguous)' : ''
            );
        }
    }

    if (apply && wouldUpdate > 0) {
        fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
        console.log('\nApplied', wouldUpdate, 'update(s). Restart the server and hard-refresh client dashboards.');
    } else if (apply) {
        console.log('\nNo rows needed updating.');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
