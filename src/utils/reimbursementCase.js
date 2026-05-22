/**
 * Reimbursement case cockpit — Seller Central text and status helpers.
 */

const CASE_STATUSES = ['draft', 'ready', 'submitted', 'approved', 'partial', 'denied'];

const STATUS_LABELS = {
    draft: 'Draft',
    ready: 'Ready to file',
    submitted: 'Submitted to Amazon',
    approved: 'Approved',
    partial: 'Partially approved',
    denied: 'Denied',
};

const SC_URL = 'https://sellercentral.amazon.co.uk/help/hub/reference/G202130860';

function buildCaseText(claim) {
    const c = claim || {};
    const ref = String(c.package_reference || '').trim();
    const item = String(c.item_description || '').trim();
    const type = String(c.reimbursement_type || 'Damaged Inventory').trim();
    const notes = String(c.notes || '').trim();
    const order = String(c.order_number || '').trim();
    const lines = [
        'ReturnPal reimbursement support — please review the following FBA inventory claim.',
        '',
        'Claim type: ' + type,
        'Package reference: ' + ref,
        'Item: ' + item,
    ];
    if (order) lines.push('Order ID: ' + order);
    if (notes) {
        lines.push('');
        lines.push('Details:');
        lines.push(notes);
    }
    lines.push('');
    lines.push('Photo evidence is attached. Units were processed at ReturnPal on behalf of the seller.');
    lines.push('Please reimburse per Amazon policy for this claim type.');
    return lines.join('\n');
}

function normalizeCaseStatus(raw) {
    const s = String(raw || 'draft').trim().toLowerCase();
    return CASE_STATUSES.includes(s) ? s : 'draft';
}

function enrichClaimRow(row) {
    const status = normalizeCaseStatus(row.case_status);
    return {
        ...row,
        case_status: status,
        case_status_label: STATUS_LABELS[status] || status,
        case_text: row.case_text || buildCaseText(row),
        seller_central_url: SC_URL,
    };
}

module.exports = {
    CASE_STATUSES,
    STATUS_LABELS,
    SC_URL,
    buildCaseText,
    normalizeCaseStatus,
    enrichClaimRow,
};
