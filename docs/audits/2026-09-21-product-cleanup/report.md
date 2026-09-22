# EdgeHQ product cleanup audit

## Scope

Combined UX and accessibility review of the live owner dashboard, priority inbox,
messages, schedule, customers, quotes, invoices, payments, and settings. The goal
was to reduce missed follow-ups, accidental record changes, and visual noise while
preserving message-channel truth, no-GST behavior, and historical records.

## Flow health

1. **Dashboard — generally healthy.** Strong priority summary and next-work-day
   preview. Date labels need deployment verification because the live header and
   the visible “Today” schedule did not agree during the audit.
2. **Priority inbox — healthy with a grouping risk.** Urgent work is ranked well,
   but grouped `+N more` items hide how many distinct customers are waiting.
3. **Messages — needs a channel-truth decision.** Unread and needs-reply filters are
   useful. Internal audit notes visually compete with actual customer messages, and
   the generic “New message” action does not explain whether it uses paid CRM SMS,
   email, or the owner's preferred external channel.
4. **Schedule — powerful but dense.** Conflict health, weather, capacity, route,
   crew, customer messaging, and job controls all appear at once. Primary field
   actions are hard to distinguish from planning and repair tools on a phone.
5. **Customers — usable, slow to scan.** Search and consent filters are clear, but
   rendering the first 100 records creates a long mobile page and repeats the same
   row actions.
6. **Quotes — improved in this branch.** The live summary counted follow-ups that
   could not actually be sent, while each table row exposed a lifecycle-changing
   dropdown. The branch separates actionable follow-ups from blocked records and
   keeps list status read-only.
7. **Invoices — accurate but long.** Balance wording is good. Rendering the full
   invoice history without paging or progressive loading makes recent collection
   work harder to scan on mobile.
8. **Payments — improved in this branch.** The ledger is trustworthy and searchable,
   but long verification notes overwhelmed each row. Notes are now behind an
   accessible native disclosure while remaining searchable.
9. **Settings — generally healthy.** Sections and explanatory copy are clear. A
   future payment-tips setting cannot be a UI-only toggle because the current ledger
   would treat the full checkout total as invoice revenue.

## Changes implemented

- Quote summary now reports **follow-ups ready** separately from follow-ups blocked
  by missing contact permission/details. The tile opens the exact follow-up queue or
  data-quality screen as appropriate.
- Quote list rows now show a read-only status badge. Deliberate, confirmation-gated
  status repair remains on the quote detail page.
- Payment verification notes now use an accessible `details/summary` disclosure;
  customer, invoice, method, receipt, and amount remain visible at a glance.
- Added a focused product-simplification verification script and strengthened the
  quote-status contract.

## Ranked remaining opportunities

1. **Channel truth in Messages:** introduce an owner-configurable outbound mode and
   label every composer with its actual channel and cost before enabling Send.
2. **Tip support:** add a separate `tip` ledger kind, server-validated hosted-checkout
   selector, split webhook writes, distinct receipts/refunds/reporting, and never add
   tips to AutoPay or off-session charges. Stripe Terminal is a separate project.
3. **Progressive lists:** paginate or virtualize Customers and Invoices while keeping
   search over the complete dataset.
4. **Schedule hierarchy:** keep On my way, Start, Complete, Photos, and Route visible;
   move planning, crew, change-order, and repair controls into contextual menus.
5. **Inbox expansion:** show the first few hidden customer names before the owner opens
   a grouped `+N more` queue.

## Evidence limits

The live authenticated flows were visually captured and inspected in the browser
during this run. Browser automation could not persist those authenticated captures
as workspace files, so this report records the reviewed steps and current DOM state.
Keyboard order, screen-reader output, reduced-motion behavior, and zoom reflow still
need dedicated testing; this audit does not claim full WCAG compliance.
