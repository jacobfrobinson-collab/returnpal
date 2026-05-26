/**
 * Unit tests for SKU → legacy Client ID helpers.
 * Run: node test/ebay-refund-sku-client.test.js
 */

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const {
    extractLegacyClientIdFromText,
    normalizeClientIdSpecifier,
    bulkSetClientIdValue,
    textIncludesInsensitive,
    textMatchesBulkContains,
    rowSkuHaystack,
} = require('../src/utils/ebayRefundSkuClient');

function testPpfVariants() {
    assert(extractLegacyClientIdFromText('Shelf PPF081 foo') === 'PPF081', 'PPF081 in title');
    assert(extractLegacyClientIdFromText('PPF-081') === 'PPF081', 'PPF-081');
    assert(extractLegacyClientIdFromText('something PPF 81 end') === 'PPF081', 'PPF 81');
    assert(extractLegacyClientIdFromText('ppf081') === 'PPF081', 'lowercase');
    assert(extractLegacyClientIdFromText('DU12-3NewPPF-081') === 'PPF081', 'DU prefix');
}

function testNormalizeSpecifier() {
    assert(normalizeClientIdSpecifier('ppf-81') === 'PPF081', 'normalize hyphen');
    assert(normalizeClientIdSpecifier('PPF081') === 'PPF081', 'already canonical');
    assert(normalizeClientIdSpecifier('ac') === 'ac', 'non-ppf unchanged');
}

function testBulkSet() {
    assert(bulkSetClientIdValue('PPF-081') === 'PPF081', 'bulk set normalizes');
}

function testContains() {
    const row = { custom_label: 'NewOther PPF-040', product: 'Widget', notes: '' };
    const hay = rowSkuHaystack(row);
    assert(textIncludesInsensitive(hay, 'ppf-040'), 'contains hyphen form');
    assert(textMatchesBulkContains(hay, 'PPF040'), 'PPF040 matches PPF-040 in SKU');
    assert(textMatchesBulkContains(hay, 'PPF-040'), 'canonical needle');
}

function run() {
    testPpfVariants();
    testNormalizeSpecifier();
    testBulkSet();
    testContains();
    console.log('ebay-refund-sku-client.test.js: all passed');
}

run();
