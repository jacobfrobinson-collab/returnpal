# ReturnPal Backend + Frontend

Full-stack Amazon Returns Processing platform. Node.js/Express backend with SQLite database serving your existing frontend.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Seed the database with demo data
npm run seed

# 3. Start the server
npm start
```

Open **http://localhost:3000** in your browser.

**Demo login:** `david@returnpal.com` / `demo123`

---

## What's Included

### Backend (`src/`)
- **server.js** — Express entry point, serves API + static frontend
- **database.js** — SQLite schema (7 tables), auto-creates `data/` directory
- **seed.js** — Populates demo user, packages, received/sold/pending items, invoices
- **middleware/auth.js** — JWT authentication middleware

### API Routes (`src/routes/`)
| Route File | Endpoints | Auth Required |
|------------|-----------|--------------|
| `auth.js` | `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`, `PUT /api/auth/profile`, `PUT /api/auth/password` | Login/Register: No, Others: Yes |
| `packages.js` | `GET/POST /api/packages`, `GET/PUT/DELETE /api/packages/:id` | Yes |
| `received.js` | `GET /api/received`, `POST /api/received`, `PUT /api/received/:id/status` | Yes |
| `sold.js` | `GET /api/sold` (with stats), `POST /api/sold` | Yes |
| `pending.js` | `GET /api/pending` (with stats), `POST /api/pending`, `PUT /api/pending/:id/stage`, `DELETE /api/pending/:id` | Yes |
| `invoices.js` | `GET /api/invoices`, `GET /api/invoices/:id`, `POST /api/invoices`, `PUT /api/invoices/:id/status` | Yes |
| `settings.js` | `GET /api/settings`, `PUT /api/settings/vat`, `PUT /api/settings/webhook` | Yes |
| `contact.js` | `POST /api/contact` | No |
| `upload.js` | `POST /api/upload/packages` (Excel/CSV), `GET /api/upload/template` | Yes |
| `dashboard.js` | `GET /api/dashboard/stats` | Yes |

### Frontend Wiring (`public/`)
- **assets/js/api.js** — API client with token management, used by all pages
- **dashboard/assets/js/dashboard.js** — Loads live data into all dashboard tables/cards
- **login.html** — Wired to `/api/auth/login` and `/api/auth/register` with form toggle
- **index.html** — Contact form wired to `/api/contact`
- All dashboard pages load data from the API on page load

### Database Tables
`users`, `packages`, `package_products`, `received_items`, `sold_items`, `pending_items`, `invoices`, `contact_messages`

---

## Environment Variables (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `JWT_SECRET` | (set in .env) | JWT signing secret — **change in production** |
| `JWT_EXPIRES_IN` | `7d` | Token expiry duration |
| `DB_PATH` | `./data/returnpal.db` | SQLite database file path |
| `FRONTEND_URL` | `*` | CORS allowed origin |

## Scripts

```bash
npm start        # Start production server
npm run dev      # Start with --watch (auto-restart on changes)
npm run seed     # Seed/reset demo data
```

## Tech Stack
- **Runtime:** Node.js
- **Framework:** Express 5
- **Database:** SQLite (via sql.js — pure JS, no native dependencies)
- **Auth:** JWT (jsonwebtoken) + bcryptjs
- **File Upload:** multer + xlsx (for bulk Excel/CSV import)
