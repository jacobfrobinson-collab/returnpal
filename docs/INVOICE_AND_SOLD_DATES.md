# Invoice periods and sold dates

## Rules

- **Statement period** = calendar month of the **sale** (`sold_items.sold_date`), not the upload month.
- **Returns** on a statement use **`refund_date`** (or `created_at` when unlinked), not the linked sale’s sold month.
- **Schedule:** April sales → statement issued 1 May → payout due end of May. May sales → issued 1 June → due end of June.
- Months with **no sales and no applied returns** in that calendar month do not appear as payout rows.
- A month with **only returns** (no sales) can appear as `refund_only_period`.

## Storage (production)

`sold_items.sold_date` is **calendar `YYYY-MM-DD`**. The app reads calendar dates by default (`soldDateStorageMode.js`).

Only set `RETURNPAL_SOLD_DATES_LEGACY=1` on a machine that still has the **unmigrated** old database (local dev). Do **not** set this on Render after migration.

The sold dashboard shows **`sold_date_label` from the API** — the browser must not re-parse dates client-side.

## Operator runbook

1. **Back up** the database (`DB_PATH`).
2. **Stop** the Node app on production.
3. Dry-run migration:
   ```bash
   npm run migrate-sold-dates
   # or: node scripts/migrate-sold-dates-to-calendar.js --user-id <id>
   ```
4. Review `data/sold-date-migration-ambiguous.csv` if printed; resolve edge cases manually if needed.
5. Apply:
   ```bash
   npm run migrate-sold-dates:apply
   ```
6. Restart the app; clients should hard-refresh the sold items page.
7. Reconcile a client:
   ```bash
   npm run reconcile-invoice-months -- --user-id <id>
   ```
8. In admin **Client → Invoice month sources**, compare `2026-04` / `2026-05` counts to the sold dashboard.
9. Regenerate or re-download statements where historical PDFs were wrong.

## Fail-safes in code

| Check | Where |
|-------|--------|
| Import preview **Invoice month** | Admin bulk import sold preview |
| Period consistency before statement payload | `buildInvoicePeriodPayload` |
| Reconcile script | `npm run reconcile-invoice-months` |
| Admin debug JSON | `GET /api/admin/users/:id/invoice-month-sources` |

## Tests

```bash
npm run test:unit
```

Includes `test/sold-date-calendar.test.js`, `test/invoice-month-consistency.test.js`, and `test/computed-monthly-statements.test.js`.
