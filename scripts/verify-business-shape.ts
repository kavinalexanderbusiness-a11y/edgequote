/* eslint-disable no-console */
// Verification of the business-shape derivation — what a business DOES, inferred
// from rows it already has. Imports the real production functions; nothing is
// reimplemented here.
//
// WHY THIS IS A SIBLING OF verify-automations.ts RATHER THAN A SECTION IN IT
// Three reasons, in order of weight:
//  1. That harness's headline is "PASS 244 / FAIL 0", and that number is the
//     acceptance signal for the automation engine's promotion story. Folding
//     unrelated checks into it moves the number for reasons that have nothing to
//     do with automations, and the next person to read "PASS 251" can't tell
//     whether the engine's coverage changed.
//  2. It opens "End-to-end verification of the two automatic chasers' DECISION
//     logic." Business shape is a UI gate. A red `verify:automations` caused by a
//     lawn field would send the reader to the wrong engine.
//  3. Its section 26 walks the cron engine's import closure and pins it EXACTLY.
//     That check is rooted at the engine's route, not at the harness file, so
//     adding imports here would not actually break it today — but keeping this
//     file's imports out of that file keeps it that way by construction.
//
// It is wired into package.json AND .github/workflows/ci.yml in the same commit.
// This repo has already shipped a harness with 234 checks wired to nothing; a
// guard rail nobody runs is not a guard rail, and a sibling script is only the
// right call if it actually runs.
import { deriveBusinessShape, showLawnFieldFor, SHAPE_LOADING, type ShapeEvidence } from '@/lib/businessShape'
import { computePropertyHealth, type PropertyHealth, type PropertyHealthInput } from '@/lib/propertyHealth'

let pass = 0, fail = 0
const fails: string[] = []
function check(group: string, name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(`${group} › ${name}`); console.log(`  ❌ ${name}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`) }
}
const H = (s: string) => console.log(`\n═══ ${s} ═══`)

// Evidence builders — named for the BUSINESS, so a failure reads as a sentence.
const ev = (e: Partial<ShapeEvidence>): ShapeEvidence =>
  ({ serviceTemplates: [], jobServiceTypes: [], ...e })

const tpl = (...names: string[]) => names.map(name => ({ name, category: null }))

// ── THE FROZEN "BEFORE", for the property-health acceptance test ─────────────
// A verbatim copy of computePropertyHealth as it stood at f6c3dee, before the
// shape gate existed. It is a duplicate on purpose, and it is the one duplicate
// in this story that is correct: the acceptance bar is "a lawn business's card is
// IDENTICAL to before", and the only way to prove identical-to-before is to keep
// a before to compare against. Nothing imports it and nothing ships it.
//
// It must NEVER be edited to agree with the engine. The moment it's "fixed" to
// make a red check green it stops being evidence and becomes a mirror. If it
// disagrees, the engine regressed — that is the whole point.
//
// (Contrast lib/businessShape, where a second copy of the service-name matcher
// would be a live bug: that copy would RUN in production. This one only judges.)
type V0Input = Omit<PropertyHealthInput, 'shape'>
type V0Result = Omit<PropertyHealth, 'lawnApplies'>
function computePropertyHealthV0(i: V0Input): V0Result {
  let score = 0
  if (i.measured) score += i.measurementStale ? 12 : 24
  score += i.pricingConfidence === 'high' ? 14 : i.pricingConfidence === 'medium' ? 9 : i.pricingConfidence === 'low' ? 4 : 0
  score += i.completedVisits >= 5 ? 24 : i.completedVisits >= 1 ? 15 : 0
  if (i.hasActiveRecurring) score += i.recurringNothingScheduled ? 9 : 22
  else if (i.hasWonQuote) score += 9
  score += i.hasUpcoming ? 12 : 0
  if (i.hasVision) score += 4
  if (i.hasActiveRecurring && i.daysSinceLastService != null && i.daysSinceLastService > 45) score -= 12
  score = Math.max(0, Math.min(100, Math.round(score)))

  let recommendation: string | null
  let action: PropertyHealth['action']
  let actionLabel: string
  const fallbackAction: PropertyHealth['action'] = i.measured ? 'remeasure' : 'measure'
  const fallbackLabel = i.measured ? 'Re-measure' : 'Measure'

  if (!i.measured) {
    recommendation = 'Measure this property to unlock pricing.'; action = 'measure'; actionLabel = 'Measure'
  } else if (i.hasActiveRecurring && i.recurringNothingScheduled) {
    recommendation = 'Recurring plan has no upcoming visit — book the next one.'; action = 'schedule'; actionLabel = 'Schedule'
  } else if (i.hasActiveRecurring && i.daysSinceLastService != null && i.daysSinceLastService > 45) {
    recommendation = `Not serviced in ${i.daysSinceLastService} days — rebook this customer.`; action = 'schedule'; actionLabel = 'Schedule'
  } else if (i.hasWonQuote && !i.hasUpcoming && !i.hasActiveRecurring) {
    recommendation = 'Quote accepted — schedule the first visit.'; action = 'schedule'; actionLabel = 'Schedule'
  } else if (!i.hasWonQuote && i.quotedCount === 0 && i.hasCustomer) {
    recommendation = 'Measured and ready — send a quote.'; action = 'quote'; actionLabel = 'Create quote'
  } else if (i.measurementStale) {
    recommendation = 'Measurement is over a year old — recalculate pricing.'; action = 'recalc'; actionLabel = 'Recalculate'
  } else if (i.pricingConfidence === 'low') {
    recommendation = 'Low pricing confidence — re-measure or build nearby route density.'; action = 'remeasure'; actionLabel = 'Re-measure'
  } else if (i.pricingDriftPct != null && Math.abs(i.pricingDriftPct) >= 15) {
    recommendation = `Pricing has drifted ${i.pricingDriftPct > 0 ? '+' : ''}${i.pricingDriftPct}% vs the last price — review it.`; action = 'quote'; actionLabel = 'Re-quote'
  } else if (!i.hasUpcoming && i.completedVisits > 0 && !i.hasActiveRecurring) {
    recommendation = 'No upcoming visit — rebook or offer a recurring plan.'; action = 'schedule'; actionLabel = 'Schedule'
  } else {
    recommendation = null; action = fallbackAction; actionLabel = fallbackLabel
  }
  if (!i.hasCustomer && (action === 'quote' || action === 'schedule')) {
    action = fallbackAction; actionLabel = fallbackLabel
  }
  let label: string, tone: PropertyHealth['tone']
  if (i.completedVisits === 0 && i.quotedCount === 0 && !i.hasWonQuote) { label = 'New'; tone = 'new' }
  else if (score >= 80) { label = 'Healthy'; tone = 'good' }
  else if (score >= 58) { label = 'Good'; tone = 'ok' }
  else if (score >= 35) { label = 'Needs attention'; tone = 'warn' }
  else { label = 'At risk'; tone = 'warn' }
  return { score, label, tone, recommendation, action, actionLabel }
}

// A property with nothing done to it yet. Overrides read as a sentence.
const prop = (o: Partial<V0Input> = {}): V0Input => ({
  hasCustomer: true, measured: false, measurementStale: false, located: true,
  pricingConfidence: null, completedVisits: 0, hasActiveRecurring: false,
  recurringNothingScheduled: false, daysSinceLastService: null, hasUpcoming: false,
  hasWonQuote: false, quotedCount: 0, pricingDriftPct: null, hasVision: false, ...o,
})

// Every value of every input the scorer reads. `located` gets one value because
// the engine never reads it (see the report) — sweeping a field nothing consumes
// would just double the runtime and prove nothing.
const AXES: { [K in keyof V0Input]: V0Input[K][] } = {
  hasCustomer: [true, false],
  measured: [true, false],
  measurementStale: [true, false],
  located: [true],
  pricingConfidence: ['high', 'medium', 'low', null],
  completedVisits: [0, 1, 5],
  hasActiveRecurring: [true, false],
  recurringNothingScheduled: [true, false],
  daysSinceLastService: [null, 10, 60],
  hasUpcoming: [true, false],
  hasWonQuote: [true, false],
  quotedCount: [0, 2],
  pricingDriftPct: [null, 5, 20],
  hasVision: [true, false],
}
// Odometer over AXES — every combination, exactly once.
function* everyProperty(): Generator<V0Input> {
  const keys = Object.keys(AXES) as (keyof V0Input)[]
  const at = keys.map(() => 0)
  for (;;) {
    const o = {} as Record<string, unknown>
    keys.forEach((k, n) => { o[k] = (AXES[k] as unknown[])[at[n]] })
    yield o as V0Input
    let p = keys.length - 1
    for (; p >= 0; p--) {
      at[p]++
      if (at[p] < (AXES[keys[p]] as unknown[]).length) break
      at[p] = 0
    }
    if (p < 0) return
  }
}

function run() {
  console.log('\n  BUSINESS SHAPE — inferred, never asked\n' + '═'.repeat(60))

  // ═══════════════════════════════════════════════════════════════════════════
  H('1. BACKWARDS COMPATIBILITY — the four acceptance cases')
  // These four are the whole contract. Everything else in this file exists to
  // stop one of them regressing by accident.

  // CASE 1 — a lawn business. Templates, jobs and measured properties all say
  // lawn. Must be indistinguishable from the app before businessShape existed.
  {
    const lawnCo = ev({
      serviceTemplates: tpl('Weekly Mowing', 'Spring Aeration', 'Fertilization'),
      jobServiceTypes: ['Lawn Mowing', 'Lawn Mowing', 'Fertilizing'],
    })
    check('case-1', 'a lawn business shows lawn fields', deriveBusinessShape(lawnCo).showLawnFields, true)
    check('case-1', '➜ and it has evidence (not defaulting — actually detected)', deriveBusinessShape(lawnCo).hasEvidence, true)
  }

  // CASE 2 — a brand-new account. No templates, no jobs, nothing to infer from.
  // MUST show everything: this is the core market on day one, and hiding the
  // measure tool from a new lawn signup is the single worst outcome here.
  {
    const brandNew = ev({})
    check('case-2', 'a brand-new empty account shows lawn fields', deriveBusinessShape(brandNew).showLawnFields, true)
    check('case-2', '➜ …because there is NO evidence, not because it found lawn', deriveBusinessShape(brandNew).hasEvidence, false)
  }

  // CASE 3 — a plumber. A real catalogue, real jobs, no lawn anywhere.
  {
    const plumber = ev({
      serviceTemplates: tpl('Drain cleaning', 'Water heater install', 'Leak repair'),
      jobServiceTypes: ['Drain cleaning', 'Water heater install'],
    })
    check('case-3', 'a plumber does NOT show lawn fields', deriveBusinessShape(plumber).showLawnFields, false)
    check('case-3', '➜ and that is a finding, not a default (hasEvidence)', deriveBusinessShape(plumber).hasEvidence, true)

    // CASE 4 — the same plumber, who happens to have one property measured at
    // 5,000 ft². The ACCOUNT is still not a lawn business…
    check('case-4', 'one measured property does not re-shape the whole account',
      deriveBusinessShape(plumber).showLawnFields, false)
    // …but THAT property still renders its lawn size. Hiding a number someone can
    // remember entering reads as data loss.
    const shape = deriveBusinessShape(plumber)
    check('case-4', '➜ the measured property still renders its 5,000 ft²', showLawnFieldFor(shape, 5000), true)
    check('case-4', '➜ …while his unmeasured properties stay clean', showLawnFieldFor(shape, null), false)
    check('case-4', '➜ …and 0 is not data (an empty field is not a measurement)', showLawnFieldFor(shape, 0), false)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  H('2. THE OVERRIDE NEVER FIGHTS THE FLAG')
  {
    const lawnShape = deriveBusinessShape(ev({ jobServiceTypes: ['Lawn Mowing'] }))
    // A lawn business sees the field whether or not this property is measured —
    // this is what makes case 1 "identical to today": the gate is a no-op for them.
    check('override', 'a lawn business sees the field on an unmeasured property', showLawnFieldFor(lawnShape, null), true)
    check('override', '➜ and on a zero one (today\'s behaviour, preserved)', showLawnFieldFor(lawnShape, 0), true)
    check('override', '➜ and on a measured one', showLawnFieldFor(lawnShape, 5000), true)
    check('override', 'the loading placeholder shows everything (no field blinks out mid-load)',
      [SHAPE_LOADING.showLawnFields, showLawnFieldFor(SHAPE_LOADING, null)], [true, true])
  }

  // ═══════════════════════════════════════════════════════════════════════════
  H('3. EVIDENCE SOURCES — each one alone is enough')
  // Every source is an independent net. Any ONE of them firing keeps a lawn
  // business whole, which is why a miss in one place is not a regression.
  {
    check('sources', 'a lawn TEMPLATE name alone is enough',
      deriveBusinessShape(ev({ serviceTemplates: tpl('Weekly Mowing'), jobServiceTypes: ['Consultation'] })).showLawnFields, true)
    check('sources', 'a lawn template CATEGORY alone is enough (name says nothing)',
      deriveBusinessShape(ev({ serviceTemplates: [{ name: 'Weekly Visit', category: 'Lawn Care' }] })).showLawnFields, true)
    check('sources', 'a lawn JOB alone is enough (catalogue never set up)',
      deriveBusinessShape(ev({ jobServiceTypes: ['Lawn Mowing'] })).showLawnFields, true)
    // JobForm defaults service_type to 'Lawn Mowing', so in practice essentially
    // every lawn account in existence trips this net on its first job.
    check('sources', "➜ JobForm's 'Lawn Mowing' default trips the job net on job #1",
      deriveBusinessShape(ev({ jobServiceTypes: ['Lawn Mowing'] })).showLawnFields, true)
    check('sources', 'one lawn job among many non-lawn ones is still evidence',
      deriveBusinessShape(ev({ jobServiceTypes: ['Service Call', 'Repair', 'Lawn Mowing', 'Repair'] })).showLawnFields, true)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  H('4. THE MATCHER IS BORROWED, NOT REBUILT (lib/seasons serviceCategory)')
  // f760a3a fixed 'ice' matching inside serv·ice, which classified "Lawn Service"
  // as SNOW and sent those customers dormant all summer. This module classifies
  // nothing itself; these cases prove it inherited the fix rather than re-typing
  // the bug. If someone writes a second matcher here, these are what go red.
  {
    check('matcher', '"Lawn Service" is lawn, not snow (the f760a3a bug)',
      deriveBusinessShape(ev({ jobServiceTypes: ['Lawn Service'] })).showLawnFields, true)
    check('matcher', '"Full Service Mowing" is lawn',
      deriveBusinessShape(ev({ serviceTemplates: tpl('Full Service Mowing') })).showLawnFields, true)
    check('matcher', '"Weekly Service" alone is NOT lawn evidence (year_round)',
      deriveBusinessShape(ev({ jobServiceTypes: ['Weekly Service'] })).showLawnFields, false)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  H('5. THE OTHER TRADES')
  {
    const trades: [string, string[]][] = [
      ['HVAC', ['Furnace tune-up', 'AC install', 'Duct cleaning']],
      ['cleaning', ['Deep clean', 'Move-out clean', 'Office cleaning']],
      ['electrical', ['Panel upgrade', 'Outlet install', 'Lighting retrofit']],
      ['pest control', ['Wasp nest removal', 'Rodent exclusion', 'Quarterly spray']],
      ['roofing', ['Shingle replacement', 'Roof inspection', 'Flashing repair']],
      ['painting', ['Interior repaint', 'Exterior repaint', 'Cabinet refinish']],
      ['junk removal', ['Garage cleanout', 'Furniture haul', 'Estate cleanout']],
      ['pool service', ['Pool opening', 'Weekly chemical check', 'Filter clean']],
      ['handyman', ['Drywall patch', 'Door adjustment', 'Shelf install']],
    ]
    for (const [trade, services] of trades) {
      check('trades', `a ${trade} business does not show lawn fields`,
        deriveBusinessShape(ev({ serviceTemplates: tpl(...services), jobServiceTypes: services })).showLawnFields, false)
    }
    // A snow-only operator measures driveways, not lawns. serviceCategory tests
    // snow BEFORE lawn, so this also pins that ordering staying intact.
    check('trades', 'a snow-only operator does not show lawn fields',
      deriveBusinessShape(ev({ serviceTemplates: tpl('Snow Removal', 'Ice Melt', 'Plowing') })).showLawnFields, false)
    // …but the moment they add mowing for the summer, the shape follows. No
    // stored type to go stale, no setting for anyone to remember to change.
    check('trades', '➜ the day they add mowing, lawn fields come back on their own',
      deriveBusinessShape(ev({ serviceTemplates: tpl('Snow Removal', 'Weekly Mowing') })).showLawnFields, true)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  H('6. ABSENCE OF EVIDENCE IS NOT EVIDENCE OF ABSENCE')
  // The clause the whole design rests on. Each of these is an account with
  // nothing to infer from, and each must look exactly like the app does today.
  {
    check('absence', 'no templates + no jobs → show (not hide)',
      deriveBusinessShape(ev({})).showLawnFields, true)
    check('absence', 'a catalogue of empty names is not a plumber',
      deriveBusinessShape(ev({ serviceTemplates: [{ name: '', category: '' }] })).showLawnFields, true)
    check('absence', 'null service_types are not evidence of anything',
      deriveBusinessShape(ev({ jobServiceTypes: [null, null] })).showLawnFields, true)
    // The distinction the flag exists to carry: same answer, opposite reasons.
    check('absence', 'hasEvidence separates "found no lawn" from "found nothing"',
      [deriveBusinessShape(ev({})).hasEvidence,
       deriveBusinessShape(ev({ serviceTemplates: tpl('Drain cleaning') })).hasEvidence], [false, true])
  }

  // ═══════════════════════════════════════════════════════════════════════════
  H('7. NO business_type DEPENDENCY — the property, not the promise')
  // The owner's hard constraint: nothing stored, nothing asked, no industry type.
  // A comment saying so is worth nothing; assert it against the real source.
  {
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const { resolve } = require('node:path') as typeof import('node:path')
    const SRC = readFileSync(resolve(process.cwd(), 'src/lib/businessShape.ts'), 'utf8')
    // Strip comments first — this module's own prose says "business_type" while
    // explaining that there isn't one. A check that can't tell code from
    // commentary fails on the sentence documenting the property it's proving.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/gm, '$1')

    check('no-type', 'the engine never reads a business_type column', /business_type/.test(code), false)
    check('no-type', 'it declares no industry type or enum', /type\s+BusinessType|enum\s+BusinessType/.test(code), false)
    // The subtler version of the same mistake: a flag named for an industry is an
    // industry type with extra steps. Flags must be named for what they GATE.
    //
    // What this must NOT catch is `serviceCategory(s) === 'lawn'`, which is the
    // whole point of the module — that reads the BORROWED matcher's category of a
    // service NAME. Comparing a string to a season category is not the same act as
    // comparing a BUSINESS to an industry, and the first draft of this check
    // couldn't tell them apart. So look for the shape/type being compared, not for
    // the word 'lawn'.
    check('no-type', "no business is compared to a trade (shape === 'lawn', businessType…)",
      /\bshape\s*===|\bBusinessShape\s*===|businessType|isLawnBusiness|isPlumber/.test(code), false)
    // NOTHING is written. This feature needs no migration; the day it writes a row
    // it has become the stored type it was built to avoid.
    check('no-type', 'it writes nothing — no insert/update/upsert/delete',
      /\.(insert|update|upsert|delete)\s*\(/.test(code), false)
    check('no-type', '➜ and it reads only the two evidence tables it documents',
      [...code.matchAll(/\.from\(\s*'([^']+)'\s*\)/g)].map(m => m[1]).sort(), ['jobs', 'service_templates'])
    // The matcher lives in ONE place. A hint list appearing here is the second
    // matcher the brief forbids — and the exact shape of the 'ice'/serv·ice bug,
    // which took a whole mowing season to notice. Both halves are asserted: no
    // hints of its own, AND it actually imports the real one.
    check('no-type', 'it re-lists no service-name hints of its own',
      /'mow'|'fertiliz'|'aerat'|'grass'|LAWN_HINTS|SNOW_HINTS/.test(code), false)
    check('no-type', '➜ because it imports serviceCategory from lib/seasons',
      /import\s*\{[^}]*\bserviceCategory\b[^}]*\}\s*from\s*'@\/lib\/seasons'/.test(code), true)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  H('8. PROPERTY HEALTH — the nag a plumber could never fix')
  // propertyHealth scored "no lawn measured" as −24 of 100, made "Measure this
  // property to unlock pricing." the recommendation, and left Measure as the
  // primary action on every card forever. For a plumber that is a permanent,
  // unfixable defect on every property he owns. These prove it's gone for him and
  // untouched for everyone else.
  {
    const LAWN = deriveBusinessShape(ev({ jobServiceTypes: ['Lawn Mowing'], serviceTemplates: tpl('Weekly Mowing') }))
    const PLUMBER = deriveBusinessShape(ev({ serviceTemplates: tpl('Drain cleaning', 'Water heater install'), jobServiceTypes: ['Leak repair'] }))
    const BRAND_NEW = deriveBusinessShape(ev({}))
    const strip = (h: PropertyHealth): V0Result => {
      const { lawnApplies: _drop, ...rest } = h   // eslint-disable-line @typescript-eslint/no-unused-vars
      return rest
    }

    // ── CASE 1 — THE ACCEPTANCE TEST ──
    // Not a sample of cases: EVERY combination of every input, replayed against
    // the frozen pre-change scorer. A lawn business must not be able to tell this
    // change happened, and "identical" is a claim worth proving exhaustively
    // rather than on the four inputs I happened to think of.
    let combos = 0
    const lawnDrift: string[] = []
    const newDrift: string[] = []
    for (const p of everyProperty()) {
      combos++
      const before = JSON.stringify(computePropertyHealthV0(p))
      if (JSON.stringify(strip(computePropertyHealth({ ...p, shape: LAWN }))) !== before && lawnDrift.length < 2) {
        lawnDrift.push(`${JSON.stringify(p)}\n         before ${before}\n         after  ${JSON.stringify(strip(computePropertyHealth({ ...p, shape: LAWN })))}`)
      }
      // CASE 5 — a brand-new account, swept the same way. No evidence either way
      // ⇒ show everything ⇒ byte-identical to the app before businessShape existed.
      if (JSON.stringify(strip(computePropertyHealth({ ...p, shape: BRAND_NEW }))) !== before && newDrift.length < 2) {
        newDrift.push(`${JSON.stringify(p)}\n         before ${before}\n         after  ${JSON.stringify(strip(computePropertyHealth({ ...p, shape: BRAND_NEW })))}`)
      }
    }
    check('case-1', `a lawn business is IDENTICAL on all ${combos.toLocaleString()} input combinations (score, label, tone, recommendation, action)`, lawnDrift, [])
    check('case-5', `a brand-new account is IDENTICAL on all ${combos.toLocaleString()} too — it shows everything`, newDrift, [])
    // The named case underneath the sweep: the exact nag, still firing.
    {
      const unmeasured = prop({ hasCustomer: true, quotedCount: 1 })
      const h = computePropertyHealth({ ...unmeasured, shape: LAWN })
      check('case-1', '➜ the lawn nag itself still fires, word for word',
        [h.recommendation, h.action, h.actionLabel], ['Measure this property to unlock pricing.', 'measure', 'Measure'])
      check('case-1', '➜ and unmeasured still costs a lawn business exactly 24 of 100',
        [computePropertyHealth({ ...unmeasured, measured: true, shape: LAWN }).score, h.score], [24, 0])
    }

    // ── CASE 2 — a plumber's unmeasured property is not penalised and not nagged ──
    {
      // A real, healthy plumbing customer: serviced 5×, on a plan, work booked.
      // No lawn — because he is a plumber, not because he forgot.
      const busy = prop({ hasCustomer: true, completedVisits: 5, hasActiveRecurring: true, daysSinceLastService: 7, hasUpcoming: true, hasWonQuote: true, quotedCount: 1 })
      const p = computePropertyHealth({ ...busy, shape: PLUMBER })
      check('case-2', 'plumber: an unmeasured property is never told to measure', p.recommendation, null)
      check('case-2', '➜ Measure is not the primary action (nothing pressing ⇒ view, not a nag)', [p.action, p.actionLabel], ['view', 'View customer'])
      check('case-2', '➜ and the card knows not to offer the quiet Re-measure link either', p.lawnApplies, false)
      // The penalty, gone: 58/100 "Good" was the ceiling for a property doing
      // everything right. Renormalised over what actually applies, it reads true.
      check('case-2', '➜ it scores 94 "Healthy", not 58 "Good" — the missing 42 was never his to earn',
        [p.score, p.label], [94, 'Healthy'])
      check('case-2', '➜ (that 58 is what today gives the identical property)', computePropertyHealthV0(busy).score, 58)
      // Same property, same day, at a lawn company: unchanged, still nagged.
      const l = computePropertyHealth({ ...busy, shape: LAWN })
      check('case-2', '➜ while the lawn business sees today\'s exact nag on the same property',
        [l.score, l.recommendation, l.action], [58, 'Measure this property to unlock pricing.', 'measure'])
    }

    // ── CASE 3 — no 76/100 cap. Perfect is 100 in every trade ──
    {
      const lawnPerfect = prop({ hasCustomer: true, measured: true, pricingConfidence: 'high', completedVisits: 5, hasActiveRecurring: true, daysSinceLastService: 7, hasUpcoming: true, hasWonQuote: true, quotedCount: 1, hasVision: true })
      // A plumber's perfect property is perfect WITHOUT the two lawn-derived terms
      // — not because they're unfilled, but because his app cannot produce them:
      // the only caller computes confidence as `saved ? … : null`, and `saved` is
      // the lawn measure tool's own snapshot.
      const plumberPerfect = prop({ hasCustomer: true, completedVisits: 5, hasActiveRecurring: true, daysSinceLastService: 7, hasUpcoming: true, hasWonQuote: true, quotedCount: 1, hasVision: true })
      check('case-3', 'a plumber\'s perfect property scores the SAME maximum as a lawn business\'s',
        [computePropertyHealth({ ...plumberPerfect, shape: PLUMBER }).score, computePropertyHealth({ ...lawnPerfect, shape: LAWN }).score], [100, 100])
      check('case-3', '➜ today that same perfect property caps at 62 (the defect, in one number)',
        computePropertyHealthV0(plumberPerfect).score, 62)
      // Why pricing had to ride with the measurement: gate only measurement and
      // 62/76 = 82 — a ceiling moved, not removed.
      check('case-3', '➜ neither is nagged at the top of a perfect card',
        [computePropertyHealth({ ...plumberPerfect, shape: PLUMBER }).recommendation, computePropertyHealth({ ...lawnPerfect, shape: LAWN }).recommendation], [null, null])
      // The `!= null` clause: pricing is gated on the LAWN chain, not deleted for
      // plumbers. A confidence from any future non-lawn source still scores.
      check('case-3', 'a pricing confidence from ANY source still counts for a plumber (the != null clause)',
        [computePropertyHealth({ ...plumberPerfect, pricingConfidence: 'high', shape: PLUMBER }).score,
         computePropertyHealth({ ...plumberPerfect, pricingConfidence: 'low', shape: PLUMBER }).score], [100, 87])
    }

    // ── CASE 4 — data on file always wins, whatever the trade ──
    {
      // The plumber who measured one customer's yard years ago. lawn_sqft > 0, so
      // the caller passes measured: true — that property is scored on it.
      const measuredProp = prop({ hasCustomer: true, measured: true, completedVisits: 5, hasActiveRecurring: true, daysSinceLastService: 7, hasUpcoming: true, hasWonQuote: true, quotedCount: 1, hasVision: true })
      const h = computePropertyHealth({ ...measuredProp, shape: PLUMBER })
      check('case-4', 'plumber: a property that HAS a lawn size still counts as measured', h.lawnApplies, true)
      check('case-4', '➜ scored on it, byte-identical to today (86 — no re-weighting, no penalty)',
        [h.score, computePropertyHealthV0(measuredProp).score], [86, 86])
      check('case-4', '➜ and Re-measure stays reachable on it', [h.action, h.actionLabel], ['remeasure', 'Re-measure'])
      // …while his OTHER properties are untouched by that one record.
      check('case-4', '➜ …without re-shaping his other properties', PLUMBER.showLawnFields, false)
      // A stale lawn measurement on a plumber's property still recalculates — the
      // per-record override reaches the recommendation, not just the score.
      const staleProp = prop({ hasCustomer: true, measured: true, measurementStale: true, completedVisits: 5, hasActiveRecurring: true, daysSinceLastService: 7, hasUpcoming: true, hasWonQuote: true, quotedCount: 1 })
      check('case-4', '➜ a stale measurement on his property still says recalculate',
        computePropertyHealth({ ...staleProp, shape: PLUMBER }).recommendation, computePropertyHealthV0(staleProp).recommendation)
    }

    // The loading placeholder must behave like the brand-new account it mirrors —
    // a Measure button that vanishes once the shape lands would be worse than one
    // that was never there.
    check('shape-loading', 'mid-load, the scorer behaves exactly as it does today',
      strip(computePropertyHealth({ ...prop({ hasCustomer: true }), shape: SHAPE_LOADING })),
      computePropertyHealthV0(prop({ hasCustomer: true })))
  }

  console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
  if (fails.length) { console.log('\n  FAILURES:'); fails.forEach(f => console.log('   • ' + f)) }
  process.exit(fail ? 1 : 0)
}
run()
