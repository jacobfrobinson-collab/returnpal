# Email (SMTP) setup

ReturnPal can send:

| Type | When | Recipients |
|------|------|------------|
| Weekly summary | **Sunday ~18:00 UK** (Mon–Sun calendar week) | All clients (opt out: Settings → Scheduled summaries → Off) |
| Weekly action-required | **Sunday ~19:00 UK** | Clients with `email_action_digest` on (billing, claims, queries only) |
| Monthly snapshot + invoice | **1st of month ~09:00 UK** (prior month) | All clients (same opt out) |
| Monthly trust email | **1st of month ~09:30 UK** | Narrative ops summary (`email_trust_monthly`) |
| Reimbursement reminders | Daily ~10:00 UK | Ready claims at day 0 / 3 / 7 |
| Inactivity re-engagement | Monday ~11:00 UK | No packages in 60 days (max 1 per 90 days) |
| Package delivered | When status becomes Delivered | Per-client toggle |
| Item sold | When a sale row is created | Per-client toggle |
| High-value alert | Item received/sold ≥ `HIGH_VALUE_ALERT_GBP` (default £500) | Transactional |
| Payout sent | Admin marks paid or monthly email | Per-client toggle + Discord/Slack webhooks |
| **Admin: client query** | Client submits or follows up on **My queries** | `ADMIN_QUERY_NOTIFY_EMAIL` |
| **Admin: homepage contact** | Public **Contact us** form on [returnpal.co.uk](https://www.returnpal.co.uk/index.html#contact) | Same inbox |

Weekly emails always send (including zero-activity weeks). Monthly emails include invoice totals and payout schedule text.

All outbound email requires SMTP on the server.

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
| `WEEKLY_DIGEST_EMAIL_ENABLED` | `1` | Sunday weekly summary scheduler |
| `MONTHLY_INVOICE_EMAIL_ENABLED` | `1` | 1st-of-month monthly snapshot + invoice |
| `TRANSACTIONAL_EMAIL_ENABLED` | `1` | Package delivered / item sold |
| `ADMIN_QUERY_NOTIFY_ENABLED` | `1` | Email operators on new client queries (falls back to transactional toggle) |
| `ADMIN_QUERY_NOTIFY_EMAIL` | `contact@returnpal.co.uk` | Inbox for query alerts |

### Optional schedule overrides

| Variable | Default | Meaning |
|----------|---------|---------|
| `WEEKLY_DIGEST_CRON` | `0 18 * * 0` | Sunday 18:00 (end of week) |
| `MONTHLY_INVOICE_CRON` | `0 9 1 * *` | 1st of month 09:00 |
| `MONTHLY_TRUST_CRON` | `30 9 1 * *` | Monthly trust narrative |
| `WEEKLY_ACTION_CRON` | `0 19 * * 0` | Action-required digest |
| `REIMBURSEMENT_REMINDER_CRON` | `0 10 * * *` | Ready-claim reminders |
| `INACTIVITY_CRON` | `0 11 * * 1` | 60-day inactivity |
| `HIGH_VALUE_ALERT_GBP` | `500` | Threshold for high-value emails |
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
| Digest never arrives | User chose **Off** under scheduled summaries in Settings |
| Monthly email shows £0 | No sales or returns in the previous calendar month (email still sends) |
| Duplicate event emails | Prevented by `email_log` — same package/sale id only emails once |
| Wrong links in email | Set `PUBLIC_APP_URL` to production URL |

## Idempotency

The `email_log` table records `(user_id, kind, ref_key)` so cron retries and re-imports do not send duplicate emails.
