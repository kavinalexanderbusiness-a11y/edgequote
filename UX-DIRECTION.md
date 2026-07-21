# EdgeQuote — Canonical UX Direction

**Status:** APPROVED (owner, 2026-07-21) as the canonical UX direction for all future UI work.
**Nature:** Design guidance. NOT an implementation licence. No lane is opened by this document.
**Interactive gallery:** `docs/ux-direction/edgequote-next.html` (self-contained, open in any browser).

> This document is the *territory sketch*, not a build order. It sets the direction future
> UI work is measured against. It does not authorize touching any frozen lane, does not
> repeal any phasing, and does not add or modify any engine. When it and a freeze/spec
> disagree, **the freeze/spec wins** and this document is what gets corrected.

---

## The thesis

The next generation of field-service software, for a 1–3 crew owner-operator running the
business from a phone in a truck, is **not more features**. EdgeQuote already has what the
incumbents charge $300/month for: one ledger, one route engine, one capacity engine, an
offline field day, and explainable heuristic intelligence on every surface.

What it lacks is **compression**. A five-agent audit of every shipped surface found the same
shape almost everywhere: the right answer lives one or two screens away from the question.
The direction keeps every engine and collapses that distance.

Six principles, in priority order:

1. **Fewer clicks.** Every number is a tap to the filtered list it names. Every warning
   carries its own fix. Reductions are committed with mechanisms (see the click ledger), not
   asserted.
2. **Mobile first, glove first.** A bottom tab bar ends the hamburger tax. Stage-primary
   actions render as one giant button. 44px targets everywhere a gloved thumb acts — the
   standard the codebase already wrote down (`.tap-target`, pointer-coarse gated), applied
   without exception.
3. **AI that drafts, never decides.** Drafts, explains, ranks, pre-fills. **Never prices,
   never sends, never a second engine.** The heuristic engines stay the deciders.
4. **Hierarchy = the one next action.** Boards open on what to do, not what exists. Vanity
   counts die (`N jobs on the calendar`); stage-value tiles live (`$1,215 awaiting approval →`).
5. **Premium is consistency.** Syne + DM Sans, the ink/green token system, one motion
   vocabulary — already shipped, already good. The redesign *extends* the language; it never
   forks it.
6. **Honest by construction.** Unknown renders `—`, never `0`. Empty books say so. Engine
   provenance rides every price. The product's existing honesty rules become visible design
   features.

---

## Information architecture

Thirty-plus routes collapse into **five task hubs**, with Messages one tap from anywhere via
a phone bottom tab bar: **Today · Schedule · Messages · Customers · More**.

| Hub | Contains | Merges in (same engines, fewer doors) |
|-----|----------|----------------------------------------|
| **Today** | Priorities, day strip + Start, stage-value tiles, Sunday review, durable Setup | `review` gains a home link (nothing links to it today) |
| **Schedule** | Field-day board, calendar, route drawer, rain ops, dispatch map | `routes` → day-ops analysis drawer; `weather` actions → the rain card |
| **Money** | Quotes, Invoices, Payments, Accounting, Reports | — |
| **Customers** | People, Properties, Inbox ⇄ everywhere, Reactivation, door-knock CRM | — |
| **Insights** | "What changed" brief over one workspace | `profitability` + `saturation` merge in; Marketing stays one sealed door |

**Merges follow shared engines, not opinions.** `routes` re-renders Schedule's own
`optimizeRoute`/`computeDayEtas`/`routeStats` with zero actions — a dead end that becomes a
drawer. Follow-ups get **one owner** (Today's ranked queue); the dashboard, Messages and
grow/crm all host the list today, and everywhere but Today should link to it.

The 7-route marketing cluster stays **sealed behind one door** (frozen at `4627924`). The
customer profile goes from 15 stacked cards to four tabs with the timeline first-class.
Properties inverts: a searchable lightweight list, the dossier on the detail page (today the
detail page shows *less* than its own list card).

---

## The click ledger — counted on the shipped code

Auditors walked each flow through the source and counted every discrete action. Each target
names the seam that delivers it; **none adds an engine.**

| Flow | Now | Target | Mechanism |
|------|-----|--------|-----------|
| Reschedule one recurring job | 5 | 2 | Move becomes a visible card action with 3 suggested-date chips from `analyzeSchedule`'s closest-legal-moves; cadence warning merges INTO the scope dialog as one confirm. The scope choice stays — it's load-bearing. (`DayOpsPanel.tsx:925`, `schedule/page.tsx:2190,1792`) |
| Find customer → read history → contextual message | 11 | 6 | Whole row navigates (today only the name links); profile tabs make the timeline 1 tap not 13 cards; composer opens pre-drafted from the visible history instead of empty-on-`custom`. (`CustomerList.tsx:275`, `customers/[id]/page.tsx:683`) |
| Reply to an inbound, verify what the customer sees | 10 | 5 | Reply box focuses on thread-open (drop the ≥1024px autofocus gate); "Open portal preview" reuses `ensurePortalToken`, deleting profile→copy→new-tab→paste→scroll-9-tabs. (`ConversationThread.tsx:150`) |
| Act on a dashboard priority row | 1 + hunt | 1 | Rows carry the deep links that already exist (`?followup=1`, `?status=sent`) and land filtered; build the missed-jobs view Schedule lacks. (`TodaysPriorities.tsx:162`) |
| Navigate anywhere from home on a phone | 2 | 1 | Bottom tab bar; unread badge moves onto the Messages tab. (`Sidebar.tsx:215`) |
| Act on a weather warning | ~4 | 1 | The risk row's button runs `planRainDelay` where the warning renders — the engine already computes the whole move (LawnPro's one-gesture reschedule). |
| Start the first job of the day from home | 3+ | 1 | Stage-primary button (On my way → Start) on Today's day strip, reusing `jobStatus.ts` + the ONE outbox. |
| Fix a bad route day from the analysis view | dead end | 1 | "Fix this day" carries `?date=` into the day board; structurally merge the page into the day-ops drawer. |
| Change a scheduled message's send time | ~6 | 2 | Inline edit on the pending row through the same CAS-on-`pending` guard. |

---

## The AI posture (one boundary, no exceptions)

- **Drafts** — nudges, replies, rain notices, scope notes. Owner edits, owner sends.
- **Explains** — priorities, health scores, the weekly brief. Cites its engine, every time.
  This is the shape `quote_intelligence` already proved.
- **Ranks & pre-fills** — CSV column mappings, dupe-merge previews, suggested dates.
- **Never prices. Never sends. Never a second engine.** Any dollar figure an AI surface shows
  is quoted verbatim from a quote/invoice record. All AI is drafts-only via
  `studioGateway`/`ai-assist`; consent gates (`reach.ts`, `applyConsent`) are unchanged.

---

## Design language (extended, never forked)

The premium design language is already shipped and owner-directed (2026-07-14). This
direction is built *in* it, and the gallery renders in it as a live token plate.

- **Type:** Syne 700/800 (display, headings, money heroes) + DM Sans 400/500/700 (body, UI,
  data). `tabular-nums` on every figure. Overlines `10px / 600 / +0.14em` uppercase.
- **Color:** the shipped dark-default palette (`bg 080C12` · `surface 141E2E` · `raised
  1A2640` · `accent 00C896` · `ink F0F4FF`) and the two-token accent rule for light
  (`accent-as-fill 00A97F` ≠ `accent-as-text 006E53`, which keeps AA). Kept verbatim.
- **Charts:** the brand accent is a UI token, not a chart step. Data marks use their own
  validated pair (green `#00A87D` / blue `#5B8DF5`) that passes the palette validator on the
  `#141E2E` surface (lightness band, chroma, CVD separation, normal-vision, contrast). One
  hue per series; color follows the entity, never the rank; one axis, never two.
- **Motion:** one vocabulary — rise + stagger, pop, panel, drawer, toast, page-fade. Fill-mode
  `backwards`, always. The global reduced-motion net stays.
- **Surfaces:** radius 14/20, hairline borders at 7%, **one aurora hero per page**, card-lift
  on navigation only.

---

## Constraints — what this direction must never touch

This is the reason the rest is buildable. The direction **recomposes surfaces**; it does not
open lanes, add engines, or relitigate settled decisions.

### Frozen lanes (drawn only as labeled post-freeze direction)
- **Pricing** — frozen outside the Pricing V2 roadmap. A proven defect is redesign input, not
  a patch licence. Do not re-invest in the Settings pricing-tab knobs V2 replaces.
- **Customer Journey** (portal + funnel + comms templates) `7573dd9`
- **Messaging** `2576b79` (`lib/comms/*`, composers, messages page)
- **Scheduling** `1d4ef66`
- **Marketing Studio + Photo** `4627924` (the whole 7-route cluster, treated as one sealed unit)
- **Quotes / Invoices / Payments** `66de14f` (batch invoicing and Tap-to-Pay are drawn but
  captioned "post-freeze"; Tap-to-Pay additionally must clear the payments-trust decisions and
  Canadian availability)

### Approved specs (rendered, not rivaled)
- **Quote Presentation Phase 6 spec** `7b8eed1` — 17 settled decisions + the `quote_events`
  taxonomy. The Quotes board *illustrates* it; **decision #17 forbids additional specs.**
  Sequencing law kept: **observable → delivered → beautiful.** Deliberately absent, per the
  spec: no deposit-on-accept, no stored `expired` event, no fifth `sent` writer. G/B/B stays
  blocked on Pricing Phase 3.
- **Booking** is its own deferred redesign project — it appears nowhere in this direction. Do
  not partially de-lawn it: copy and engine must ship together.

### One engine per responsibility (consume, never compete)
`invoiceBalance` · `needsFollowUp` · `lib/signals` (the ADR'd detection engine) ·
`capacityForDate` · `dayProfitability`/`gradeRoute` · `optimizeRoute`/`computeDayEtas`
(never a second route calc) · `reach.ts` + `applyConsent` ·
`buildTimeline`/`timelineData`/`TimelineCard` · `ensureCustomerAndProperty` +
`findCustomerMatch` · `renderMessage` · `lib/comms/log.ts` as the sole `notification_log`
writer (`error` vs `failed` is load-bearing) · the ONE outbox · the ONE palette
(`pageCommands`) · the `lib/modules` registry driving sidebar AND palette.

### Field invariants (render bigger, never thinner)
Offline bundle + outbox where `job.complete` queues patch + invoice + text as **one op** (a
reconnect can never leave a finished job unbilled) · day-view-as-default · the stage-primary
On-my-way → Start → Complete progression · undo with **verified** restores · the recurring
scope choice (its dialog may merge with the cadence warning; the choice itself stays).

### Honesty rules (now first-class visual states)
Unknown ≠ zero, everywhere. Empty books announce themselves (`marginPct → null` → `—`, plus a
banner). Season-to-date compares like with like. A derived state is never stored. Credit
settlements never read as new money.

### Recorded non-bugs (do not "fix" during redesign)
The season-visits annualizer claim is **false** — don't chase it. Charge-route divergence is
verified harmless. Quote expiry stays display-only with no backfill (owner refused).
`MOW_LABEL` deferral stands. Never rename `pricing_mow_rate` / `lawn_sqft`.

---

## How to use this document

- **For any future UI work:** this is the direction to align to. Cite the relevant board and
  the click-ledger target in the PR.
- **When it conflicts with a freeze or an approved spec:** the freeze/spec wins; fix this doc.
- **It is not a build order.** Implementation of any board that touches a frozen lane waits
  for that lane to open, on its own terms.

---

*Grounded in a five-agent audit of every shipped surface, the shipped token system, and field
research on Jobber, Housecall Pro, ServiceTitan, LawnPro and Yardbook. Set in the product's own
Syne & DM Sans. All customer names in the gallery are fictional; all mechanisms and file
citations are real. Provenance note: three research threads (the money-surface audit, the
design-system token extraction, and the Linear/Notion/Stripe/Arc study) were interrupted by a
transient classifier error and then the session usage limit, and were completed inline from the
same surfaces rather than by a dedicated agent.*
