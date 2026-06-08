# Email (SMTP) setup

ReturnPal can send:

| Type | When | User setting |
|------|------|----------------|
| Weekly digest | Monday ~08:00 UK (default) | Settings → Email digest → Weekly |
| Monthly digest | 1st of month ~08:00 UK | Settings → Email digest → Monthly |
| Monthly invoice | 1st of month ~09:00 UK | Settings → Monthly invoice checkbox |
| Package delivered | When status becomes Delivered | Settings → Package delivered |
| Item sold | When a sale row is created | Settings → Item sold |
| Payout sent | Wording in monthly invoice when status is Paid | Settings → Payout notice in invoice |

All outbound email requires SMTP on the server. Client preferences only control *who* receives mail; they do not configure the mail provider.

## Render / production environment

Set these in **Render → Web Service → Environment**, then **Manual Deploy** (or wait for auto-deploy).

### Master switch + SMTP

| Variable | Example | Purpose |
|----------|---------|---------|
| `EMAIL_ENABLED` | `1` | Master switch — no sends when unset or `0` |
| `SMTP_HOST` | `smtp.sendgrid.net` | Provider host |
| `SMTP_PORT` | `587` | Usually 587 (STARTTLS) or 465 if `SMTP_SECURE=1` |
| `SMTP_SECURE` | `0` | `1` only for port 465 SSL |
| `SMTP_USER` | `apikey` | Provider login / API user |
| `SMTP_PASS` | *(secret)* | API key or password |
| `SMTP_FROM` | `noreply@returnpal.co.uk` | From address (must be verified with provider) |
| `PUBLIC_APP_URL` | `https://www.returnpal.co.uk` | Links in email bodies |

Also set `FRONTEND_URL` to your public site URL (used as fallback for links).

### Per-job toggles

| Variable | Value | Effect |
|----------|-------|--------|
| `WEEKLY_DIGEST_EMAIL_ENABLED` | `1` | Monday weekly digest scheduler |
| `MONTHLY_DIGEST_EMAIL_ENABLED` | `1` | 1st-of-month monthly digest |
| `MONTHLY_INVOICE_EMAIL_ENABLED` | `1` | 1st-of-month invoice email |
| `TRANSACTIONAL_EMAIL_ENABLED` | `1` | Package delivered / item sold |

### Optional schedule overrides

| Variable | Default | Meaning |
|----------|---------|---------|
| `WEEKLY_DIGEST_CRON` | `0 8 * * 1` | Monday 08:00 |
| `MONTHLY_DIGEST_CRON` | `0 8 1 * *` | 1st of month 08:00 |
| `MONTHLY_INVOICE_CRON` | `0 9 1 * *` | 1st of month 09:00 |
| `WEEKLY_DIGEST_TZ` | `Europe/London` | Cron timezone |

## Provider examples

### SendGrid

- Host: `smtp.sendgrid.net`
- Port: `587`, `SMTP_SECURE=0`
- User: `apikey`
- Pass: your SendGrid API key
- Verify sender domain / single sender for `SMTP_FROM`

### Mailgun / Postmark / Amazon SES

Use the SMTP credentials from your provider dashboard. Set `SMTP_FROM` to a verified address.

## Verify after deploy

1. **Logs on startup** — when enabled, you should see lines like:
   - `[weekly-digest] scheduler started: 0 8 * * 1 Europe/London`
   - `[monthly-digest] scheduler started: ...`
   - `[monthly-invoice] scheduler started: ...`
2. **Client settings** — user enables digest / invoice / event toggles and saves.
3. **Test scripts** (on Render Shell or locally with env set):
   ```bash
   npm run email:test-weekly -- 123
   npm run email:test-monthly-invoice -- 123
   ```
   Replace `123` with a user id.

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| No emails at all | `EMAIL_ENABLED` not `1`, or `SMTP_HOST` missing |
| Digest never arrives | User chose Off, or weekly digest skipped (zero activity in last 7 days) |
| Monthly invoice skipped | No sales or returns in the previous calendar month |
| Duplicate event emails | Prevented by `email_log` — same package/sale id only emails once |
| Wrong links in email | Set `PUBLIC_APP_URL` to production URL |

## Idempotency

The `email_log` table records `(user_id, kind, ref_key)` so cron retries and re-imports do not send duplicate emails.
