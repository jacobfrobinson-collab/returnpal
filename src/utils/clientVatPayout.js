/**
 * Client payout amounts for monthly statements / invoices.
 * Non–VAT-registered clients: 20% withholding on net payout (after returns/fees).
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
    if (!isClientVatRegistered(vatRegistered)) {
        return Math.round(net * NON_VAT_CLIENT_PAYOUT_RATE * 100) / 100;
    }
    return net;
}

/** VAT column on invoices (20% of line subtotal when registered). */
function invoiceVatOnSubtotal(subtotalNet, vatRegistered) {
    const sub = Number(subtotalNet) || 0;
    if (!isClientVatRegistered(vatRegistered) || sub <= 0) return 0;
    return Math.round(sub * 0.2 * 100) / 100;
}

module.exports = {
    NON_VAT_CLIENT_PAYOUT_RATE,
    isClientVatRegistered,
    clientPayoutFromGrossNet,
    invoiceVatOnSubtotal,
};
