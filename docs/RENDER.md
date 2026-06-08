# Deploying ReturnPal on Render

This app runs as a **Node Web Service** on [Render](https://render.com). Environment variables are set in the Render Dashboard — **not** in GitHub (except templates like `production.env.example`).

## 1. Web Service settings

| Setting | Value |
|---------|--------|
| **Root directory** | *(leave empty — repo root has `package.json`)* |
| **Build command** | `npm install` |
| **Start command** | `npm start` |
| **Health check path** | `/api/health` |

Connect the service to your GitHub repo (`jacobfrobinson-collab/returnpal`) and branch `main`. Enable **Auto-Deploy** if you want pushes to redeploy.

## 2. Persistent disk (SQLite)

Without a disk, the database resets on every deploy/restart.

1. Render Dashboard → your Web Service → **Disks** → **Add disk**
2. **Mount path:** e.g. `/var/lib/returnpal` (check **Disks** in the dashboard for your service)
3. **Size:** 1 GB (or more)
4. Save — Render will redeploy

Set env (match your disk mount + file name):

```env
DB_PATH=/var/lib/returnpal/data/returnpal.db
UPLOAD_DIR=/var/lib/returnpal/data/uploads
```

`UPLOAD_DIR` must be on the **same persistent disk** as the database. Reimbursement claim photos and avatars are stored here; without it, uploads are lost on redeploy and clients cannot download evidence.

After `migrate-sold-dates --apply`, redeploy. Do **not** set `RETURNPAL_SOLD_DATES_LEGACY=1` on production.

### Sold dates on production (required)

1. **Delete** `RETURNPAL_SOLD_DATES_LEGACY` from Environment if it exists (do not set it to `1`).
2. **Delete** `RETURNPAL_SOLD_DISPLAY_REPAIR_MONTH_DAY_SWAP_ALL` if set to `1` (this turns December 2025 sales into “March 12th 2025” on screen even without legacy mode).
3. Redeploy / restart the service.
4. Verify: open a client sold list, DevTools → Network → sold-items API → response must include `"sold_date_display_version":"calendar-api-label-2026-06d"`. If you see `legacy-ydm-2026-06b`, legacy mode is still on.
4. Hard-refresh the dashboard (`Ctrl+F5`). Job #38-style imports should show Oct–Dec 2025, not mis-labelled Jan/Mar 2025.
5. If sold months are still wrong (Jan/Mar on screen for Oct–Dec sales): payout CSV repair — see [INVOICE_AND_SOLD_DATES.md](INVOICE_AND_SOLD_DATES.md). **Render Shell** (this service uses **Root Directory = `src`**, so there is no `package.json` in `~/project` — use `node`, not `npm run`):
   ```bash
   cd ~/project/src
   export DB_PATH=/var/lib/returnpal/data/returnpal.db
   ls -la /var/lib/returnpal/data/Previous-Year-Payout.csv   # must exist on the disk (upload if missing)
   node audit-sold-dates-by-client.js --csv "/var/lib/returnpal/data/Previous-Year-Payout.csv"
   node repair-sold-dates-from-payout-csv.js --csv "/var/lib/returnpal/data/Previous-Year-Payout.csv"
   # after backup + stop app, then:
   node repair-sold-dates-from-payout-csv.js --csv "/var/lib/returnpal/data/Previous-Year-Payout.csv" --apply
   ```
   If `~/project/src` is missing, try `node src/scripts/audit-sold-dates-by-client.js` from `~/project` after the latest deploy.

   Optional long-term: set **Root Directory** to empty (repo root) so `npm run` works; redeploy.
6. Only for **unmigrated** legacy storage: `npm run migrate-sold-dates` (dry run first). Do **not** use migration to fix Job #38 wire-as-calendar rows.

## 3. Environment variables (Production)

Dashboard → **Environment**.

**Important:** Render allows **one row per key**. If you already have `NODE_ENV` or `FRONTEND_URL`, click the existing row to **edit** the value — do not use **Add Environment Variable** again for the same name. Pasting all of `production.env.example` at once will show *Duplicate key … is not allowed* for any key that already exists.

### Required

| Key | Value | If it already exists |
|-----|--------|----------------------|
| `NODE_ENV` | `production` | Edit existing row |
| `JWT_SECRET` | long random string | Edit or add if missing |
| `FRONTEND_URL` | `https://www.returnpal.co.uk` | Edit existing row |
| `DB_PATH` | `/var/lib/returnpal/data/returnpal.db` | Edit or add *(must match disk mount)* |
| `RETURNPAL_SOLD_DATES_LEGACY` | *(omit on production)* | Only `1` for unmigrated local DB |

### Signup protection (recommended)

| Key | Value |
|-----|--------|
| **`SIGNUP_REQUIRE_ADMIN_APPROVAL`** | **`1`** |
| `REGISTER_RATE_LIMIT_ENABLED` | `1` |
| `REGISTER_RATE_LIMIT_MAX` | `1` |
| `REGISTER_RATE_LIMIT_WINDOW_MS` | `86400000` |
| `SIGNUP_MIN_FORM_SECONDS` | `3` |
| `LOGIN_RATE_LIMIT_ENABLED` | `1` |
| `LOGIN_RATE_LIMIT_MAX` | `20` |

### Turnstile (recommended)

Create keys at [Cloudflare Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile). Add hostname `returnpal.co.uk` (and `localhost` for testing).

| Key | Value |
|-----|--------|
| `TURNSTILE_SITE_KEY` | your site key |
| `TURNSTILE_SECRET_KEY` | your secret key |
| `SIGNUP_TURNSTILE_REQUIRED` | `1` |

### Outbound email (SMTP)

See [`EMAIL.md`](EMAIL.md) for full setup. Minimum for digests + transactional mail:

| Key | Value |
|-----|--------|
| `EMAIL_ENABLED` | `1` |
| `SMTP_HOST` | e.g. `smtp.sendgrid.net` |
| `SMTP_PORT` | `587` |
| `SMTP_SECURE` | `0` |
| `SMTP_USER` | provider user (SendGrid: `apikey`) |
| `SMTP_PASS` | provider secret |
| `SMTP_FROM` | verified from address |
| `PUBLIC_APP_URL` | `https://www.returnpal.co.uk` |
| `WEEKLY_DIGEST_EMAIL_ENABLED` | `1` |
| `MONTHLY_INVOICE_EMAIL_ENABLED` | `1` |
| `TRANSACTIONAL_EMAIL_ENABLED` | `1` |

After deploy, logs should show `[weekly-digest] scheduler started` (and monthly schedulers if enabled). Test with `npm run email:test-weekly -- USER_ID` from Shell.

### Payout bank details (Jotform)

Clients see a private verification code on **Settings** and **Payouts & Invoices**. The “Open secure bank details form” button only appears when the server reads this env var at **startup** (saving it in the dashboard triggers a redeploy).

| Key | Value |
|-----|--------|
| **`PAYOUT_BANK_DETAILS_FORM_URL`** | Full Jotform URL, e.g. `https://form.jotform.com/123456789012345` |
| **`PAYOUT_JOTFORM_WEBHOOK_SECRET`** | Long random string — append to Jotform webhook URL as `?secret=…` |
| `PAYOUT_JOTFORM_CODE_FIELD` | Optional — prefill + webhook field name (default `payout_verification_code`) |
| `PAYOUT_JOTFORM_EMAIL_FIELD` | Optional — prefill field name (default `email`) |

**Jotform webhook** (sets “bank details on file” on the client dashboard — no account numbers stored on ReturnPal):

1. Jotform → your bank details form → **Settings → Integrations → Webhooks**
2. URL: `https://www.returnpal.co.uk/api/webhooks/jotform-payout-bank?secret=YOUR_PAYOUT_JOTFORM_WEBHOOK_SECRET`
3. Ensure the form includes a field for the client’s verification code (prefill name `payout_verification_code`, or match `PAYOUT_JOTFORM_CODE_FIELD`). Jotform sends webhooks as **multipart/form-data** with a `rawRequest` JSON field — ReturnPal parses this automatically.

Verify after redeploy:

1. `GET https://www.returnpal.co.uk/api/health` → `"payout_bank_form":{"configured":true}`
2. Render **Logs** on boot → `Payout bank details form URL is configured`
3. Hard-refresh dashboard (`Ctrl+F5`) on Settings or Invoices

If `configured` is still `false`, the key name must match exactly (`PAYOUT_BANK_DETAILS_FORM_URL`) on the **Web Service** that serves `www.returnpal.co.uk`, with no surrounding quotes in the value.

### Optional

| Key | Value |
|-----|--------|
| `JWT_EXPIRES_IN` | `7d` |
| `RETURNPAL_GIT_COMMIT` | auto if you use Render’s `RENDER_GIT_COMMIT` — or leave unset |

After saving env vars, click **Manual Deploy → Deploy latest commit** (or wait for auto-deploy).

## 4. What `SIGNUP_REQUIRE_ADMIN_APPROVAL=1` does

- Public register → account **pending**, no login token
- **Admin** → [your Render URL]/admin/index.html → **Pending registrations** → **Approve**
- **Create client account** (admin form) → unlimited, approved immediately, no IP limit

## 5. Verify after deploy

Open in browser:

```text
https://YOUR-SERVICE.onrender.com/api/auth/register-config
```

Expect JSON including:

```json
"require_admin_approval": true
```

Custom domain (e.g. `www.returnpal.co.uk`) should point at the same service; use that URL in `FRONTEND_URL`.

## 6. Create / fix admin user (Render Shell)

Dashboard → service → **Shell** (repo root, where `package.json` is):

```bash
npm run create-admin
```

Save the printed email and password. Log in at `/admin/login.html`.

Promote an existing user:

```bash
npm run set-admin -- your@email.com
```

**Do not** run `node src/create-admin-user.js` from the wrong directory — use `npm run create-admin` from project root.

## 7. Custom domain

1. **Settings** → **Custom Domains** → add `www.returnpal.co.uk`
2. Update DNS per Render’s instructions
3. Set `FRONTEND_URL=https://www.returnpal.co.uk`
4. Redeploy

## 8. Troubleshooting

| Issue | Fix |
|-------|-----|
| Signups still auto-login | Confirm `SIGNUP_REQUIRE_ADMIN_APPROVAL=1` in Render env and redeploy |
| Data lost after deploy | Add persistent disk + `DB_PATH` on mount path |
| CORS errors | `FRONTEND_URL` must match the site origin (with `https://`) |
| Turnstile fails | Hostname must include your live domain in Cloudflare widget settings |
| 429 on register | Expected — 1 registration per IP per 24h |

See also [`PRODUCTION_ENV.md`](PRODUCTION_ENV.md).
