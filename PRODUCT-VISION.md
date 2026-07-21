# EdgeQuote Product Vision — THE CANONICAL STATEMENT

**Status: APPROVED by the owner (2026-07-21). This document is the authority on
what EdgeQuote is building toward and why. Feature debates end here; changes to
this document require explicit owner approval.**

Derived from an adversarial competitive analysis (14 candidate moat features,
each stress-tested by a simulated incumbent war-room and a skeptical 2-crew
contractor persona). The full ranking lives in the analysis record; this page
keeps only what governs decisions.

---

## 1. The moat is the loop, not any feature

Every candidate feature, tested alone, was copyable, neutralizable by an
incumbent's marketing, or defended an installed base we don't yet have. What is
**not** copyable inside two years is the closed system:

> **satellite measurement → parametric per-contractor pricing engine →
> instant no-login price a customer can accept at 9pm → payment mandate at the
> moment of acceptance → learned true costs (timed visits, wage snapshots,
> parts ledger) feeding back into the engine.**

Incumbents quote with freeform documents a human types. Retrofitting computed
pricing across a large installed base is a multi-year replatform for them —
that seam is the one structural advantage we own. Every roadmap decision should
be tested against one question: **does this close, tighten, or feed the loop?**

Priority order from the approved analysis:

- **Tier 1 (the loop itself):** True-Cost Engine (= the accepted Pricing V2
  roadmap), the instant-price front door (auto-measure → engine menu → book →
  mandate), Demand Memory (acceptance outcomes anchored to measured properties
  — the Phase 6 `quote_events` spec).
- **Tier 2 (demo-winning wedges that ride the loop):** Canada-first money stack
  (Interac reconciliation, GST autopilot), Overnight Dispatcher
  (weather → cadence-aware replan → approved fan-out), Territory Economics
  (route-marginal-cost pricing, pre-priced neighbor offers).
- **Tier 3 (valuable, not moats — build when they feed the loop):** everything
  else. Network features (passport, commons, work network) are re-assessed only
  when two tenants overlap in one metro; until then they are roadmap, not moat.

## 2. The switching window is the shoulder season

Contractors do not migrate platforms mid-season — every persona refused July
and several volunteered October. Launches, migration tooling, and sales pushes
aim at the shoulder; mid-season effort goes to retention and proof (the demo
that survives an October evaluation is built in July).

## 3. Standing governance (owner directives, 2026-07-21)

1. **Real customer feedback outranks assumptions — always.** Where observed
   customer behaviour or direct feedback conflicts with an assumption in this
   vision, the analysis behind it, or any roadmap document, the feedback wins
   and the document gets amended, not defended. (The war-room personas are
   assumptions too — the first real contractors replace them.)
2. **The AI pricing boundary is permanent: AI never produces a price.**
   Engines compute; AI explains what the engines computed. No feature, Tier 1
   included, may relax this.
3. **Frozen lanes stay frozen.** This vision does not reopen any frozen area
   (pricing outside the V2 roadmap, customer journey, messaging, scheduling,
   marketing/photo, invoices/payments, AI Vision charter). Vision-driven work
   inside a frozen lane needs the owner to open that lane explicitly, exactly
   as before.

## 4. Honesty clauses this vision inherits

- The loop's data corpora start near-empty; the moat matures with real usage.
  We never fake it: unknown stays unknown, honest nulls render as "—", and
  "record truth or nothing" applies to every sensor.
- Per-tenant data is a retention moat, not an acquisition tool. Acquisition is
  won by the demo wedges (Tier 2) and the instant-price front door; retention
  is won by the corpus each tenant accumulates.

---

# Part II — The product specification

*Sections 1–4 above are the strategic thesis and are the authority on priority.
Sections 5–14 below are the detailed product specification that serves that
thesis: how EdgeQuote should look, feel, and sequence work so the loop gets
built. Everything here is subordinate to the thesis and to the governance in §3
— where they conflict, §1–4 win. Grounded in the current Product Strategy, the
onboarding specification, the live architecture, and the repository.*

Audience: 1–3 person field-service operators (lawn & landscaping first;
multi-industry via trade packs), Canada-first. Product promise: **calm,
automatic, intelligent** — "EdgeQuote remembers everything and every workflow
feels automatic."

## 5. Core design principles

1. **One engine per responsibility.** EdgeQuote has exactly one of each: one
   pricing engine (`lib/pricing`), one labour/duration model (`labor.ts`), one
   comms pipeline (`lib/comms/*`), one route engine, one rain engine, one
   detection engine (`lib/signals/*`), one dedup engine (`lib/dedup.ts`). A
   second implementation of a settled concept is a bug — the proven failure mode
   is *"one concept, two implementations, and the second copy was always the one
   that priced."* Before writing any predicate or threshold, check whether the
   question already has a named home.
2. **Solve root causes; enforce with the database.** Prefer DB constraints,
   partial unique indexes, triggers, and RPCs over app code that "always does the
   steps in order." A canonical seam is only real once the old execution path is
   deleted or routed through it.
3. **Reuse before you build; consolidate on contact.** First question of any
   task: *"what already exists that I should extend or consume?"* Never add a
   parallel table, engine, or UI pattern.
4. **Calm, automatic, intelligent.** For every workflow ask: *Can EdgeQuote
   remember this? Can it fill it automatically next time? Can one click be
   removed? Is there an obvious next action?* Never ask the operator to measure
   the same property or re-enter the same fact twice.
5. **Explain everything, from the business's own data.** Every recommendation
   states *why*, in plain language, derived from this operator's history.
6. **Honesty over confidence.** Unknown stays unknown and lowers confidence; it
   is never a placeholder. Confidence describes **agreement**, never row count.
   Money is auditable components, never one opaque scalar. (Inherits §4.)
7. **No sprawl.** Improve and automate the existing workflow instead of adding a
   surface. Fewer clicks, fewer pages, surface information in place.
8. **One premium design system.** EdgeQuote must feel like one senior product
   team built it (Apple/Stripe/Linear, not Salesforce). All presentation reuses
   the shared `globals.css` primitives — `animate-rise`/`stagger`, `card-lift`,
   `hero-aurora` (one hero moment per page), `icon-glow`/`pill-glow`,
   `EmptyState`, `StatTile` — with conventions enforced in the primitives
   (`tabular-nums` metrics, `tracking-tight` titles, quiet confidence dot+label,
   accent-chip section headers, skeletons over spinners, lucide not emoji). A
   standing **Design System Guardian** audits merged work for bypasses and
   extracts a new primitive when a pattern recurs 3+ times.

## 6. Navigation philosophy

- **Hub-and-leaf, never a maze.** Top-level rails lead to hubs (Dashboard,
  Schedule, Quotes, Customers, Grow, Analytics, Settings). Every orphan leaf
  answers "where am I" via a `crumb` breadcrumb overline and a lit parent rail
  item (`sectionOf`).
- **One command palette.** A single `pageCommands` palette is the universal
  keyboard entry point. There is never a second palette.
- **Information lives where the decision is made.** Prefer surfacing data in
  place; navigational cards lean in; dead-ends resolve to an actionable
  `EmptyState`, never a blank.
- **Analytical depth belongs in Grow/Analytics, not the primary rail.**
  Measurement Accuracy, automations, and reports live inside their hubs.

## 7. Mobile philosophy

- **Field-first and one-thumbed.** Mobile is the truck cab: large targets,
  drawer nav, scrollable filter pills, no dense tables.
- **Offline is a first-class state, not an error.** Field actions enqueue
  through the outbox/offline op model and reconcile when back online. Composite
  operations (e.g. undo-of-complete) are **one atomic op** so a half-applied
  state can never charge un-done work.
- **Effortless capture.** A background upload queue survives navigation, retries
  with backoff, pauses offline / resumes online, and dedupes by content hash and
  EXIF.
- **PWA delivery.** Installable, push-capable (pending VAPID config),
  server-seeded for instant first paint.

## 8. Desktop philosophy

- **Desktop is the command center.** The dashboard opens on a Morning Briefing:
  today's jobs with drive/finish times, revenue in flight, payments due/overdue,
  follow-ups due, weather impact — from existing data only, no vanity stats.
- **Priorities, then depth.** One "Today's Priorities" aurora hero states the
  highest-value next moves; analytics and configuration are one hub away.
- **Keyboard-driven.** Command palette, deep-linked detail rows, dirty-state-
  aware forms make the desk fast for the owner doing books at night.
- **Setup Health, not a checklist wall.** Onboarding progress is a dismissible
  card mirroring real consumer gates; it disappears when complete.

## 9. Customer philosophy

- **The customer never touches your data — they make requests.** The portal
  issues *requests* (service, reschedule, changes); it never mutates operator
  records. Server-first, seeded with `initialData`, nav ordered highest-value-
  first.
- **The customer journey is one coherent, frozen arc.** Booking funnel → portal
  → comms templates are a single designed experience; the booking redesign is
  its own project and must not be partially de-lawned. Public doors deduplicate
  customer + property on every submission.
- **Communication is governed, not sprayed.** One send governor owns *when* and
  *how often*; `reach.ts` owns *whether* (consent). Commercial sends fail closed,
  service sends fail open — asymmetric on purpose. All notification-log writes go
  through one writer.
- **Remember the customer's habits.** Preferred channel, response time, days-to-
  pay, favourite services, typical start time — derived from existing history
  (no new storage) and used to pre-fill the next interaction.

## 10. AI philosophy

> **The hard boundary (permanent, per §3.2): AI must NEVER produce a price.** AI
> measures, explains, drafts, detects, and suggests next actions. Price is always
> produced by the deterministic pricing engine, and every price carries its own
> derivation.

- **Effortless in, explained out.** If EdgeQuote can determine something
  confidently, it just does it. If confidence is low, it asks **one clear
  question — never a form.**
- **Everything learns from everything.** Pricing, scheduling, measurement, and
  marketing share models and one service vocabulary (`serviceKey`); never
  separate systems.
- **AI drafts, humans send.** The in-app writing engine produces drafts only; a
  human always approves before anything leaves.
- **Structural explainability.** Reasons are part of the result object, not a
  debug view — "why" is always available and always honest.
- **Unknown is a valid, respected answer.** Low evidence lowers confidence; it
  never fabricates a value.

## 11. Top 25 features ranked by impact

*Frozen lanes and the AI-pricing boundary are respected; items inside an approved
roadmap cite it. "Blocker" = on the master launch-blocker list. Tier tags map to
the loop (§1).*

**Launch-critical foundation**

1. Turn on the scheduled layer (crons) — *INF-1, blocker*
2. One measurement sensor feeding the SavedRecommendation pricing reads — *MEAS-1,
   blocker; Tier 1*
3. One quote-status writer — *QL-1, blocker*
4. Cost truth: transparent component cost breakdown (labour wage, payroll burden,
   equipment, fuel, travel, insurance, overhead, materials; unknown stays
   unknown) — *Pricing V2 Phase 1; Tier 1*
5. Money through one visit-value seam — *RPT-1, blocker*
6. Workforce delete = archive, never cascade — *PAY-1, blocker*
7. Atomic offline undo-of-complete — *SCH-1, blocker*
8. Public-door (booking) dedup — *BK-1, blocker*
9. One send governor (frequency / quiet-hours / CASL) — *MSG-1, blocker*
10. Bounded reads, one paging helper — *PERF-1, blocker*

**Pricing V2 (the deliberate repricing — land as one event, Tier 1 loop)**

11. Canonical `priceQuote()` engine — pure, `sum(terms) === price` — *Phase 2*
12. Real travel & drive-time model — *Phase 2*
13. Service framework — methods × dimensions (non-lawn trades; mowing reprices
    byte-identically; columns never renamed) — *Phase 3*
14. Multi-dimension measurement framework — *Phase 4*
15. One learning model + one variance-aware confidence (record what was *bought*)
    — *Phase 5*

**The quote as a document (Demand Memory, Tier 1)**

16. Quote gets seen & can be accepted — `viewed_at`, PDF accept, good/better/best,
    versioned revisions, `quote_events` — *Quote Presentation V2, approved spec*
17. Quote intelligence panel (explains pricing, never prices) — *shipped*

**Operator daily leverage**

18. Morning Briefing + grouped, actionable notifications
19. Proactive next action everywhere (measure→quote→schedule→invoice→paid)
20. Property Health as the single property truth (one pill, one rec, one action)
21. Effortless capture pipeline (queue + dedup + same-day grouping)
22. First-run onboarding via trade packs (seeds into emptiness only, neutral by
    default)

**Growth & reach**

23. Campaign & reactivation studio on the shared engines (`reach.ts` /
    `audience.ts` / `lib/signals/*`)
24. Integrations platform (outbox → pg_net → cron; the one event seam)
25. Self-serve signup — *OWN-1, owner call; the instant-price front door is Tier 1*

## 12. Six-month roadmap — *ship a trustworthy, buyable 1.0; build the demo that survives October*

- **Wave 0 — Infrastructure (first, isolated).** Crons on (INF-1); canonical SQL
  reconciled (INF-2, done). Unblocks the automated layer, defuses the portal
  landmine.
- **Wave 1 — Launch blockers (parallel, disjoint sessions).** PAY-1, SCH-1, BK-1,
  MSG-1, RPT-1 + PERF-1. The quote critical path (MEAS-1 → PR-1 → QL-1 → QL-2)
  runs as **one serialized session** (all touch QuoteBuilder). *(MEAS-1 merged;
  PR-1/QL-1/QL-2 pushed, awaiting merge.)*
- **Wave 2 — Pricing V2, sensors before brain.** Phase 0 (closed) → Phase 1 cost
  truth ($25 = wage, components not scalar) → Phase 2 canonical engine + real
  travel, validated by the differential harness (every price diff must map to a
  named finding).
- **Wave 3 — The quote as a document (Demand Memory).** Quote Presentation V2.
  Land Pricing Phases 1–3 as **one deliberate repricing**, grandfathering the 14
  live recurring plans.
- **Wave 4 — Buyable.** Self-serve signup + instant-price front door (OWN-1 /
  Tier 1); onboarding polish; Setup Health completion.

Gate: re-measure the calibration base rate on recorded anchors before trusting any
"owner closes under engine" claim.

## 13. Twelve-month roadmap — *tool → multi-industry operating system; light up the wedges*

- **Pricing V2 completed** — Phases 4–5. One profit model (`margin.ts`), one
  confidence; the learner free to say "0.77" *and* "I'm not sure."
- **Multi-industry breadth** — the service framework proven across ≥3 non-lawn
  trades end-to-end; trade packs matured; never rename `pricing_mow_rate`/
  `lawn_sqft`.
- **Tier 2 wedges** — Canada money stack (Interac reconciliation, GST autopilot),
  Overnight Dispatcher (weather → cadence-aware replan → approved fan-out),
  Territory Economics (route-marginal-cost pricing, pre-priced neighbor offers).
- **Customer V2 (unpause)** — resume the accepted architecture; M4 only on
  explicit approval; `resolveDocAddress` stays the address seam.
- **Inventory V2 (unpause on its two conditions)** — one ledger, one cost model;
  no costing before Pricing Phase 1 clears.
- **Automation promotion** — ROI-ranked wiring; scheduled reports gain the
  empty-books guard before wider rollout.
- **Full offline field app + push** (VAPID) and **accounting depth** (costed
  drive-time and materials) so margins are trustworthy at the job level.

## 14. Long-term vision

**EdgeQuote is the operating system for the owner-operated field-service
business** — the whole company run from a truck and a laptop, feeling like a
patient, expert back-office that never forgets. The durable advantage is the
**loop** of §1, not any single feature.

- **The business runs itself between decisions.** Measurement, pricing,
  scheduling, invoicing, collections, follow-up, and reactivation flow
  automatically; the operator is interrupted only for a genuine decision, always
  with the reason and the one-click action attached.
- **Every number is auditable and every recommendation is explained.** Price and
  derivation are the same object; the system never invents a value.
- **One coherent product across every trade** — the same engines, seams, and
  design language, configured by trade packs, never forked.
- **AI amplifies judgment, it doesn't own price.** AI removes the busywork and
  explains the world; the operator keeps authorship of price and voice.
- **It grows without sprawl** — new capability arrives by deepening an existing
  engine, never by bolting on a parallel one.

*Success: an operator ends the day having quoted, scheduled, served, invoiced, and
been paid — with fewer clicks than yesterday, and without EdgeQuote ever asking
them the same thing twice.*
