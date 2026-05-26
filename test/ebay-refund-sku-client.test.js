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
    canonicalizeClientIdCandidate,
} = require('../src/utils/ebayRefundSkuClient');

function testPpfVariants() {
    assert(extractLegacyClientIdFromText('Shelf PPF081 foo') === 'PPF081', 'PPF081 in title');
    assert(extractLegacyClientIdFromText('PPF-081') === 'PPF081', 'PPF-081');
    assert(extractLegacyClientIdFromText('PPF001') === 'PPF001', 'PPF001');
    assert(extractLegacyClientIdFromText('PPF-32') === 'PPF032', 'PPF-32');
    assert(extractLegacyClientIdFromText('DU12-3NewPPF-081') === 'PPF081', 'DU prefix');
}

function testFtfVariants() {
    assert(extractLegacyClientIdFromText('Widget FTF012 end') === 'FTF012', 'FTF numbered');
    assert(extractLegacyClientIdFromText('FTF') === 'FTF', 'FTF alone');
}

function testTwoLetterClients() {
    assert(extractLegacyClientIdFromText('NewOther AI Cable') === 'AI', 'tagged AI');
    assert(extractLegacyClientIdFromText('Shelf BD item') === 'BD', 'tagged BD');
    assert(extractLegacyClientIdFromText('something RC NEW') === 'RC', 'before NEW');
    assert(extractLegacyClientIdFromText('OS widget') === '', 'OS excluded');
    assert(extractLegacyClientIdFromText('EU plug') === '', 'EU excluded');
    assert(canonicalizeClientIdCandidate('ai') === 'AI', 'lowercase ai');
}

function testNormalizeSpecifier() {
    assert(normalizeClientIdSpecifier('ppf-32') === 'PPF032', 'normalize hyphen');
    assert(normalizeClientIdSpecifier('PPF081') === 'PPF081', 'already canonical');
    assert(normalizeClientIdSpecifier('bd') === 'BD', 'two letter');
    assert(normalizeClientIdSpecifier('OS') === 'OS', 'OS left as-is if not recognized');
}

function testBulkSet() {
    assert(bulkSetClientIdValue('PPF-032') === 'PPF032', 'bulk set PPF');
    assert(bulkSetClientIdValue('AI') === 'AI', 'bulk set AI');
}

function testContains() {
    const row = { custom_label: 'NewOther PPF-040', product: 'Widget', notes: '' };
    const hay = rowSkuHaystack(row);
    assert(textIncludesInsensitive(hay, 'ppf-040'), 'contains hyphen form');
    assert(textMatchesBulkContains(hay, 'PPF040'), 'PPF040 matches PPF-040 in SKU');
    assert(textMatchesBulkContains(hay, 'PPF-040'), 'canonical needle');
    assert(textMatchesBulkContains('NewOther AI item', 'AI'), 'AI match');
}

function run() {
    testPpfVariants();
    testFtfVariants();
    testTwoLetterClients();
    testNormalizeSpecifier();
    testBulkSet();
    testContains();
    console.log('ebay-refund-sku-client.test.js: all passed');
}

run();
