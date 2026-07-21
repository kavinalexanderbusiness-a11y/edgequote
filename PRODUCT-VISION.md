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
