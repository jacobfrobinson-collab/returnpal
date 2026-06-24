const assert = require('assert');
const {
    CURRENT_TERMS_VERSION,
    userNeedsTermsAcceptance,
    enrichUserWithTerms,
} = require('../src/utils/termsOfService');

assert.strictEqual(userNeedsTermsAcceptance(null), true);
assert.strictEqual(userNeedsTermsAcceptance({}), true);
assert.strictEqual(userNeedsTermsAcceptance({ terms_accepted_at: '2026-06-01T00:00:00.000Z' }), true);
assert.strictEqual(
    userNeedsTermsAcceptance({
        terms_accepted_at: '2026-06-01T00:00:00.000Z',
        terms_version: '0.9',
    }),
    true
);
assert.strictEqual(
    userNeedsTermsAcceptance({
        terms_accepted_at: '2026-06-24T00:00:00.000Z',
        terms_version: CURRENT_TERMS_VERSION,
    }),
    false
);

const enriched = enrichUserWithTerms(
    {
        id: 1,
        terms_accepted_at: null,
        terms_version: null,
    },
    false
);
assert.strictEqual(enriched.terms_acceptance_required, true);
assert.strictEqual(enriched.current_terms_version, CURRENT_TERMS_VERSION);

const admin = enrichUserWithTerms({ id: 2, is_admin: true }, true);
assert.strictEqual(admin.terms_acceptance_required, false);

console.log('terms-acceptance: all checks passed');
