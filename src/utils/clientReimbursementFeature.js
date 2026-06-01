/** Client self-serve reimbursement UI/API (dashboard cockpit). Admin routes are separate. */
function isClientReimbursementEnabled() {
    const v = (process.env.CLIENT_REIMBURSEMENT_ENABLED || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}

module.exports = { isClientReimbursementEnabled };
