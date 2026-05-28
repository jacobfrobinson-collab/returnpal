/**
 * Unit tests for refund insight category inference.
 */

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'Assertion failed');
};

const { inferRefundCategory, inferRefundSubcategory } = require('../src/utils/refundInsights');

function testBeautyBrandsNotOther() {
    const cases = [
        'Baxter of California Oil Free Moisturizer',
        'Babyliss Cordless Straightener',
        'Lancôme Tonique Confort Lait',
        'Lanc Lait Hydrating Toner',
    ];
    for (const name of cases) {
        const cat = inferRefundCategory(name);
        assert(cat === 'Beauty & Personal Care', `${name} => ${cat}, expected Beauty`);
        const sub = inferRefundSubcategory(cat, name);
        assert(sub !== 'Miscellaneous', `${name} subcategory should be typed, got ${sub}`);
    }
}

function testBabylissHairStyling() {
    assert(inferRefundSubcategory('Beauty & Personal Care', 'Babyliss Cordless') === 'Hair Styling');
}

function testBaxterSkincare() {
    assert(inferRefundSubcategory('Beauty & Personal Care', 'Baxter California Moisturizer') === 'Skincare');
}

function run() {
    testBeautyBrandsNotOther();
    testBabylissHairStyling();
    testBaxterSkincare();
    console.log('refund-insights.test.js: all passed');
}

run();
