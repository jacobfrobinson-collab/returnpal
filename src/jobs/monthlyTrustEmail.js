/**
 * 1st of month trust email — narrative ops summary beyond invoice.
 */
const { getDb } = require('../database');
const { isMonthlyDigestEnabled, sendEmail, publicAppUrl } = require('../utils/emailTransport');
const { prefsFromUserRow, listNonAdminUsersWithEmail } = require('../utils/emailPreferences');
const { wasEmailSent, recordEmailSent } = require('../utils/emailLog');
const { maxInvoicablePeriodYm, parsePeriodYm } = require('../utils/computedMonthlyStatements');
const {
    getLifetimeRecovered,
    getMilestones,
    getRecoveredBreakdown,
} = require('../utils/clientRecoveryMetrics');
const { getClientBenchmarks } = require('../utils/clientBenchmarks');
const {
    wrapBrandedEmail,
    greetingHtml,
    paragraphHtml,
    summaryTableHtml,
    ctaButtonHtml,
    signOffHtml,
    buildPlainEmail,
    formatGbp,
} = require('../utils/emailTemplates');

function parseResults(result) {
    if (!result || !result.length) return [];
    const cols = result[0].columns;
    return result[0].values.map((row) => {
        const obj = {};
        cols.forEach((col, i) => {
            obj[col] = row[i];
        });
        return obj;
    });
}

function periodLabel(periodYm) {
    const p = parsePeriodYm(periodYm);
    if (!p) return periodYm;
    return new Date(p.y, p.m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function fetchMonthOps(db, userId, periodYm) {
    const p = parsePeriodYm(periodYm);
    if (!p) return null;
    const received = parseResults(
        db.exec(
            `SELECT COUNT(*) AS c FROM received_items WHERE user_id = ? AND date_received >= ? AND date_received <= ?`,
            [userId, p.monthStart + ' 00:00:00', p.monthEndStr + ' 23:59:59']
        )
    );
    const sold = parseResults(
        db.exec(
            `SELECT COUNT(*) AS c FROM sold_items WHERE user_id = ? AND sold_date >= ? AND sold_date <= ?`,
            [userId, p.monthStart, p.monthEndStr]
        )
    );
    const claims = parseResults(
        db.exec(
            `SELECT COUNT(*) AS c FROM reimbursement_claims WHERE user_id = ? AND created_at >= ? AND created_at <= ?`,
            [userId, p.monthStart + ' 00:00:00', p.monthEndStr + ' 23:59:59']
        )
    );
    const queriesResolved = parseResults(
        db.exec(
            `SELECT COUNT(*) AS c FROM item_queries WHERE user_id = ? AND status = 'closed' AND updated_at >= ? AND updated_at <= ?`,
            [userId, p.monthStart + ' 00:00:00', p.monthEndStr + ' 23:59:59']
        )
    );
    const prepSendbacks = parseResults(
        db.exec(
            `SELECT COUNT(*) AS c FROM prep_sendback_requests WHERE user_id = ? AND created_at >= ? AND created_at <= ?`,
            [userId, p.monthStart + ' 00:00:00', p.monthEndStr + ' 23:59:59']
        )
    );
    const recovery = getRecoveredBreakdown(db, userId, { periodYm });
    return {
        received: received[0]?.c || 0,
        sold: sold[0]?.c || 0,
        claims: claims[0]?.c || 0,
        queries_resolved: queriesResolved[0]?.c || 0,
        prep_sendbacks: prepSendbacks[0]?.c || 0,
        recovered: recovery.total_recovered,
    };
}

function wantsTrustEmail(prefs) {
    if (!prefs) return false;
    if (String(prefs.email_digest).toLowerCase() === 'off') return false;
    return prefs.email_trust_monthly !== false;
}

function buildTrustBody(u, periodYm, ops, lifetime, milestones, benchmark) {
    const name = u.full_name || u.email || 'there';
    const label = periodLabel(periodYm);
    const url = publicAppUrl() + '/dashboard/index.html';
    const narrative = [];
    if (ops.received > 0) {
        narrative.push(
            `We opened <strong>${ops.received}</strong> package check-in${ops.received === 1 ? '' : 's'} for you in ${label}.`
        );
    }
    if (ops.sold > 0) {
        narrative.push(
            `<strong>${ops.sold}</strong> item${ops.sold === 1 ? ' was' : 's were'} sold, adding ${formatGbp(ops.recovered)} to your recovery for the month.`
        );
    }
    if (ops.claims > 0) {
        narrative.push(
            `We prepared <strong>${ops.claims}</strong> reimbursement claim${ops.claims === 1 ? '' : 's'} to help you recover Amazon fees.`
        );
    }
    if (ops.queries_resolved > 0) {
        narrative.push(`<strong>${ops.queries_resolved}</strong> of your item queries were resolved.`);
    }
    if (ops.prep_sendbacks > 0) {
        narrative.push(
            `<strong>${ops.prep_sendbacks}</strong> prep send-back request${ops.prep_sendbacks === 1 ? ' was' : 's were'} handled.`
        );
    }
    if (!narrative.length) {
        narrative.push(`It was a quieter month in ${label}, but your dashboard still has the full picture of inventory and payouts.`);
    }

    let milestoneHtml = '';
    if (milestones.earned.length) {
        const latest = milestones.earned[milestones.earned.length - 1];
        milestoneHtml = paragraphHtml(
            `Milestone unlocked: <strong>${latest.label}</strong> — lifetime recovery is now ${formatGbp(lifetime)}.`
        );
    }

    let benchHtml = '';
    if (benchmark.vs_last_year_pct != null && benchmark.recovered > 0) {
        const dir = benchmark.vs_last_year_pct >= 0 ? 'more' : 'less';
        benchHtml = paragraphHtml(
            `You recovered <strong>${Math.abs(benchmark.vs_last_year_pct)}%</strong> ${dir} than the same month last year.`
        );
        if (benchmark.cohort_sufficient && benchmark.vs_cohort_pct != null) {
            benchHtml += paragraphHtml(
                `Compared to similar sellers, you are ${benchmark.vs_cohort_pct >= 0 ? 'above' : 'below'} the typical recovery for ${label}.`
            );
        }
    }

    const summaryRows = [
        { label: 'Packages opened', value: String(ops.received) },
        { label: 'Items sold', value: String(ops.sold) },
        { label: 'Claims filed', value: String(ops.claims) },
        { label: 'Recovered (month)', value: formatGbp(ops.recovered), emphasis: true },
        { label: 'Lifetime recovered', value: formatGbp(lifetime) },
    ];

    const bodyHtml =
        greetingHtml(name) +
        paragraphHtml(`Here is what ReturnPal did for you in <strong>${label}</strong>:`) +
        narrative.map((n) => paragraphHtml(n)).join('') +
        milestoneHtml +
        benchHtml +
        summaryTableHtml('Your month at a glance', summaryRows) +
        ctaButtonHtml('Open dashboard', url) +
        signOffHtml();

    const html = wrapBrandedEmail({
        title: 'Here’s what we did for you',
        subtitle: label,
        bodyHtml,
        recipientEmail: u.email,
        preheader: `${label}: ${ops.received} opened · ${ops.sold} sold · ${formatGbp(ops.recovered)} recovered`,
    });

    const text = buildPlainEmail({
        title: `ReturnPal monthly trust summary — ${label}`,
        greeting: `Hello ${name},`,
        paragraphs: narrative.map((n) => n.replace(/<[^>]+>/g, '')),
        summaryLines: summaryRows,
        ctaLabel: 'Open dashboard',
        ctaUrl: url,
        recipientEmail: u.email,
    });

    return { subject: `Here’s what we did for you — ${label}`, text, html };
}

async function runMonthlyTrustEmailOnce() {
    if (!isMonthlyDigestEnabled()) return;
    const db = await getDb();
    const periodYm = maxInvoicablePeriodYm();
    const refKey = `trust:${periodYm}`;
    const users = listNonAdminUsersWithEmail(db).filter((u) => wantsTrustEmail(prefsFromUserRow(u)));

    for (const u of users) {
        try {
            if (wasEmailSent(db, u.id, 'monthly_trust', refKey)) continue;
            const ops = fetchMonthOps(db, u.id, periodYm);
            if (!ops) continue;
            const lifetime = getLifetimeRecovered(db, u.id);
            const milestones = getMilestones(lifetime);
            const benchmark = getClientBenchmarks(db, u.id, periodYm);
            const { subject, text, html } = buildTrustBody(u, periodYm, ops, lifetime, milestones, benchmark);
            const sent = await sendEmail({ to: u.email, subject, text, html });
            if (sent) recordEmailSent(db, u.id, 'monthly_trust', refKey);
        } catch (e) {
            console.error('[monthly-trust] user', u.id, e.message || e);
        }
    }
    console.log('[monthly-trust] completed for', users.length, 'subscribers, period', periodYm);
}

function startMonthlyTrustEmailScheduler() {
    if (!isMonthlyDigestEnabled()) return;
    let cron;
    try {
        cron = require('node-cron');
    } catch (e) {
        return;
    }
    const expr = process.env.MONTHLY_TRUST_CRON || '30 9 1 * *';
    cron.schedule(
        expr,
        () => runMonthlyTrustEmailOnce().catch((err) => console.error('[monthly-trust]', err)),
        { timezone: process.env.MONTHLY_TRUST_TZ || 'Europe/London' }
    );
    console.log('[monthly-trust] scheduler started:', expr);
}

module.exports = { startMonthlyTrustEmailScheduler, runMonthlyTrustEmailOnce };
