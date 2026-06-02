/**
 * Client dashboard preferences stored as JSON on users.client_preferences.
 */

const DEFAULT_PREFS = {
    billing_name: '',
    billing_company: '',
    billing_address: '',
    billing_phone: '',
    prep_name: '',
    prep_address: '',
    prep_contact: '',
    prep_phone: '',
    prep_email: '',
    prep_reference: '',
    vat_number: '',
    email_package_delivered: true,
    email_item_sold: true,
    email_payout_sent: true,
    email_monthly_invoice: false,
    email_digest: 'off',
    /** Available to all clients unless admin sets prep_sendback_enabled to false */
    prep_sendback_enabled: true,
};

function parseClientPreferences(raw) {
    if (!raw || typeof raw !== 'string') return { ...DEFAULT_PREFS };
    try {
        const o = JSON.parse(raw);
        return { ...DEFAULT_PREFS, ...o };
    } catch {
        return { ...DEFAULT_PREFS };
    }
}

function mergeClientPreferences(existing, patch) {
    const base = parseClientPreferences(existing);
    const p = patch && typeof patch === 'object' ? patch : {};
    const out = { ...base };
    const strKeys = [
        'billing_name',
        'billing_company',
        'billing_address',
        'billing_phone',
        'prep_name',
        'prep_address',
        'prep_contact',
        'prep_phone',
        'prep_email',
        'prep_reference',
        'vat_number',
        'email_digest',
    ];
    for (const k of strKeys) {
        if (p[k] !== undefined) out[k] = String(p[k] == null ? '' : p[k]).trim();
    }
    for (const k of ['email_package_delivered', 'email_item_sold', 'email_payout_sent', 'email_monthly_invoice']) {
        if (p[k] !== undefined) out[k] = !!p[k];
    }
    if (p.prep_sendback_enabled !== undefined) out.prep_sendback_enabled = !!p.prep_sendback_enabled;
    if (p.email_digest !== undefined) {
        const d = String(p.email_digest).trim().toLowerCase();
        out.email_digest = d === 'weekly' || d === 'monthly' ? d : 'off';
    }
    return out;
}

/** Client settings form must not self-enable prep send-back. */
function mergeClientPreferencesFromClient(existing, patch) {
    const p = patch && typeof patch === 'object' ? { ...patch } : {};
    delete p.prep_sendback_enabled;
    return mergeClientPreferences(existing, p);
}

function isPrepSendbackEnabled(prefs) {
    if (!prefs || prefs.prep_sendback_enabled === undefined) return true;
    return prefs.prep_sendback_enabled !== false;
}

module.exports = {
    DEFAULT_PREFS,
    parseClientPreferences,
    mergeClientPreferences,
    mergeClientPreferencesFromClient,
    isPrepSendbackEnabled,
};
