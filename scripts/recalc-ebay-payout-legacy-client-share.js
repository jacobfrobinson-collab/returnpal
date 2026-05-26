#!/usr/bin/env node
'use strict';

/**
 * Fix client_payout / payout_rate on already-exported eBay payout rows:
 * before EBAY_PAYOUT_TIERED_SINCE (default 2025-12-01) every sale used a flat 25% fee
 * (75% client share of adjusted net). The exporter used tiered 75%/80%/85% on net for all dates.
 *
 * Usage:
 *   node scripts/recalc-ebay-payout-legacy-client-share.js --in path/to/ebay-payout-....json [--out path.csv]
 *   node scripts/recalc-ebay-payout-legacy-client-share.js --in path/to/ebay-payout-....csv [--out path-fixed.csv]
 *
 * Env (same as ebay-payout-puppeteer.js):
 *   EBAY_PAYOUT_TIERED_SINCE   default 2025-12-01
 *   EBAY_PAYOUT_LEGACY_CLIENT_SHARE  default 0.75
 *
 * Prefers column net_earnings / netEarnings when present; otherwise infers net from the OLD
 * client_payout using the tiered bands the script used historically.
 */

const fs = require('fs');
const path = require('path');

const money = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : 0);

function parseMoney(v) {
    const t = String(v || '').replace(/[^\d.,-]/g, '').replace(/,/g, '');
    const n = Number(t);
    return Number.isFinite(n) ? money(n) : 0;
}

const payoutRateTiered = (n) => (n <= 50 ? 0.75 : n <= 150 ? 0.8 : 0.85);

function parseTieredSinceUtcMidnight() {
    const raw = String(process.env.EBAY_PAYOUT_TIERED_SINCE || '2025-12-01').trim();
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return new Date(Date.UTC(2025, 11, 1));
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return new Date(Date.UTC(2025, 11, 1));
    return new Date(Date.UTC(y, mo - 1, d));
}

function parseSoldDateLoose(s) {
    const raw = String(s || '').trim();
    if (!raw) return null;
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) {
        const y = parseInt(iso[1], 10);
        const mo = parseInt(iso[2], 10);
        const d = parseInt(iso[3], 10);
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return new Date(Date.UTC(y, mo - 1, d));
    }
    const uk = raw.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:\s|T|$)/);
    if (uk) {
        const d0 = parseInt(uk[1], 10);
        const mo0 = parseInt(uk[2], 10);
        const y0 = parseInt(uk[3], 10);
        if (mo0 >= 1 && mo0 <= 12 && d0 >= 1 && d0 <= 31) return new Date(Date.UTC(y0, mo0 - 1, d0));
    }
    const t = Date.parse(raw.replace(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/, '$1 $2 $3'));
    if (!Number.isNaN(t)) {
        const dt = new Date(t);
        return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
    }
    return null;
}

function usesLegacyFlatClientShare(soldDateStr) {
    const d = parseSoldDateLoose(soldDateStr);
    if (!d) return false;
    return d.getTime() < parseTieredSinceUtcMidnight().getTime();
}

function legacyClientShareFraction() {
    const x = parseFloat(String(process.env.EBAY_PAYOUT_LEGACY_CLIENT_SHARE || '0.75'));
    return Number.isFinite(x) && x > 0 && x < 1 ? x : 0.75;
}

/** Infer adjusted net from client_payout that was computed as net * tieredRate(net). */
function inferNetFromTieredClientPayout(clientPayout) {
    const C = money(parseMoney(clientPayout));
    if (!(C > 0)) return null;
    const trials = [
        { r: 0.75, test: (n) => n > 0 && n <= 50 },
        { r: 0.8, test: (n) => n > 50 && n <= 150 },
        { r: 0.85, test: (n) => n > 150 },
    ];
    for (const { r, test } of trials) {
        const n = money(C / r);
        if (test(n)) return n;
    }
    return null;
}

function clientShareRate(adjustedNet, soldDateStr) {
    if (usesLegacyFlatClientShare(soldDateStr)) return legacyClientShareFraction();
    return payoutRateTiered(adjustedNet);
}

function parseArgs(argv) {
    let input = null;
    let output = null;
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--in' && argv[i + 1]) input = argv[++i];
        else if (argv[i] === '--out' && argv[i + 1]) output = argv[++i];
    }
    return { input, output };
}

function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) {
            if (c === '"') {
                if (line[i + 1] === '"') {
                    cur += '"';
                    i++;
                } else inQ = false;
            } else cur += c;
        } else if (c === '"') inQ = true;
        else if (c === ',') {
            out.push(cur);
            cur = '';
        } else cur += c;
    }
    out.push(cur);
    return out;
}

function normalizeKey(h) {
    return String(h || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_');
}

function loadRows(inputPath) {
    const ext = path.extname(inputPath).toLowerCase();
    if (ext === '.json') {
        const j = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
        const rows = Array.isArray(j.rows) ? j.rows : Array.isArray(j) ? j : [];
        return rows.map((r) => ({
            orderNumber: r.orderNumber || r.order_number || '',
            itemTitle: r.itemTitle || r.item_title || '',
            customSku: r.customSku || r.custom_sku || '',
            clientId: r.clientId || r.client_id || '',
            quantity: r.quantity ?? 1,
            soldDate: r.soldDate || r.sold_date || '',
            grossEarnings: r.grossEarnings ?? r.gross_earnings ?? '',
            postageCost: r.postageCost ?? r.postage_cost ?? '',
            packagingCost: r.packagingCost ?? r.packaging_cost ?? '',
            netEarnings: r.netEarnings ?? r.net_earnings ?? '',
            payoutRate: r.payoutRate ?? r.payout_rate ?? '',
            clientPayout: r.clientPayout ?? r.client_payout ?? '',
        }));
    }
    const text = fs.readFileSync(inputPath, 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.length);
    if (!lines.length) return [];
    const headers = parseCsvLine(lines[0]).map(normalizeKey);
    const idx = (name) => headers.indexOf(normalizeKey(name));
    const out = [];
    for (let li = 1; li < lines.length; li++) {
        const cells = parseCsvLine(lines[li]);
        const get = (aliases) => {
            for (const a of aliases) {
                const i = idx(a);
                if (i >= 0 && cells[i] != null) return cells[i];
            }
            return '';
        };
        out.push({
            orderNumber: get(['order_number']),
            itemTitle: get(['item_title']),
            customSku: get(['custom_sku']),
            clientId: get(['client_id']),
            quantity: get(['quantity']) || 1,
            soldDate: get(['sold_date']),
            grossEarnings: get(['gross_earnings']),
            postageCost: get(['postage_cost']),
            packagingCost: get(['packaging_cost']),
            netEarnings: get(['net_earnings']),
            payoutRate: get(['payout_rate']),
            clientPayout: get(['client_payout']),
        });
    }
    return out;
}

function recalcRow(r) {
    const soldDate = String(r.soldDate || '').trim();
    let net = money(parseMoney(r.netEarnings));
    if (!(net > 0) && r.clientPayout != null && r.clientPayout !== '') {
        const inferred = inferNetFromTieredClientPayout(r.clientPayout);
        if (inferred != null) net = inferred;
    }
    const oldPayout = money(parseMoney(r.clientPayout));
    const oldRate = parseFloat(String(r.payoutRate));
    const rate = clientShareRate(net, soldDate);
    const newPayout = money(net * rate);
    const legacy = usesLegacyFlatClientShare(soldDate);
    return {
        ...r,
        netEarnings: net,
        payoutRate: rate,
        clientPayout: newPayout,
        _meta: {
            legacyDateRule: legacy,
            oldClientPayout: oldPayout,
            oldPayoutRate: Number.isFinite(oldRate) ? oldRate : null,
            delta: money(newPayout - oldPayout),
        },
    };
}

function writeCsv(rows, outPath) {
    const header =
        'order_number,item_title,custom_sku,client_id,quantity,sold_date,gross_earnings,postage_cost,packaging_cost,net_earnings,payout_rate,client_payout,old_client_payout,delta_client_payout,legacy_rule_applied\n';
    const esc = (s) => {
        const t = String(s ?? '');
        if (/[",\n\r]/.test(t)) return '"' + t.replace(/"/g, '""') + '"';
        return t;
    };
    const body = rows.map((r) =>
        [
            esc(r.orderNumber),
            esc(r.itemTitle),
            esc(r.customSku),
            esc(r.clientId),
            esc(r.quantity),
            esc(r.soldDate),
            esc(r.grossEarnings),
            esc(r.postageCost),
            esc(r.packagingCost),
            esc(r.netEarnings),
            esc(r.payoutRate),
            esc(r.clientPayout),
            esc(r._meta.oldClientPayout),
            esc(r._meta.delta),
            r._meta.legacyDateRule ? '1' : '0',
        ].join(','),
    );
    fs.writeFileSync(outPath, header + body.join('\n'), 'utf8');
}

function main() {
    const { input, output } = parseArgs(process.argv);
    if (!input || !fs.existsSync(input)) {
        console.error('Usage: node scripts/recalc-ebay-payout-legacy-client-share.js --in <file.json|csv> [--out <file.csv>]');
        process.exit(1);
    }
    const rows = loadRows(path.resolve(input));
    if (!rows.length) {
        console.error('No rows loaded.');
        process.exit(1);
    }
    const recalced = rows.map(recalcRow);
    let changed = 0;
    let legacyRows = 0;
    for (const r of recalced) {
        if (r._meta.legacyDateRule) legacyRows++;
        if (Math.abs(r._meta.delta) > 0.005) changed++;
    }
    const outPath =
        output ||
        path.join(
            path.dirname(path.resolve(input)),
            path.basename(input, path.extname(input)) + '-recalc.csv',
        );
    writeCsv(recalced, outPath);
    console.log(
        JSON.stringify(
            {
                tieredSince: parseTieredSinceUtcMidnight().toISOString().slice(0, 10),
                legacyClientShare: legacyClientShareFraction(),
                totalRows: recalced.length,
                rowsMatchingLegacyDate: legacyRows,
                rowsWithPayoutChange: changed,
                output: outPath,
            },
            null,
            2,
        ),
    );
}

main();
