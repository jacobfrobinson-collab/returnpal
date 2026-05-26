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
2. **Mount path:** `/opt/render/project/src/data`
3. **Size:** 1 GB (or more)
4. Save — Render will redeploy

Set env:

```env
DB_PATH=/opt/render/project/src/data/returnpal.db
```

## 3. Environment variables (Production)

Dashboard → **Environment** → add each variable (or paste from [`production.env.example`](../production.env.example)).

### Required

| Key | Value |
|-----|--------|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | *(long random string — use Generate or your own)* |
| `FRONTEND_URL` | `https://www.returnpal.co.uk` |
| `DB_PATH` | `/opt/render/project/src/data/returnpal.db` *(with disk mounted)* |

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
