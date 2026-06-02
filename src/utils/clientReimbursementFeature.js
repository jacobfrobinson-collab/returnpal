/** Client self-serve reimbursement UI/API. Disabled only when CLIENT_REIMBURSEMENT_ENABLED=0|false|no */
function isClientReimbursementEnabled() {
    const v = (process.env.CLIENT_REIMBURSEMENT_ENABLED || '').trim().toLowerCase();
    if (v === '0' || v === 'false' || v === 'no') return false;
    return true;
}

module.exports = { isClientReimbursementEnabled };
