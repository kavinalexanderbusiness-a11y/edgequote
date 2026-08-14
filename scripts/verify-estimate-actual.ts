// ── Verify: the estimate-vs-actual primitive stays truthful ──────────────────
//   npm run verify:estimate-actual
//
// WHY THIS SCRIPT EXISTS
// Every failure mode of a "what did I think vs what happened" feature is a
// number that is arithmetically valid and quietly false. None of them is a type
// error, and all of them are flattering:
//
//   * a visit with no recorded time reading as a PERFECT estimate (0 difference)
//   * an empty or failed read reading as ZERO VARIANCE ("your estimates are
//     spot on") instead of "I don't know"
//   * a cancelled or re-opened visit teaching the model about work that never
//     finished — the capture trigger fires on any actual_minutes change and does
//     NOT check status, so this one is live, not theoretical
//   * one visit counted twice, inflating the sample size the UI presents as
//     evidence
//   * four spellings of "mowing" splitting 30 comparable visits into four
//     buckets that each clear nothing — or the opposite, unrelated services
//     merged into one average
//   * a mis-tapped stopwatch (production holds a real 1-minute visit against a
//     15-minute estimate) dragging a service average by −93%
//   * the mean of per-visit percentages presented as the business's overall
//     bias, which lets short visits outvote the hours actually lost
//
// Runs the REAL module against hand-derived fixtures. Deterministic, no network.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  readVisitLabor, rollupLaborVariance, laborVarianceByService, learnFromCompletedVisits,
  formatMinutes, formatVarianceMinutes, formatVariancePct, describeVariance,
  MIN_SERVICE_SAMPLE, MIN_PLAUSIBLE_MINUTES, MAX_PLAUSIBLE_MINUTES,
  serviceHistory, describeTypicalVariance,
  type VisitLike, type LaborComparison,
} from '../src/lib/estimateVsActual'
import { loadCompletedVisitLearning, HISTORY_LIMIT } from '../src/lib/estimateVsActualData'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

const visit = (o: Partial<VisitLike> & { id: string }): VisitLike =>
  ({ status: 'completed', service_type: 'Lawn Mowing', ...o })

// ── 1. THE OWNER'S OWN EXAMPLE ───────────────────────────────────────────────
// 8 planned hours became 11. The owner states this as "labour underestimated by
// 37.5%", which fixes the denominator as the ESTIMATE and the sign as positive
// for running long. Both are load-bearing for every sentence the UI writes.
console.log('\nThe worked example an owner would state by hand:')
{
  const r = readVisitLabor(visit({ id: 'a', duration_minutes: 480, actual_minutes: 660 }))
  const c = r.comparison!
  check('8h planned against 11h actual is comparable', c != null, 'got null')
  eq('…difference is +180 minutes', c.varianceMinutes, 180)
  eq('…and +37.5% — measured against the PLAN, not the outcome', c.variancePct, 37.5)
  check('…described as running longer', /longer than planned/.test(describeVariance(c)),
        describeVariance(c))
}

// ── 2. THE SIGN MEANS WHAT THE WORDS SAY ─────────────────────────────────────
// Production overestimates mowing badly (avg 42min planned, 25min actual), so
// the negative branch is the COMMON case here, not the corner.
console.log('\nFinishing early is a negative variance, and says so:')
{
  const c = readVisitLabor(visit({ id: 'b', duration_minutes: 60, actual_minutes: 45 })).comparison!
  eq('difference is −15 minutes', c.varianceMinutes, -15)
  eq('…and −25%', c.variancePct, -25)
  check('…described as finishing sooner', /sooner than planned/.test(describeVariance(c)),
        describeVariance(c))
  eq('…formatted with an explicit sign', formatVarianceMinutes(c.varianceMinutes), '−15m')
}

// ── 3. UNKNOWN IS NEVER ZERO ─────────────────────────────────────────────────
// The headline regression. A 0-minute difference and an absent one look almost
// identical on screen and mean opposite things.
console.log('\nA visit that cannot be compared yields nothing, not a zero:')
{
  const noActual = readVisitLabor(visit({ id: 'c', duration_minutes: 60, actual_minutes: null }))
  eq('no recorded time → no comparison', noActual.comparison, null)
  eq('…and the reason is stated', noActual.reason, 'no_actual')
  eq('…the estimate is still readable', noActual.estimatedMinutes, 60)
  eq('…the actual is null, NOT 0', noActual.actualMinutes, null)

  const noEst = readVisitLabor(visit({ id: 'd', duration_minutes: null, actual_minutes: 55 }))
  eq('no planned time → no comparison', noEst.comparison, null)
  eq('…and the reason is stated', noEst.reason, 'no_estimate')

  // A zero estimate is not an estimate — and it is the divide-by-zero too.
  const zeroEst = readVisitLabor(visit({ id: 'e', duration_minutes: 0, actual_minutes: 55 }))
  eq('a 0-minute plan is treated as no plan', zeroEst.reason, 'no_estimate')
  eq('…never Infinity', zeroEst.comparison, null)

  eq('and the formatter refuses to invent a number', formatVarianceMinutes(null), '—')
  eq('…for percentages too', formatVariancePct(null), '—')
  eq('…and for durations', formatMinutes(null), '—')
}

// ── 4. ONLY COMPLETED WORK TEACHES ANYTHING ──────────────────────────────────
// trg_capture_labor fires on any actual_minutes change without checking status,
// and re-opening a completed visit KEEPS its banked minutes — so a scheduled or
// cancelled visit really can arrive carrying both numbers.
console.log('\nUnfinished and cancelled work is excluded even when it carries both numbers:')
{
  for (const status of ['cancelled', 'scheduled', 'in_progress', 'pending']) {
    const r = readVisitLabor(visit({ id: `s-${status}`, status, duration_minutes: 60, actual_minutes: 90 }))
    eq(`a ${status} visit is not comparable`, r.comparison, null)
    eq(`…for the stated reason`, r.reason, 'not_completed')
  }
  const learning = learnFromCompletedVisits([
    visit({ id: 'done', duration_minutes: 60, actual_minutes: 90 }),
    visit({ id: 'gone', status: 'cancelled', duration_minutes: 60, actual_minutes: 600 }),
  ])
  eq('a cancelled visit cannot reach the rollup', learning.overall.sampleSize, 1)
  eq('…and cannot move the variance', learning.overall.variancePct, 50)
}

// ── 5. A MIS-TAPPED STOPWATCH IS NOT EVIDENCE — BUT A LONG DAY IS ────────────
// This bound cuts BOTH ways, and the second direction is the one that bites: a
// filter tight enough to catch every stray tap also throws away real long jobs.
// The first draft of this module reused lib/duration's 600-minute cap and
// silently excluded the 11-hour example above — a true reading, discarded as
// noise. Both directions are pinned here so neither can drift back.
console.log('\nImplausible readings are excluded — and real long days are not:')
{
  // The real production row: 1 minute recorded against a 15-minute plan.
  const misTap = readVisitLabor(visit({ id: 'f', service_type: 'General Landscaping', duration_minutes: 15, actual_minutes: 1 }))
  eq('a 1-minute visit is excluded', misTap.comparison, null)
  eq('…and named as a mis-tap, not as missing data', misTap.reason, 'implausible_actual')

  const forgotten = readVisitLabor(visit({ id: 'g', duration_minutes: 60, actual_minutes: 1200 }))
  eq('a timer left running overnight is excluded', forgotten.reason, 'implausible_actual')

  // The regression that started this section.
  eq('an 11-hour landscaping day is REAL data, not an outlier',
     readVisitLabor(visit({ id: 'g2', duration_minutes: 480, actual_minutes: 660 })).reason, null)
  check('…because the cap is past any single workable visit',
        MAX_PLAUSIBLE_MINUTES >= 960, `cap is ${MAX_PLAUSIBLE_MINUTES} minutes`)
  eq('…while the floor stays where lib/duration put it', MIN_PLAUSIBLE_MINUTES, 5)
  eq('…and the boundary itself is kept, not dropped',
     readVisitLabor(visit({ id: 'h', duration_minutes: 10, actual_minutes: 5 })).reason, null)
}

// ── 6. ONE VISIT, ONE VOTE ───────────────────────────────────────────────────
console.log('\nA visit that arrives twice is counted once:')
{
  const dup = visit({ id: 'same', duration_minutes: 60, actual_minutes: 120 })
  const learning = learnFromCompletedVisits([dup, { ...dup }, { ...dup }])
  eq('three copies of one visit are one sample', learning.overall.sampleSize, 1)
  eq('…and the variance is not tripled', learning.overall.variancePct, 100)
  eq('…coverage counts it once too', learning.coverage.completed, 1)
}

// ── 7. AN EMPTY OR FAILED READ IS NOT "ON TARGET" ────────────────────────────
console.log('\nNothing to measure reports nothing, never zero variance:')
{
  const empty = rollupLaborVariance([])
  eq('sample size is 0', empty.sampleSize, 0)
  eq('…variance % is null, NOT 0', empty.variancePct, null)
  eq('…median is null, NOT 0', empty.medianVariancePct, null)
  eq('…and it is not an established finding', empty.established, false)

  const none = learnFromCompletedVisits([])
  eq('an empty visit list learns nothing', none.overall.variancePct, null)
  eq('…and claims no coverage', none.coverage.comparablePctOfCompleted, null)
  eq('…rather than 100%', none.coverage.comparable, 0)
}

// ── 8. THE HEADLINE IS THE RATIO OF SUMS, NOT THE MEAN OF RATIOS ─────────────
// Averaging percentages lets a short visit outvote the hours actually lost.
// These two numbers are asserted in opposite directions so a future "simplify"
// that swaps one for the other breaks this file.
console.log('\nShort visits cannot outvote the hours actually lost:')
{
  const cs: LaborComparison[] = [
    visit({ id: 'p', duration_minutes: 15, actual_minutes: 30 }),   // +100%
    visit({ id: 'q', duration_minutes: 120, actual_minutes: 132 }), // +10%
    visit({ id: 'r', duration_minutes: 60, actual_minutes: 60 }),   // 0%
  ].map(v => readVisitLabor(v).comparison!)

  const roll = rollupLaborVariance(cs)
  eq('total planned', roll.totalEstimatedMinutes, 195)
  eq('total actual', roll.totalActualMinutes, 222)
  eq('27 minutes over 195 planned = +13.8%', roll.variancePct, 13.8)
  eq('…while the TYPICAL visit is +10%', roll.medianVariancePct, 10)
  check('the headline is not the mean of the percentages (36.7%)', roll.variancePct !== 36.7,
        `variancePct came back as ${roll.variancePct}`)
}

// ── 9. SERVICE IDENTITY IS CANONICAL, NEVER FUZZY ────────────────────────────
// The four spellings below are verbatim from production. Grouping on the raw
// string splits one real service into four buckets that clear no threshold.
console.log('\nFour spellings of one service are one bucket — and only because serviceKey says so:')
{
  const learning = learnFromCompletedVisits([
    visit({ id: 'm1', service_type: 'Lawn Mowing', duration_minutes: 40, actual_minutes: 25 }),
    visit({ id: 'm2', service_type: 'Weekly Mowing', duration_minutes: 40, actual_minutes: 25 }),
    visit({ id: 'm3', service_type: 'Bi-Weekly Mowing', duration_minutes: 40, actual_minutes: 25 }),
    visit({ id: 'm4', service_type: 'Lawn mowing', duration_minutes: 40, actual_minutes: 25 }),
    visit({ id: 'm5', service_type: 'Lawn Mowing', duration_minutes: 40, actual_minutes: 25 }),
  ])
  eq('one service bucket, not four', learning.byService.length, 1)
  eq('…holding all five visits', learning.byService[0].sampleSize, 5)
  eq('…under the canonical key', learning.byService[0].serviceKey, 'mowing')

  // The other direction matters just as much.
  const mixed = learnFromCompletedVisits([
    visit({ id: 'x1', service_type: 'Lawn Mowing', duration_minutes: 40, actual_minutes: 60 }),
    visit({ id: 'x2', service_type: 'Mulch delivery', duration_minutes: 40, actual_minutes: 60 }),
    visit({ id: 'x3', service_type: 'Gutter cleaning', duration_minutes: 40, actual_minutes: 60 }),
  ])
  eq('unrelated services never merge', mixed.byService.length, 3)
  check('…and each keeps its own label',
        new Set(mixed.byService.map(s => s.serviceKey)).size === 3,
        JSON.stringify(mixed.byService.map(s => s.serviceKey)))

  // The grouper is a public entry point in its own right (reporting and pricing
  // calibration will call it directly), so it is exercised directly too — not
  // only through learnFromCompletedVisits.
  const direct = laborVarianceByService(learning.comparisons)
  eq('called directly, it agrees with the whole-book path', direct.length, learning.byService.length)
  eq('…on the bucket', direct[0].serviceKey, learning.byService[0].serviceKey)
  eq('…and on the variance', direct[0].variancePct, learning.byService[0].variancePct)
}

// ── 10. A SAMPLE OF ONE IS NOT A FINDING ─────────────────────────────────────
console.log('\nSample size travels with every claim, and one visit establishes nothing:')
{
  const one = rollupLaborVariance([
    readVisitLabor(visit({ id: 'solo', duration_minutes: 60, actual_minutes: 120 })).comparison!,
  ])
  eq('one visit still produces its arithmetic', one.variancePct, 100)
  eq('…but is NOT established', one.established, false)
  eq('…and says how thin it is', one.sampleSize, 1)

  const atThreshold = rollupLaborVariance(
    Array.from({ length: MIN_SERVICE_SAMPLE }, (_, i) =>
      readVisitLabor(visit({ id: `t${i}`, duration_minutes: 60, actual_minutes: 66 })).comparison!))
  eq(`${MIN_SERVICE_SAMPLE} visits IS established`, atThreshold.established, true)
  eq('…one short is not', rollupLaborVariance(
    Array.from({ length: MIN_SERVICE_SAMPLE - 1 }, (_, i) =>
      readVisitLabor(visit({ id: `u${i}`, duration_minutes: 60, actual_minutes: 66 })).comparison!)).established, false)

  check('the threshold is high enough that one bad row cannot flip a sign',
        MIN_SERVICE_SAMPLE >= 5, `MIN_SERVICE_SAMPLE is ${MIN_SERVICE_SAMPLE}`)

  // Thin buckets are REPORTED, not dropped — dropping them would make the list
  // read as "these are your services".
  const thin = learnFromCompletedVisits([
    ...Array.from({ length: 6 }, (_, i) =>
      visit({ id: `mw${i}`, service_type: 'Lawn Mowing', duration_minutes: 40, actual_minutes: 30 })),
    visit({ id: 'one-off', service_type: 'Gutter cleaning', duration_minutes: 60, actual_minutes: 200 }),
  ])
  eq('the thin bucket is still listed', thin.byService.length, 2)
  const gutter = thin.byService.find(s => s.serviceKey === 'gutter')!
  eq('…with its real sample size', gutter.sampleSize, 1)
  eq('…flagged as not established', gutter.established, false)
  eq('…and established findings sort first', thin.byService[0].serviceKey, 'mowing')
}

// ── 11. COVERAGE IS THE DENOMINATOR, AND IT BALANCES ─────────────────────────
// Without this, a variance computed from 3 of 78 visits looks like the business.
console.log('\nCoverage travels with the answer and accounts for every visit:')
{
  const learning = learnFromCompletedVisits([
    visit({ id: 'c1', duration_minutes: 60, actual_minutes: 66 }),
    visit({ id: 'c2', duration_minutes: 60, actual_minutes: 66 }),
    visit({ id: 'c3', duration_minutes: 60, actual_minutes: null }),
    visit({ id: 'c4', duration_minutes: null, actual_minutes: 66 }),
    visit({ id: 'c5', duration_minutes: 60, actual_minutes: 2 }),
    visit({ id: 'c6', status: 'cancelled', duration_minutes: 60, actual_minutes: 66 }),
  ])
  const cov = learning.coverage
  eq('six visits considered', cov.visits, 6)
  eq('…five of them completed', cov.completed, 5)
  eq('…two comparable', cov.comparable, 2)
  eq('…which is 40% of completed', cov.comparablePctOfCompleted, 40)
  eq('…one missing an actual', cov.excluded.no_actual, 1)
  eq('…one missing an estimate', cov.excluded.no_estimate, 1)
  eq('…one implausible', cov.excluded.implausible_actual, 1)
  eq('…one not completed', cov.excluded.not_completed, 1)
  const accounted = cov.comparable + Object.values(cov.excluded).reduce((a, b) => a + b, 0)
  eq('every visit is accounted for', accounted, cov.visits)
}

// ── 12. THE MODULE NEVER PRODUCES MONEY ──────────────────────────────────────
// Production has ZERO time_entries and ZERO expenses, so actual labour cost and
// actual material cost do not exist. Any dollar figure here would be an estimate
// wearing a different unit — and would read as independent evidence of profit.
//
// Asserted BEHAVIOURALLY, over the real returned objects, rather than by
// grepping the source: this file's own header discusses cost at length, and a
// guard that greps its subject matter reports the cure as the disease.
console.log('\nNo money is produced anywhere — the data for it does not exist:')
{
  const learning = learnFromCompletedVisits([
    visit({ id: 'k1', duration_minutes: 60, actual_minutes: 90 }),
    visit({ id: 'k2', service_type: 'Mulch', duration_minutes: 30, actual_minutes: 20 }),
  ])
  const keys = new Set<string>()
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) { keys.add(k); walk(val) }
    }
  }
  walk(learning)
  const money = [...keys].filter(k => /cost|price|revenue|margin|amount|profit|dollar|rate/i.test(k))
  check('no money-shaped field is returned', money.length === 0, `found: ${money.join(', ')}`)
  check('…and something was actually inspected', keys.size > 15, `only ${keys.size} keys walked`)

  // Every leaf number must be a duration, a percentage, or a count — never cents.
  const vals: unknown[] = []
  const walkVals = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walkVals); return }
    if (v && typeof v === 'object') { Object.values(v).forEach(walkVals); return }
    vals.push(v)
  }
  walkVals(learning)
  check('no value is formatted as currency',
        !vals.some(v => typeof v === 'string' && /[$£€]/.test(v)),
        `found: ${vals.filter(v => typeof v === 'string' && /[$£€]/.test(v)).join(', ')}`)
}

// ── 13. THE PRIMITIVE STAYS PURE, SO TENANT SCOPING CANNOT BE ITS JOB ────────
// It learns from exactly the rows it is handed. That is only safe while it
// cannot fetch rows itself — an import of a supabase client here would let a
// future caller skip the RLS-scoped read without anyone noticing.
console.log('\nThe primitive cannot fetch its own data:')
{
  const src = readFileSync(join(process.cwd(), 'src/lib/estimateVsActual.ts'), 'utf8')
  const imports = src.split('\n').filter(l => /^\s*import\b/.test(l))
  check('it imports something (the scan is live)', imports.length > 0, 'no import lines found')
  check('…and nothing that can reach the database',
        !imports.some(l => /supabase|createClient|node:|fetch/i.test(l)),
        imports.join(' | '))
  check('…and nothing from React',
        !imports.some(l => /\breact\b/i.test(l)), imports.join(' | '))
  check('…only the canonical service normalizer',
        imports.every(l => /serviceKey/.test(l)), imports.join(' | '))
}

// ── 14. FORMATTERS ───────────────────────────────────────────────────────────
console.log('\nDurations read the way an owner says them:')
{
  eq('45 minutes', formatMinutes(45), '45m')
  eq('…an hour and three quarters', formatMinutes(105), '1h 45m')
  eq('…a round two hours', formatMinutes(120), '2h')
  eq('an exact estimate says so in words', formatVarianceMinutes(0), 'exact')
  eq('…and as a percentage', formatVariancePct(0), 'on target')
  eq('a positive variance keeps its plus', formatVarianceMinutes(21), '+21m')
  eq('…and so does the percentage', formatVariancePct(47), '+47%')
}

// ═══════════════════════════════════════════════════════════════════════════
// V2 — HISTORICAL LEARNING. Turning many finished visits into a tendency adds
// exactly one new way to lie: a claim that sounds like evidence but is drawn
// from a sample that cannot support it, or from rows that were never
// comparable. Each section below is a specific false sentence, blocked.
// ═══════════════════════════════════════════════════════════════════════════

// ── 15. THE TYPICAL MISS IS PAIRED ───────────────────────────────────────────
// The mutation this blocks is the tempting simplification
// `medianActual − medianEstimate`, which unpairs the plan from its own outcome.
// This fixture is built so the two answers DISAGREE and the wrong one is the
// flattering one: three visits that each ran on-or-over produce a median miss of
// +10m, while the difference of the medians is exactly 0 — "lands on plan".
console.log('\nThe typical miss is measured per visit, not by subtracting two medians:')
{
  const cs: LaborComparison[] = [
    { jobId: 'a', serviceKey: 'mowing', serviceLabel: 'Mowing', serviceDate: null, estimatedMinutes: 60,  actualMinutes: 60,  varianceMinutes: 0,  variancePct: 0,   crewSize: null, laborMinutes: null },
    { jobId: 'b', serviceKey: 'mowing', serviceLabel: 'Mowing', serviceDate: null, estimatedMinutes: 30,  actualMinutes: 45,  varianceMinutes: 15, variancePct: 50,  crewSize: null, laborMinutes: null },
    { jobId: 'c', serviceKey: 'mowing', serviceLabel: 'Mowing', serviceDate: null, estimatedMinutes: 120, actualMinutes: 130, varianceMinutes: 10, variancePct: 8.3, crewSize: null, laborMinutes: null },
  ]
  const r = rollupLaborVariance(cs)
  eq('typical plan is the median estimate', r.medianEstimatedMinutes, 60)
  eq('typical result is the median actual', r.medianActualMinutes, 60)
  eq('…and the typical MISS is +10m, the median of the per-visit differences', r.medianVarianceMinutes, 10)
  check('…which is NOT the difference of the two medians (that would say 0)',
        r.medianVarianceMinutes !== (r.medianActualMinutes! - r.medianEstimatedMinutes!),
        'the paired statistic collapsed into the unpaired one')
  check('…and it is described as running long, not as on-plan',
        /longer than planned/.test(describeTypicalVariance(r.medianVarianceMinutes)!),
        String(describeTypicalVariance(r.medianVarianceMinutes)))
}

// ── 16. AN EMPTY BUCKET HAS NO TYPICAL ANYTHING ──────────────────────────────
console.log('\nAn absent history reports nothing, never a zero:')
{
  const empty = rollupLaborVariance([])
  eq('…no typical plan', empty.medianEstimatedMinutes, null)
  eq('…no typical result', empty.medianActualMinutes, null)
  eq('…no typical miss', empty.medianVarianceMinutes, null)
  eq('…and no sentence at all', describeTypicalVariance(null), null)
  check('…and it is not established', empty.established === false, 'empty sample claimed to be established')
  eq('…rendered as an em dash, not 0m', formatMinutes(empty.medianActualMinutes), '—')
}

// ── 17. THE USER'S OWN EXAMPLE: TWO CLEANUPS ARE TWO SERVICES ────────────────
// "Spring Cleanup" and "Yard Cleanup" must never pool. If they ever merge, five
// visits of each become one bucket of ten that clears the threshold and starts
// making claims about work nobody did.
console.log('\nSimilarly-named services stay separate:')
{
  const mk = (t: string, i: number): VisitLike =>
    visit({ id: `${t}-${i}`, service_type: t, duration_minutes: 120, actual_minutes: 100 + i })
  const vs = [...Array(5)].flatMap((_, i) => [mk('Spring Cleanup', i), mk('Yard Cleanup', i)])
  const l = learnFromCompletedVisits(vs)
  eq('ten visits, two buckets', l.byService.length, 2)
  const spring = serviceHistory('Spring Cleanup', l.comparisons)
  const yard = serviceHistory('Yard Cleanup', l.comparisons)
  check('…they key differently', spring.serviceKey !== yard.serviceKey,
        `both keyed ${spring.serviceKey}`)
  eq('…spring cleanup sees only its own five', spring.sampleSize, 5)
  eq('…yard cleanup sees only its own five', yard.sampleSize, 5)
  check('…and neither sees all ten', spring.sampleSize + yard.sampleSize === 10 && spring.sampleSize !== 10,
        'a bucket absorbed the other service')
}

// ── 18. THE FOUR SPELLINGS OF MOWING DO POOL ─────────────────────────────────
// The opposite failure, and the one live in production: 30 comparable mowing
// visits written four ways. Splitting them leaves no bucket clearing 5.
console.log('\nOne service written four ways is one service:')
{
  const spellings = ['Lawn Mowing', 'Weekly Mowing', 'Bi-Weekly Mowing', 'Lawn mowing']
  const vs = spellings.map((s, i) => visit({ id: `m${i}`, service_type: s, duration_minutes: 40, actual_minutes: 30 }))
  const l = learnFromCompletedVisits(vs)
  eq('four spellings, one bucket', l.byService.length, 1)
  eq('…and every visit is in it', serviceHistory('Lawn Mowing', l.comparisons).sampleSize, 4)
  eq('…reachable by any of the four spellings',
     serviceHistory('Bi-Weekly Mowing', l.comparisons).sampleSize, 4)
}

// ── 19. A VISIT IS NOT ITS OWN EVIDENCE ──────────────────────────────────────
console.log('\nA visit is excluded from its own history:')
{
  const vs = [...Array(5)].map((_, i) =>
    visit({ id: `j${i}`, duration_minutes: 60, actual_minutes: 90 }))
  const l = learnFromCompletedVisits(vs)
  eq('all five are comparable', serviceHistory('Lawn Mowing', l.comparisons).sampleSize, 5)
  const h = serviceHistory('Lawn Mowing', l.comparisons, { excludeJobId: 'j0' })
  eq('…but the one on screen sees only the other four', h.sampleSize, 4)
  check('…which drops it below the threshold, and it says so', h.established === false,
        'a 4-visit sample still claimed to be established')
}

// ── 20. THE THRESHOLD IS A CLIFF, AND IT IS THE SHARED ONE ──────────────────
console.log('\nThe sample threshold is deterministic:')
{
  const at = (n: number) => {
    const vs = [...Array(n)].map((_, i) => visit({ id: `t${i}`, duration_minutes: 60, actual_minutes: 75 }))
    return serviceHistory('Lawn Mowing', learnFromCompletedVisits(vs).comparisons)
  }
  eq(`one short of ${MIN_SERVICE_SAMPLE} is not established`, at(MIN_SERVICE_SAMPLE - 1).established, false)
  eq(`…exactly ${MIN_SERVICE_SAMPLE} is`, at(MIN_SERVICE_SAMPLE).established, true)
  check('…and the thin sample still reports its real size, rather than hiding',
        at(1).sampleSize === 1 && at(1).medianVarianceMinutes === 15,
        'a below-threshold bucket withheld or faked its figures')
}

// ── 21. WHAT MUST NEVER REACH A BUCKET ───────────────────────────────────────
// Each of these would inflate a sample size that the UI presents as evidence.
console.log('\nNon-comparable rows never reach the history:')
{
  const good = [...Array(5)].map((_, i) => visit({ id: `g${i}`, duration_minutes: 60, actual_minutes: 72 }))
  const poison: VisitLike[] = [
    visit({ id: 'x1', status: 'cancelled', duration_minutes: 60, actual_minutes: 300 }),
    visit({ id: 'x2', status: 'scheduled', duration_minutes: 60, actual_minutes: 300 }),
    visit({ id: 'x3', duration_minutes: 60, actual_minutes: null }),
    visit({ id: 'x4', duration_minutes: null, actual_minutes: 300 }),
    visit({ id: 'x5', duration_minutes: 60, actual_minutes: 1 }),
    visit({ id: 'x6', duration_minutes: 60, actual_minutes: 5000 }),
  ]
  const h = serviceHistory('Lawn Mowing', learnFromCompletedVisits([...good, ...poison]).comparisons)
  eq('a cancelled visit with banked minutes, an unfinished one, a missing actual, a missing estimate, a mis-tap and a timer left running — none of them count',
     h.sampleSize, 5)
  eq('…and the typical miss is the honest +12m', h.medianVarianceMinutes, 12)

  // Duplicates: the same visit twice must not become two votes.
  const dupes = serviceHistory('Lawn Mowing',
    learnFromCompletedVisits([...good, ...good]).comparisons)
  eq('the same five visits handed over twice are still five', dupes.sampleSize, 5)
}

// ── 22. A MISSING ACTUAL IS NOT A FAST VISIT ─────────────────────────────────
// The single most flattering possible bug: untimed visits counted as 0 minutes
// would make every service look far quicker than planned.
console.log('\nAn untimed visit does not drag the typical result to zero:')
{
  const timed = [...Array(5)].map((_, i) => visit({ id: `a${i}`, duration_minutes: 60, actual_minutes: 66 }))
  const untimed = [...Array(20)].map((_, i) => visit({ id: `b${i}`, duration_minutes: 60, actual_minutes: null }))
  const h = serviceHistory('Lawn Mowing', learnFromCompletedVisits([...timed, ...untimed]).comparisons)
  eq('…the sample is the five that were timed', h.sampleSize, 5)
  eq('…the typical result is 66m, not dragged toward 0', h.medianActualMinutes, 66)
  check('…and it still reads as running long', h.medianVarianceMinutes! > 0,
        `got ${h.medianVarianceMinutes}`)
}

// ── 23. THE LOADER: A FAILED READ IS NEVER AN EMPTY HISTORY ─────────────────
// The V2 failure this whole three-outcome contract exists for. Driven through
// the REAL loader with a stub client, so the branch is executed, not grepped.
// (The loader is async and this script compiles to CJS, so the two sections
// that drive it live in a function rather than at top level.)
async function loaderChecks() {
console.log('\nThe loader tells a broken read apart from an empty one:')
{
  const stub = (result: { data: unknown; error: unknown }) => {
    const eqCalls: [string, unknown][] = []
    const tables: string[] = []
    const b: Record<string, unknown> = {}
    Object.assign(b, {
      select: () => b,
      eq: (c: string, v: unknown) => { eqCalls.push([c, v]); return b },
      order: () => b,
      limit: () => b,
      then: (r: (v: unknown) => unknown) => Promise.resolve(result).then(r),
    })
    const client = { from: (t: string) => { tables.push(t); return b } }
    return { client: client as never, eqCalls, tables }
  }
  const rows = (n: number) => [...Array(n)].map((_, i) => ({
    id: `r${i}`, status: 'completed', service_type: 'Lawn Mowing',
    scheduled_date: null, duration_minutes: 60, actual_minutes: 75,
  }))

  const errored = stub({ data: null, error: { message: 'network down' } })
  const e = await loadCompletedVisitLearning(errored.client, 'user-a')
  eq('a read error is unavailable', e.outcome, 'unavailable')
  check('…and carries the reason', e.outcome === 'unavailable' && /network down/.test(e.reason), JSON.stringify(e))

  const nullish = await loadCompletedVisitLearning(stub({ data: null, error: null }).client, 'user-a')
  eq('a null payload with NO error is still unavailable, not empty', nullish.outcome, 'unavailable')

  const emptyLoad = await loadCompletedVisitLearning(stub({ data: [], error: null }).client, 'user-a')
  eq('a genuine empty result is no_history — a different outcome', emptyLoad.outcome, 'no_history')

  const okLoad = await loadCompletedVisitLearning(stub({ data: rows(5), error: null }).client, 'user-a')
  eq('rows that compare are ok', okLoad.outcome, 'ok')
  check('…with the learning attached',
        okLoad.outcome === 'ok' && okLoad.learning.coverage.comparable === 5, JSON.stringify(okLoad))

  // Completed rows that are all untimed: the read worked, there is simply
  // nothing comparable. Must NOT be reported as a failure either.
  const untimedLoad = await loadCompletedVisitLearning(stub({
    data: rows(5).map(r => ({ ...r, actual_minutes: null })), error: null,
  }).client, 'user-a')
  eq('completed but untimed rows are no_history, not unavailable', untimedLoad.outcome, 'no_history')

  const capped = await loadCompletedVisitLearning(stub({ data: rows(HISTORY_LIMIT), error: null }).client, 'user-a')
  check('hitting the cap is disclosed, never silent',
        capped.outcome === 'ok' && capped.truncated === true, JSON.stringify({ ...capped, learning: undefined }))
  check('…and a short read is not flagged as capped',
        okLoad.outcome === 'ok' && okLoad.truncated === false, 'a 5-row read claimed truncation')
}

// ── 24. THE LOADER IS TENANT-SCOPED, AND THE SCOPE IS REAL ──────────────────
// Business A's finished work must never teach Business B what to charge. RLS is
// the guarantee, but RLS is bypassed by a service-role client — so the explicit
// filter is asserted here, with the actual id, by running the real loader.
console.log('\nOne business never learns from another:')
{
  const stub = () => {
    const eqCalls: [string, unknown][] = []
    const tables: string[] = []
    const b: Record<string, unknown> = {}
    Object.assign(b, {
      select: () => b,
      eq: (c: string, v: unknown) => { eqCalls.push([c, v]); return b },
      order: () => b, limit: () => b,
      then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
    })
    return { client: { from: (t: string) => { tables.push(t); return b } } as never, eqCalls, tables }
  }
  const a = stub()
  await loadCompletedVisitLearning(a.client, 'business-a')
  check('the read is filtered by the caller\'s own user_id',
        a.eqCalls.some(([c, v]) => c === 'user_id' && v === 'business-a'),
        JSON.stringify(a.eqCalls))
  check('…and only completed visits are asked for',
        a.eqCalls.some(([c, v]) => c === 'status' && v === 'completed'),
        JSON.stringify(a.eqCalls))
  eq('…from the jobs table', a.tables.join(','), 'jobs')

  // Mutation: a hardcoded or dropped filter would keep saying 'business-a'.
  const b2 = stub()
  await loadCompletedVisitLearning(b2.client, 'business-b')
  check('…and the filter FOLLOWS the caller, it is not a constant',
        b2.eqCalls.some(([c, v]) => c === 'user_id' && v === 'business-b') &&
        !b2.eqCalls.some(([, v]) => v === 'business-a'),
        JSON.stringify(b2.eqCalls))

  // No user at all must not produce an UNSCOPED read.
  const none = stub()
  const r = await loadCompletedVisitLearning(none.client, '')
  eq('a signed-out read is unavailable', r.outcome, 'unavailable')
  eq('…and no query was issued at all', none.tables.length, 0)
}
}

// ── 25. LEARNING IS EVIDENCE, NOT AN ACTION ─────────────────────────────────
// The standing product rule: the system shows the owner what happened and never
// re-prices on its own. Structural, so no future edit can quietly add a writer.
console.log('\nHistory can be read but never applied:')
{
  const engine = readFileSync(join(process.cwd(), 'src/lib/estimateVsActual.ts'), 'utf8')
  const loader = readFileSync(join(process.cwd(), 'src/lib/estimateVsActualData.ts'), 'utf8')
  const ui = readFileSync(join(process.cwd(), 'src/components/labor/ServiceEstimateLearning.tsx'), 'utf8')

  check('the loader only ever reads',
        !/\.(insert|update|upsert|delete|rpc)\s*\(/.test(loader),
        'the loader contains a write')
  check('…and reads exactly one table',
        (loader.match(/\.from\(/g) || []).length === 1, 'the loader touches more than one table')
  check('the learning UI writes nothing back to the form',
        !/setValue|register\(|onChange|\.update\(|\.insert\(/.test(ui),
        'the history surface can edit the estimate it is describing')
  check('…and offers no "apply" affordance',
        !/<button|onClick/i.test(ui), 'the history surface has an actionable control')
  // ⚠️ Strip comments FIRST. This module's header is a long argument about why
  // it holds no money, so a scan of the raw text finds "price" and "cost" in the
  // prose and reports the explanation as the violation.
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  check('the engine still holds no currency and no price concept',
        !/price|amount|dollar|currency/i.test(code(engine)),
        'a money concept entered the labour learning engine')
  check('…and neither does the loader',
        !/price|amount|dollar|currency/i.test(code(loader)),
        'a money concept entered the learning loader')
  // `$` only counts as money when it is NOT opening a template interpolation.
  check('…and the surface renders no money',
        !/[£€]|\$(?!\{)/.test(code(ui)), 'the history surface prints a currency amount')

  // ONE VISIT IS NEVER A TENDENCY. The two describers are deliberately worded
  // apart, and the surface must pick the singular one at n=1 — a disclaimer
  // below a "a typical visit…" headline does not unsay the headline.
  check('the tendency wording is the only one that says "typical"',
        /typical/i.test(describeTypicalVariance(15)!) &&
        !/typical/i.test(describeVariance({ varianceMinutes: 15, variancePct: 50 })),
        'the singular and tendency wordings are no longer distinguishable')
  check('…and the surface uses the singular wording for a sample of one',
        /sampleSize === 1[\s\S]{0,200}?describeVariance\(/.test(code(ui)),
        'a single visit is being described as typical')
}

loaderChecks().then(() => {
  console.log('')
  if (failures) { console.log(`✗ ${failures} estimate-vs-actual check(s) failed\n`); process.exit(1) }
  console.log('✓ all estimate-vs-actual checks passed — unknown stays unknown, no sample is oversold, and no money is invented\n')
})
