# ReturnPal – Backend & API

This document outlines what to add when you connect a real backend so the dashboard and main site work with live data.

## Auth

- **POST /api/auth/login** – `{ email, password }` → `{ token, user }`
- **POST /api/auth/register** – `{ email, password, full_name, company_name }` → `{ token, user }`
- **POST /api/auth/forgot-password** – `{ email }` → send reset email (e.g. link or code)
- **GET /api/auth/me** – (Bearer token) → current user profile
- **PUT /api/auth/profile** – update profile
- **PUT /api/auth/password** – `{ current_password, new_password }`

## Dashboard data

- **GET /api/packages** – list packages → `{ packages: [{ id, reference, products[], total_qty, status, date_added, notes }] }`
- **GET /api/packages/:id** – single package
- **POST /api/packages** – create package
- **PUT /api/packages/:id** – update package
- **DELETE /api/packages/:id**
- **GET /api/received** – `{ total, items: [{ reference, items_description, quantity, status, date_received, notes }] }`
- **GET /api/sold** – `{ total, stats: { total_earnings, items_sold, avg_earnings, avg_margin }, items: [{ reference, product, quantity, unit_price, total_revenue, profit, margin, sold_date, status }] }`
- **GET /api/pending** – `{ total, stats: { pending_count, total_quantity, oldest_date }, items: [{ reference, product, quantity, received_date, current_stage, est_completion, notes }] }`
- **GET /api/invoices** – `{ invoices: [{ date_issued, amount, items_count, status }] }`
- **GET /api/dashboard/summary** – overview: `{ total_recovered, items_processing, items_sold, packages_sent, recent_activity[], top_items[], latest_payout }`
- **GET /api/activity** – activity feed
- **GET /api/inventory/summary** – `{ items_received, items_processing, items_sold, awaiting_inspection, awaiting_listing, estimated_resale_value, recovered_so_far, potential_remaining_value, stage_breakdown }`
- **GET /api/analytics** – `{ recoveryRate, avgRecoveryPerItem, recoveredOverTime: [{ month, value }] }`
- **GET /api/referrals** – `{ referral_code, referral_link, referrals[], total_earned, tiers, current_tier, next_tier }`
- **GET /api/reports/roi?from=&to=** – ROI report for date range
- **GET /api/invoices/period/:period** – invoice line items for month (e.g. `2026-02`) for download

## Admin (master dashboard)

- **GET /api/admin/users** – (Bearer token, admin only) list all clients → `{ users: [{ id, email, full_name, company_name, created_at }] }`
- **POST /api/admin/impersonate/:id** – (Bearer token, admin only) get a short-lived token to view the dashboard as that client → `{ token, user }` (token expires in 1 hour)

**Creating an admin user:** set `is_admin = 1` for a user in the database, e.g. `UPDATE users SET is_admin = 1 WHERE email = 'your@email.com';` or run the seed script (which makes the demo user `david@returnpal.com` an admin).

**Admin UI:** `/admin/login.html` (admin login), `/admin/index.html` (list clients, “View dashboard” opens the client dashboard in a new tab with impersonation).

## Other

- **POST /api/contact** – contact form
- **POST /api/upload/packages** – file upload for bulk packages
- **GET /api/settings**, **PUT /api/settings/vat**, **PUT /api/settings/webhook**

## Frontend config

- Set `window.RETURNPAL_CONFIG = { useMock: false }` when the API is live (or remove the mock default in `dashboard/assets/js/custom.js`).
- Ensure CORS allows your frontend origin and credentials if using cookies.

## Security

- Use HTTPS in production.
- Store JWTs securely; consider short-lived access + refresh tokens.
- Validate and sanitise all inputs; use parameterised queries for the database.
