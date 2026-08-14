// ── Verify: smart time estimates are honest about big work ───────────────────
//   npm run verify:smart-estimate
//
// WHY THIS SCRIPT EXISTS
// Session 48 measured the live "Smart Labor Estimate" in the job form and found
// it structurally unable to describe project work: its output was clamped to 240
// minutes (`clamp(Math.round(solo / crewEff), 10, 240)` in lib/labor), so a
// two-day job was not merely mis-estimated — it was unrepresentable; it rendered
// nothing at all without a lawn measurement; it reported a manufactured
// percentage ("87% · High confidence"); and its buckets came from keyword tables
// (`/mow|grass\s*cut/`, an `isMowing` seasonal factor) in a product that is not a
// lawn-care app. Every failure below is arithmetically derivable and
// operationally false, and each one regresses silently.
//
// THE RULES PINNED (this session's regression matrix):
//   1  elapsed and labour are DIFFERENT questions, never scaled versions
//   2  unknown stays unknown — never 0, never 45, never a crew of 1
//   3  an unreliable sample is never presented as established, and never
//      offers a value to apply
//   4  scale is structural — no service-name keyword can move it
//   5  price is never a duration proxy (and is not readable from here)
//   6  ONE sample threshold: the canonical MIN_SERVICE_SAMPLE, reused
//   7  ONE duration rule: the estimate delegates to dayFit.resolveDuration
//   8  crew evidence carries its OWN sample size
//   9  the labour median is PAIRED, not median(elapsed) × median(crew)
//  10  multi-day durations are spoken in workdays, never raw minutes, and
//      round in the direction that cannot understate a commitment
//  11  the estimate never writes: no persistence, no auto-fill, no rewriting of
//      a historical estimate
//  12  tenancy: the engine is pure, every read is user-scoped
//  13  Day Suggestions (Session 46) is unchanged and still consumes the
//      canonical primitive
//  14  the card stays a card — no dashboard on a 375px form
//  15  only completed, plausible visits teach
//  16  the learner cannot read its own output
//
// SESSION 47 (work sessions + multi-day) added the labour half's real source:
//  17  ACTUAL work-session labour outranks the planned crew
//  18  a clock or carried session's worker count IS the plan, and says so
//  19  a partial or still-open session set fails to UNKNOWN, never to zero and
//      never to a fallback that looks like an answer
//  20  a multi-day project learns end to end, and no name changes the answer
//  21  the card and Day Suggestions agree about established vs unknown
//
// Deterministic, no network: every fixture is hand-derived below.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildWorkEstimate, workdayMinutes, formatEstimatedDuration, formatLaborHours,
  describeConfidence, describeLaborBasis, type WorkEstimate,
} from '../src/lib/workEstimate'
import {
  serviceHistory, learnFromCompletedVisits, readVisitLabor, rollupLaborVariance,
  MIN_SERVICE_SAMPLE, type VisitLike, type LaborComparison,
} from '../src/lib/estimateVsActual'
import { resolveDuration } from '../src/lib/dayFit'
import { loadCompletedVisitLearning } from '../src/lib/estimateVsActualData'
import { DEFAULT_CAPACITY_HOURS } from '../src/lib/route'
import { WORKDAY_FALLBACK_HOURS, formatDuration } from '../src/lib/workDuration'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => (cond ? ok(n) : fail(n, d))
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, Object.is(a, b), `expected ${String(b)}, got ${String(a)}`)
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
// Prose explaining WHY a rule holds must never satisfy a check that the rule
// holds — a source scan has flagged a module's own explanation before now.
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Deliberately NOT lawn work: the whole point is that nothing keys off the name.
// A: six completed "Warehouse Fit-Out" visits, each ~11h elapsed with a crew of
//    4 → 11h elapsed, 44 labour-hours, and 11h > an 8h day, so it is multi-day.
const project: VisitLike[] = Array.from({ length: 6 }, (_, i) => ({
  id: `p${i}`, status: 'completed', service_type: 'Warehouse Fit-Out',
  scheduled_date: `2026-05-0${i + 1}`,
  duration_minutes: 600, actual_minutes: 660, crew_size: 4,
}))
// B: nine short repeat visits of a service with no keyword anywhere, solo.
const short: VisitLike[] = Array.from({ length: 9 }, (_, i) => ({
  id: `s${i}`, status: 'completed', service_type: 'Filter Swap',
  scheduled_date: `2026-06-0${i + 1}`,
  duration_minutes: 40, actual_minutes: 45, crew_size: 1,
}))
const learned = learnFromCompletedVisits([...project, ...short])
const estFor = (svc: string, capacityHours: number | null = 8): WorkEstimate =>
  buildWorkEstimate(serviceHistory(svc, learned.comparisons), { capacityHours })

console.log('\n1. Elapsed and labour are different questions:')
{
  const e = estFor('Warehouse Fit-Out')
  eq('elapsed is the stopwatch — 11h', e.suggestedElapsedMinutes, 660)
  eq('labour is person-minutes — 11h × 4 = 44 labour-hours', e.suggestedLaborMinutes, 2640)
  check('…and they are NOT the same number', e.suggestedElapsedMinutes !== e.suggestedLaborMinutes)
  eq('typical crew is stated, not inferred', e.typicalCrewSize, 4)
  eq('labour says where it came from', e.laborSource, 'planned_crew')
  eq('labour is spoken in labour-hours', formatLaborHours(e.suggestedLaborMinutes), '44 labour-hours')
  // The failure this blocks: putting labour on a calendar (triples the job) or
  // elapsed into a cost (divides it by three).
  check('the elapsed figure is not the labour figure in disguise',
    e.suggestedElapsedMinutes! * (e.typicalCrewSize ?? 1) === e.suggestedLaborMinutes,
    'labour must be elapsed × crew for this fixture, and separately reported')

  const solo = estFor('Filter Swap')
  eq('solo work: elapsed 45m', solo.suggestedElapsedMinutes, 45)
  eq('solo work: labour equals elapsed', solo.suggestedLaborMinutes, 45)
  eq('…and the crew line is suppressed, because 1 is not a crew', solo.needsCrew, false)
}

console.log('\n2. Unknown stays unknown — never 0, never 45, never a crew of 1:')
{
  const none = estFor('Something Never Done')
  eq('no history → confidence none', none.confidence, 'none')
  eq('…elapsed is null, NOT 0', none.suggestedElapsedMinutes, null)
  eq('…and NOT the shared 45-minute default', none.suggestedSource, 'unknown')
  eq('…labour is null, not 0', none.suggestedLaborMinutes, null)
  eq('…crew is null, not 1', none.typicalCrewSize, null)
  eq('…scale is unknown, not "short"', none.scale, 'unknown')
  eq('…sample size is 0', none.sampleSize, 0)
  eq('…and it is worded as absence', describeConfidence(none), 'Not enough history yet')
  eq('a null duration formats as an em dash, never a number', formatEstimatedDuration(null, 480), '—')
  eq('null labour formats as an em dash', formatLaborHours(null), '—')

  // A visit that never stated a crew contributes NO crew evidence — silence is
  // not a one-person crew, and person-hours must not be minted from it.
  const crewless = learnFromCompletedVisits(
    Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`, status: 'completed', service_type: 'Duct Cleaning',
      duration_minutes: 120, actual_minutes: 150, crew_size: null,
    })) as VisitLike[])
  const e = buildWorkEstimate(serviceHistory('Duct Cleaning', crewless.comparisons), { capacityHours: 8 })
  eq('six visits, none stating a crew → crew sample 0', e.crewSampleSize, 0)
  eq('…crew null', e.typicalCrewSize, null)
  eq('…labour null, NOT elapsed × 1', e.suggestedLaborMinutes, null)
  eq('…labour source says none', e.laborSource, 'none')
  eq('…while the DURATION is still established from those same six visits', e.suggestedElapsedMinutes, 150)
}

console.log('\n3. A thin sample is never presented as established:')
{
  const thin = learnFromCompletedVisits(
    Array.from({ length: MIN_SERVICE_SAMPLE - 1 }, (_, i) => ({
      id: `t${i}`, status: 'completed', service_type: 'Roof Inspection',
      duration_minutes: 90, actual_minutes: 100, crew_size: 2,
    })) as VisitLike[])
  const e = buildWorkEstimate(serviceHistory('Roof Inspection', thin.comparisons), { capacityHours: 8 })
  eq(`n = ${MIN_SERVICE_SAMPLE - 1} → confidence limited`, e.confidence, 'limited')
  eq('…worded as limited history', describeConfidence(e), 'Limited history')
  eq('…and NOTHING is offered to apply', e.suggestedElapsedMinutes, null)
  eq('…nor a labour figure', e.suggestedLaborMinutes, null)
  check('…but the observed figure IS available as context', e.observedElapsedMinutes === 100,
    `expected 100, got ${String(e.observedElapsedMinutes)}`)
  check('the two are SEPARATE fields, so a surface cannot apply the loose one',
    e.observedElapsedMinutes != null && e.suggestedElapsedMinutes == null)

  // One more visit crosses the canonical line, and only then.
  const atThreshold = learnFromCompletedVisits(
    Array.from({ length: MIN_SERVICE_SAMPLE }, (_, i) => ({
      id: `u${i}`, status: 'completed', service_type: 'Roof Inspection',
      duration_minutes: 90, actual_minutes: 100, crew_size: 2,
    })) as VisitLike[])
  const at = buildWorkEstimate(serviceHistory('Roof Inspection', atThreshold.comparisons), { capacityHours: 8 })
  eq(`n = ${MIN_SERVICE_SAMPLE} → established`, at.confidence, 'established')
  eq('…and only now is a value offered', at.suggestedElapsedMinutes, 100)
  eq('…worded as established', describeConfidence(at), 'Established estimate')

  // No percentage anywhere: "87% confident" reads as a measurement.
  const src = stripComments(read('src/lib/workEstimate.ts'))
  check('the engine produces no confidence percentage',
    !/confidencePct|percent|\bpct\b/i.test(src), 'a percentage confidence reappeared')
  const card = stripComments(read('src/components/labor/SmartEstimateCard.tsx'))
  check('nor does the card render one', !/%/.test(card.replace(/w-|h-|\[\d/g, '')), 'a % appeared in the card')
}

console.log('\n4. Scale is structural — service NAMES control nothing:')
{
  // Same numbers, wildly different names, including every keyword the old
  // engine's tables carried. If any of them moved the answer, this fails.
  const names = ['Warehouse Fit-Out', 'Mulch Delivery', 'Weekly Mowing', 'Snow Removal',
                 'Office Cleaning', 'Bathroom Renovation', 'zzz']
  const answers = names.map(n => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      id: `${n}${i}`, status: 'completed', service_type: n,
      duration_minutes: 600, actual_minutes: 660, crew_size: 4,
    })) as VisitLike[]
    const l = learnFromCompletedVisits(rows)
    return buildWorkEstimate(serviceHistory(n, l.comparisons), { capacityHours: 8 })
  })
  check('identical time + crew → identical estimate, whatever it is called',
    answers.every(a => a.suggestedElapsedMinutes === 660 && a.suggestedLaborMinutes === 2640
      && a.scale === 'multi_day'),
    answers.map(a => `${a.serviceLabel}:${a.suggestedElapsedMinutes}/${a.scale}`).join(' '))

  // And the same in the other direction: a short job stays short under a name
  // the old keyword tables treated as heavy work.
  const shortMulch = learnFromCompletedVisits(Array.from({ length: 6 }, (_, i) => ({
    id: `m${i}`, status: 'completed', service_type: 'Mulch Installation',
    duration_minutes: 30, actual_minutes: 35, crew_size: 1,
  })) as VisitLike[])
  const sm = buildWorkEstimate(serviceHistory('Mulch Installation', shortMulch.comparisons), { capacityHours: 8 })
  eq('a 35-minute "Mulch Installation" is within-day', sm.scale, 'within_day')
  eq('…and needs no crew line', sm.needsCrew, false)

  // Structural, in the source too: no keyword table may exist here.
  const src = stripComments(read('src/lib/workEstimate.ts'))
  for (const kw of ['mow', 'mulch', 'snow', 'clean', 'lawn', 'grass', 'hedge', 'plow', 'sod']) {
    check(`no "${kw}" rule in the engine`, !new RegExp(kw, 'i').test(src), `"${kw}" appears in workEstimate.ts`)
  }
  check('…and no regex literal at all', !/=\s*\/[^/\n]+\/[gimsuy]*/.test(src), 'a pattern table appeared')
}

console.log('\n5. Price is never a duration proxy:')
{
  const src = stripComments(read('src/lib/workEstimate.ts'))
  for (const money of ['price', 'total', 'amount', 'revenue', 'dollar', 'invoice', 'cost']) {
    check(`the engine never reads "${money}"`, !new RegExp(`\\b${money}`, 'i').test(src),
      `"${money}" appears in workEstimate.ts`)
  }
  // Structural, not just textual, because a keyword scan is one rename away
  // from blind: the entry point's options are pinned to the ONE field it takes,
  // so growing any second input — money by any name — fails here.
  const sig = src.match(/export function buildWorkEstimate\(([\s\S]*?)\): WorkEstimate/)?.[1] ?? '?'
  eq('buildWorkEstimate takes a history and one option', sig.replace(/\s+/g, ' ').trim(),
    'history: ServiceVariance, opts?: { capacityHours?: number | null },')
  // …and the type the engine learns from has no money in it either, so there is
  // nothing to read even if someone wanted to.
  const eva = stripComments(read('src/lib/estimateVsActual.ts'))
  const visitLike = eva.slice(eva.indexOf('interface VisitLike'), eva.indexOf('export type NotComparable'))
  check('the visit slice the learner consumes carries no money field',
    !/price|total|amount|cost/i.test(visitLike), visitLike)
  // Behavioural: an expensive short job and a cheap long one classify on TIME.
  const cheapLong = buildWorkEstimate(serviceHistory('Warehouse Fit-Out', learned.comparisons), { capacityHours: 8 })
  const pricyShort = buildWorkEstimate(serviceHistory('Filter Swap', learned.comparisons), { capacityHours: 8 })
  eq('11 hours is multi-day regardless of what it bills', cheapLong.scale, 'multi_day')
  eq('45 minutes is within-day regardless of what it bills', pricyShort.scale, 'within_day')
}

console.log('\n6. One sample threshold — the canonical one, reused:')
{
  const src = stripComments(read('src/lib/workEstimate.ts'))
  check('the engine imports MIN_SERVICE_SAMPLE rather than declaring a rival',
    /MIN_SERVICE_SAMPLE/.test(src) && !/MIN_[A-Z_]*SAMPLE\s*=/.test(src),
    'a second sample threshold was declared')
  // No bare numeric threshold constants at all: any `const X = <number>` here
  // would be a rule this module invented rather than composed.
  const decls = src.match(/^\s*(?:export\s+)?const\s+[A-Z_]+\s*=\s*[\d.]+/gm) || []
  check('no numeric constant is declared in the engine', decls.length === 0, decls.join(' · '))
  // Session 47 owns the working day. This module held its own copy for one
  // commit; keeping both would let "9 hours" mean two different things.
  check('the working day comes from Session 47 lib/workDuration',
    /from '@\/lib\/workDuration'/.test(src), 'the workday was re-implemented locally')
  check('…and this module declares no workday of its own',
    !/function workdayMinutes/.test(src), 'a rival workdayMinutes came back')
  eq('…which is the same fallback every capacity reader uses', WORKDAY_FALLBACK_HOURS, 8)
  eq('…and dayLoad still agrees with it', DEFAULT_CAPACITY_HOURS, WORKDAY_FALLBACK_HOURS)

  // Crew is held to the SAME bar, on its own count — not a looser one.
  const mixed = learnFromCompletedVisits([
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `x${i}`, status: 'completed', service_type: 'Site Survey',
      duration_minutes: 120, actual_minutes: 120, crew_size: i < 2 ? 3 : null,
    })),
  ] as VisitLike[])
  const e = buildWorkEstimate(serviceHistory('Site Survey', mixed.comparisons), { capacityHours: 8 })
  eq('6 visits, only 2 stating a crew → duration established', e.confidence, 'established')
  eq('…crew sample is 2, not 6', e.crewSampleSize, 2)
  eq('…so the crew claim is withheld', e.typicalCrewSize, null)
  eq('…and so is labour', e.suggestedLaborMinutes, null)
}

console.log('\n7. One duration rule — delegated, not restated:')
{
  const src = stripComments(read('src/lib/workEstimate.ts'))
  check('the estimate calls dayFit.resolveDuration', /resolveDuration\(/.test(src),
    'the duration precedence was re-implemented')
  check('…with a null own-estimate, so it answers "what does history alone say"',
    /resolveDuration\(null,/.test(src), '')
  // Proven by agreement, not just by reading: whatever resolveDuration says
  // about this history is exactly what the card offers.
  const h = serviceHistory('Warehouse Fit-Out', learned.comparisons)
  eq('the offered figure IS resolveDuration\'s answer',
    buildWorkEstimate(h, { capacityHours: 8 }).suggestedElapsedMinutes,
    resolveDuration(null, h).minutes)
  const thin = serviceHistory('Nothing At All', learned.comparisons)
  eq('…and its silence is exactly resolveDuration\'s silence',
    buildWorkEstimate(thin, { capacityHours: 8 }).suggestedElapsedMinutes,
    resolveDuration(null, thin).minutes)
}

console.log('\n8. The labour median is paired:')
{
  // Built so the two answers DISAGREE and the unpaired one is wrong: the big
  // visit is the small crew, so median(elapsed) × median(crew) overstates.
  // Built so the two answers DISAGREE and the unpaired one is the flattering
  // direction: the longest visit ran with a small crew and the shortest with a
  // large one, so multiplying the median hours by the median headcount reports
  // 4 labour-hours where the typical visit really carries 8.
  const cs: LaborComparison[] = [
    { jobId: 'a', serviceKey: 'k', serviceLabel: 'K', serviceDate: null, estimatedMinutes: 60, actualMinutes: 60,  varianceMinutes: 0,   variancePct: 0,   crewSize: 1, laborMinutes: 60 , laborSource: 'planned_crew' },
    { jobId: 'b', serviceKey: 'k', serviceLabel: 'K', serviceDate: null, estimatedMinutes: 60, actualMinutes: 120, varianceMinutes: 60,  variancePct: 100, crewSize: 4, laborMinutes: 480 , laborSource: 'planned_crew' },
    { jobId: 'c', serviceKey: 'k', serviceLabel: 'K', serviceDate: null, estimatedMinutes: 60, actualMinutes: 600, varianceMinutes: 540, variancePct: 900, crewSize: 2, laborMinutes: 1200 , laborSource: 'planned_crew' },
  ]
  const r = rollupLaborVariance(cs)
  eq('typical elapsed is the median elapsed', r.medianActualMinutes, 120)
  eq('typical crew is the median crew', r.medianCrewSize, 2)
  eq('…and typical LABOUR is the median of each visit\'s own elapsed × its own crew', r.medianLaborMinutes, 480)
  eq('…where the unpaired answer would have said', r.medianActualMinutes! * r.medianCrewSize!, 240)
  check('…so the paired statistic has NOT collapsed into the unpaired one',
    r.medianLaborMinutes !== r.medianActualMinutes! * r.medianCrewSize!,
    'the paired statistic collapsed into the unpaired one')
}

console.log('\n9. Multi-day durations are spoken in workdays:')
{
  const day = 480
  // ⭐ These are Session 47's answers, not this session's. The estimate formats
  // through lib/workDuration's formatDuration; a divergence here means a rival
  // formatter has grown back and "9 hours" now means two things in one product.
  check('960 minutes is never shown as minutes', !/\d{3,}m/.test(formatEstimatedDuration(960, day)),
    formatEstimatedDuration(960, day))
  eq('16h on an 8h day → 2 days', formatEstimatedDuration(960, day), '2 days')
  eq('exactly one day is one day', formatEstimatedDuration(480, day), '1 day')
  eq('under an hour stays in minutes', formatEstimatedDuration(45, day), '45m')
  eq('…and mid-range stays in hours', formatEstimatedDuration(150, day), '2h 30m')
  // A part-day remainder is CARRIED, never dropped: "1 day" for nine hours would
  // be a promise the day cannot keep.
  eq('9h is a day and an hour, not "1 day"', formatEstimatedDuration(540, day), '1 day 1h')
  eq('…and 10h likewise', formatEstimatedDuration(600, day), '1 day 2h')
  eq('24h is 3 days', formatEstimatedDuration(1440, day), '3 days')
  // The owner's OWN day is the unit.
  eq('on a 10h day, 9h is within the day', formatEstimatedDuration(540, 600), '9h')
  eq('workdayMinutes reads the owner\'s setting', workdayMinutes(10), 600)
  eq('…an unset day falls back to the shared default', workdayMinutes(null), WORKDAY_FALLBACK_HOURS * 60)
  eq('…and a blocked (0) day is not a zero-length unit', workdayMinutes(0), WORKDAY_FALLBACK_HOURS * 60)
  // Every one of the above IS lib/workDuration's own answer, asserted rather
  // than assumed — one formatter, proven, not two kept in step by hand.
  for (const m of [45, 150, 480, 540, 600, 960, 1440]) {
    check(`${m}m formats exactly as lib/workDuration says`,
      formatEstimatedDuration(m, day) === formatDuration(m, day),
      `${formatEstimatedDuration(m, day)} vs ${formatDuration(m, day)}`)
  }
  // Scale follows the same unit.
  eq('11h is multi-day on an 8h day', estFor('Warehouse Fit-Out', 8).scale, 'multi_day')
  eq('…and within-day for a 12-hour operator', estFor('Warehouse Fit-Out', 12).scale, 'within_day')
}

console.log('\n10. The estimate never writes:')
{
  const src = stripComments(read('src/lib/workEstimate.ts'))
  const data = stripComments(read('src/lib/workEstimateData.ts'))
  const card = stripComments(read('src/components/labor/SmartEstimateCard.tsx'))
  check('the engine does no I/O at all', !/supabase|fetch\(|from\(/i.test(src), 'workEstimate must stay pure')
  for (const w of ['insert', 'update', 'upsert', 'delete', 'rpc']) {
    check(`the loader never calls .${w}()`, !new RegExp(`\\.${w}\\(`).test(data), `${w} in workEstimateData`)
    check(`the card never calls .${w}()`, !new RegExp(`\\.${w}\\(`).test(card), `${w} in the card`)
  }
  // ⭐ No auto-fill. The widget this replaced applied its estimate from an
  // effect whenever its inputs changed, which is how a saved visit's duration
  // gets silently re-estimated by a learner that has since moved.
  check('the card has no effect that applies the estimate',
    !/useEffect\([^)]*[\s\S]{0,400}?onApply\(/.test(card), 'onApply is reachable from an effect')
  const applies = card.match(/onApply\(/g) || []
  eq('onApply is called exactly once…', applies.length, 1)
  check('…and only from a click handler', /onClick=\{\(\) => onApply\(minutes\)\}/.test(card),
    'the apply call is not a click handler')
  // Nothing is persisted, so a historical estimate cannot be rewritten: there is
  // no column for a learned suggestion and no migration that adds one.
  check('no learned-estimate column is introduced',
    !/learned_|suggested_|estimate_source/.test(src + data + card), 'a persisted suggestion appeared')
  check('the owner\'s own duration field is what gets written, by the form',
    /setValue\('duration_minutes'/.test(read('src/components/schedule/JobForm.tsx')), '')
}

console.log('\n11. Tenancy — one business never estimates from another\'s work:')
{
  // ⚠️ Split on `.from('` — NOT on `supabase.from(`. Both loaders break the call
  // chain over lines (`await supabase\n  .from('jobs')`), so the tighter pattern
  // matches nothing, the loop body never runs, and a tenancy check that asserts
  // NOTHING reports all-green. That is the same shape as counting a filter
  // whole-file and being satisfied by a comment. The block count is asserted
  // first for exactly that reason: a scan that finds no reads has not proved the
  // reads are scoped, it has proved the scan is broken.
  const readBlocks = (src: string) => src.split(/\.from\('/).slice(1)
  const scoped = (src: string, label: string, expected: number) => {
    const blocks = readBlocks(src)
    eq(`${label} has exactly ${expected} read(s)`, blocks.length, expected)
    for (const b of blocks) {
      const table = b.match(/^([a-z_]+)'/)?.[1] ?? '?'
      check(`…its ${table} read is tenant-scoped in ITS OWN call chain`,
        /\.eq\('user_id', userId\)/.test(b.split(/\n\s*\n/)[0]),
        `no .eq('user_id', userId) inside the ${table} read`)
    }
  }
  const data = read('src/lib/workEstimateData.ts')
  scoped(data, 'the capacity loader', 1)
  check('a missing user id issues no query at all', /if \(!userId\) return/.test(data), '')
  // The visits themselves come from the S15 loader, which is scoped the same way.
  const eva = read('src/lib/estimateVsActualData.ts')
  scoped(eva, 'the completed-visit loader', 1)
  check('…and it now reads crew_size, or labour could never be known',
    /select\('[^']*crew_size[^']*'\)/.test(eva), 'crew_size missing from the select')
  // ⭐ Work sessions arrive through Session 47's own bulk loader, and are then
  // filtered to this owner in memory. Not theatre: the composite FK
  // (job_id, user_id) → jobs(id, user_id) already makes a foreign session
  // unable to point at one of these jobs, but the filter is what stands if a
  // service-role client is ever passed, exactly as the visits read carries one.
  check('sessions are read through Session 47\'s canonical loader',
    /loadWorkSessionsForJobs\(/.test(eva), 'a rival work-session read appeared')
  check('…and person-minutes come from Session 47\'s own arithmetic',
    /sessionTotals\(/.test(eva), 'labour was re-summed locally')
  check('…and every session row is checked against this owner',
    /if \(s\.user_id !== userId\) continue/.test(eva), 'foreign sessions are not filtered out')
  check('…and no session is loaded without a user id',
    /if \(!userId \|\| jobIds\.length === 0\) return out/.test(eva), '')
  // The engine has no idea who the owner is. ("session" is no longer a usable
  // token for this check — Session 47 gave the product `work_sessions`, and the
  // engine legitimately names them — so the test is for the ways an identity
  // could actually be obtained.)
  check('the engine learns only from rows it is handed',
    !/user_id|getUser|getSession|auth\./i.test(stripComments(read('src/lib/workEstimate.ts'))), '')
}

console.log('\n12. A failed read is not an empty history:')
{
  const card = stripComments(read('src/components/labor/SmartEstimateCard.tsx'))
  check('the card branches on outcome unavailable', /outcome === 'unavailable'/.test(card), '')
  check('…and says it is a loading problem, not a finding',
    /loading problem/.test(card), 'the failure state does not distinguish itself')
  // The unavailable branch must return BEFORE any estimate is built, or the
  // failure would render as "no history yet".
  const iUnavail = card.indexOf("outcome === 'unavailable'")
  const iBuild = card.indexOf('buildWorkEstimate(')
  check('…and it returns before an estimate is built', iUnavail > -1 && iUnavail < iBuild,
    `unavailable at ${iUnavail}, build at ${iBuild}`)
  // A capacity read that fails changes the UNIT, never the duration.
  const data = stripComments(read('src/lib/workEstimateData.ts'))
  check('a failed capacity read falls back to the shared default',
    /if \(error \|\| !data\) return workdayMinutes\(null\)/.test(data), '')

  // ⭐ A work-session read that fails costs the LABOUR claim and nothing else.
  // The elapsed half needs nothing from it — jobs.actual_minutes already carries
  // the multi-day total — so darkening the whole card would be an overreaction,
  // and silently keeping a measured label would be a lie. It degrades to
  // planned_crew, which is a true statement about the figure that remains.
  const eva2 = stripComments(read('src/lib/estimateVsActualData.ts'))
  check('a thrown session read is caught, not propagated',
    /try \{[\s\S]*loadWorkSessionsForJobs[\s\S]*\} catch \{[\s\S]*return out/.test(eva2),
    'a session read that throws would take the whole estimate down')
  check('…and a failed one returns no facts rather than partial ones',
    /if \(load\.failed\) return out/.test(eva2), '')
  // Behaviour, not just shape: a visit with no session facts still learns.
  const noFacts = learnFromCompletedVisits(
    Array.from({ length: 6 }, (_, i) => ({
      id: `nf${i}`, status: 'completed', service_type: 'Bench Fitting',
      duration_minutes: 200, actual_minutes: 240, crew_size: 3,
    })) as VisitLike[])
  const degraded = buildWorkEstimate(serviceHistory('Bench Fitting', noFacts.comparisons), { capacityHours: 8 })
  eq('sessions unavailable → elapsed is unaffected', degraded.suggestedElapsedMinutes, 240)
  eq('…labour still offered, from the plan', degraded.suggestedLaborMinutes, 720)
  eq('…and labelled as the plan, never as measured', degraded.laborSource, 'planned_crew')
  eq('…worded as the plan on screen', describeLaborBasis(degraded), 'at the planned crew size')
}

console.log('\n13. Session 46 is unchanged and still the canonical primitive:')
{
  // resolveDuration's own contract, re-pinned here because this session now
  // depends on it: history is usable only when established, and unknown stays
  // unknown. If Day Suggestions' rule moves, the smart estimate moves with it.
  const est = serviceHistory('Warehouse Fit-Out', learned.comparisons)
  eq('the owner\'s own estimate still wins', resolveDuration(300, est).minutes, 300)
  eq('…and is labelled as theirs', resolveDuration(300, est).source, 'estimate')
  eq('history fills the gap when established', resolveDuration(null, est).source, 'learned')
  const thin = rollupLaborVariance(learned.comparisons.slice(0, 1))
  eq('…and never when it is not', resolveDuration(null, { ...thin, serviceKey: 'k', serviceLabel: 'K' }).minutes, null)
  check('dayFit still owns no threshold of its own',
    /MIN_SERVICE_SAMPLE|established/.test(read('src/lib/dayFit.ts')), '')
  check('dayFit is still pure', !/supabase|fetch\(/i.test(read('src/lib/dayFit.ts')), '')
}

console.log('\n14. The card stays a card:')
{
  const card = read('src/components/labor/SmartEstimateCard.tsx')
  const lines = card.split('\n').length
  check(`the card is small (${lines} lines)`, lines < 200, 'a dashboard is growing inside the job form')
  for (const heavy of ['Chart', 'Recharts', 'Table', '<table', 'Sparkline', 'grid-cols-3', 'grid-cols-4']) {
    check(`no ${heavy} in the estimate card`, !card.includes(heavy), `${heavy} appeared`)
  }
  // The replaced widget is gone from the job form, and with it the 240-minute
  // ceiling that made project work unrepresentable.
  const form = read('src/components/schedule/JobForm.tsx')
  check('JobForm no longer mounts the sqft labour widget', !/SmartLaborField/.test(form), '')
  check('…and mounts the smart estimate instead', /<SmartEstimateCard/.test(form), '')
  check('the old 240-minute ceiling is not in the new path',
    !/240/.test(stripComments(read('src/lib/workEstimate.ts'))), '')
  // A single visit is never called typical (the S15 rule, still true here).
  const one = learnFromCompletedVisits([{ id: 'o', status: 'completed', service_type: 'One Off',
    duration_minutes: 60, actual_minutes: 90, crew_size: 2 }] as VisitLike[])
  const e = buildWorkEstimate(serviceHistory('One Off', one.comparisons), { capacityHours: 8 })
  eq('n=1 is limited, never established', e.confidence, 'limited')
  eq('…and offers nothing', e.suggestedElapsedMinutes, null)
  check('…and the card words it as an observation',
    /observation, not a pattern/.test(read('src/components/labor/SmartEstimateCard.tsx')), '')
}

console.log('\n15. Only completed, plausible visits teach:')
{
  const noisy: VisitLike[] = [
    { id: 'n1', status: 'scheduled', service_type: 'Site Survey', duration_minutes: 60, actual_minutes: 300, crew_size: 4 },
    { id: 'n2', status: 'cancelled', service_type: 'Site Survey', duration_minutes: 60, actual_minutes: 300, crew_size: 4 },
    { id: 'n3', status: 'completed', service_type: 'Site Survey', duration_minutes: 60, actual_minutes: 1, crew_size: 4 },
    { id: 'n4', status: 'completed', service_type: 'Site Survey', duration_minutes: 60, actual_minutes: 4000, crew_size: 4 },
    { id: 'n5', status: 'completed', service_type: 'Site Survey', duration_minutes: 60, actual_minutes: null, crew_size: 4 },
  ]
  const l = learnFromCompletedVisits(noisy)
  eq('none of the five is comparable', l.coverage.comparable, 0)
  const e = buildWorkEstimate(serviceHistory('Site Survey', l.comparisons), { capacityHours: 8 })
  eq('…so there is no estimate', e.suggestedElapsedMinutes, null)
  eq('…and no crew evidence from rows that never qualified', e.crewSampleSize, 0)
  // A visit is never counted twice — a duplicated row must not inflate a sample.
  const dup = learnFromCompletedVisits([...short, ...short])
  eq('a duplicated read does not double the sample', dup.byService.find(s => s.serviceLabel === 'Filter Swap')?.sampleSize, 9)
  // The visit on screen stays out of its own history.
  const self = serviceHistory('Filter Swap', learned.comparisons, { excludeJobId: 's0' })
  eq('the visit being edited is excluded from its own history', self.sampleSize, 8)
  eq('…and readVisitLabor still refuses an unfinished one', readVisitLabor(noisy[0]).reason, 'not_completed')
}

console.log('\n16. The feedback loop cannot eat itself:')
{
  // The suggestion descends from RECORDED time and nothing else. A learner that
  // suggested from past ESTIMATES would converge on its own opinion and then
  // present the agreement as evidence — accuracy climbing while nothing about
  // the work improved. Same outcomes, wildly different plans: the offered
  // duration must not move.
  const mk = (plan: number, tag: string) => learnFromCompletedVisits(
    Array.from({ length: 6 }, (_, i) => ({
      id: `${tag}${i}`, status: 'completed', service_type: 'Panel Install',
      duration_minutes: plan, actual_minutes: 90, crew_size: 2,
    })) as VisitLike[])
  const wild = buildWorkEstimate(serviceHistory('Panel Install', mk(20, 'a').comparisons), { capacityHours: 8 })
  const tame = buildWorkEstimate(serviceHistory('Panel Install', mk(300, 'b').comparisons), { capacityHours: 8 })
  eq('a 20-minute plan and a 90-minute outcome suggests', wild.suggestedElapsedMinutes, 90)
  eq('a 300-minute plan and the SAME outcome suggests the same', tame.suggestedElapsedMinutes, 90)
  check('…so the plan cannot steer the suggestion',
    wild.suggestedElapsedMinutes === tame.suggestedElapsedMinutes, 'the estimate leaked into the estimate')
  eq('…and labour likewise comes from recorded time × crew', wild.suggestedLaborMinutes, 180)
  // Structural: no planned figure is readable from the engine at all.
  const src = stripComments(read('src/lib/workEstimate.ts'))
  check('the engine never reads a planned figure',
    !/medianEstimatedMinutes|duration_minutes|estimatedMinutes/.test(src),
    'a planned figure is readable from the engine')
  // Completing a visit must not re-read the history it is about to join — and
  // the read must not be gated on completion either, which is how the card came
  // to render nothing at all on every new job.
  const form = stripComments(read('src/components/schedule/JobForm.tsx'))
  const at = form.indexOf('loadCompletedVisitLearning(supabase')
  const effect = form.slice(Math.max(0, at - 700), at + 400)
  check('the learning read is not gated on completion',
    !/status !== 'completed'/.test(effect), 'the estimate card would be starved on a new job')
  check('…and runs once per form, not on every status change',
    /\}, \[supabase\]\)/.test(effect), 'status is a dependency of the learning read')
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSION 47 — WORK SESSIONS. The labour half of this engine now has a real
// source, and the whole risk is that it gets confused with the elapsed half or
// wears a claim it has not earned.
// ═══════════════════════════════════════════════════════════════════════════

/** A visit whose work sessions are known. Mirrors what the loader builds from
 *  lib/workSession's sessionTotals — days of (minutes × workers). */
const withSessions = (
  id: string, service: string, plan: number,
  days: { minutes: number; workers: number }[],
  opts?: { stated?: boolean; open?: boolean; crewSize?: number | null },
): VisitLike => {
  const elapsed = days.reduce((s, d) => s + d.minutes, 0)
  const labour = days.reduce((s, d) => s + d.minutes * d.workers, 0)
  const w = new Set(days.map(d => d.workers))
  return {
    id, status: 'completed', service_type: service,
    duration_minutes: plan, actual_minutes: elapsed,
    crew_size: opts?.crewSize === undefined ? 1 : opts.crewSize,
    sessions: {
      count: days.length, elapsedMinutes: elapsed, laborMinutes: labour,
      open: opts?.open ?? false,
      attendanceStated: opts?.stated ?? true,
      workers: w.size === 1 ? days[0].workers : null,
    },
  }
}

console.log('\n17. Work-session labour beats planned crew:')
{
  // The owner's own example: 200m × 1 worker, then 310m × 2 workers.
  // Elapsed 510m. Labour 820m. No job-level multiplication can produce that pair.
  const v = withSessions('mix', 'Deck Rebuild', 480,
    [{ minutes: 200, workers: 1 }, { minutes: 310, workers: 2 }], { crewSize: 1 })
  const r = readVisitLabor(v)
  eq('elapsed is the summed session time', r.comparison!.actualMinutes, 510)
  eq('labour is Σ(each day × that day\'s workers)', r.comparison!.laborMinutes, 820)
  eq('…and it is labelled as measured', r.comparison!.laborSource, 'work_sessions')
  check('⛔ NOT actual_minutes × planned crew_size',
    r.comparison!.laborMinutes !== r.comparison!.actualMinutes * 1, 'the plan was used instead')
  eq('…crew is null, because it VARIED day to day', r.comparison!.crewSize, null)
  check('…so labour is known while crew is not — separately knowable',
    r.comparison!.laborMinutes != null && r.comparison!.crewSize == null)

  // The same visit with a planned crew of 3 must not move the labour figure.
  const planted = readVisitLabor({ ...v, crew_size: 3 })
  eq('a different planned crew cannot change measured labour', planted.comparison!.laborMinutes, 820)
}

console.log('\n18. Clock and carried sessions are the PLAN, and say so:')
{
  // Read from the live triggers: bank_job_clock_session and
  // carry_forward_job_actual_minutes both write workers = jobs.crew_size. Their
  // labour is real minutes × the plan, which is exactly the figure that must not
  // be dressed up as attendance.
  const clocked = withSessions('c1', 'Duct Run', 300,
    [{ minutes: 240, workers: 2 }], { stated: false, crewSize: 2 })
  const r = readVisitLabor(clocked)
  eq('the arithmetic still uses the sessions', r.comparison!.laborMinutes, 480)
  eq('…but the CLAIM is planned_crew, not work_sessions', r.comparison!.laborSource, 'planned_crew')
  eq('…and the crew is reported, because the sessions agree', r.comparison!.crewSize, 2)

  const stated = readVisitLabor({ ...clocked, id: 'c2', sessions: { ...clocked.sessions!, attendanceStated: true } })
  eq('the same numbers, hand-logged, ARE measured', stated.comparison!.laborSource, 'work_sessions')
  eq('…with the identical figure', stated.comparison!.laborMinutes, 480)
}

console.log('\n19. A partial session set never contaminates learning:')
{
  const open = withSessions('o1', 'Site Prep', 300, [{ minutes: 200, workers: 2 }], { open: true })
  const ro = readVisitLabor(open)
  eq('an OPEN stretch → labour unknown', ro.comparison!.laborMinutes, null)
  eq('…not zero', ro.comparison!.laborSource, 'none')
  eq('…and no crew claim either', ro.comparison!.crewSize, null)
  check('…while the ELAPSED comparison still stands', ro.comparison!.actualMinutes === 200)

  // Sessions that do not add up to the visit's own actual_minutes are not all
  // of them. Session 47 makes the database enforce that equality, so a mismatch
  // means a truncated or filtered read — and summing part of a job understates
  // its labour without saying so.
  const partial: VisitLike = {
    id: 'p1', status: 'completed', service_type: 'Site Prep',
    duration_minutes: 300, actual_minutes: 510, crew_size: 2,
    sessions: { count: 1, elapsedMinutes: 200, laborMinutes: 400, open: false, attendanceStated: true, workers: 2 },
  }
  const rp = readVisitLabor(partial)
  eq('sessions that disagree with actual_minutes → labour unknown', rp.comparison!.laborMinutes, null)
  eq('…and NOT the planned-crew fallback, which would look like an answer', rp.comparison!.laborSource, 'none')
  check('⛔ and never 0', rp.comparison!.laborMinutes !== 0)

  // Those unknowns must shrink the labour sample, not join it.
  const l = learnFromCompletedVisits([open, partial,
    ...Array.from({ length: 5 }, (_, i) => withSessions(`g${i}`, 'Site Prep', 300, [{ minutes: 200, workers: 2 }]))])
  const h = serviceHistory('Site Prep', l.comparisons)
  eq('7 comparable visits', h.sampleSize, 7)
  eq('…but only 5 back the labour figure', h.laborSampleSize, 5)
  eq('…and the median is of those 5 alone', h.medianLaborMinutes, 400)
}

console.log('\n20. Multi-day project learning, end to end:')
{
  // Six comparable completed projects, each two days: 8h with 2 workers then
  // 4h with 2. Elapsed 720m = 1.5 working days on an 8h day; labour 1440m = 24h.
  const projects = Array.from({ length: 6 }, (_, i) =>
    withSessions(`mp${i}`, 'Warehouse Fit-Out', 600,
      [{ minutes: 480, workers: 2 }, { minutes: 240, workers: 2 }], { crewSize: 2 }))
  const l = learnFromCompletedVisits(projects)
  const e = buildWorkEstimate(serviceHistory('Warehouse Fit-Out', l.comparisons), { capacityHours: 8 })
  eq('confidence is established', e.confidence, 'established')
  eq('…elapsed is 12h', e.suggestedElapsedMinutes, 720)
  eq('…which is multi-day', e.scale, 'multi_day')
  eq('…and reads as a day and a half', formatEstimatedDuration(720, e.workdayMinutes), '1 day 4h')
  eq('…typical crew 2', e.typicalCrewSize, 2)
  eq('…and 24 labour-hours', formatLaborHours(e.suggestedLaborMinutes), '24 labour-hours')
  eq('…measured, not planned', e.laborSource, 'work_sessions')
  eq('…backed by all six', e.laborSampleSize, 6)
  check('⛔ nothing is clamped to the old 240-minute ceiling',
    (e.suggestedElapsedMinutes ?? 0) > 240, `got ${e.suggestedElapsedMinutes}`)

  // ⛔ Same numbers, any name. Session 47 changed nothing about that.
  for (const n of ['Warehouse Fit-Out', 'Mulch Delivery', 'Weekly Mowing', 'Interior Painting']) {
    const rows = Array.from({ length: 6 }, (_, i) =>
      withSessions(`k${i}`, n, 600, [{ minutes: 480, workers: 2 }, { minutes: 240, workers: 2 }], { crewSize: 2 }))
    const k = buildWorkEstimate(serviceHistory(n, learnFromCompletedVisits(rows).comparisons), { capacityHours: 8 })
    check(`"${n}" gets the identical answer`,
      k.suggestedElapsedMinutes === 720 && k.suggestedLaborMinutes === 1440 && k.scale === 'multi_day',
      `${k.suggestedElapsedMinutes}/${k.suggestedLaborMinutes}/${k.scale}`)
  }

  // A mixed bucket takes the WEAKER label: one planned-crew visit among five
  // measured ones means the bucket's labour is not wholly measured.
  const mixed = learnFromCompletedVisits([
    ...projects.slice(0, 5),
    withSessions('mx', 'Warehouse Fit-Out', 600, [{ minutes: 720, workers: 2 }], { stated: false, crewSize: 2 }),
  ])
  eq('one planned-crew visit downgrades the bucket',
    serviceHistory('Warehouse Fit-Out', mixed.comparisons).laborSource, 'planned_crew')
}

console.log('\n21. Day Suggestions and the Smart Estimate agree:')
{
  // Session 46 is not rewritten; it is the SAME function. Established or
  // unknown, both surfaces must say the same word about the same history —
  // otherwise a card offers a duration the scheduler will not fit, or refuses
  // one the scheduler is happy to use.
  const cases: { name: string; visits: VisitLike[] }[] = [
    { name: 'multi-day project (n=6)', visits: Array.from({ length: 6 }, (_, i) =>
        withSessions(`a${i}`, 'Warehouse Fit-Out', 600, [{ minutes: 480, workers: 2 }, { minutes: 240, workers: 2 }])) },
    { name: 'short repeat work (n=9)', visits: short },
    { name: 'thin history (n=2)', visits: short.slice(0, 2) },
    { name: 'no history', visits: [] },
  ]
  for (const c of cases) {
    const svc = c.visits[0]?.service_type ?? 'Nothing At All'
    const h = serviceHistory(svc, learnFromCompletedVisits(c.visits).comparisons)
    const card = buildWorkEstimate(h, { capacityHours: 8 })
    const scheduler = resolveDuration(null, h)
    eq(`${c.name}: same minutes`, card.suggestedElapsedMinutes, scheduler.minutes)
    eq(`${c.name}: same provenance`, card.suggestedSource, scheduler.source)
    check(`${c.name}: "established" means the same thing on both`,
      (card.confidence === 'established') === (scheduler.source === 'learned'),
      `card ${card.confidence} vs scheduler ${scheduler.source}`)
  }
  // And the scheduler still prefers the owner's own estimate over any of it.
  const h = serviceHistory('Filter Swap', learned.comparisons)
  eq('the owner\'s own estimate still outranks history', resolveDuration(90, h).minutes, 90)
  check('Session 46 owns no threshold of its own',
    /MIN_SERVICE_SAMPLE|established/.test(read('src/lib/dayFit.ts')), '')
}

// ── 22. THE LOADER'S OWN WIRING ──────────────────────────────────────────────
// Everything above hands the engine hand-built session facts, which proves the
// JUDGEMENT and not the PLUMBING. A mutation that swapped the loader's
// `elapsedMinutes: t.elapsedMinutes` for `t.labourMinutes` sailed through every
// one of them: elapsed and labour would arrive already confused, and the engine
// would faithfully reason about the wrong pair. So this section drives the real
// loader against a stub client that answers both reads.
async function loaderChecks() {
  console.log('\n22. The loader maps Session 47\'s totals to the right fields:')

  const stub = (jobs: unknown[], sessions: unknown[], opts?: { sessionsThrow?: boolean }) => {
    const calls: { table: string; eq: [string, unknown][]; ins: unknown[] }[] = []
    return {
      from(table: string) {
        const rec = { table, eq: [] as [string, unknown][], ins: [] as unknown[] }
        calls.push(rec)
        const rows = table === 'jobs' ? jobs : sessions
        const b: Record<string, unknown> = {}
        Object.assign(b, {
          select: () => b,
          eq: (c: string, v: unknown) => { rec.eq.push([c, v]); return b },
          in: (_c: string, v: unknown[]) => {
            if (opts?.sessionsThrow) throw new Error('transport exploded')
            rec.ins.push(v); return b
          },
          order: () => b,
          limit: () => b,
          then: (r: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(r),
        })
        return b
      },
      calls,
    }
  }

  // Six two-day projects: 480m×2 then 240m×2. Elapsed 720, labour 1440.
  const jobRows = Array.from({ length: 6 }, (_, i) => ({
    id: `j${i}`, status: 'completed', service_type: 'Warehouse Fit-Out',
    scheduled_date: '2026-05-01', duration_minutes: 600, actual_minutes: 720, crew_size: 2,
  }))
  const sessionRows = jobRows.flatMap(j => ([
    { id: `${j.id}a`, user_id: 'owner', job_id: j.id, worked_on: '2026-05-01', started_at: null, ended_at: null, minutes: 480, workers: 2, labour_minutes: 960, note: null, source: 'manual', created_at: '', updated_at: '' },
    { id: `${j.id}b`, user_id: 'owner', job_id: j.id, worked_on: '2026-05-02', started_at: null, ended_at: null, minutes: 240, workers: 2, labour_minutes: 480, note: null, source: 'manual', created_at: '', updated_at: '' },
  ]))

  {
    const s = stub(jobRows, sessionRows)
    const load = await loadCompletedVisitLearning(s as never, 'owner')
    eq('the load succeeds', load.outcome, 'ok')
    const c = load.outcome === 'ok' ? load.learning.comparisons[0] : null
    eq('ELAPSED is the summed session minutes — not the labour', c?.actualMinutes, 720)
    eq('LABOUR is the summed person-minutes — not the elapsed', c?.laborMinutes, 1440)
    check('…and the two are not interchangeable', c!.actualMinutes !== c!.laborMinutes)
    eq('…labelled as measured, because every session was hand-logged', c?.laborSource, 'work_sessions')
    eq('…and the crew is the count the sessions agree on', c?.crewSize, 2)
    const e = load.outcome === 'ok'
      ? buildWorkEstimate(serviceHistory('Warehouse Fit-Out', load.learning.comparisons), { capacityHours: 8 })
      : null
    eq('end to end: 1 day 4h on site', formatEstimatedDuration(e!.suggestedElapsedMinutes, e!.workdayMinutes), '1 day 4h')
    eq('end to end: 24 labour-hours', formatLaborHours(e!.suggestedLaborMinutes), '24 labour-hours')
    eq('end to end: measured', e!.laborSource, 'work_sessions')
    // Tenancy, on the wire: both reads scoped, and the session read asks only
    // for job ids that came from this owner's own jobs.
    const jobsCall = s.calls.find(c2 => c2.table === 'jobs')
    const sessCall = s.calls.find(c2 => c2.table === 'job_work_sessions')
    check('the jobs read is scoped to the caller',
      jobsCall!.eq.some(([c2, v]) => c2 === 'user_id' && v === 'owner'), JSON.stringify(jobsCall?.eq))
    check('the session read asks only for this owner\'s job ids',
      Array.isArray(sessCall?.ins[0]) && (sessCall!.ins[0] as string[]).every(id => jobRows.some(j => j.id === id)),
      JSON.stringify(sessCall?.ins[0]))
  }

  {
    // A foreign session that somehow reached the client is dropped, not summed.
    // (The composite FK makes this unreachable in the database; the filter is
    // what stands if a service-role client is ever passed.)
    const foreign = sessionRows.map(r => ({ ...r, user_id: 'someone-else' }))
    const load = await loadCompletedVisitLearning(stub(jobRows, foreign) as never, 'owner')
    const c = load.outcome === 'ok' ? load.learning.comparisons[0] : null
    eq('a foreign session contributes NO labour', c?.laborSource, 'planned_crew')
    eq('…and the figure falls back to the plan, correctly labelled', c?.laborMinutes, 1440)
    check('…while elapsed is untouched, because it never came from there',
      c?.actualMinutes === 720)
  }

  {
    // A session read that THROWS costs the labour claim and nothing else.
    const load = await loadCompletedVisitLearning(
      stub(jobRows, sessionRows, { sessionsThrow: true }) as never, 'owner')
    eq('a thrown session read still loads', load.outcome, 'ok')
    const c = load.outcome === 'ok' ? load.learning.comparisons[0] : null
    eq('…elapsed is unaffected', c?.actualMinutes, 720)
    eq('…and labour degrades to the plan, never to "measured"', c?.laborSource, 'planned_crew')
  }

  console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ smart-estimate: every rule holds')
  process.exit(failures ? 1 : 0)
}

// ⚠️ These scripts compile to CJS — no top-level await. The async section runs
// through .then(), which is also where the final verdict is printed.
// ⚠️ NO trailing process.exit here. One used to sit at the end of this file and
// would fire the instant loaderChecks() suspended on its first await — killing
// the process before a single loader check ran, and exiting 0 while reporting
// nothing. The verdict is printed and the code returned INSIDE the async
// function; a rejection is failed loudly rather than swallowed.
loaderChecks().catch(e => {
  console.log(`\n✗ loader checks threw: ${String(e)}`)
  process.exit(1)
})
