# Measure & Price + Quote Builder — UX & Architecture Audit

**Date:** 2026-07-15 · **Scope:** the full quoting workflow, all trades · **Code state:** `main` @ `220225d`
**Method:** every claim below was verified by reading source or querying production. Cites are `file:line`.
Claims I could not verify are marked **[UNVERIFIED]** rather than asserted.

---

## The one-sentence finding

**EdgeQuote invents numbers and then tells the owner they were confirmed.**

Not "EdgeQuote assumes lawn care." The lawn assumption is real and pervasive (§1), but it is a
*symptom*. The disease is that at every point where the product doesn't know something, it
substitutes a plausible number and renders it with the same confidence as a known one — a
fabricated price badged **"✓ Applied"**, a mowing price on an HVAC quote, a caption promising
service-specific pricing above an engine that never receives the service. A contractor cannot
tell, by looking, which numbers on this screen are real.

That is a trust bug, and trust is the entire product. Every P0 below is an instance of it.

---

## §0 · Evidence base, and its limits

| Probe | Result |
|---|---|
| Non-lawn service names → pricing engine | **8 of 19** realistic names route to the **lawn cadence engine** |
| `service_templates.pricing_display_type` in prod | **24 of 27** are `starting_from` — indistinguishable |
| `quotes` columns encoding grass | **11 of 45** (`overgrowth_multiplier`, `weekly/biweekly/monthly_price`, 6 section cols) |
| Per-unit rates in `business_settings` | **exactly one**, named `pricing_mow_rate` |
| Properties ever polygon-traced | **0 of 61** |
| Quotes using multi-service lines | **1 of 51** (2 lines total) |
| Quotes using `overgrowth_multiplier ≠ 1` | **0 of 51** |
| Quotes using any section breakdown | **1 of 51** |

**The limit — read this before citing any number above.** All 51 quotes, 27 templates and 61
properties belong to **one business** (`select count(distinct user_id)` = 1): the owner's own
lawn-care company. These are single-tenant numbers. "0/51 overgrowth" means *this owner never used
it*, not *the market doesn't want it*. I am **not** ranking anything on usage frequency alone.

Two facts do survive the caveat, because they concern features with *zero* exercise and are
structural rather than statistical:
- `lawn_polygon` traced on **0 of 61** properties — the marquee measurement feature has never run in prod.
- `quote_services` used on **1 of 51** quotes — multi-service quoting is shipped and unexercised.

### The regex probe, reproduced

`servicePricingKind()` ([servicePricing.ts:99-121](src/lib/servicePricing.ts#L99-L121)) falls
through to a name regex for `starting_from` templates — which is 24/27 of production. The `mowing`
regex ([labor.ts:93](src/lib/labor.ts#L93)) is `/mow|grass[\s-]*cut|lawn[\s-]*cut|\bcut\b|trim|whipper|string|edg/i`:

```
Trim Carpentry          → mowing → lawn_recurring   ("trim")
Window Trim Repair      → mowing → lawn_recurring   ("trim")
Baseboard Trim Install  → mowing → lawn_recurring   ("trim")
Edge Sealing            → mowing → lawn_recurring   ("edg")
String Light Install    → mowing → lawn_recurring   ("string")
Cut & Cap Gas Line      → mowing → lawn_recurring   ("\bcut\b")
Hair Cut                → mowing → lawn_recurring   ("\bcut\b")
(blank — no service yet) → other → lawn_recurring   ← the default state of every new quote
```

The last line is the important one: `return serviceType?.trim() ? 'labour' : 'lawn_recurring'`
([servicePricing.ts:120](src/lib/servicePricing.ts#L120)). **An empty service type defaults to lawn.**
Every quote begins its life as a mowing quote.

---

## §1 · The lawn assumption, by layer

It is not one assumption. It is four, and they get more expensive to remove as you descend.

| Layer | The assumption | Cost to fix |
|---|---|---|
| **Copy** | "Lawn Size (ft²)", "Click around the edge of the lawn", "Auto-measuring this lawn…" | Cheap — words only |
| **Routing** | Name regex decides recurrence; `starting_from` can't express it | Medium — needs template columns |
| **Engine** | `pricingPackage` = `base + sqft/1000 × mowRate`, `CADENCE_MULT` tuned to Calgary mow+trim+edge | High — but correctly *scoped*, see below |
| **Schema** | 11 lawn columns on `quotes`; one rate in settings, named `pricing_mow_rate` | Highest — `boulevard_sqft` on a plumbing quote |

**A migration is already half-done and it proves the direction.** Settings has been de-lawned with an
explicit comment ([settings/page.tsx:536-541](src/app/dashboard/settings/page.tsx#L536-L541)): *"The
labels used to name mowing… The stored columns keep their original names; only the words change."*
The portal too ([PortalClient.tsx:711-714](src/app/portal/[token]/PortalClient.tsx#L711-L714)): *"the
label must not tell a pool company we measured their lawn."* **Measure & Price is the surface the
de-lawning pass never reached.** This is not a new direction — it is finishing one already chosen.

**`lib/pricing.ts` is not the problem and should not be "generalized."** It is an honest,
well-scoped domain engine: residential lawn pricing genuinely is non-linear-from-zero, and
`units.ts:3-17` already states the rule — *"a unit is a LABEL… It NEVER enters the arithmetic. NOT
IN SCOPE — and never will be: lib/pricing.ts."* That boundary is correct. The bug is not that the
lawn engine exists; it is that **everything defaults into it**.

---

## §2 · P0 — the product states things that are false

Ranked by *how confidently the product asserts something untrue*, not by effort.

### P0-1 · The price is fabricated on mount and badged "✓ Applied"

Defaults `hours: 2`, `crew_size: 1`, `rate: 50` ([QuoteBuilder.tsx:58,83-85](src/components/quotes/QuoteBuilder.tsx#L83-L85)) feed:
```js
useEffect(() => { if (!initialManual && !pickedCadence) setValue('initial_price', suggestedInitial) },
          [suggestedInitial, initialManual, pickedCadence, setValue])   // :321-325
```
This fires **on mount**, before a customer, address, or service exists — writing `initial_price = $100`.
Because `initial_price` then equals `serviceRec.price` by construction, the card renders the green
**"✓ Applied"** state ([:655-661](src/components/quotes/QuoteBuilder.tsx#L655-L661)) instead of an
Accept button. *The owner is shown a number they never touched, labelled as one they confirmed.*

Concrete: seeded **"Plumbing Service Call"** (`$145/hr`) → `rate` is set but `hours` is not → **$290,
"✓ Applied"**, basis `"2 hr × 1 crew × $145.00/hr"`, for what may be a 20-minute call. Inversely,
**"Furnace Repair"** (`starting_from_materials`, $189) never sets `rate` → proposes **$100**, *47%
under the business's own catalogued starting price*.

**Fix:** unknown hours is not 2 hours. Same rule as the cost work already shipped — no number until
there is a reason for one. Leave `initial_price` empty; render "Accept" only after a real accept.

### P0-2 · "Measure & Price" puts a mowing price on every trade's quote

The modal shows a service picker captioned *"Pricing & duration are specific to this service"*
([QuoteMeasure.tsx:458](src/components/quotes/QuoteMeasure.tsx#L458)). **This is false.** The
computation is `pricingPackage(totalSqft, cfg, …)` / `gradedProspectPricing(sqft, cfg, pkgCtx, prospect, opts)`
([:396-405](src/components/quotes/QuoteMeasure.tsx#L396-L405)) — **neither signature accepts a
service** ([prospect.ts:416-421](src/lib/prospect.ts#L416-L421)). Tracing the same polygon for "Lawn
Mowing" vs "Pressure Washing" vs "Fence Installation" yields **byte-identical** output. The picker is
decorative.

Worse, `onApply` ([QuoteBuilder.tsx:1019-1046](src/components/quotes/QuoteBuilder.tsx#L1019-L1046))
sets `initial_price = sel.oneTime` (the lawn formula) **and** `initialManual = true`, which then
*blocks* the correct labour price from auto-filling ([:321-325](src/components/quotes/QuoteBuilder.tsx#L321-L325)).
The correct card still renders below — so a careful owner *can* fix it. **The default one-tap path is
the wrong one.** On save this lawn "recommendation" is written into the property's
`measurement_history` ([quotes/new/page.tsx:216-224](src/app/dashboard/quotes/new/page.tsx#L216-L224)),
poisoning it for every future quote.

### P0-3 · Blank or innocently-named services route to the lawn engine

§0's probe. Fix requires the template to declare its own recurrence — it currently **cannot** (§3).

### P0-4 · Four dead fields are shown to customers as fact

`fence_length`, `mulch_area`, `rock_area`, `driveway_area` are declared
([types/index.ts:97-100](src/types/index.ts#L97-L100)), **read and rendered** — including
customer-facing: `"{fence_length} ft fence"` ([PortalClient.tsx:715](src/app/portal/[token]/PortalClient.tsx#L715))
— and **written by nothing in the codebase**. No measure UI produces a fence line or a bed area.
They are pre-satellite carryover. Either delete the display or build a writer; showing a customer a
measurement that no code can produce is the worst of both.

### P0-5 · A $0 quote can be created, sent, and accepted

`initial_price` has `{ min: 0 }` and **no `required`** ([QuoteBuilder.tsx:759](src/components/quotes/QuoteBuilder.tsx#L759)).
`handleConvertToInvoice` blocks $0 with *"Set a price on this quote before invoicing it"*
([quotes/[id]/page.tsx:314](src/app/dashboard/quotes/[id]/page.tsx#L314)) — **the guard exists, at
the wrong end**. Nothing stops a $0 quote reaching the customer.

### P0-6 · Editing a quote silently discards its own stored values

`defaultValues={{ …, overgrowth_multiplier: 1, distance_km: 0, … }}`
([quotes/[id]/page.tsx:562-563](src/app/dashboard/quotes/[id]/page.tsx#L562-L563)) — the loaded
record's real values are available and ignored. Travel distance shows blank as if never calculated.
Compounding: `applyOvergrowth` **bakes the multiplier permanently into `rate`** at save
([new/page.tsx:127-128](src/app/dashboard/quotes/new/page.tsx#L127-L128)), so reopening shows an
already-inflated "Base Rate ($/man-hour)" that cannot be reconstructed.

---

## §3 · P1 — the wedge: option selling, and the engines already built

### P1-1 · Cadence tiles are Good/Better/Best in disguise — this is the strategic centrepiece

The Weekly / Bi-Weekly / One-Time tiles ([QuoteBuilder.tsx:674-718](src/components/quotes/QuoteBuilder.tsx#L674-L718))
are **option-based selling** — the single highest-leverage feature in Housecall Pro and ServiceTitan,
the one that reliably lifts average ticket. EdgeQuote already has the UI, the engine, the one-tap
fill, and the accept flow. It is hardcoded to mean *"how often we mow your grass."*

Reframe: **cadence → plan options.** Lawn's `{one-time, weekly, bi-weekly}` becomes one instance of a
general option set. HVAC: `{tune-up, full service, membership}`. Plumbing: `{repair, replace, premium}`.
Snow: `{per visit, seasonal}`. This is the same work as de-lawning the panel, but it changes the goal
from *removing an assumption* (defensive) to *shipping option selling to every trade* (offensive).

**Blocker — the template cannot express recurrence.** `service_templates` has 15 columns; there is no
recurrence, duration, or unit column. `pricing_display_type` is `starting_from` for 24/27 rows, so it
cannot distinguish Lawn Mowing from Mulch Installation from Snow Removal. **The owner's brief asks
the panel to adapt from "the template's recurrence settings, units, duration and pricing model" —
three of those five do not exist.** This needs an additive migration (recurrence mode, offered
cadences, duration, first-visit label), backfilled from the name regex **once** — which is the
legitimate place for a name check: converting implicit knowledge into explicit data, then never
running again.

**Open question for you — I will not guess:** "Seasonal" and "per visit" have **no quote column**
(`quotes` stores `initial/weekly/biweekly/monthly_price`). Supporting Snow's `{per visit, seasonal}`
means new columns. Worth it, or keep options ⊆ the four that exist?

### P1-2 · The trained labour model is forbidden from filling the field it sits next to

`labor.ts` is a real self-calibrating engine, fed **automatically by a DB trigger**
(`capture_labor_observation()`, [schema.sql:1706-1729](supabase/schema.sql#L1706-L1729)) — no app
wiring needed, it is already learning. `estimateLabor` returns a confidence-banded estimate with an
explicit `enoughData` "don't guess" flag.

- Scheduling a job: `onApply={(min) => setValue('duration_minutes', min)}` — **it fills the field** ([JobForm.tsx:599-608](src/components/jobs/JobForm.tsx#L599-L608)).
- Pricing a quote: `SmartLaborField readOnly … onApply={() => {}}` — **a no-op** ([QuoteBuilder.tsx:778-787](src/components/quotes/QuoteBuilder.tsx#L778-L787)), captioned *"Reference only — doesn't change your price."*

The same estimator fills the field when you *schedule* and is defused when you *price* — while the
field it won't touch defaults to a hardcoded `2`. This is the direct fix for **P0-1**: the honest
replacement for a fabricated 2 hours is *the learned estimate when confident, and nothing when not*.

Adjacent contradiction: `"Adjusts the suggested price above"` ([:768](src/components/quotes/QuoteBuilder.tsx#L768))
sits immediately above a widget documenting `"Never touches pricing"` ([SmartLaborField.tsx:31](src/components/labor/SmartLaborField.tsx#L31)).

### P1-3 · The graded pricing engine is bypassed on the default path

[QuoteBuilder.tsx:186](src/components/quotes/QuoteBuilder.tsx#L186) hardcodes `nearbyCount: 0` and
passes no `valueGrade`. So route-density travel discounting ([pricing.ts:143-150](src/lib/pricing.ts#L143-L150))
and A+…F value-based aggressiveness ([pricing.ts:216-255](src/lib/pricing.ts#L216-L255)) **never
apply** unless the owner opens the satellite modal. On a repeat/edit quote with `measured_sqft`
already populated — the common case — the full `gradedProspectPricing` engine is one parameter away
and silently degrades to baseline.

### P1-4 · Non-lawn trades get a visibly poorer product

Lawn gets `PriceIntelligence`: win-rate %, confidence, sample size, a "Because" list, a floor.
Everything else gets `serviceRec` — one number, one basis line
([:643-670](src/components/quotes/QuoteBuilder.tsx#L643-L670)). No win-rate, no confidence, no
reasoning. `quoteLearning.ts` is **already per-`serviceKey`** and was built for exactly this
([quoteLearning.ts:24-28](src/lib/quoteLearning.ts#L24-L28)) — it is gated off for non-lawn by UI, not
by capability.

### P1-5 · ~~Multi-trade onboarding is written, CI-verified, and never called~~ — **FIXED while this audit was being written**

`lib/trades/*` defines `tradePack(key)` → starter templates, seasons, campaigns, modules for
plumbing/HVAC/electrical/cleaning/roofing/painting/pest/pool/junk/handyman. `scripts/verify-trades.ts`
checks it in CI.

**This finding was true at `220225d` and is false at `d71001a`.** A parallel session shipped
`53e3c1c` ("Onboarding: first-run setup that seeds from the trade packs"), and `tradePack()` now has
real consumers — [setup/page.tsx:10,58](src/app/setup/page.tsx#L58) and
[CampaignManager.tsx:288](src/components/grow/CampaignManager.tsx#L288). Re-verified at rebase time.
Recorded here rather than deleted, because the *pattern* it exemplifies (a complete, CI-tested engine
with zero product consumers) is what the rest of §3 is about — and it took an outside session, not a
CI check, to notice. `verify-trades.ts` asserts the packs are *internally consistent*, never that
anything *calls* them. A green CI check on dead code is exactly how this pattern survives.

---

## §4 · P2 — measurement, and closing the learning loop

- **P2-1 · Two duplicate measure tools.** `MeasureTool.tsx` (sections, haptics) and `QuoteMeasure.tsx`
  (no sections, no haptics), each with its own hardcoded `M2_TO_SQFT`. They disagree on whether
  sections exist. Violates one-engine-per-responsibility. Merge before generalizing — generalizing
  twice is the expensive mistake.
- **P2-2 · Only area, only ft².** Both tools are polygon-area-only. No linear tracing (fence,
  eavestrough, baseboard — and `per_linear_ft` templates **ship** in the catalog), no counts
  (windows, fixtures, rooms), no volume (junk removal prices by truck-load). A measurement can never
  carry a unit; `measured_sqft` bakes ft² into the column name.
- **P2-3 · `autoMeasure` is lawn-shaped.** `DEFAULT_LAWN_RATIO = 2.3` (footprint × 2.3) — meaningless
  for a roof (≈1.0) or a driveway (unrelated to footprint). The per-neighborhood learning loop is
  real and good; it is learning the wrong ratio for any non-lawn trade.
- **P2-4 · Sections are a closed set of 6, flattened to columns.** `LawnSections` is fixed
  front/back/left/right/boulevard/other; `quotes` stores them as **six `numeric` columns**
  ([schema.sql:480-485](supabase/schema.sql#L480-L485)). A roofer's 5th roof face needs a migration.
  jsonb flexibility exists on `properties` and stops at `quotes`.
- **P2-5 · Extra service lines get zero pricing help.** No recommendation, no guardrails —
  `priceGuardrails` never evaluates `services[].unit_price`. The primary line gets two competing
  engines; line 2 gets none. Given multi-service is 1/51 used, **fixing the help may matter less than
  asking why nobody uses it** — do not build here on my say-so.
- **P2-6 · Loss reasons are captured on the wrong screen.** `QuoteStatusControl.tsx:25-65` marks a
  quote declined with **no reason prompt**; tagging lives in the unrelated Grow tab
  ([winLoss.ts:101-114](src/lib/winLoss.ts#L101-L114)). `quoteLearning.ts:232` reads `priceLossShare`
  to nudge recommendations — a signal starved by the UI. One field at the point of decline closes the
  product's only pricing feedback loop.
- **P2-7 · Travel fee is static.** `suggestTravelFee(distanceKm, tiers)` reads a flat $/km table and
  nothing else. `routeDensityTravel` ("the truck is already here") and the learned `travelLearning`
  drive-time model — **10 consumers elsewhere** — are never consulted at quote time. The win-rate
  price floor never receives `driveMin` despite the model being cached in the same app.

---

## §5 · P3 — polish, and one thing to *not* do

- **P3-1 · Do not invest in mobile mechanics.** I expected to rank this and the evidence says no.
  Haptics on vertex placement, 14px finger-target radii, touch-safe snap-close computed from pixel
  distance (because Maps never fires `mousemove` on touch), `touch-action: manipulation`,
  `env(safe-area-inset-bottom)`, 16px inputs to defeat iOS zoom, bottom-sheet modals. This is
  better-than-average mobile craft. **Two real nits only:** the price breakdown is behind an extra
  tap on mobile (the desktop preview column is `hidden lg:block`), and the three cadence tiles are
  `grid-cols-3` with no `sm:` fallback (~100px/tile at 360px).
- **P3-2 · Data-quality nags every business to measure lawns.**
  *"No lawn measurement on file — pricing recommendations need this"*
  ([data-quality/page.tsx:412](src/app/dashboard/data-quality/page.tsx#L412)) — shown to electricians.
- **P3-3 · Measurement is never presented as skippable.** "Lawn Size (ft²)" and the satellite button
  render **unconditionally** ([:581-601](src/components/quotes/QuoteBuilder.tsx#L581-L601)) for every
  trade. It is optional-by-omission, which is not the same as the UI saying so.
- **P3-4 · `property_intelligence` has no writer.** The vision read-seam (`propertyContext.ts`) and
  its `quote_scope` consumer are fully built and permanently starved — no insert exists anywhere in
  `src/`. So the AI scope writer silently never receives property facts.
  **[UNVERIFIED]** — memory records AI Vision as a *shipped, frozen* feature; the audit grepped only
  this repo. The writer may live in a clone (`mktg-studio`/`website-int`) or an unmerged branch.
  **Confirm before acting.**

---

## §6 · Competitive position

| | Jobber | Housecall Pro | ServiceTitan | EdgeQuote |
|---|---|---|---|---|
| Line-item quoting | ✅ strong | ✅ | ✅ | ✅ (`quote_services`, generic) |
| Price book | ✅ cost+markup | ✅ strong | ✅ **the product** | ⚠️ weakest area |
| Good/Better/Best | ⚠️ optional lines | ✅ core lever | ✅ core lever | 🔒 **built, locked to lawn** |
| Memberships / recurring | ⚠️ | ✅ | ✅ big | ⚠️ lawn cadence only |
| **Measures the property** | ❌ | ❌ | ❌ | ✅ **satellite tracing** |
| **Learns price → win-rate** | ❌ | ❌ | ❌ | ✅ `quoteLearning.ts` |
| **Route-aware pricing** | ❌ | ❌ | ❌ | ✅ `routeDensityTravel` |
| **Learns actual job duration** | ❌ | ❌ | ⚠️ reports only | ✅ auto via DB trigger |

**Do not copy them.** The bottom four rows are things none of the three do at all, and EdgeQuote has
working engines for every one. That is the wedge:

> *"Jobber tells you what you charged. EdgeQuote tells you what to charge — because it measured the
> property, learned how long the job actually took, knows the truck is already on that street, and
> knows which of your prices win."*

Every one of those four claims is **already true in code and switched off in the UI** (P1-2, P1-3,
P1-4, P2-7). The competitive gap is not a build problem; it is a wiring problem.

Where they are genuinely ahead: **the price book**. ServiceTitan's flat-rate task book is their moat,
and EdgeQuote's `service_templates` — 15 columns, no recurrence, no duration, no units, no assemblies,
no materials list — is not close. The cost/margin foundation shipped at `220225d` is the first brick.

---

## §7 · Ranked plan

**P0 — stop asserting false things.** Small, mostly deletions. Do first; nothing else earns trust while these stand.
1. Remove the mount-time price fabrication + the false "✓ Applied" (P0-1)
2. Make `QuoteMeasure` service-aware, or remove the lying caption and the one-tap lawn apply (P0-2)
3. Kill the `'' → lawn_recurring` default (P0-3) — the regex itself needs P1-A first
4. Delete or write `fence_length`/`mulch_area`/`rock_area`/`driveway_area` (P0-4)
5. Move the $0 guard from invoice-time to quote-send-time (P0-5)
6. Load a quote's real `overgrowth`/`distance` when editing (P0-6)

**P1 — the wedge.**
- **A.** Migration: template declares recurrence + offered options + duration + first-visit label; backfill from the regex **once** *(needs your answer on seasonal/per-visit — §3)*
- **B.** `lib/servicePlans.ts` — ONE seam deriving plan options from a template; panel renders from it
- **C.** Wire `estimateLabor` → the Hours field (fixes P0-1 honestly) (P1-2)
- **D.** Pass `nearbyCount` + `valueGrade` on the default path (P1-3) — near-free
- ~~**E.** Call `tradePack()` at onboarding (P1-5)~~ — **done by a parallel session at `53e3c1c`**
- **F.** `PriceIntelligence` for all kinds, not just lawn (P1-4)

**P2 — measurement + the loop.** Merge the two tools (P2-1) *before* generalizing. Then measurable
quantities with units (P2-2), loss-reason at decline (P2-6), route-aware travel (P2-7).

**P3 — polish.** Skippable measurement (P3-3), de-lawn data-quality (P3-2), the two mobile nits
(P3-1). Confirm the vision-writer question (P3-4).

### If I could do one thing
**P1-C + P0-1 together.** Delete the fabricated 2 hours; put the trained estimate — which is already
learning, automatically, from a DB trigger — into the field that sets the price. One change removes
the product's most confident lie and switches on its best engine. It is the whole thesis in a single
diff.
