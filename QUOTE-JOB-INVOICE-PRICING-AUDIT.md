# Audit — Quote ↔ Scheduled Job ↔ Invoice pricing

**Date:** 2026-07-26 · **Scope:** how a price flows between the accepted quote, a
scheduled job, and its invoice — specifically, *what editing a scheduled job's price
does.* **Outcome: no code change. The behavior is correct by design; this document
records the intended design and the one nuance that is redesign input for the frozen
pricing lane, not a bug.**

This audit touches three frozen lanes at once — Pricing (frozen outside the Pricing
V2 roadmap), Quotes/Invoices/Payments (`66de14f`), and Scheduling (`1d4ef66`). The
pricing freeze's standing rule governs the conclusion: *a proven defect is redesign
input, not a licence to patch.* The audit found no defect.

---

## TL;DR

Editing a scheduled job's price is **not** a single behavior — it is three, and each
is intentional:

| You edit… | `jobs.price` | `quotes.*_price` | Draft invoice | Sent/paid invoice |
|---|---|---|---|---|
| **One-time job** | set on the job | untouched | re-priced to match | never touched |
| **Recurring · "This visit only"** | set on that visit | untouched | re-priced to match | never touched |
| **Recurring · "This & future" / "All"** | cleared → *derives* the quote | **the cadence price is updated (it is the source of truth)** | future visits re-priced | past/billed frozen |

So the answer to "does editing a job's price update the accepted quote, stay
job-only, or flow only to the invoice?" is: **all three, by scope** — and in every
case the invoice reflects the job that produced it, future recurring visits reflect
the one quote cadence price, and already-billed history is frozen.

---

## The three records and who owns what

**Quote — the accepted agreement.**
- On acceptance, `portal_accept_quote` snapshots `accepted_price = coalesce(accepted_price, total)` — the quote's own `total` at the moment of yes, written idempotently so a double-click cannot rewrite it (`supabase/RUN-2026-07-16d-portal-accept-snapshot.sql`). `selected_cadence` is deliberately left NULL: the portal button means "yes to this quote," not "yes to weekly," and inventing a cadence would teach the pricing learner a fact the customer never stated.
- The cadence columns — `weekly_price` / `biweekly_price` / `monthly_price` — are the **live recurring rate** and the **single source of truth** for every future recurring visit. Future visits carry `jobs.price = null` and *derive* their amount from the quote's cadence price (`jobVisitValue` / `quoteVisitAmount` in `src/lib/visitValue.ts`). There is never a divergent `jobs.price` shadowing the quote for a future visit.

**Scheduled Job — the operational visit.**
- `jobs.price` is a per-visit **override**. `null` means "derive from the quote" (recurring) or "unpriced." A number means "this visit costs this, regardless."
- Two edit entry points, both in `src/app/dashboard/schedule/page.tsx`:
  - `setJobPrice` (one-time): writes `jobs.price`, records a price-change audit (`recordPriceChange`), and syncs the draft invoice. Never reads or writes a quote (`setJobPrice`, ~L1507).
  - `applyPriceChange` (recurring, behind the scope dialog — `RecurrenceScope` = `this` / `future` / `all`, ~L1556). `writesQuote = quote_id && cadenceField && newPrice != null && (scope === 'future' || scope === 'all')`.

**Invoice — what is billed.**
- `syncDraftInvoiceAmounts` (`src/lib/invoicing.ts`, ~L71) keeps **draft** invoices matching **the job** (base + add-ons) — *"the JOB is the source of truth."* It filters `.eq('status', 'draft')`; **sent and paid invoices are never re-priced.** Each caller reports the real re-price count and calls out any failure rather than claiming a sync it didn't verify. An unpriced visit drafts nothing (never a $0 invoice).

---

## Why this is consistent, not contradictory

1. **The invoice can never silently diverge from its job.** Any price change —
   one-time, this-visit, or recurring — re-prices the *draft* invoice in the same
   operation, with explicit success/failure reporting. What you'll bill always
   matches the visit you edited.

2. **Future recurring visits can never diverge from the quote.** A "future"/"all"
   change writes the quote's cadence price and *clears* the affected visits'
   overrides so they derive it. There is exactly one number, in one place, for the
   ongoing rate.

3. **History is frozen, everywhere.** Past visits and completed/billed visits keep
   their value (`applyPriceChange` freezes them at their current amount before
   writing the new cadence price); sent/paid invoices are excluded from the sync;
   `accepted_price` is coalesce-guarded. A rate change going forward never rewrites
   what already happened.

4. **The quote is not "just history" — for a recurring plan it is the live rate.**
   This is why a "future/all" change *should* touch the quote: the quote's cadence
   price *is* the ongoing agreement, and updating it is how the change reaches every
   future visit and the customer's plan view coherently. A one-time or "this visit
   only" change *should not* touch the quote, and doesn't — it's a one-off, and the
   agreement is unchanged.

This is the same "one engine / one source of truth" discipline the rest of the
codebase follows, applied to money: the job owns the invoice, the quote owns the
recurring rate, and neither is allowed a second, drifting copy.

---

## The one nuance (redesign input for Pricing V2 — NOT a patch)

For an **accepted recurring** quote, the customer portal renders the quote's **live**
cadence prices (`src/app/portal/[token]/model.ts`, `PortalClient.tsx` — "Weekly plan
(per visit)"). So if the owner later raises the recurring rate with "future"/"all"
scope, the portal's plan line shows the **new** rate, while `accepted_price` (the
acceptance-moment `total`) is preserved separately.

Two readings, and why this is not actionable now:

- **It is arguably correct.** Once accepted, the quote is the living service
  agreement; a rate the owner deliberately changed going forward (an explicit
  scope choice, and one they would communicate) *is* the current plan. The portal
  showing the current rate is showing the truth of the ongoing plan.
- **If it is ever considered a presentation gap** — i.e. the portal should show
  "accepted at $X · current rate $Y" for a plan whose rate moved — that is a Pricing
  V2 / quote-presentation decision (`quote-presentation-v2-spec`, Phase 6), and it
  lands in the **frozen** pricing + portal lanes. Phase 0 already reasoned about the
  snapshot deliberately recording `total` and *not* the cadence ("record truth or
  nothing"); revisiting how the accepted rate is *displayed* belongs to that
  roadmap, opened by the owner — not to a patch here.

No customer-facing figure is *wrong* today: the invoice matches the job, future
visits match the quote, past visits and issued invoices are frozen. The nuance is
about whether to *additionally* surface the original accepted rate alongside a
changed current rate — an enhancement, not a correctness fix.

---

## Verified against (origin/main `67c5897`)

- `src/app/dashboard/schedule/page.tsx` — `setJobPrice` (one-time, ~L1507),
  `applyPriceChange` + `writesQuote` + scope freeze/clear logic (~L1556–L1620),
  `cadenceField` (~L1545).
- `src/lib/invoicing.ts` — `syncDraftInvoiceAmounts` (~L71; draft-only, job-as-truth),
  `createDraftInvoiceForCompletedJob`.
- `src/lib/visitValue.ts` — `jobVisitValue` / `quoteVisitAmount` (a visit derives the
  quote cadence price when `jobs.price` is null).
- `supabase/RUN-2026-07-16d-portal-accept-snapshot.sql` — `accepted_price =
  coalesce(accepted_price, total)`, `selected_cadence` stays NULL.
- `src/app/portal/[token]/model.ts`, `PortalClient.tsx` — portal renders live cadence
  prices.

*Documentation only. No source file changed. The intended behavior is sound; the sole
open question is a display enhancement reserved for the frozen Pricing V2 lane.*
