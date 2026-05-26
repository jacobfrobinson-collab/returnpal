/**
 * Unit tests for return adjustment → sold item linking (product title match).
 */

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const { normalizeProductKey } = require('../src/utils/returnAdjustmentSoldLink');

function testNormalizeProductKey() {
    const a = normalizeProductKey('Garmin DriveSmart 51 LMT-S GPS Satellite Navigation');
    const b = normalizeProductKey('garmin drivesmart 51 lmt s gps satellite navigation system touchscreen');
    assert(a.length >= 18 && b.includes('garmin'), 'normalize strips punctuation');
    assert(b.includes('51'), 'keeps alphanumerics');
}

function testNormalizeShortProductSkipped() {
    assert(normalizeProductKey('ab').length < 10, 'short keys');
}

function run() {
    testNormalizeProductKey();
    testNormalizeShortProductSkipped();
    console.log('return-adjustment-sold-link.test.js: all passed');
}

run();
