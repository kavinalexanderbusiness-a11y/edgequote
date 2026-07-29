# Reporting backlog — what's left, and why it isn't presentation

Financial reporting had a run of **presentation-only** consistency fixes (2026-07):
the emailed report and the P&L page / CSV export now use one vocabulary and one set
of explanations —

- empty-books warning (report ⇐ page)
- cost basis note: gross vs net of reclaimable tax (rule 1)
- capital purchases + owner draws surfaced as "money out that isn't a cost" (rule 4)
- "GST collected" (was "Sales tax") · "Net movement" (was "Bank movement")
- the cash-flow month bars gained a Cash-in/Cash-out legend
- the emailed report now declares its **cash basis**, like the page and CSV

**That well is now dry.** A sweep of every owner-facing money surface (P&L page,
cash-flow page, GST page, job-costing page, the reports/exports page, the scheduled
report's email + HTML + PDF + CSV, and the payments reconciler) found no remaining
figure that is shown without a label, named differently across surfaces, or
explained on one surface but not another. `verify:reports` pins the report against
the engine field-by-field, and `verify:accounting` owns the maths.

Everything below WOULD improve reporting, and none of it is presentation — each
needs a **business-logic change, a data source that doesn't exist yet, or an owner
decision.** Do not implement these as cosmetic edits. Ranked by owner value against
how much it's blocked.

---

## P1 · True job profit (labour + real cost components)
**What:** job costing shows receipts-only cost and the P&L shows only logged
expenses. Neither includes labour, and materials/fuel/equipment/overhead are absent.
**Why blocked — data + one owner decision, not code.** As of the 2026-07 money
audits every cost source was empty (expenses tagged to jobs, `job_line_items` costs,
`wage_history`, `time_entries`, `equipment` — all 0 rows); re-check before acting.
`jobCosting.ts` deliberately omits labour because
`crew_cost_per_hour` is a single loaded scalar (wage + overhead); adding receipted
fuel on top of it double-counts. The prerequisite is the **same decision Pricing V2
Phase 1 turns on** — split `crew_cost_per_hour` into wage-only vs overhead
(answered by the owner: $25 is a wage → cost = components). Until that lands and
owners actually log costs, the honest report is the empty-books one that already
ships. See the Pricing V2 roadmap + `jobCosting.ts`'s own "WHY THIS DOES NOT ADD
LABOUR" note.

## P2 · Accrual view / the GST FILING figure in the report
**What:** the P&L and the scheduled report are **cash basis** (now labelled as such).
The number an owner actually files — GST owed on an **accrual** basis — lives only on
the GST page (`gstReturn`, "this one is accrual, not cash"). A report a bookkeeper
files from should be able to show it.
**Why blocked — business logic + period alignment.** `composeReport` reads the
cash-basis engines (`profitAndLoss`/`cashFlow`); wiring the accrual `gstReturn` into
it is a new engine path, not a label. And filing periods are quarterly/annual while
report cadences are daily/weekly/monthly/yearly — the two don't line up, so this
needs a period-mapping decision, not a passthrough. `gst.ts` already states the
accrual figure is the one to file; the work is surfacing it without implying the
cash estimate is filable.

## P3 · Real bank reconciliation
**What:** "Net movement" reconciles the ledger to a **computed** total (sum of cash
rows), and the cash-flow page's "why bank ≠ profit" bridge is excellent — but nothing
reconciles against an **actual bank statement**.
**Why blocked — a data source that doesn't exist.** There is no bank feed or
statement import; the app only knows the payments it recorded. True reconciliation
(did the bank receive what we think it did?) needs that external source. The Stripe
reconciler (`reconcile.ts`) is the nearest thing and only covers Stripe. This is the
biggest data lift here and likely a post-1.0 integration.

## P4 · Ghost / expired quotes in conversion reporting
**What:** any report of quote acceptance / conversion is biased upward, because a
`sent` quote never transitions to lost or expired — there is no status writer for
expiry, so ghosts sit in `sent` forever.
**Why blocked — an owner decision, then logic.** "When is a quote dead?" is a
product call (Pricing V2 Phase 0 recorded the owner's stance: ghosts are NOT losses).
Until a dead-quote rule exists, a conversion report would state a number the app
can't stand behind. This is logic downstream of that decision, not presentation.

## P5 · Per-owner timezone for report periods
**What:** scheduled reports derive their period from the **server** date
(`localTodayISO`, cron ~06:00 America/Edmonton). An owner in another timezone gets
period boundaries — and therefore which day's money lands in which report — off by
hours.
**Why blocked — wiring, not data.** The column now exists:
`business_settings.timezone` (NOT NULL, default `America/Edmonton`; added by
`supabase/RUN-2026-07-18-comms-governor-timezone.sql`, applied to prod). The comms
governor reads it; the period engine does not yet. Remaining work is the roughly
one-line change in the period engine (the code already notes "One line to change
when a per-owner tz lands") plus verifying every report entry point passes it.

## P6 · Quote engagement in reporting (viewed_at)
**What:** reporting on whether quotes were opened/viewed.
**Why blocked — data + a frozen spec.** Quotes carry no `viewed_at` (invoices do).
This belongs to the accepted Quote Presentation V2 spec (Phase 6), which is design-
approved but not built and gated behind Pricing V2. Do not add ad-hoc view tracking;
it has a home.

---

## The rule for the next session
If asked to "improve reporting," the presentation-consistency work is **done** —
resist inventing a seventh cosmetic tweak. The value now is in P1–P6, and every one
of them is blocked on a **decision, a data source, or a schema change** that is the
owner's to make, not a wording choice. Surface the blocker; don't paper over it with
a label.
