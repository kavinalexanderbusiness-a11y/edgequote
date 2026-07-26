# Quote Builder — UX & Product Audit

**Date:** 2026-07-26 · **Scope:** `/dashboard/quotes/new` and the edit surface, i.e.
[QuoteBuilder.tsx](src/components/quotes/QuoteBuilder.tsx) (1,337 lines) plus its two hosts
[new/page.tsx](src/app/dashboard/quotes/new/page.tsx) and [[id]/page.tsx](src/app/dashboard/quotes/[id]/page.tsx).
**Lens:** cognitive load · hierarchy · workflow · unnecessary surface · defaults · speed for an owner-operator.
**Method:** read every line of the builder and the primitives it composes; verified each claim against source,
with a runtime repro for the one that needed it. Claims I could not verify are marked **[UNVERIFIED]**.

**Companion, not a replacement:** [MEASURE-AND-QUOTE-AUDIT.md](MEASURE-AND-QUOTE-AUDIT.md) (2026-07-15) audited
this same screen for *honesty* — invented numbers rendered as confirmed ones. Most of its P0s are fixed and the
discipline it created is visible everywhere in the file (`priceOrigin`, the "No recommended price" card, null
recommendations). This audit assumes that work and asks a different question: **once the numbers are honest, is
this thing fast to use?**

---

## The one-sentence finding

**The fast path is fast for exactly one case — a measured lawn, for a business with history — and every other
case falls out of it into a form where the price field itself was hidden behind a collapsed disclosure, one
line under a card that says "enter your price".**

Everything below is either an instance of that, or a defect I found while looking for instances of it.

---

## §0 · What shipped, as a map

| Depth | Surface | Contents |
|---|---|---|
| 0 | Card *"New quote"* | Customer · manual-entry panel · Address · Service (template) · **Service Name** · **Measured Area** · Measure button · recommendation card · plan tiles |
| 1 | ▸ *Advanced Pricing* | saved measurement · **Price ($, first visit)** |
| 2 | ▸▸ *Labour calculator* | hours · **crew size (required)** · SmartLaborField · multiplier · rate |
| 2 | ▸▸ *Plan pricing* | weekly · biweekly · monthly · **guardrail warnings** |
| 2 | ▸▸ *Travel* | calculate · distance · fee · tier note · two toggles |
| 1 | ▸ *Additional services* | n × (service, template, qty, unit, price, minutes, discount, notes) |
| 1 | ▸ *Materials* | n × (material, 8 suggestion chips, qty, unit, price, discount, notes) |
| 1 | ▸ *Notes* | textarea + AI scope writer |
| 1 | ▸ *Scheduling & status* | status dropdown · "best days to schedule" |
| — | sticky right / mobile bar | breakdown + Save |

Three nesting levels, styled identically at levels 1 and 2 (same border, same `bg-bg-secondary`, same
`py-3.5`) — so the form's depth is undiscoverable until you open a section and find more of the same rows
inside it.

---

## §1 · P0 — the builder crashes on any quote with more than one line

**Verified, live since 2026-07-17, and it is a hard crash, not a glitch.**

[QuoteBuilder.tsx](src/components/quotes/QuoteBuilder.tsx) read `watchedServices` at what was line 128 —

```ts
const kindAt = (i: number) => watchedServices?.[i]?.kind ?? 'service'
const serviceIdx  = indexedLines.filter(({ i }) => kindAt(i) !== 'material')   // calls kindAt NOW
const materialIdx = indexedLines.filter(({ i }) => kindAt(i) === 'material')
…
const watchedServices = watch('services')                                       // ~130 lines below
```

`Array.prototype.filter` invokes its callback synchronously, so `kindAt` reaches a `const` still in its
**temporal dead zone**. With zero lines the filters never run and nothing happens; with **one** line it throws
`ReferenceError: Cannot access 'watchedServices' before initialization` and the whole builder unmounts.

Reproduced outside React to isolate the semantics from anything framework-shaped:

```
empty array -> 0
one line THREW: ReferenceError: Cannot access 'watched' before initialization
```

**What that means in the product:** tapping **Add service** or **Add material** blanks the screen, and opening
any saved multi-line quote for editing blanks the screen. `tsconfig.json` targets ES2017, so `const` is not
downlevelled to a hoisted `var` — the TDZ is real in the shipped bundle.

**Introduced by** `829cf3f` *"Quotes: materials become a kind of line, not a second system"* (2026-07-17), which
added the three lines above the existing declaration. Before it, `watchedServices` was only read inside JSX,
below its declaration (verified against `829cf3f^`).

**Why it survived 9 days:** the prior audit measured `quote_services` in use on **1 of 51** production quotes.
The feature is shipped and essentially unexercised, so the crash had almost no chance to be reported.

✅ **Fixed** — declaration hoisted above its first reader; nothing else moved.

---

## §2 · Cognitive load

### 2.1 The price field was not in the fast path ✅ fixed
The single number the document exists to communicate lived inside a **collapsed** "Advanced Pricing" section.
The consequence is worst in exactly the case the builder is weakest at: when no engine can recommend anything,
the fast path renders

> **No recommended price** — *No recommendation yet — … or type a price.*

…and there is no price field anywhere on screen to type it into. That is the default state for every trade the
lawn engine can't price and for every business with no quote history. Editing a saved quote to change its price
was the same hunt.

**Fixed:** the field now renders in the fast path directly under whatever recommendation is (or isn't) offered.
Same `register('initial_price')`, same hint states, same `priceOrigin` tracking — nothing about the number
changed, only where it is.

### 2.2 Guardrail warnings rendered inside a section about recurring plans ✅ fixed
`priceGuardrails` evaluates **every** filled cadence including `one_time`, but `<PriceGuardrailNote>` was
rendered inside *Plan pricing* — two taps down. So "this first-visit price is below your crew-cost floor" waited
for someone to go looking in a recurring-plans panel. A never-block warning that nobody sees is not a warning.
**Fixed:** moved (not copied) to sit under the price it judges.

### 2.3 Two fields for one answer ✅ fixed
*Service* (template picker) and *Service Name \** sat adjacent; picking "Lawn Mowing" in the first fills the
second with "Lawn Mowing", which then still reads as an empty-looking required field. **Fixed:** once a template
has settled the name, the field is replaced by a one-line *"Customer reads **Lawn Mowing**"* with a **Rename**
button. Free-text quotes and any validation error still get the real field, and the value is never unregistered.

### 2.4 A measured area asking to be filled in on jobs it doesn't price ✅ fixed
For labour-priced trades the field's own hint read *"Optional for this service — it feeds the labour estimate,
not the price"* — a full-width numeric input whose caption explains its own irrelevance. **Fixed:** it renders
when it **prices** the job (lawn cadence / per-area) or when a figure already exists; otherwise it collapses to
a `+ Enter measured area (optional)` link. The satellite **Measure** button now sits *above* it — the fast path
was leading with the slow input.

### 2.5 Repetition in the copy ✅ partly fixed
The plan-tile block carried a heading (*"Plan options — one tap fills all"*) and, four lines later, a 14-word
restatement of that heading. Eight material-suggestion chips re-rendered under **every** material line forever,
including filled ones. Both trimmed; the chips now retire once a line is named.

### 2.6 Hint density — **recommended, not implemented**
Five consecutive fields in the fast path each carry a hint. Hints are load-bearing here (they're where honesty
about provenance lives), so this needs judgement per string rather than a sweep. Suggested rule: a hint that
states *where a number came from* stays; a hint that restates the label goes.

---

## §3 · Hierarchy

### 3.1 A three-deep accordion, flat-styled ✅ fixed
Levels 1 and 2 were the same component with the same styling, so depth was invisible. **Fixed:** "Advanced
Pricing" → **Pricing details**, and its three nested disclosures are now flat `FieldGroup` blocks — a heading,
a rule, and the fields. Depth 3 → 2; hours/crew/rate/travel go from two taps to one. The three summary lines the
nested headers used to carry are composed into the parent's one-line summary, so a closed section still reports
its state.

### 3.2 The breakdown mislabelled and miscounted its own lines ✅ fixed
One row read `Additional services ({serviceLines.fields.length})` — the length of the array holding **both**
services and materials — over `extras.net`, which also includes both. One hedge trim + two yards of mulch read
*"Additional services (3)"*. **Fixed:** two rows, each counting and summing its own kind, both from the same
`sumServiceLines` engine. `serviceExtras.net + materialsSum.net === extras.net`, so the total is untouched.

### 3.3 The breakdown stated unknowns as facts ✅ fixed
`Number(hours).toFixed(1)` rendered unknown hours as **"0.0 hrs · 1 crew"** — a confident claim that the job
takes no time, in the one place the owner checks their numbers, in a file whose comments go to some length to
keep `hours` honestly blank. An empty quote also headlined **$0.00** as its "First visit total". **Fixed:** the
Hours row renders only when there are hours; empty totals render `—`.

### 3.4 Naming ✅ fixed
The desktop card said *"Quote Preview"* and the mobile sheet said *"Quote breakdown"* for identical content —
and neither is a preview of the quote. Both now read **Quote breakdown**. The card header said *"New quote"*
directly beneath a page header saying *"New Quote"*; it now names its content: **Customer, property & price**.
*Scheduling & status* shared `SlidersHorizontal` with the pricing section — it has its own icon now.

---

## §4 · Workflow & speed

### 4.1 Save could fail silently ✅ fixed
`crew_size` is `required` and lived inside a collapsed section. Clear it, tap **Save**, and: react-hook-form
blocks the submit, tries to focus a field that isn't mounted, the error message renders into an unmounted
component — and nothing at all happens on screen. Same for a negative `hours` or `rate`. **Fixed:** an
`onInvalid` handler toasts the first message and opens the section holding the offending field (which required
adding optional controlled `open`/`onOpenChange` props to
[ui/Collapsible](src/components/ui/Collapsible.tsx) — additive; every uncontrolled caller keeps its internal
state and behaves exactly as before).

### 4.2 Save doesn't send — **recommended, not implemented**
The owner's goal is a *sent* quote. Today: Save → redirect to the quote page → find Send. The builder's primary
action should be **Save & send** with "Save as draft" secondary. Not implemented: it changes quote lifecycle and
must go through the send governor ([lib/comms/governor.ts](src/lib/comms/governor.ts)), not the builder.

### 4.3 No sight of what the customer receives — **recommended, not implemented**
[QuotePDF.tsx](src/components/quotes/QuotePDF.tsx) exists and renders the customer-facing document. A **Preview**
button in the builder would close the loop on "what am I actually sending?". Cheap, and squarely presentation —
left out only because it adds a surface rather than improving one, which is outside "independent presentation
improvements".

### 4.4 Re-render on every keystroke — **recommended, not implemented** [UNVERIFIED impact]
`const formValues = watch()` subscribes the component to *every* field for autosave, on top of ~20 individual
`watch()` calls. The file already memoises option arrays specifically to survive this. On a mid-range phone in
a driveway this is the difference between typing and waiting. Fix: `useWatch` with a debounced projection for
the autosave value. Not implemented — it touches the shared autosave engine and wants a profiler run, not a
guess.

### 4.5 Autosave considers a lines-only quote "empty" — **recommended, not implemented**
`isEmpty` checks customer/name/address/service/initial_price and ignores `services`. A quote whose content is
additional lines isn't drafted. Small blast radius, but it's a data-loss shape.

---

## §5 · Unnecessary surface

| Surface | Verdict |
|---|---|
| **"Best days to schedule"** inside the quote builder | **Remove.** Nothing is schedulable until the quote is accepted; it's a scheduling answer to a pricing question, and it sits in the same disclosure as a status dropdown that shouldn't be there either (below). Recommended, not implemented — it deletes a feature. |
| **Status dropdown on a NEW quote** | **Restrict to Draft/Sent.** Offering *accepted / scheduled / completed / paid* at creation lets the owner write a lifecycle state directly; the pre-launch audit already flags this dropdown as the *5th raw status writer*, bypassing expiry and follow-up. Recommended, not implemented — it belongs to the status-engine fix, not to a UI pass. |
| **Adjustment Multiplier** | **Hide for non-lawn kinds.** It is a grass-overgrowth concept shown to every trade, and the 2026-07-15 audit measured `overgrowth_multiplier ≠ 1` on **0 of 51** production quotes (single-tenant data — one lawn-care business). Recommended only: it is a pricing input, and the pricing freeze is the owner's, not mine to spend. |
| **Additional services + Materials as two sections** | **Keep split.** They look duplicative (two arrays' worth of chrome over one field array) but the split is deliberate and correct — materials have no duration, services do, and the code documents why. Merging into one "Line items" list with a kind toggle is a plausible future; it is not a cleanup. |
| Everything else | earns its place. |

---

## §6 · Defaults

| Default | Assessment |
|---|---|
| `hours: 0` (blank) | **Correct and hard-won.** Do not "improve" this into a number. |
| `crew_size: 1` | Structural floor, but `business_settings.default_crew_size` exists in the DB with no TS type and no Settings UI. **Recommend** plumbing it end-to-end rather than leaving a half-connected column. |
| `rate: settings.default_rate` | Correct — reads the owner's own configured rate, no `\|\| 50` backstop. |
| `status: 'draft'` | Correct. |
| `includeTravel: true`, fee 0 | Correct — charging is the default posture, the number stays honest. |
| **No service preselected** | **Recommend:** when a business has exactly one active template (or one favourite), preselecting it removes a tap from every quote. Not implemented — selecting a service changes `pricingKind`, the recommending engine, the rate and the notes, so it is a pricing-path default, not a presentation one. |
| Monthly cadence off | Correct, and explained. |

---

## §7 · Consistency notes (small, real)

- **Five verbs for one action:** *Accept* · *Use $X* · *Use measured prices* · *Apply suggested travel fee* ·
  *Use suggested (…)*. I unified the travel one (**Use suggested fee**) since it was in reach; the rest live in
  frozen pricing components. Recommend converging on **Use**.
- **`PriceIntelligence` infers "Applied" from numeric equality**
  (`Math.abs(currentPrice - rec.price) < 0.5`, [PriceIntelligence.tsx:110](src/components/pricing/PriceIntelligence.tsx#L110))
  — precisely the inference the builder's own `PriceOrigin` comment forbids, for precisely the stated reason.
  Flagged, not touched: frozen component.
- **Plan tiles had no `aria-pressed`** ✅ fixed — the selection ring was visual-only, so a screen reader heard
  three identical price buttons.

---

## §8 · What I changed

All in [QuoteBuilder.tsx](src/components/quotes/QuoteBuilder.tsx) plus one additive prop on
[ui/Collapsible.tsx](src/components/ui/Collapsible.tsx). **No pricing engine, component or calculation was
touched**; `verify:pricing` and `verify:guardrails` both pass, `tsc --noEmit` clean, production build clean.

1. **P0 crash fixed** — `watchedServices` declared above its readers (§1).
2. Price field moved into the fast path (§2.1).
3. Guardrail note moved next to the price (§2.2).
4. Service Name collapses to *"Customer reads X · Rename"* once a template settles it (§2.3).
5. Measured Area demoted to a link on trades it doesn't price; Measure button promoted above it (§2.4).
6. "Advanced Pricing" → **Pricing details**, three nested disclosures flattened to `FieldGroup` blocks, state
   summaries composed into the parent (§3.1).
7. Breakdown splits services from materials, with correct counts and subtotals (§3.2).
8. Breakdown hides unknown hours and renders empty totals as `—` (§3.3).
9. Naming: *Quote breakdown* both places · *Customer, property & price* · distinct scheduling icon (§3.4).
10. Blocked submits now say what's wrong and open the section holding it (§4.1).
11. `aria-pressed` on plan tiles (§7).
12. Copy trims: duplicated plan-options sentence, repeated material chips, section cross-references retargeted
    to the renamed section.

## §9 · Ranked plan for what I did not do

1. **Fix the status dropdown** (launch blocker, already tracked) — restrict at creation, route through the
   status engine.
2. **Save & send** as the builder's primary action (§4.2).
3. **Preselect the single active service** (§6) — one tap off every quote for most businesses.
4. **PDF preview in the builder** (§4.3).
5. **Remove "best days" from the builder** (§5).
6. **Profile and fix the keystroke re-render** (§4.4).
7. **Plumb `default_crew_size`** or drop the column (§6).
8. **Unify the accept verbs** when the pricing freeze lifts (§7).
