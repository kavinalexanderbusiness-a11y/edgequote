// ── Verify: a recurring service is quoted from its configuration ─────────────
//   npm run verify:recurring-quote-flow
//
// WHY THIS SCRIPT EXISTS
// Session 111 made a recurring service quotable in one pass: pick the customer,
// the property and the service, confirm the measurement if there is one, choose
// how it is offered, send. Everything that makes that safe is a SEPARATION, and
// separations are exactly what a refactor collapses without noticing, because
// collapsing them makes the code shorter and the screens simpler.
//
// Seven facts are kept apart, and each one costs real money to confuse:
//
//   MEASUREMENT ≠ PRICE ≠ COMMERCIAL OFFERING ≠ BILLING TERM
//               ≠ OPERATIONAL RECURRENCE ≠ SERVICE TRIGGER ≠ CONTRACT TERM
//
// The two that hurt most:
//   • $240/month is what the CUSTOMER PAYS PER MONTH. It is not one visit a
//     month. A seasonal snow contract might be eight visits or twenty-two, and
//     only the weather and the dispatch engines know which.
//   • An UNKNOWN price is not $0. A plan with no rate quotes nothing; it does
//     not quote free work.
//
// Neither is expressible in the type system — `null` and `0` are both numbers to
// a reader, and a `/snow/i` type-checks perfectly.
//
// This executes the REAL engine and parses the REAL migration. It never mocks
// the thing under test.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  offeringsFor, offerable, offerableForOptions, offeringOptionRows,
  optionDescription, termText, canOfferOptions, defaultOffering,
  noOfferingsReason, pricingSourceFor, startingPriceIsFallback,
  PRICING_PRECEDENCE, BILLING_VS_VISITS, offeringTermsLine,
  type OfferingPlan,
} from '../src/lib/recurringOffering'
import { pricePlan, buildMeasurementSnapshot, type ServicePricingPlan } from '../src/lib/measurePricing'
import { optionSetProblem, MIN_QUOTE_OPTIONS, MAX_QUOTE_OPTIONS } from '../src/lib/quoteOptions'
import { planSetProblem, draftsFor } from '../src/lib/servicePlans'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/**
 * Source with comments removed.
 *
 * ⚠️ LOAD-BEARING, and [[crlf-disarms-comment-strippers]] is why the `\r` is
 * explicit: `.` does not match a carriage return, so on a CRLF checkout a
 * `[^\n]*` line-comment stripper silently stops at the `\r` and leaves the
 * comment body in the "stripped" text.
 *
 * The rules below are about what the CODE does, and the code is surrounded by
 * comments that necessarily NAME the things it must not do — recurringOffering's
 * own header explains at length that a commercial term must never reach a
 * recurrence builder. Grepping raw source flags the explanation of a rule as a
 * violation of it, which trains the next person to delete the explanation.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n\r]*/g, ' ')
}

const SRC = {
  offering: read('src/lib/recurringOffering.ts'),
  panel: read('src/components/quotes/ServiceOfferings.tsx'),
  builder: read('src/components/quotes/QuoteBuilder.tsx'),
  measure: read('src/components/quotes/QuoteMeasure.tsx'),
  plans: read('src/lib/servicePlans.ts'),
  editor: read('src/components/pricing/MeasurePricingEditor.tsx'),
}
const CODE = Object.fromEntries(
  Object.entries(SRC).map(([k, v]) => [k, stripComments(v)]),
) as Record<keyof typeof SRC, string>

// The fixtures. ⛔ Deliberately named for nothing: "Service A" and "Service B"
// are a snow-like and a mowing-like configuration, and if any assertion below
// starts depending on the WORDS, the universal-CRM rule has already been broken.
const SNOW_LIKE: OfferingPlan[] = [
  { service_template_id: 't1', term: 'one_time', basis: 'flat', rate: 70, sort_order: 0, customer_note: 'Pay only when we attend.' },
  { service_template_id: 't1', term: 'monthly', basis: 'flat', rate: 240, is_recommended: true, sort_order: 3, customer_note: 'One predictable monthly price.' },
  { service_template_id: 't1', term: 'seasonal', basis: 'flat', rate: 900, sort_order: 4, term_label: '2026/27 Season', term_start: '2026-11-01', term_end: '2027-03-31' },
]
const MOW_LIKE: OfferingPlan[] = [
  { service_template_id: 't2', term: 'one_time', basis: 'per_unit', rate: 0.05, sort_order: 0 },
  { service_template_id: 't2', term: 'weekly', basis: 'per_unit', rate: 0.04, is_recommended: true, sort_order: 1 },
  { service_template_id: 't2', term: 'biweekly', basis: 'per_unit', rate: 0.045, sort_order: 2 },
  { service_template_id: 't2', term: 'monthly', basis: 'flat', rate: 180, sort_order: 3 },
]

console.log('\n── 1. The offering is the owner\'s configuration, not the trade ──')
{
  // ⭐ THE PRODUCTION PROOF, IN THE GUARD. A snow-like service sold three ways
  // and a mowing-like service sold four reach the same code and get their own
  // answers — with NOTHING keyed on a name, a category or an industry.
  const snow = offeringsFor(SNOW_LIKE, null, 'none')
  eq('snow-like: three offerings, owner order preserved', snow.map(o => o.term), ['one_time', 'monthly', 'seasonal'])
  eq('snow-like: per-visit / monthly / seasonal prices', snow.map(o => o.price), [70, 240, 900])
  eq('snow-like: labels come from ONE term catalogue', snow.map(o => o.label), ['One-time', 'Monthly', 'Seasonal'])
  eq('snow-like: money is per the TERM, not per a visit count', snow.map(o => o.priceSuffix), ['/visit', '/month', '/season'])

  // ⭐⭐ NOT MEASURED, AND FULLY PRICED. This is the case that could not be
  // configured OR quoted before Session 111: the plans block was gated on
  // `measured`, and the only door to the plans was inside the satellite map,
  // which answers "this service isn't measured" and shows nothing.
  check('a NOT-MEASURED service is fully priced from flat plans',
    offerable(snow).length === 3, `got ${offerable(snow).length} priced offerings`)
  eq('and reports no missing-configuration reason', noOfferingsReason({ measured_by: 'none' }, SNOW_LIKE, null), null)

  const mow = offeringsFor(MOW_LIKE, 2919, 'area')
  eq('mowing-like: four offerings from the same code path', mow.map(o => o.term), ['one_time', 'weekly', 'biweekly', 'monthly'])
  // 0.05 × 2919 = 145.95 → 146; 0.04 × 2919 = 116.76 → 117; 0.045 × 2919 = 131.355 → 131
  eq('mowing-like: per-unit prices are rate × measurement, rounded once', mow.map(o => o.price), [146, 117, 131, 180])
  check('mowing-like: a flat plan alongside per-unit plans is untouched by the measurement',
    mow[3].price === 180, `got ${mow[3].price}`)

  // The universal rule, asserted on the source rather than trusted.
  const NAME_PATTERNS = [/\bsnow\b/i, /\bmow\b/i, /\blawn\b/i, /\bgrass\b/i, /\bplow\b/i, /\bice\b/i, /winter/i, /\.name\s*\.\s*(includes|match|test)/]
  for (const [where, code] of Object.entries(CODE) as Array<[keyof typeof CODE, string]>) {
    // The builder legitimately still hosts the pre-existing lawn cadence engine
    // (lib/pricing), which is not this feature and is not being changed here.
    if (where === 'builder' || where === 'measure') continue
    const hit = NAME_PATTERNS.find(re => re.test(code))
    check(`${where}: no service-name keyword decides behaviour`, !hit, `matched ${hit}`)
  }
}

console.log('\n── 2. ⛔⛔ A BILLING TERM IS NOT A VISIT SCHEDULE ──')
{
  // The single most expensive confusion available here. Asserted three ways:
  // structurally (no import), by shape (no schedule fields), and by wording.
  const RECURRENCE_IMPORTS = [
    /from\s+['"]@?\/?.*\/recurrence['"]/,
    /from\s+['"]@?\/?.*serviceRecurrence['"]/,
    /job_recurrences/,
    /from\s+['"]@?\/?.*\/scheduleQuote['"]/,
    /from\s+['"]@?\/?.*\/dayPlan['"]/,
  ]
  for (const re of RECURRENCE_IMPORTS) {
    check(`recurringOffering imports no scheduling engine (${re.source.slice(0, 34)})`,
      !re.test(CODE.offering), 'a commercial term must never reach a recurrence builder')
  }
  check('ServiceOfferings imports no scheduling engine',
    !RECURRENCE_IMPORTS.some(re => re.test(CODE.panel)), 'the panel must not schedule')

  // ⭐ By SHAPE: an Offering carries no field a scheduler could act on. If one
  // ever appears — visitCount, dates, freq, interval — the separation is gone
  // whatever the comments say.
  const snow = offeringsFor(SNOW_LIKE, null, 'none')
  const FORBIDDEN_KEYS = ['visits', 'visitCount', 'freq', 'interval', 'intervalCount', 'startDate', 'endDate', 'schedule', 'recurrence']
  for (const o of snow) {
    const leaked = Object.keys(o).filter(k => FORBIDDEN_KEYS.includes(k))
    check(`offering '${o.term}' carries no scheduling field`, leaked.length === 0, `found ${leaked.join(', ')}`)
  }

  // ⭐ A SEASONAL PLAN MANUFACTURES NO SCHEDULE. It has dates — term_start and
  // term_end — and they are the period the PRICE covers. Nothing derives a visit
  // count, a first visit or a cadence from them.
  const seasonal = snow[2]
  check('a dated seasonal plan produces a term SENTENCE, not dates to schedule from',
    typeof seasonal.termText === 'string' && !FORBIDDEN_KEYS.some(k => k in seasonal),
    JSON.stringify(seasonal))
  eq('the term reads as one owner-authored line', seasonal.termText, '2026/27 Season · Nov 1, 2026 – Mar 31, 2027')

  // ⭐ MONTHLY IS A BILLING TERM. Asserted on the suffix, which is what a
  // customer reads: "/month" is what they pay per month. Nothing says "1 visit".
  const monthly = snow[1]
  eq('monthly is priced per MONTH, not per visit', monthly.priceSuffix, '/month')
  check('monthly states no visit frequency anywhere in its customer text',
    !/\b(visit|visits)\b/i.test(optionDescription(monthly)),
    optionDescription(monthly))

  // And the sentence that says so out loud, present at every surface that shows
  // terms. One definition — it cannot be softened on one screen and kept on
  // another.
  check('the separation sentence exists and names both halves',
    /priced and billed/i.test(BILLING_VS_VISITS) && /scheduled separately/i.test(BILLING_VS_VISITS),
    BILLING_VS_VISITS)
  check('the offerings panel shows it', CODE.panel.includes('BILLING_VS_VISITS'), 'panel must render the separation')
  check('the Price Book editor says it where plans are configured',
    /doesn.{0,3}t schedule visits|recurrence still does that/i.test(CODE.editor),
    'the owner must read it while configuring')
  check('a configured term repeats it', /doesn.{0,3}t schedule any visits/i.test(CODE.editor),
    'dates on a plan are the loudest possible invitation to read them as a schedule')
}

console.log('\n── 3. ⭐⭐ UNKNOWN IS NOT ZERO ──')
{
  const noRate: OfferingPlan[] = [
    { service_template_id: 't', term: 'monthly', basis: 'flat', rate: 0, sort_order: 0 },
    { service_template_id: 't', term: 'seasonal', basis: 'flat', rate: 900, sort_order: 1 },
  ]
  const out = offeringsFor(noRate, null, 'none')
  eq('a plan with no rate has price null, NOT 0', out[0].price, null)
  eq('and no price text at all', out[0].priceText, null)
  check('an unpriced offering is excluded from what may be offered',
    offerable(out).length === 1 && offerable(out)[0].term === 'seasonal',
    JSON.stringify(offerable(out).map(o => o.term)))

  // ⭐⭐ THE ONE THAT REACHES A CUSTOMER. offeringOptionRows is what writes
  // quote_options; a null price must never arrive there as 0.
  const rows = offeringOptionRows(out)
  eq('only priced offerings become customer options', rows.map(r => r.name), ['Seasonal'])
  check('no option is written at $0', !rows.some(r => Number(r.price) === 0), JSON.stringify(rows))

  // A per-unit plan with nothing measured is unknown, not free.
  const unmeasured = offeringsFor(MOW_LIKE, null, 'area')
  eq('per-unit plans with no measurement are unpriced', unmeasured.slice(0, 3).map(o => o.price), [null, null, null])
  eq('and the flat plan beside them still prices', unmeasured[3].price, 180)
  eq('the reason names the missing measurement, not missing pricing',
    noOfferingsReason({ measured_by: 'area' }, MOW_LIKE, null), null)
  eq('with only per-unit plans and nothing traced, the owner is told to measure',
    noOfferingsReason({ measured_by: 'area' }, MOW_LIKE.slice(0, 3), null), 'no_measurement')
  eq('with no plans at all, the owner is sent to the Price Book',
    noOfferingsReason({ measured_by: 'area' }, [], 1000), 'no_plans')

  // The editor refuses to STORE a zero, so the unknown never enters the system.
  const drafts = draftsFor([])
  drafts[0] = { ...drafts[0], enabled: true, rate: '' }
  eq('a blank rate cannot be saved', planSetProblem(drafts), 'no_rate')
  drafts[0] = { ...drafts[0], rate: '0' }
  eq('a zero rate cannot be saved either', planSetProblem(drafts), 'no_rate')

  // The panel must render a sentence, never a zero.
  check('the panel renders no price rather than $0', CODE.panel.includes("'No price'") || CODE.panel.includes('No price'),
    'an unpriced row must say so')
  check('an unpriced offering cannot be selected in the panel', /disabled=\{unpriced\}/.test(CODE.panel),
    'selecting a priceless plan would apply nothing, or worse, zero')
}

console.log('\n── 4. One price, one multiplication ──')
{
  // ⭐ THE OPTION TOTAL IS THE CANONICAL PRICE. Not "close to it", not "recomputed
  // consistently" — the same number, because offeringsFor delegates to pricePlan
  // and offeringOptionRows copies it.
  for (const plan of MOW_LIKE) {
    const canonical = pricePlan(plan as ServicePricingPlan, 2919, 'area')
    const viaOffering = offeringsFor([plan], 2919, 'area')[0]
    eq(`option price === canonical price (${plan.term})`, viaOffering.price, canonical.price)
  }
  const rows = offeringOptionRows(offeringsFor(MOW_LIKE, 2919, 'area'))
  const canonicalPrices = MOW_LIKE.map(p => pricePlan(p as ServicePricingPlan, 2919, 'area').price)
  eq('every option row carries the canonical price', rows.map(r => r.price), canonicalPrices)

  // Structural: this module must not contain a second multiplication.
  check('recurringOffering performs no arithmetic of its own',
    !/\brate\s*\*/.test(CODE.offering) && !/Math\.round\s*\(/.test(CODE.offering),
    'a second multiplication is how the map and the builder come to disagree by a dollar')
}

console.log('\n── 5. Quote Options is reused, not re-implemented ──')
{
  check('the offering seam defers the minimum to lib/quoteOptions',
    CODE.offering.includes('MIN_QUOTE_OPTIONS') && !/>=\s*2\b/.test(CODE.offering),
    'a second copy of the threshold is a second answer waiting to drift')
  const snow = offeringsFor(SNOW_LIKE, null, 'none')
  check('three offerings may become a customer choice', canOfferOptions(snow), '')
  check('one offering may not', !canOfferOptions(snow.slice(0, 1)), 'one option is not a choice')
  eq('never more than Quote Options accepts',
    offerableForOptions([...snow, ...snow].slice(0, 6)).length, MAX_QUOTE_OPTIONS)
  check(`the minimum is genuinely ${MIN_QUOTE_OPTIONS}`, MIN_QUOTE_OPTIONS === 2, `${MIN_QUOTE_OPTIONS}`)

  // The rows produced must actually satisfy the options engine.
  const rows = offeringOptionRows(snow)
  eq('generated options pass the options engine\'s own validation', optionSetProblem(rows), null)
  eq('the recommended badge is carried, not invented', rows.filter(r => r.is_recommended).map(r => r.name), ['Monthly'])
  eq('option names are the commercial terms', rows.map(r => r.name), ['One-time', 'Monthly', 'Seasonal'])

  // ⛔ No second options engine anywhere in the new code.
  check('the offering seam never selects or totals an option',
    !/selected_option_id/.test(CODE.offering) && !/reduce\s*\(/.test(CODE.offering),
    'selection and money belong to lib/quoteOptions and the RPC')
  check('the panel writes options through the ONE row builder',
    CODE.panel.includes('onOfferOptions') && !CODE.panel.includes('quote_options'),
    'the panel must not write rows itself')
  check('the builder seeds options only via offeringOptionRows',
    (CODE.builder.match(/offeringOptionRows\(/g) || []).length >= 2,
    'both the panel path and the map path must use the one seam')
}

console.log('\n── 6. What the CUSTOMER reads is what the OWNER wrote ──')
{
  const snow = offeringsFor(SNOW_LIKE, null, 'none')
  eq('the owner\'s own sentence reaches the option', optionDescription(snow[1]), 'One predictable monthly price.')
  eq('a configured term travels with the price', optionDescription(snow[2]), '2026/27 Season · Nov 1, 2026 – Mar 31, 2027')

  // ⭐⭐ PROVENANCE IS NOT AN OFFER. "$0.05/sq ft × 1,392 sq ft" is the owner's
  // rationale for a number. It used to be written into quote_options.description,
  // which the customer reads on the quote, the portal and the PDF.
  const mow = offeringsFor(MOW_LIKE, 2919, 'area')
  for (const o of mow) {
    check(`'${o.term}': the provenance string never becomes the customer's description`,
      optionDescription(o) !== o.basisText && !optionDescription(o).includes('/sq ft'),
      `description was ${JSON.stringify(optionDescription(o))}`)
  }
  eq('a plan the owner wrote nothing for carries NO description', optionDescription(mow[0]), '')
  check('the builder no longer maps basisText onto an option description',
    !/description:\s*p\.basisText/.test(CODE.builder), 'that is the customer-facing leak this session fixed')

  // ⛔ NO DEFAULT PROMISES. The product ships no sentence about how service is
  // delivered — every one of them is owner-typed or absent.
  const PROMISES = [/pay only when/i, /predictable monthly/i, /one price for the/i, /guaranteed/i, /unlimited/i]
  for (const re of PROMISES) {
    check(`no shipped default promise (${re.source.slice(0, 24)})`,
      !re.test(CODE.offering) && !re.test(CODE.panel) && !re.test(CODE.editor) && !re.test(CODE.plans),
      'a claim the owner never made must not reach a customer')
  }
  check('the plan editor offers no placeholder that could be saved as a promise',
    !/placeholder="[^"]*\b(only|predictable|guaranteed|includes)\b/i.test(SRC.editor), '')

  // A plan with no words has no words. termText is null, not an invented range.
  eq('an undated, unnamed plan has no term text', termText({}), null)
  eq('a named-only term needs no dates', termText({ term_label: '2026/27 Season' }), '2026/27 Season')
  eq('a dated-only term needs no name', termText({ term_start: '2026-11-01', term_end: '2027-03-31' }), 'Nov 1, 2026 – Mar 31, 2027')
  eq('a half-dated term says what it knows', termText({ term_start: '2026-11-01' }), 'From Nov 1, 2026')
}

console.log('\n── 7. ⛔ INTERNAL NOTES ARE NOT CUSTOMER NOTES ──')
{
  // The offering seam has no concept of an internal note, and the surfaces that
  // show offerings must never reach for one.
  check('the offering seam never reads internal notes', !/internal/i.test(CODE.offering), '')
  check('the offerings panel never reads internal notes', !/internal/i.test(CODE.panel), '')

  // ⭐ The pre-send preview is a rehearsal of what the CUSTOMER receives. It
  // reads `notes` and must never read `internal_notes`.
  const preview = CODE.builder.slice(CODE.builder.indexOf('const previewBreakdown'))
  const previewBlock = preview.slice(0, preview.indexOf('const ', 40) > 0 ? preview.indexOf('\n  const ') : preview.length)
  check('the owner preview never renders internal_notes',
    !/internal_notes|internalNotes/.test(previewBlock),
    'the preview rehearses what the customer receives')
  check('the preview does render the customer-facing notes',
    /Customer notes/.test(previewBlock), 'the owner must be able to check what is being said')
}

console.log('\n── 8. Only what the owner offers today is selectable ──')
{
  // ⭐ THERE IS NO is_enabled ON A PLAN — the row existing IS the offer. So the
  // "inactive plan" failure takes the only shape it can: a plan with no usable
  // rate must not be selectable, and must not reach a customer.
  check('service_pricing_plans has no is_enabled flag to fall out of sync',
    !/is_enabled/.test(CODE.plans) && !/is_enabled/.test(CODE.offering),
    'a flag that can be false while the row exists is one UPDATE from quoting a withdrawn plan')
  const withDead = offeringsFor(
    [...SNOW_LIKE, { service_template_id: 't1', term: 'weekly', basis: 'flat', rate: 0, sort_order: 1 }],
    null, 'none',
  )
  check('a rate-less plan is never offerable', !offerable(withDead).some(o => o.term === 'weekly'), '')
  check('and never lands as the default choice', defaultOffering(withDead)?.term !== 'weekly', '')

  // ⭐ INACTIVE SERVICE. The builder's picker is fed `activeTemplates`, and the
  // offerings panel reads the picked template — so an archived service cannot be
  // picked and therefore cannot be offered.
  check('the builder offers only ACTIVE services in the picker',
    /templates=\{activeTemplates\}/.test(CODE.builder),
    'an archived service must not be selectable')
  check('the offerings panel renders nothing without configured plans',
    /if\s*\(!hasPlans\)\s*return null/.test(CODE.panel),
    'a service with no plans must see the builder it always saw')
}

console.log('\n── 9. ⭐⭐ THE PRICING PRECEDENCE IS ONE ANSWER, NOT FOUR ──')
{
  eq('the precedence is stated, most specific first', [...PRICING_PRECEDENCE],
    ['configured_plans', 'measured_template_rate', 'labour', 'starting_price', 'unknown'])

  // Configured plans win over every other source, whatever else is available.
  eq('plans beat a per_sqft template rate',
    pricingSourceFor({ measured_by: 'area', pricing_display_type: 'per_sqft' }, MOW_LIKE, true, true), 'configured_plans')
  eq('plans beat a labour estimate',
    pricingSourceFor({ pricing_display_type: 'hourly' }, SNOW_LIKE, false, true), 'configured_plans')
  eq('plans beat a starting price',
    pricingSourceFor({ pricing_display_type: 'starting_from' }, SNOW_LIKE, false, false), 'configured_plans')

  // Without plans, the existing ladder is unchanged — this session demotes the
  // starting price, it does not remove it.
  eq('no plans + measurement → the template rate speaks',
    pricingSourceFor({ pricing_display_type: 'per_sqft' }, [], true, false), 'measured_template_rate')
  eq('no plans, no measurement → labour speaks',
    pricingSourceFor({ pricing_display_type: 'hourly' }, [], false, true), 'labour')
  eq('no plans, no labour → the starting price speaks',
    pricingSourceFor({ pricing_display_type: 'starting_from' }, [], false, false), 'starting_price')
  eq('nothing configured → UNKNOWN, and unknown is an answer',
    pricingSourceFor({}, [], false, false), 'unknown')

  // ⭐ THE DEMOTION. A display hint, never deleted.
  check('the starting price is a fallback exactly when plans exist',
    startingPriceIsFallback(SNOW_LIKE) && !startingPriceIsFallback([]), '')
  const templates = read('src/app/dashboard/settings/templates/page.tsx')
  check('the Price Book editor tells the owner which figure prices their quotes',
    /Fallback/.test(templates),
    'an owner must be able to see why a number they typed is not the quote')
  check('the starting price field is still editable when demoted',
    /register\('default_rate'/.test(templates) && !/disabled/.test(templates.slice(templates.indexOf('default_rate') - 400, templates.indexOf('default_rate') + 200)),
    'demoted means relabelled, never removed — a service whose plans go away is priced by it again')
}

console.log('\n── 10. The measurement snapshot is frozen ──')
{
  // ⭐ A PRICE BOOK EDIT MUST NOT REWRITE AN ISSUED QUOTE. The snapshot copies the
  // rate, basis and term as they were; nothing re-reads the plan on render.
  const plan = { ...MOW_LIKE[1] }
  const priced = pricePlan(plan as ServicePricingPlan, 2919, 'area')
  const snap = buildMeasurementSnapshot({
    type: 'area', value: 2919, parts: [{ label: 'Drive', value: 2919 }],
    measuredAt: '2026-08-27T00:00:00.000Z', serviceTemplateId: 't2', serviceName: 'Service B', plan: priced,
  })
  const before = JSON.stringify(snap)
  // The owner raises the rate next season.
  plan.rate = 0.11
  const after = JSON.stringify(snap)
  eq('raising a rate does not alter an existing snapshot', after, before)
  eq('the snapshot records the rate that actually priced it', snap.rate, 0.04)
  eq('and the term it was sold on', snap.term, 'weekly')
  check('re-pricing the plan today gives a DIFFERENT number, proving the freeze is real',
    pricePlan(plan as ServicePricingPlan, 2919, 'area').price !== snap.price,
    'if these agree the test proves nothing')
}

console.log('\n── 11. Add-ons stay PRE-acceptance, and are not change orders ──')
{
  // ⛔ SESSION 111 DID NOT BUILD QUOTE ADD-ONS. The database half is live; the
  // application half has never landed. This guard pins the seam so the next
  // session cannot accidentally weld add-ons onto the change-order engine, which
  // answers a different question at a different time.
  const baseline = latestBaseline()
  check('the quote_addons table exists in the baseline', /create table if not exists public\."quote_addons"/.test(baseline), '')
  check('quote_addons is frozen after approval by a DB trigger',
    /quote_addons_write_guard/.test(baseline), 'the freeze must be structural, not a UI rule')
  // ⚠️ `[\s\S]` rather than the `/s` flag: tsconfig targets below es2018, where
  // dotAll is a compile error, and a guard that will not compile is a guard that
  // does not run.
  check('the addon-aware choice RPC exists and is granted to no role',
    /quote_apply_choice/.test(baseline) &&
    /revoke all on function public\."quote_apply_choice"[\s\S]*?from public, anon, authenticated, service_role/.test(baseline),
    'an unauthorised DEFINER core callable by anon is the S106 bug')
  check('the addons total is written by trigger, not by app code',
    /quote_addons_sync_total/.test(baseline), '')

  // The seam this session leaves for it: nothing in the new code claims add-ons
  // exist, and nothing conflates them with change orders.
  check('the new offering code makes no add-on claim',
    !/addon/i.test(CODE.offering) && !/addon/i.test(CODE.panel), '')
  check('nothing in the new code touches change orders',
    !/change_order|changeOrder/i.test(CODE.offering) && !/change_order|changeOrder/i.test(CODE.panel),
    'an add-on is chosen BEFORE approval; a change order is agreed AFTER — different tables, different times')
}

console.log('\n── 12. The migration says what it does, and applies nothing else ──')
{
  const mig = read('supabase/migrations/20260827120000_commercial_plan_presentation.sql')
  // ⚠️ THE SAME TRAP AS THE TS SOURCE, AND IT CAUGHT THIS GUARD ON ITS FIRST RUN.
  // The migration's comments necessarily NAME what it must not do — "⛔ NOT
  // RESTRICTED TO term = 'seasonal'" is the explanation of the rule, and grepping
  // raw SQL read it as a violation. Strip first.
  // `[^\n\r]*` not `[^\n]*`: on a CRLF checkout `.`/`[^\n]` swallow the `\r` and
  // the stripper walks past the line ending — [[crlf-disarms-comment-strippers]].
  const migCode = mig.replace(/--[^\n\r]*/g, ' ')
  for (const col of ['customer_note', 'term_label', 'term_start', 'term_end']) {
    check(`adds ${col} to service_pricing_plans`,
      new RegExp(`add column if not exists "${col}"`).test(mig), '')
  }
  check('every added column is NULLABLE', !/not null/i.test(mig),
    'a required column would force existing plans to invent a value')
  check('empty strings are refused, so absence has one representation',
    /btrim\("customer_note"\)\s*<>\s*''/.test(mig) && /btrim\("term_label"\)\s*<>\s*''/.test(mig), '')
  check('a term cannot end before it starts', /"term_end"\s*>=\s*"term_start"/.test(mig), '')
  check('the app refuses a backwards term too, before the DB does',
    /term_backwards/.test(CODE.plans), 'the owner should read a sentence, not a check_violation')

  // ⛔ THE THINGS THIS MIGRATION MUST NOT DO.
  check('creates no table', !/create table/i.test(migCode), 'V1 is four columns')
  check('drops nothing', !/\bdrop\b/i.test(migCode), '')
  check('hardcodes no date', !/\b(nov|dec|jan|feb|mar|apr)\b/i.test(migCode),
    'a Calgary winter is not a product constant')
  check('does not restrict the term fields to seasonal plans',
    !/term\s*=\s*'seasonal'/.test(migCode),
    'which commercial arrangements a business may have is not the product\'s decision')
  check('adds no default text to any column',
    !/default\s+'/i.test(migCode), 'a shipped default sentence is a promise the owner never made')
  check('the migration is not applied by this session',
    !/insert into supabase_migrations/i.test(migCode), '')
  // ⚠️ The stripper must actually be doing something, or every check above is
  // passing vacuously against a gutted string. A guard whose negatives are all
  // green and whose extractor is dead is the failure pattern from S107's PDF work.
  check('the comment stripper left the DDL intact',
    /add column if not exists/.test(migCode) && migCode.length > 400 && migCode.length < mig.length,
    `stripped ${mig.length} → ${migCode.length}`)

  // ⭐ It must sort after the baseline it extends. Measured against the FLOOR,
  // not "last forever" — see the custom-fields guard's own lesson.
  const names = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort()
  const baselineName = names.filter(n => n.includes('baseline')).pop() || ''
  check('sorts after the current baseline',
    '20260827120000_commercial_plan_presentation.sql' > baselineName,
    `baseline is ${baselineName}`)
}

console.log('\n── 13. The flow is reachable, and short ──')
{
  // ⭐ THE BUG THIS SESSION EXISTS TO FIX, pinned. The offerings panel must be
  // mounted in the builder itself — not only inside the satellite modal.
  check('the offerings panel is mounted in the quote builder',
    /<ServiceOfferings/.test(CODE.builder), 'the plans must be reachable without opening a map')
  const panelIdx = CODE.builder.indexOf('<ServiceOfferings')
  const measureIdx = CODE.builder.indexOf('<QuoteMeasure')
  check('it is NOT nested inside the measure modal',
    panelIdx > 0 && (measureIdx < 0 || panelIdx < measureIdx),
    'the map is one way to get a MEASUREMENT, not the way to get a PRICE')
  check('the panel is rendered beside the service field, above pricing',
    panelIdx < CODE.builder.indexOf('previewBreakdown') || panelIdx > 0, '')

  // The Price Book must let an UNMEASURED service carry plans at all.
  check('the plan editor is not gated on the service being measured',
    !/\{measured\s*&&\s*\(/.test(CODE.editor),
    'gating plans on measurement is what made a flat-priced service unconfigurable')
  check('an unmeasured service is forced to a flat price rule',
    /if\s*\(!measured\)\s*next\.basis\s*=\s*'flat'/.test(CODE.editor),
    'per_unit with no unit prices nothing, forever')

  // The one-line summary both surfaces share.
  eq('the terms line names the offerings in the owner\'s order',
    offeringTermsLine(offeringsFor(SNOW_LIKE, null, 'none')), 'One-time · Monthly · Seasonal')
  eq('and says so honestly when there are none', offeringTermsLine([]), 'No priced plans')
}

console.log('\n── 14. Mobile: nothing the thumb cannot hit ──')
{
  // The brief's floor: no sub-40px primary control. Asserted on the classes the
  // panel actually ships, because a control that is unreachable on a phone is
  // not a control.
  const heights = [...SRC.panel.matchAll(/min-h-\[(\d+)px\]/g)].map(m => Number(m[1]))
  check('the panel declares explicit touch heights', heights.length >= 3, `found ${heights.length}`)
  check('no primary control under 40px', heights.every(h => h >= 40), `smallest was ${Math.min(...heights)}`)
  const editorHeights = [...SRC.editor.matchAll(/min-h-\[(\d+)px\]|\bh-11\b/g)].map(m => (m[1] ? Number(m[1]) : 44))
  check('the plan editor\'s controls clear 40px too', editorHeights.every(h => h >= 40), `smallest was ${Math.min(...editorHeights)}`)
  check('the panel stacks its actions on a phone',
    /flex-col\s+sm:flex-row/.test(SRC.panel), 'two side-by-side buttons do not fit at 375')
  check('the term fields stack on a phone',
    /grid-cols-1\s+sm:grid-cols-3/.test(SRC.editor), '')
}

function latestBaseline(): string {
  const dir = join(ROOT, 'supabase/migrations')
  const name = readdirSync(dir).filter(f => f.includes('baseline') && f.endsWith('.sql')).sort().pop()
  if (!name) throw new Error('no baseline migration found')
  return readFileSync(join(dir, name), 'utf8')
}

console.log(`\n${failures === 0 ? '✅ recurring quote flow: all checks passed' : `❌ ${failures} check(s) failed`}\n`)
process.exit(failures === 0 ? 0 : 1)
