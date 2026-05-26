/**
 * Optional on-disk log of *actual* resale you achieved (for calibrating estimates).
 * File: scripts/john-pye-actuals.json or JOHN_PYE_ACTUALS path.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @param {string} [p]
 */
function defaultActualsPath(p) {
    if (p && String(p).trim()) {
        return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
    }
    return path.join(__dirname, 'john-pye-actuals.json');
}

/**
 * @param {string} filePath
 */
function loadJohnPyeActuals(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
        return { version: 1, byLot: {} };
    }
    try {
        const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!j || typeof j !== 'object') {
            return { version: 1, byLot: {} };
        }
        if (!j.byLot || typeof j.byLot !== 'object') {
            j.byLot = {};
        }
        j.version = 1;
        return j;
    } catch {
        return { version: 1, byLot: {} };
    }
}

/**
 * @param {string} lotUrl
 * @param {object} data
 * @param {string} [filePath]
 */
function appendOrUpdateActual(lotUrl, data, filePath) {
    const p = defaultActualsPath(filePath);
    const cur = loadJohnPyeActuals(p);
    const u = String(lotUrl)
        .trim()
        .replace(/\/+$/, '');
    if (!u) {
        return { ok: false, error: 'no url' };
    }
    const key = Object.keys(cur.byLot).find((k) => k.replace(/\/+$/, '') === u) || u;
    cur.byLot[key] = {
        lotUrl: key,
        ...data,
        updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(p, JSON.stringify(cur, null, 2), 'utf8');
    return { ok: true, path: p, key };
}

/**
 * @param {string} lotUrl
 * @param {string} [filePath]
 * @returns {{ actualResaleGbp: number, recordedAt?: string, note?: string } | null}
 */
function getActualForLot(lotUrl, filePath) {
    const j = loadJohnPyeActuals(defaultActualsPath(filePath));
    const u = String(lotUrl)
        .trim()
        .replace(/\/+$/, '');
    const key = j.byLot[u] ? u : Object.keys(j.byLot).find((k) => k.replace(/\/+$/, '') === u);
    if (!key || !j.byLot[key]) {
        return null;
    }
    const a = j.byLot[key];
    if (a.actualResaleGbp == null) {
        return null;
    }
    return a;
}

module.exports = {
    defaultActualsPath,
    loadJohnPyeActuals,
    appendOrUpdateActual,
    getActualForLot,
};
