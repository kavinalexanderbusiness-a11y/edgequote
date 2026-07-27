# Quote Builder — UX & Product Audit

> **Round 2 is §10–§12** — two more correctness bugs, the click-reduction pass, the first-run
> dead ends (`cb38580`). **Round 3 is §13–§17** — everything the builder used to overwrite
> without telling anyone (`2b07fa4`). **Round 4 is §18–§21** — the draft that a failed save
> deleted, and the map of what's left. §1–§9 are round 1 (`7c343ff`).

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

---
---

# Round 2 — friction in the creation workflow

Same scope, one pass deeper, looking specifically for clicks that don't need to exist and
decisions the owner shouldn't have to make. Two more correctness bugs fell out of it.

## §10 · Two more bugs, both in the "don't lose the owner's work" class

### 10.1 Restoring an autosaved draft threw away the restored price ✅ fixed

`onRestore` called `reset(v)` — which restores the **fields** but not the provenance state that
protects them. On a new quote `priceOrigin` starts at `'empty'`, so a restored draft came back
**unlocked**, and the reconciliation effect fired on the very next render:

```ts
if (priceLocked || pickedCadence) return
const price = serviceRec?.price ?? 0
if (price > 0) { setValue('initial_price', price); setPriceOrigin('suggested') }
```

So: type $250 → tab crashes / phone locks / you navigate away → come back → **Restore** → the
engine's number silently replaces your $250. On the one path whose entire purpose is not losing
your work. `includeMonthly` was dropped by the same gap (a restored monthly price with the pill
reading off).

**Fixed:** a restored price is treated exactly like loading a saved quote — it is the owner's own
past decision, so it locks (`'manual'`), and the monthly toggle is rehydrated from the value.

### 10.2 "✓ Applied" survived changing the service ✅ fixed

`priceOrigin === 'applied'` means *the owner accepted an engine's recommendation*. Nothing
re-examined that claim when the **service** changed underneath it. Measure a lawn → tap Accept →
switch the service to "Furnace Repair", and the badge still read a confident green **✓ Applied**
next to a mowing price on a furnace quote — the exact failure mode
[MEASURE-AND-QUOTE-AUDIT.md §2 P0-1](MEASURE-AND-QUOTE-AUDIT.md) was written about, arriving by a
different door. The file's own rule is that equal numbers are not consent; consent given for one
service is not consent for the next either.

**Fixed:** every accept path now goes through one `markApplied()` that records *what was accepted,
and for which service* (template id when there is one, so renaming a template-backed service on
the quote doesn't count as switching). When the service changes under an accepted price, the badge
drops to "Manual price". **The number is not touched** — it may still be what the owner wants, and
silently zeroing their price would be a worse bug than a stale badge. It stays locked, so no
suggestion overwrites it either.

### 10.3 Two smaller ones ✅ fixed

- **The Monthly pill could claim a state the quote didn't have.** The toggle skipped its write
  whenever the price was manual, so it read *"Monthly: on"* over an empty monthly field. Now: off
  always clears; on fills only an **empty** field, so a monthly price the owner typed is never
  overwritten either.
- **"Beyond your furthest travel tier — enter a custom travel fee"** kept demanding a fee after the
  owner switched to *"Absorbing travel — no fee"*. Gated on actually charging travel.

## §11 · Clicks removed

### 11.1 The service picker, for the businesses that have few services ✅
A `<select>` costs two taps and hides the entire catalogue behind the first. An owner-operator
quoting in a driveway has a handful of services that fit on one screen — so at **≤6 active
templates the options become the control**: a wrapped row of chips, one tap, each showing its own
`formatServicePrice`. Past six the chip row would be worse than the dropdown, and the dropdown
comes back. Same `Controller`, same field, same template effect — nothing downstream knows.

Net for a typical small catalogue: **2 taps → 1**, on the field every quote must set, and the
catalogue is now visible without interacting at all.

### 11.2 First-run dead ends became links ✅
On a fresh account the builder's first utterance is *"No recommendation yet — set your Default
Labour Rate in Settings"*, and there was **no way to get there from here**. Same for the Base Rate
hint, and for an empty catalogue (the Service dropdown offered one option: "Select a service…").
All three now link to the page they name. A first quote is exactly where a business discovers it
hasn't set a rate.

### 11.3 The price now looks like the answer ✅
Every other field in the fast-path card is a question; the price is the answer. It renders at
`text-lg font-semibold tabular-nums` — the only weighted input on the form.

## §12 · Recommended, still not implemented

- **Carry the typed name into "+ Enter manually".** Type "Jane Smith" in the customer picker, find
  no match, choose *Enter manually* — and the name you just typed is discarded, presenting an empty
  "Customer Name \*". You type it twice. The fix is ~6 lines (hand the query to the caller via an
  optional `onManual` prop, and label the row *"New customer — Jane Smith"*), and it is the single
  biggest remaining click-saver in the flow. **Not done because `ui/CustomerPicker.tsx` was being
  edited by another session while this pass ran** — the file changed twice under me mid-edit, so I
  backed my changes out rather than commit someone else's half-finished work. Pick this up when
  that file is quiet. It pairs with hiding the manual-entry panel until the owner actually chooses
  manual entry (today it's shown by default on every new quote, three fields before you've decided
  whether the customer already exists).
- Everything in §9 still stands, unchanged.

### A trap worth naming, not fixing (round 2)

`quotes/[id]/page.tsx` loads `overgrowth_multiplier: 1` and `distance_km: 0` into the builder on
every edit — which **looks** like the "editing discards stored values" defect, and the multiplier
really is overwritten to `1` in the database on save. Do not "fix" it by loading the stored value:
`rate` is persisted as `applyOvergrowth(rate, mult)`, i.e. **already multiplied**, so loading the
real multiplier would re-apply it on every save and compound the rate. The honest fix is storing a
base rate separately — a schema change, and Pricing V2's business, not a UI pass's.

---
---

# Round 3 — what the builder overwrites, and what it lets you get wrong

Rounds 1 and 2 each turned up a data-loss bug by accident. Round 3 went looking for the
**class**: every place the form writes into a field the owner may already have filled. There
were two more, and they are the worst ones yet, because unlike the price they don't announce
themselves — the wrong value simply sits there looking like something you typed.

## §13 · Fields the builder silently overwrote ✅ all fixed

**The rule this file already follows in three places** — *"fill it when it's empty, never
overwrite what the owner typed"*, stated most plainly at the property-address effect
(*"never make the owner retype data we just fetched"*) — **was not followed in two others.**

### 13.1 Picking a customer destroyed the address you had typed

```ts
if (!isEdit && customer.address) setValue('address', full)   // unconditional
```

Type the service address first — a rental, a second property, a job site, the thing you are
standing in front of — then pick the existing customer from the picker, and your address is
replaced by their **home** address. No prompt, no undo, no visual difference afterwards. The
quote then goes out, gets scheduled, and gets driven to for the wrong property.

It also silently overwrote the two prefilled paths that exist precisely to save typing: a
**website lead's** stated service address, and the **measure-tool handoff's** address, both of
which arrive with a `customer_id` attached and were immediately clobbered by that customer's
record.

**Fixed** by remembering what *we* auto-filled: the address is written when the field is empty
or still holds our own previous fill (so switching customers keeps working exactly as before),
and never when it holds something the owner typed. The property-address effect records its
fills the same way, so the two effects agree.

### 13.2 Changing service destroyed the notes you had written

```ts
if (!isEdit && t.default_description) setValue('notes', t.default_description)   // unconditional
```

Write the scope of work, then change the service — the template's canned description replaces
it. Worse for AI-written scope: `aiScopePrior` (the Undo state) knows nothing about this write,
so the Undo button restores what was there *before the assistant ran*, not what the template
just ate. A minute of typing, or twenty seconds of streaming, gone to a dropdown change.

**Fixed** the same way: template descriptions still swap when you move between templates (that
text is ours to replace), typed notes now survive.

### 13.3 A quote made of line items was never autosaved

`isEmpty` — the predicate deciding whether a draft is worth keeping — checked customer, name,
address, service and price, and **ignored `services` entirely**. So a quote whose content *is*
its lines ("Mulch, 6 yd, $55 · Delivery, 1 each, $40") looked blank to the autosave and was
never drafted. The quote that takes the most typing to rebuild was the one kind that got no
protection. **Fixed:** any line with a name or a price makes the draft real.

## §14 · Preventing the mistake the product can't undo ✅

A quote with **no price saves happily**, and afterwards looks identical to a priced one — in the
list, on the PDF, in the portal. The mistake surfaces when the customer reads it. The builder
now says so before the tap, next to the total, in the shared breakdown (desktop card *and*
mobile sheet):

> ⚠ No price yet — saving now creates a $0 quote. You can price it later.

**It warns and does not block.** A placeholder quote you intend to price later is legitimate;
blocking it would be the product deciding it knows better — the same never-block posture the
price guardrails already take.

## §15 · The third first-run dead end ✅

*"Set your base address in Settings first."* — the error you get when you tap **Calculate
distance** on a fresh account. It names a page and leaves you to find it. Distance, travel tiers
and route density all hang off that one field, so a new business hits this on quote one. Now it
links. That is the last of the three dead ends (rate, service catalogue, base address).

## §16 · Two smaller correctness fixes ✅

- **`role="switch"` with no state.** `show_travel_separately` has no entry in `defaultValues`,
  so on a new quote the PDF toggle rendered `aria-checked={undefined}` — a switch that announces
  no state at all. Coerced at the render site rather than adding a default, so **what gets
  written to the database is byte-identical**.
- **An effect that re-ran on every render.** `travelSuggestion` was rebuilt inline, so a fresh
  object was a fresh dependency for the effect that writes `custom_travel_required` — meaning a
  `setValue` on every render of a form that re-renders on every keystroke. Memoised on
  `(distanceKm, tiers)`: same function, same arguments, same result, no longer a new object.

## §17 · Found, deliberately not changed

**The crew cost has two defaults.** [priceGuardrails' input in the builder](src/components/quotes/QuoteBuilder.tsx)
hand-rolls `settings?.crew_cost_per_hour > 0 ? … : 40`, while
[lib/economics](src/lib/economics.ts) exports `DEFAULT_CREW_COST = 40` and `crewCostPerHour()`
doing the same guard — which is what `QuoteMeasure` uses. They agree **today**, by coincidence
of both being 40; the literal is a copy that will not follow the constant if it ever moves, and
[[engineering-principles]] is explicit that one responsibility gets one engine. Swapping the
literal for the shared call is output-identical for every value the column can hold — but it is
still a line feeding a pricing guardrail, and this pass was told not to touch pricing. Flagged
for whoever opens the Pricing V2 lane.

Also still open from §12: **the customer picker discards the name you typed** when you choose
"+ Enter manually", so a new customer's name gets typed twice. Still the biggest single
click-saver left in the flow; `ui/CustomerPicker.tsx` remains another session's active work, so
this pass stayed out of it again.

---
---

# Round 4 — the draft a failed save deleted, and the map of what's left

## §18 · The autosave draft was destroyed by a save that didn't happen ✅ fixed

The draft is the owner's **only copy** until the row exists. It was cleared the moment
`onSubmit` *returned*:

```ts
async v => { await onSubmit(v); autosave.clear() }
```

Both pages catch their own Supabase error, toast it, and **return normally**. So a save that
failed — RLS, a network drop, a constraint, an expired session — cleared the draft anyway. The
owner reads *"Could not save quote: …"*, refreshes or navigates, and a quote that took minutes
to build is gone from every copy that existed.

The codebase already had the right answer two functions further down the same file:

```ts
// Returns TRUE only when the PDF actually reached the device — the caller gates the
// "mark sent" write on it, so a failed render can never flip the quote to Sent.
async function handleOpenPdf(): Promise<boolean>
```

**Fixed** by applying that rule to saving: `onSubmit` may now resolve `false` for "did not
save", both pages return it on their error branch, and the builder clears the draft only when
the save actually happened. Returning nothing still means saved, so nothing else changes. The
error toasts now also say the draft is still there — because now it is.

*(Both pages previously had a silent hole too: `else if (error)` meant a response with neither
`data` nor `error` produced no toast and no state change — tap Update, nothing happens, no
message. Now anything that isn't a confirmed row is reported and returns `false`.)*

## §19 · Content hidden behind a closed accordion on the edit screen ✅ fixed

Opening a saved quote rendered *"Additional services · 2 lines · $180"* as a single collapsed
row. The money most likely to be wrong is the money you have to go looking for — and a quote
could be edited, re-saved and sent without its extra lines ever being on screen. **Sections
that already have content now start open**; a new quote has nothing to reveal and starts
closed exactly as before.

## §20 · The overwrite class is now fully mapped

Three rounds of hunting, and the picture is complete. Every automatic write into a field the
owner can edit:

| What writes it | Field | Status |
|---|---|---|
| Customer effect | `address` | ✅ fixed §13.1 — guarded by "we filled it" |
| Property effect | `address`, `measured_sqft` | ✅ already guarded (records its fills since §13.1) |
| Template effect | `notes` | ✅ fixed §13.2 |
| Template effect | `service_type` | ✔ correct — a different template *is* a different service |
| Suggestion effect | `initial_price` | ✔ correct — `priceLocked` since round 1 |
| Monthly toggle | `monthly_price` | ✅ fixed round 2 §10.3 |
| Draft restore | everything | ✅ fixed round 2 §10.1 |
| **Template effect** | **`rate`** | ⚠️ **open — pricing input** |
| **`calculateDistance`** | **`travel_fee`** | ⚠️ **open — pricing input** |

**The two that are left are both pricing inputs, and both are real:**

- **Picking a different hourly template replaces a per-quote rate override.** The field's own
  hint invites the override — *"Change it here for this quote only"* — and then a service
  change silently reverts it to the template's default.
- **Re-picking an address replaces a hand-entered travel fee.** `onSelect` calls
  `calculateDistance`, which re-applies the tier fee whenever travel is being charged. Set
  $25 by hand, fix a typo in the address, and you are back to the tier's $15 with no notice.

Both fixes are the same three-line guard used everywhere else in §13. **Neither was applied**,
because both change *when a pricing input is written* — which this pass was told not to touch,
and which [[pricing-experience-locked]] reserves for the Pricing V2 lane. They are listed here
as ready-to-implement, not as open questions.

## §21 · Also found, not changed

- **`includeTravel` starts `true` even on a quote that charges no travel.** Editing a quote
  the owner deliberately absorbed travel on shows the toggle reading *"Charging travel fee"*
  over a $0 fee — the label states the opposite of the quote's actual state. The one-line fix
  (`useState((defaultValues?.travel_fee ?? 0) > 0 || !isEdit)`) also changes whether a later
  **Calculate distance** re-applies a fee to that quote, so it is the same pricing-input call
  as §20 and belongs with it.
- The **crew-cost duplicate literal** (§17) is unchanged and still worth folding into
  `lib/economics` when the pricing lane opens.
- **`QuoteMeasure` was audited this round and needs nothing.** Closing is always explicit,
  a traced-but-unfinished measurement confirms before discarding, Escape routes through the
  same guard, and the in-progress trace is persisted per property and offered as *Resume*.
  It is the best-defended surface in the whole flow — the rest of the builder was measured
  against it.
