# Dashboard: ideas for a more professional, interactive experience

Suggestions you can add over time, in rough priority order.

---

## Already implemented (this round)

- **Clickable KPI cards** (Overview) – Total Recovered → Analytics, Items Processing → Items Pending, Items Sold → Sold Items, Packages Sent → Packages. Hover/focus styling in `dashboard-tokens.css`.
- **Sortable Packages table** – Reference, Total Qty, Status, Date Added. Click header to sort; active column shows arrow. State kept in memory so toggling is instant.
- **URL search on Packages** – `packages.html?search=REF` filters rows by reference and notes; subtitle shows “X packages matching search”.

---

## High impact, relatively quick

1. **Table search/filter on list pages**  
   Add a small “Filter” or “Search in this table” input on Received, Sold Items, and Items Pending (in addition to existing recovery-route dropdown). Filter rows in the client by reference, product name, or status.

2. **“Last updated” + refresh on Overview**  
   Show “Data as of 2 min ago” under KPIs or in the header, with a refresh button that reloads the dashboard summary and updates the timestamp. Gives a sense of live data.

3. **Toast / success feedback**  
   After “Save billing details”, “Save prep centre details”, or “Export report”, show a short toast (e.g. “Saved” or “Report downloaded”) instead of or in addition to the button text change. Keeps the UI consistent and visible.

4. **Notifications from real data**  
   Drive the notification dropdown from the same source as Recent Activity (or a dedicated notifications API). Show unread count and allow “mark as read” so the badge reflects real state.

5. **Breadcrumbs on detail pages**  
   On Package detail and Item detail: “Packages Sent > TRACK-RP001” or “Sold Items > Wireless Earbuds”. Improves orientation and back-navigation.

---

## Medium effort, high polish

6. **Sortable columns on other tables**  
   Reuse the same pattern (sortable headers + in-memory sort) on Received, Sold Items, and Items Pending for columns like Date, Value, Status.

7. **Persist date range**  
   Remember the last chosen date range (Overview, Analytics, Invoices) in `localStorage` and pre-select it on next visit.

8. **Activity feed filters**  
   Filter by type: “Package delivered”, “Item sold”, “Payout sent”. Either dropdown or small chips above the feed.

9. **Packages status filter**  
   On Packages Sent, add a status dropdown (All / In Transit / Delivered / etc.) so the table and “in transit” subtitle reflect the filter.

10. **Empty states**  
    Use one consistent pattern: icon + short message + primary CTA (e.g. “No packages yet” + “Add Package”). Same style on every list page.

---

## Deeper interactivity

11. **Inline row actions**  
    On Received or Pending, add “Mark as…” or “Request reimbursement” so users can act from the table without opening detail (if your backend supports it).

12. **Chart interactivity**  
    In Analytics, allow toggling series on/off in the legend and ensure tooltips show exact values and dates.

13. **Keyboard shortcuts**  
    Extend the command palette: e.g. “G then P” for Packages, “G then I” for Invoices. Document in the palette or in a “?” help modal.

14. **Invoice quick view**  
    Before “Download PDF”, open a small modal with invoice summary (period, amount, item count). Then “Download” from the modal.

15. **Global search with live results**  
    As the user types in the top bar, show a dropdown of matching packages and items (and maybe recent activity) with links, instead of only navigating on Enter.

---

## Accessibility and performance

- Ensure focus is trapped in modals and restored when closed.
- Add `aria-sort` on sortable column headers when you have an active sort.
- Consider virtualisation or pagination (“Load more” or “Show 20/50/100”) on very long tables so the DOM stays light.

Use this as a backlog: pick the items that best match your roadmap and backend capabilities.
