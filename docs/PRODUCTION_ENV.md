# Production environment variables

Use this when deploying ReturnPal (VPS, Railway, Render, Fly.io, etc.). **Never commit a real `.env` file** to GitHub — only set secrets on your host.

Copy from [`production.env.example`](../production.env.example) in the repo root.

## Required

| Variable | Example | Notes |
|----------|---------|--------|
| `JWT_SECRET` | long random string | Required; rotate if leaked |
| `NODE_ENV` | `production` | Optional; enables startup warnings |
| `FRONTEND_URL` | `https://www.returnpal.co.uk` | CORS origin for your site |
| `DB_PATH` | `./data/returnpal.db` | Persist this path on your server |

## Signup protection (recommended)

| Variable | Production value | Effect |
|----------|------------------|--------|
| `SIGNUP_REQUIRE_ADMIN_APPROVAL` | **`1`** | Public signups stay **pending** until you approve in Admin |
| `REGISTER_RATE_LIMIT_MAX` | `1` | Max **1 self-service registration per IP per day** |
| `REGISTER_RATE_LIMIT_WINDOW_MS` | `86400000` | 24 hours (milliseconds) |
| `SIGNUP_MIN_FORM_SECONDS` | `3` | Blocks instant bot form posts |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | from Cloudflare | CAPTCHA on register form |
| `SIGNUP_TURNSTILE_REQUIRED` | `1` | Enforce Turnstile when keys are set |

### With `SIGNUP_REQUIRE_ADMIN_APPROVAL=1`

1. User registers on `/login.html` → message: waiting for approval (no dashboard access).
2. You open **Admin → Clients** → **Pending registrations** → **Approve**.
3. User receives an activity notification and can log in.
4. **Reject & delete** removes the account entirely.

### With `SIGNUP_REQUIRE_ADMIN_APPROVAL=0` (local dev default)

Signups are **approved immediately**, still limited to 1/day/IP.

## Admin-created accounts (no limits)

Admins create clients from **Admin → Create client account** (`POST /api/admin/users`). Those accounts:

- Are **approved** immediately
- Do **not** count against the public IP rate limit
- Are not blocked by Turnstile on the public form

## After changing env

1. Save variables on your host.
2. **Restart** the Node process (`npm start` / platform redeploy).
3. Hard-refresh the site (`Ctrl+F5`) so updated JS loads.

## Verify

- `GET /api/health` — should return `ok`
- `GET /api/auth/register-config` — should show `"require_admin_approval": true` when approval is on
- Try a test registration — should not receive a token until approved
