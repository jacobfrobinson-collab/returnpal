#!/usr/bin/env node
/**
 * Log actual resale (GBP) for a lot URL so ranked runs can show comp vs actual.
 * Usage: node scripts/john-pye-log-actual.js <https://...LotDetails/...> <gbp> [note...]
 * Env: JOHN_PYE_ACTUALS=path to JSON (default scripts/john-pye-actuals.json)
 */
'use strict';

const { appendOrUpdateActual } = require('./john-pye-actuals.js');

function main() {
    const a = process.argv.slice(2);
    if (a.length < 2) {
        console.error('Usage: node scripts/john-pye-log-actual.js <lotUrl> <actualResaleGbp> [note]');
        process.exit(1);
    }
    const u = a[0];
    const g = parseFloat(a[1], 10);
    if (!Number.isFinite(g)) {
        console.error('Second argument must be a number (GBP).');
        process.exit(1);
    }
    const note = a.slice(2).join(' ').trim() || undefined;
    const r = appendOrUpdateActual(
        u,
        { actualResaleGbp: g, note, recordedAt: new Date().toISOString() },
        process.env.JOHN_PYE_ACTUALS,
    );
    if (!r.ok) {
        console.error('Failed.');
        process.exit(1);
    }
    console.log('Saved', r.key, '->', r.path);
}

main();
