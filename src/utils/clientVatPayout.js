/**
 * Client payout amounts for monthly statements / invoices.
 * Non–VAT-registered clients: 20% withholding on positive net payout only.
 * Returns and clawbacks pass through at the line amount (no extra withholding).
 */

const NON_VAT_CLIENT_PAYOUT_RATE = 0.8;

/**
 * @param {unknown} vatRegistered users.vat_registered (0/1 or boolean)
 */
function isClientVatRegistered(vatRegistered) {
    return !!vatRegistered;
}

/**
 * Net payout before VAT-registration policy (sales − returns − fees).
 * @param {number} grossNet
 * @param {unknown} vatRegistered
 */
function clientPayoutFromGrossNet(grossNet, vatRegistered) {
    const net = Math.round((Number(grossNet) || 0) * 100) / 100;
    if (isClientVatRegistered(vatRegistered)) return net;
    if (net <= 0) return net;
    return Math.round(net * NON_VAT_CLIENT_PAYOUT_RATE * 100) / 100;
}

/** VAT on ReturnPal processing fees (not on client sales share). */
function invoiceVatOnFees(fees, vatRegistered) {
    const f = Number(fees) || 0;
    if (!isClientVatRegistered(vatRegistered) || f <= 0) return 0;
    return Math.round(f * 0.2 * 100) / 100;
}

module.exports = {
    NON_VAT_CLIENT_PAYOUT_RATE,
    isClientVatRegistered,
    clientPayoutFromGrossNet,
    invoiceVatOnFees,
};
