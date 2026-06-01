# Bulk import: returns / refunds

## Matching sales (payout safety)

Return and refund rows **must match an existing sale** on the same client’s dashboard before they are imported:

- Same **order_number** and **product** title (fuzzy match), or
- **reference** on the sale row, or
- Explicit **`linked_sold_item_id`** in the spreadsheet.

Rows with **no matching sale** are **skipped** (not imported). This avoids deducting payout for cancelled eBay orders that were never imported as sales.

Preview shows **Matched sale** (`#123` or `—`) and **OK = No** when there is no match.

## Environment override

Set on the server only if you intentionally need legacy behaviour (orphan refunds allowed):

```bash
RETURNPAL_ALLOW_ORPHAN_REFUND_IMPORT=1
```

## Cleaning up bad imports already in the database

1. **Undo** — Admin → Recent spreadsheet imports → Undo on the refund import job.

2. **List orphans** — From the repo root:

```bash
node scripts/list-orphan-refunds.js
node scripts/list-orphan-refunds.js --user-id 14
```

3. **Delete orphans** (writes `data/returnpal.db` directly; stop the app first on production):

```bash
node scripts/list-orphan-refunds.js --delete
```

After cleanup, client payout/balance figures recalculate on the next dashboard load.
