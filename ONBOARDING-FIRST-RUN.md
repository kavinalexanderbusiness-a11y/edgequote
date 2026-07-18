# Onboarding First-Run — "The Quote Is the Onboarding"

**Status: DESIGN — approved-pattern synthesis, no code.**
Produced 2026-07-17 from a three-design panel (speed-first / AI-conversation-first / disclosure-first), each judged by three adversarial lenses (ruthless operator re-timing every step; skeptical engineer checking freezes and reuse; nervous first-time landscaper hunting confusion). The speed-first design won unanimously (41/50 from all three judges); this document is that design plus the grafts every judge independently named, minus two freeze violations the judges caught in the losing designs.

**The ask (owner, verbatim):** onboarding for someone starting a landscaping business · first quote in under 10 minutes · no confusion · progressive disclosure · AI helps configure everything.

**The thesis:** a person starting a landscaping business does not want to configure software; they want to hand a neighbour a price. So the wizard's only job is to get out of the way: **one 60-second screen, then a real quote for a real customer.** Every other setting is captured as a side-effect of quoting, or deferred to the SetupProgress card that already exists. Configuration is what happens *while* they work, not before they're allowed to.

**Not a second system.** Every piece below is an evolution of the shipped `/setup` wizard and its seeding engine (`applyTradeSelection` / pure `seedPlan`, fills-emptiness-only, fail-closed), a *presentation mode* of the existing QuoteBuilder, and new tasks in the existing `lib/ai/assist` registry. "Onboarding done" stays exactly what it is today — the `business_settings` row exists; no flag columns. "First-run" is *derived*: `quotes count === 0` (and, for one branch, `service_templates count === 0`), the same derivation philosophy as setupHealth.

---

## Step 1 — Pick your trade (evolved `/setup` · 0:00–1:05)

The existing single screen, three elements:

1. **"What's your business called?"** — helper: *"Leave it blank if you haven't decided — you can name it anytime."* Graft (warm copy): *"No name yet? Quotes will show your own name until you pick one."* Existing write-only-if-typed behaviour unchanged.
2. **"What kind of work do you do?"** — the existing `TRADE_PACKS` grid (Landscaping first), plus one new free-text box above it: *"Or just tell us: e.g. 'I cut grass and plow driveways in Calgary.'"*
   **AI touchpoint — new assist task `setup_intake`:** server-side structured extraction returning `{packKey, suggestedNames[≤3], servicesToHighlight[]}`. The client *pre-selects* the trade tile and shows tappable name chips — **the tap IS the confirm** (graft from the conversation design). Extracted fields render as provenance chips — *"Landscaping — you said this"* — with the standing AiNote: *"Read: your sentence. Nothing saved yet."* The AI never writes; the picker and the name field remain the only writers, and apply still goes through `applyTradeSelection` alone.
3. The existing **"What this will do"** seedPlan preview, reworded for a fresh account: *"We'll load a starter price list — 12 landscaping services with typical Canadian prices. Every price is yours to change."*

Buttons: **"Set up my business"** / **"Skip for now"** (existing; skip writes `business_type:'general'`).

**Writes on apply — byte-identical to today's seed engine:** the `business_settings` row; 12 landscaping `service_templates` (CAD, curated order); `service_seasons` (snow Nov–Mar, lawn Apr–Oct). Fills emptiness only; fail-closed on read error ("nothing was changed — try again").

**The Done screen is the pivot** (graft: the trust receipt). Replace the generic exit with a glanceable price list:

> **"Your price list is ready."** The 12 seeded services *with their prices*, tap-through to templates to edit. One reassurance line: *"Your snow and lawn seasons are set for Canada — nothing to do."*
> Primary: **"Quote your first job"** → `/dashboard/quotes/new?first=1` · Secondary: "Look around first" → `/dashboard`

**Clock: ~0:50–1:05** (page 15s · trade tap 5s · optional name 20s · apply 5s · done screen 10s). The AI-sentence path costs ~15s of typing and saves the name-brainstorming.

## Step 2 — First quote, guided (QuoteBuilder first-run mode · 1:05–7:00)

Not a new form — a **presentation mode** of the existing QuoteBuilder, active while `quotes === 0`, fixing the three documented killers on today's minimum path:

- **Surface the price.** When `serviceRecommendation` returns null, render a plain **"What will you charge?"** money input in the fast-path card — helper: *"Just a number for now. You can fine-tune pricing later."* This is the same field currently buried under "Advanced Pricing"; moving it is presentation, not pricing logic.
- **One service field.** With the pack applied, the template select holds 12 real services. For skippers (`service_templates === 0` **and** `quotes === 0` — both conditions, so a configured business never sees this branch), hide the dead select and show only Service Name + the surfaced price field. The skip-everything path stays sendable.
- **Honest starter prices.** Under the lawn plan tiles, one display-only line: *"Based on EdgeQuote starter rates — make them yours in Settings → Pricing."* Satisfies the say-which-config-produced-this-number rule (ADR-002 spirit) while touching no frozen engine.
- **Coach line** at the top while `?first=1`: *"Pick a service — your price fills in."* Deterministic template text (true today: seeded templates surface their catalog price through serviceRecommendation), zero AI dependency, zero latency.

Questions in order (existing fields, first-run labels): *"Who's this quote for?"* (name; phone/email marked "optional — add later") → *"Where's the property?"* (autocomplete) → *"What's the work?"* → lawn path (sqft → one plan-tile tap) or typed price.

**Config captured as side-effects, always with explicit consent:** an hourly service asks inline *"What do you charge per hour?"* with a visible pre-checked *"Save as my default rate"* — checked writes `business_settings.default_rate` (owner-entered data, the sanctioned kind); unchecked writes nothing. The customer + property are minted by the existing `ensureCustomerAndProperty` at save — the first CRM record is free. **AI drafts the scope** via the existing `quote_scope` task (stream-in, undo, AiNote), and — standing law, restated where a lazy design would break it — **AI never produces a price.**

**Clock:** ~2:00–3:00 on-screen; **budget 5:55** for a distracted human on a phone (address hunting, price second-guessing). Saved quote by ~7:00.

## Step 3 — Send it (7:00–8:30)

On the quote page, first-run mode makes the **zero-env path primary**: Download PDF relabelled **"Get the PDF — text or email it yourself"**, coach mark *"Most owners text the PDF straight to the customer. We'll mark this quote as sent."* (It already flips status through `markSentPatch`.) When `commsEnabled` is false, the composer button reads *"Send by text from EdgeQuote — set up messaging later"* and deep-links Settings → Messaging **before** the owner writes a message instead of failing after. **Implementation boundary: this relabel lives on the quote page button — never inside the frozen `lib/comms` composers.**

**Graft — the identity-at-send sheet** (every judge's #1 graft): the first send while business identity is incomplete interposes ONE sheet — *"Before this goes out — whose quote is this?"* (business name + phone) with an honest escape: *"Send anyway — your quote will show no business name."* The purest ask-at-the-moment-of-degradation in any of the three designs; it stops a nameless first PDF, writes only sanctioned `business_settings` columns, and appears at most once.

**Clock:** ~90s. **Running total ≈ 8:30 with slack; the fast lawn path lands near 4:30. The skip-everything path must also land under 10:00 — that is a tracked metric, not a hope.**

## Step 4 — The trickle (after minute 10, never before)

The **existing SetupProgress card** (9 derived items, deep links, disappears at 100%) *is* the deferral engine. Two changes:

- **Graft — zero-quote framing:** while `quotes === 0`, the card demotes its checklist behind one dominant action — **"Create your first quote — takes about 3 minutes."** Sub-line: *"Everything else can wait."* Catches every owner who tapped "Look around first."
- **"Draft this for me"** on items where drafting makes sense (terms text, review-ask wording, message-template starters) via one new assist task `settings_draft` — AI drafts, the owner edits, the settings form remains the only writer.

**Deferral map** (never asked in first run → where it surfaces): logo/terms/contact → SetupProgress · base address & travel → the first "Calculate distance" tap asks *"Where do you start your day?"* (replacing the curt error); the `Unknown: $0.00` travel tier renders as *"No travel fee set up yet — leave it off or type one"* · GST → first invoice touchpoint; $0 GST is legitimate, never nagged · e-transfer email → SetupProgress (it already gates the portal payment line) · **crew cost / wages / target rev-hour → never asked here; Pricing V2 owns them** · booking page, review link, templates, automations, season tuning → SetupProgress / Settings.

## Failure paths

- **AI down:** the `aiEnabled` gate already hides every assist surface. Step 1 renders today's static grid; Step 2 loses only the scope button. **The 10-minute path never depends on AI — AI accelerates, never gates.**
- **Maps env missing / address no-match:** autocomplete degrades to typed input; first-run mode hides the measure button when the browser key is absent (killing the raw `Missing NEXT_PUBLIC_…` string); typed sqft or typed price is the normal path outside autoMeasure coverage, not a failure.
- **Skip everything:** `general` row → dashboard → New quote via free-text service + surfaced price. Sendable with zero config, inside budget.
- **Seed failure:** existing fail-closed ("nothing was changed"); persistent failure still exits via Skip. Quote-save failure: existing honest abort.

## Explicitly excluded (freeze protection — judges' findings)

1. **No inline writer for `pricing_base_charge` / `pricing_mow_rate`** or any curve config from the quote form. The pricing experience is frozen outside the Pricing V2 roadmap, and ADR-002 makes config provenance the Phase 1 blocker — a new unversioned config writer is precisely what the freeze forbids. The display-only starter-rates line is the freeze-safe form.
2. **No AI inference of GST, crew count, or crew cost.** The AI surfaces only owner-stated fields; `crew_cost_per_hour` and every cost source stay empty by Pricing V2 decision. A province→GST hint states a number the owner never said — banned by the assist contract itself.
3. **Copy-portal-link as a zero-env send** is attractive but touches the frozen Customer Journey (pre-send token surface) — **conditional graft, requires explicit owner approval of that freeze exception.**

## Definition of success (instrumented, not vibes)

- **Done** = first quote reaches `status=sent`. Measure `business_settings.created_at → first sent_at`: **median < 10:00, p75 < 15:00 — including the skip path.**
- ≥70% of new accounts send a quote in the first session; drop-off measured per step (setup → builder open → save → send).
- Zero occurrences of: a price hidden behind "Advanced Pricing" in first-run, a raw env-var error string, a dead template select.
- **CI pin (extends `verify:onboarding`):** no AI-originated value (name, terms, template row, rate) can be written by any code path lacking an explicit user action; seeding remains byte-identical for configured businesses; the skip path still reaches a sendable quote.

## Build plan (when the lane opens)

- **S1 (small):** Done-screen price receipt + "Quote your first job" CTA · zero-quote SetupProgress framing · coach line + starter-rates line · plumbing sweep (travel-tier label, comms relabel on quote page, hide measure sans key).
- **S2 (medium):** QuoteBuilder first-run mode (surfaced price, hidden dead select, inline default-rate consent) · identity-at-send sheet.
- **S3 (medium):** `setup_intake` + `settings_draft` assist tasks + provenance-chip confirm UI · CI pin extension.
- Each stage independently shippable; S1 alone already removes the worst confusion. Nothing requires migrations; every write path already exists.
