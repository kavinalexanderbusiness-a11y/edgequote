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

---
---

# Round 7 — multi-agent audit of current main (2026-07-28)

**Method:** six parallel dimension auditors (builder correctness · pages correctness · owner
speed · customer presentation · recurring/upsell · approvals/lifecycle) over the merged code,
then two adversarial lenses per actionable finding. 37 raw findings; 13 verdicts landed;
**zero refuted**. Seven verifier agents died on a session limit, so three findings below are
explicitly UNVERIFIED.

## §22 · Fixed this round (all verified, freeze-safe)

1. **P0 — Editing a quote with no first-visit price minted one.** `priceOrigin` seeded from
   `initial_price > 0` alone, so a weekly-only quote (initial_price null, hours/rate saved)
   opened unlocked; the reconciliation effect wrote `hours×crew×rate` into the field and
   Update persisted it — quotes.total changed, ADR-002 provenance re-stamped, from an edit
   that touched only the notes. Seed is now `'manual'` on every edit; "Use suggested" still
   re-enables the engine with one tap, and the empty-manual hint says what's going on.
2. **P0 — Edit path swallowed identity-resolution failure.** The catch recovered a display
   name and FELL THROUGH: a failed resolve during a customer/address change wrote
   `customer_id: null` (or the old customer's property under a new customer's id), returned
   true, toasted nothing — the orphan class the create path already fails closed on, with four
   documented live rows. Now: toast + `return false` (draft kept), and a customer *change*
   never falls back to the old quote's property on a soft-fail.
3. **P1 — `quote_services` delete+reinsert checked neither error.** A failed delete doubled
   every line (PDF and invoice conversion bill twice); a failed insert vanished the breakdown
   while `setServices([])` made the screen agree; both returned true. Both steps now check,
   toast honestly, and return false so the draft powers a retry.
4. **P1 — Stale `defaultPropertyId` re-asserted the original property.** The property effect
   re-runs on every customer change but kept querying the URL's property and stomping the new
   customer's address (its async write always landed after the customer effect's sync one).
   The prop now only speaks while the ORIGINAL customer is selected, and the address write
   obeys the `autoFilledAddress` contract. Same contract extended to `measured_sqft`
   (`autoFilledSqft`): customer A's 5,000 ft² no longer prices customer B's plan tiles, and a
   fill nothing backs is cleared.
5. **P1 — Draft restore never re-derived `includeTravel`.** Restoring an absorbed-travel
   draft over a charging server record left the toggle ON, and the next Calculate distance
   re-applied the tier fee. onRestore now re-runs the mount seed's exact formula on the draft.
6. **P1 — Typed plan prices kept the engine's provenance.** Only `initial_price` demoted the
   origin on typing, so hand-editing a weekly price left "✓ Applied" in the header and let one
   Monthly-pill cycle overwrite a typed monthly. All four price fields now demote to manual;
   the pill clears on off and fills only an EMPTY field on on.

## §23 · Confirmed but NOT fixed — the standing trap holds

**Every edit wipes the stored `overgrowth_multiplier` to 1** (create stores the real value;
the edit form deliberately seeds 1 — the documented trap — and Update writes that 1 back).
Both verifiers confirmed the column corruption is real, and consumers exist (the detail
page's Overgrowth chip). Not fixed here: any change to what edit writes into a stored
pricing input belongs to the Pricing V2 lane with the base-rate schema fix; until then the
chip can lie after an edit. This upgrades the trap note from "display quirk" to "known data
corruption on edit" for the V2 hand-off.

## §24 · UNVERIFIED (verifier agents lost) — check before acting

- Autosave baseline is captured before the auto-fill effects run → prefilled builders mint a
  phantom "unsaved quote" draft.
- Create insert prefers the measurement handoff's stale `suggested_price` over the builder's
  live value.
- `measurement.propertyId` unconditionally overrides the resolved property on create.

## §25 · Found, unverified, worth the next round (customer-facing money/promise)

- PDF "Valid Until" computes `issued_date + 30` and ignores `quotes.valid_until`.
- `show_travel_separately` is ignored by every customer-facing surface — the PDF always
  itemizes travel.
- Portal Approve has no expiry check at click time (stale tab accepts a lapsed quote).
- Bulk Duplicate copies the quote row but not its `quote_services` (single-quote Duplicate
  preserves them).
- Scheduling an accepted recurring quote creates a single one-time visit; surfaces say done.
- Editing an ACCEPTED quote warns nobody, and `accepted_price` is read nowhere.

---
---

# Round 8 — the customer-facing four, and additional-services visibility (2026-07-28)

## §26 · The four queued items from §25, now verified and fixed

1. **PDF "Valid Until" now uses `quotes.valid_until`.** It computed `issued_date + 30`
   unconditionally, so an EXTENDED quote's re-rendered PDF still printed the original lapse
   date — the paper contradicted the portal about when the price stops standing. `issued + 30`
   survives only as the fallback for a PDF rendered before first send stamps the real date
   (the same 30-day default `markSentPatch` writes).
2. **`show_travel_separately` is honoured end-to-end.** The PDF itemized travel whenever a fee
   existed, ignoring the builder toggle whose label literally promises *"Travel rolled into
   total on PDF"*. Rolled-in travel now folds into the first-visit line's displayed amount
   (rows still sum to the grand total, which never changed); the travel row and travel
   subtotal render only when the owner opted to show them. Surfaces audited: builder toggle →
   owner detail (already honoured, verbally) → PDF (fixed) → invoice conversion (already
   honoured — separate line only when flagged). **The portal cannot honour it:** the frozen
   `get_portal_data` RPC does not return the column, so the portal always itemizes travel.
   Documented as the one inconsistency, waiting on the RPC lane; amounts are correct either way.
3. **The portal can no longer approve an expired quote from a stale tab.** The render path
   labels expiry via the shared engine, but `accept()` called the RPC regardless — a tab left
   open past midnight on the lapse date still showed yesterday's button. The handler now
   re-runs `displayQuoteStatus` against TODAY at click time (valid_until in the loaded payload
   is still the truth — expiry is the date passing, not the data changing), refuses with a
   plain message, and re-derives the view. No RPC touched.
4. **Duplicate is now a faithful copy on both paths.** Bulk Duplicate copied only the quotes
   row — the copy's total was right but its `quote_services` were gone (multi-service PDFs
   collapsed to one number, materials lost their kind) and the six section measurements were
   dropped. It now fetches all selected quotes' lines in one query and copies them with
   `kind`, plus the section fields — the same field set as single-quote Duplicate. Both paths
   now also CHECK the line-copy insert and say so when it fails, instead of leaving a
   plausible-looking copy with silently missing lines. Verified duplicated field-by-field:
   customer/property links, service + template, all four prices, provenance (ADR-002:
   verbatim, never re-stamped), overgrowth, both travel flags + fee + distance, notes,
   hours/crew/rate, measurement + sections + confidence, every line with qty/unit/price/
   discount/notes/kind. (Quotes have no attachments; photos live on jobs.)

## §27 · Additional services — visibility from the fast path

A parallel session (PR #67) landed the row-level fix this round planned: qty labels that
follow the unit, unit-granular steps, and a live `qty × unit − discount = total` equation
under each line. Kept theirs; added the piece still missing: **the fast path now says when
the first-visit price isn't the whole first visit.** With extra lines present, a note under
the Price field reads *"Plus $X in additional services & materials below — first visit total
$Y"* and tapping it opens the section holding the money. Also: the quote detail page heading
reads **"Services & materials"** when materials exist (mulch no longer files under labour),
material rows are tagged on the detail page, and the PDF labels material lines `(materials)`
and prints real units in the qty column (`6 yd³ × $55`, not `6 × $55`).

## §28 · Still open after this round

- Portal travel breakout (waits on the frozen RPC gaining `show_travel_separately`).
- §24's unverified trio, unchanged.
- From §25: scheduling an accepted recurring quote creates a one-time visit; editing an
  ACCEPTED quote warns nobody. Both are lifecycle/product decisions, not presentation fixes.

---
---

# Round 9 — launch-readiness pass: the deal the customer already made (2026-07-28)

Walked the full owner loop (create → edit → duplicate → send → schedule → invoice) on current
main. The builder itself is in good shape after eight rounds and two parallel PRs — the
remaining friction was all downstream, in what happens AFTER a customer says yes. Root cause,
found while fixing: **the acceptance snapshot columns (`accepted_price`, `selected_cadence`,
RUN-2026-07-16c/d) were written by the portal and `markWonPatch` but never added to the TS
`Quote` type** — so for twelve days no owner surface *could* read what the customer agreed to.

## §29 · Fixed this round

1. **Typed the snapshot.** `accepted_price` and `selected_cadence` joined the `Quote`
   interface (read-only app-side; the RPC and `markWonPatch` remain the only writers).
2. **Editing an approved quote now says so.** Edit was offered on accepted/scheduled/
   completed/paid quotes with no acknowledgement a deal existed. The edit screen now opens
   with a warning banner naming the approved amount — warn, never block: post-acceptance
   corrections are legitimate, but they must be made knowing the customer hasn't agreed to
   the new number.
3. **Scheduling tells the truth about recurrence.** `scheduleQuoteAsJob` books ONE visit,
   deliberately — but "Job added to today's schedule" read as *done* for a quote whose
   customer approved a weekly plan, and the plan never became a repeating schedule. Both
   callers (quote page + notification bell) now say: *"First visit added — the weekly plan
   isn't a repeating schedule yet; open the job to set its recurrence."* Copy only; the
   engine is unchanged.
4. **The plan list names the customer's choice.** The detail page listed Weekly/Bi-Weekly/
   Monthly as three equal rows on quotes where `selected_cadence` already recorded which one
   the customer picked. A "Customer's choice" chip now marks it.

## §30 · State of the surface

The New Quote fast path, additional-services flow, breakdowns, PDF, duplication and portal
gating have all been audited to a standstill across nine rounds. What remains is catalogued,
not unknown: the §24 unverified trio, the portal travel breakout (RPC lane), the `quote:new`
autosave key strategy, and the Pricing-V2-gated items (§20, §23). Nothing in the create-to-
invoice loop still silently loses, invents, or misrepresents a number the owner or customer
decided.

---
---

# Round 10 — the parallel restoration lands (2026-07-28, second session)

Two sessions independently re-verified this document against merged main on the same day
and restored disjoint halves of the 07-26 rebase regression. Round 8/9 above restored the
BLANK seeds, the travel-fee wipe gates, unit-labelled line pricing, the PDF's promises and
faithful duplicates. This round carried the other half, plus the fixes the earlier rounds
had left open:

## §30 · Restored here (rounds 1–3 content lost in the same replay)

§2.3 Service-Name collapse ("Customer reads X · Rename") · §2.4 measured-area demoted to a
link on trades it doesn't price, Measure button promoted above it · §2.5 copy trims
(plan-options restatement gone; material chips retire once named) · §3.4 "Quote breakdown"
naming · §7 `aria-pressed` on plan tiles · §10.3 travel banner gated on charging · §11.1
service chips at ≤6 active templates · §11.2+§15 all three first-run dead-end links ·
§14 no-price warning in both breakdowns (skips recurring-only quotes — §22.1 made those a
deliberate state) · §16 `travelSuggestion` memoised. **§4.1 completed one level deeper:**
the blocked-submit router now opens the exact NESTED section (Labour/Plan/Travel) hiding
the offending field, not just the outer one. §3.1's flattening stays unrestored on purpose.

## §31 · New fixes this round

- **The status pill froze at mount** (`QuoteStatusControl` seeded state from its prop once,
  under the list's stable `key={q.id}`) — a portal accept never repainted it. It now adopts
  prop CHANGES via a ref: never mid-save, never from a pre-refetch parent re-render.
- **Bulk Convert now carries `line_items`** (breakdown + travel), built exactly as the
  single-quote Convert builds them — bulk-converted invoices no longer flatten a
  multi-service quote to one opaque amount. (Bulk Duplicate's line copy landed in §26;
  both bulk actions now share one batched line fetch.)
- **Create no longer prefers the measurement handoff's stale values**: the builder's live
  `suggested_price` wins when present, and the handoff's `propertyId` applies only while
  the quote still targets the measured address — re-targeting mid-build used to save the
  new customer's quote against the old property row.

Still open, unchanged: §24's phantom-draft baseline, the portal travel breakout (frozen
RPC), portal Approve's stale-tab expiry check, and everything Pricing-V2-gated (§20, §23).
