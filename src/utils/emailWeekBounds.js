/**
 * Calendar week (Mon–Sun) bounds in a given IANA timezone for weekly digest emails.
 */

function ymdPartsInTz(date, tz) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const parts = fmt.formatToParts(date);
    return {
        y: Number(parts.find((p) => p.type === 'year').value),
        m: Number(parts.find((p) => p.type === 'month').value),
        d: Number(parts.find((p) => p.type === 'day').value),
    };
}

function ymdString(y, m, d) {
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Day of week 0=Sun … 6=Sat for a calendar Y-M-D (no DST issues at midday UTC). */
function weekdayFromYmd(y, m, d) {
    return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
}

/** Monday and Sunday YYYY-MM-DD for the week containing refDate in tz. */
function calendarWeekMonSun(refDate = new Date(), tz = process.env.WEEKLY_DIGEST_TZ || 'Europe/London') {
    const { y, m, d } = ymdPartsInTz(refDate, tz);
    const dow = weekdayFromYmd(y, m, d);
    const daysFromMonday = dow === 0 ? 6 : dow - 1;
    const mondayUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    mondayUtc.setUTCDate(mondayUtc.getUTCDate() - daysFromMonday);
    const sundayUtc = new Date(mondayUtc);
    sundayUtc.setUTCDate(sundayUtc.getUTCDate() + 6);
    const startYmd = ymdString(
        mondayUtc.getUTCFullYear(),
        mondayUtc.getUTCMonth() + 1,
        mondayUtc.getUTCDate()
    );
    const endYmd = ymdString(
        sundayUtc.getUTCFullYear(),
        sundayUtc.getUTCMonth() + 1,
        sundayUtc.getUTCDate()
    );
    return { startYmd, endYmd, tz };
}

/** Idempotency key for the week ending on Sunday (endYmd). */
function weeklyDigestRefKey(date = new Date()) {
    const { endYmd } = calendarWeekMonSun(date);
    return `week:${endYmd}`;
}

function weekLabel(startYmd, endYmd) {
    const fmt = (ymd) => {
        const [y, m, d] = ymd.split('-').map(Number);
        return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    };
    return `${fmt(startYmd)} – ${fmt(endYmd)}`;
}

module.exports = { calendarWeekMonSun, weeklyDigestRefKey, weekLabel };
