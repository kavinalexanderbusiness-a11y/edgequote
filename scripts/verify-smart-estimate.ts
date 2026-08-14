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
//
// Deterministic, no network: every fixture is hand-derived below.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildWorkEstimate, workdayMinutes, formatWorkDuration, formatLaborHours,
  describeConfidence, type WorkEstimate,
} from '../src/lib/workEstimate'
import {
  serviceHistory, learnFromCompletedVisits, readVisitLabor, rollupLaborVariance,
  MIN_SERVICE_SAMPLE, type VisitLike, type LaborComparison,
} from '../src/lib/estimateVsActual'
import { resolveDuration } from '../src/lib/dayFit'
import { DEFAULT_CAPACITY_HOURS } from '../src/lib/route'

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
  eq('a null duration formats as an em dash, never a number', formatWorkDuration(null, 480), '—')
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
  // Structural, not just textual: the type the engine consumes has no money in
  // it, so there is nothing to read even if someone wanted to.
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
  check('the working day comes from the canonical route default',
    /DEFAULT_CAPACITY_HOURS/.test(src), 'the 8-hour day was re-typed instead of imported')
  eq('…which is the same number dayLoad has always used', DEFAULT_CAPACITY_HOURS, 8)

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
    { jobId: 'a', serviceKey: 'k', serviceLabel: 'K', serviceDate: null, estimatedMinutes: 60, actualMinutes: 60,  varianceMinutes: 0,   variancePct: 0,   crewSize: 1, laborMinutes: 60 },
    { jobId: 'b', serviceKey: 'k', serviceLabel: 'K', serviceDate: null, estimatedMinutes: 60, actualMinutes: 120, varianceMinutes: 60,  variancePct: 100, crewSize: 4, laborMinutes: 480 },
    { jobId: 'c', serviceKey: 'k', serviceLabel: 'K', serviceDate: null, estimatedMinutes: 60, actualMinutes: 600, varianceMinutes: 540, variancePct: 900, crewSize: 2, laborMinutes: 1200 },
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
  check('960 minutes is never shown as minutes', !/\d{3,}m/.test(formatWorkDuration(960, day)),
    formatWorkDuration(960, day))
  eq('16h on an 8h day → 2 workdays, hours kept alongside', formatWorkDuration(960, day), '2 workdays · 16h')
  eq('exactly one day is still spoken in hours', formatWorkDuration(480, day), '8h')
  eq('under an hour stays in minutes', formatWorkDuration(45, day), '45m')
  eq('…and mid-range keeps the canonical formatter', formatWorkDuration(150, day), '2h 30m')
  // Rounding direction: 9h is MORE than a working day, and "1 workday" is a
  // promise the day cannot keep.
  eq('9h ceils to 1.5 workdays, never rounds down to 1', formatWorkDuration(540, day), '1.5 workdays · 9h')
  eq('…and 10h likewise', formatWorkDuration(600, day), '1.5 workdays · 10h')
  eq('24h is 3 workdays', formatWorkDuration(1440, day), '3 workdays · 24h')
  // The owner's OWN day is the unit.
  eq('on a 10h day, 9h is within the day', formatWorkDuration(540, 600), '9h')
  eq('workdayMinutes reads the owner\'s setting', workdayMinutes(10), 600)
  eq('…an unset day falls back to the shared default', workdayMinutes(null), DEFAULT_CAPACITY_HOURS * 60)
  eq('…and a blocked (0) day is not a zero-length unit', workdayMinutes(0), DEFAULT_CAPACITY_HOURS * 60)
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
  check('the engine learns only from rows it is handed',
    !/user_id|auth|session/i.test(stripComments(read('src/lib/workEstimate.ts'))), '')
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

console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ smart-estimate: every rule holds')
process.exit(failures ? 1 : 0)
