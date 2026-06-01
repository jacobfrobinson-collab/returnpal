# Agent / contributor notes

## Git and GitHub

After completing a substantive change set (features, fixes, tests), **commit and push** to `origin` on the current branch with a clear message. Do not leave completed work only on a local machine unless the task explicitly says not to publish yet.

- Prefer `git add -u` plus explicit `git add` for new files you added.
- Do not commit secrets, real `.env` files, or large private dumps.
- Untracked one-off scripts under `scripts/` should only be added if they are meant to be shared; otherwise leave them untracked and mention them in the PR or summary.

## Tests

Run `npm run test:unit` before pushing when you touch date, invoice, or sold-date logic. Use `npm test` when the API server is running for integration checks.

## Sold dates (do not break on deploy)

Production `sold_items.sold_date` is **calendar `YYYY-MM-DD`** (migrated 2026-06). Rules:

- **Server** formats labels via `mapSoldItemDatesForApi` in `soldDateDisplayRepair.js` (canonical by default in `soldDateStorageMode.js`).
- **Client sold list** must show `sold_date_label` from the API only — **no** `relabelSoldItemsForDisplay`, **no** legacy YYYY-DD-MM parse in the browser on `sold_date` strings.
- Legacy read exists only for `RETURNPAL_SOLD_DATES_LEGACY=1` (unmigrated local DB) and `scripts/migrate-sold-dates-to-calendar.js`.
- Before changing sold-date display, run `node test/sold-display-invariant.test.js`.

## Inventory hub metrics

The client [inventory.html](public/dashboard/inventory.html) must render **only** from `GET /api/inventory/summary` (`buildInventorySummaryPayload`):

- Pipeline counts, profit recovered, sell-through, estimates, and attention lists come from the API — **do not** recompute financial fields (e.g. `estimated - recovered`) in `loadInventory` or similar.
- Use `sold_date_label` on `recent_sold` rows; do not re-parse sold dates in the browser.
- Per-user return categories use `user_return_categories` on the summary — not the global `refund-insights` cache.
- Run `node test/inventory-summary.test.js` when changing inventory summary logic.

## Production environment

Document signup and secrets in repo templates only — never commit real `.env` files:

- [`production.env.example`](production.env.example) — includes `SIGNUP_REQUIRE_ADMIN_APPROVAL=1`
- [`docs/PRODUCTION_ENV.md`](docs/PRODUCTION_ENV.md) — operator guide
- [`docs/RENDER.md`](docs/RENDER.md) — Render.com dashboard steps

Set live values on the hosting provider, then restart the Node process.
