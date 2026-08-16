// ── Verify: Day Suggestions answer "does this REALISTICALLY fit?" ────────────
//   npm run verify:day-fit
//
// WHY THIS SCRIPT EXISTS
// Session 46 measured the live engines recommending a 5-hour, 3-worker project
// into a route day with ~50 spare minutes (the placement totalled 11 planned
// hours on an 8-hour day — capacity was never consulted), and reading two
// $1,500 patio installs 90 days apart as "they visit ~every 90 days → biweekly
// fits". Every failure mode here is a recommendation that is arithmetically
// derivable and operationally false — none is a type error, and each one, if it
// regresses, regresses silently. So the rules are pinned against the REAL
// modules with hand-derived fixtures. Deterministic, no network.
//
// THE RULES PINNED (the session's regression matrix):
//   1  a short job fits an open day
//   2  a large job does NOT fit a committed route day
//   3  ...and the first day with genuine room is named instead
//   4  an unknown duration is never a confident fit (and never becomes 0 or 45)
//   5  crew multiplies labour: hours × workers, not hours
//   6  a one_time service NEVER gets a recurring recommendation
//   7  a recurring-capable service with a real cadence MAY
//   8  service NAMES control nothing — no keyword tables anywhere in the engine
//   9  learned duration is used only at the canonical sample threshold
//  10  suggestion surfaces cannot write (deposit gate & schedule doors stay S36's)
//  11  a preferred day influences ranking but cannot force an over-capacity day
//  12  cancelled visits do not consume capacity; only open visits are loaded
//  13  tenancy: every read is user-scoped; the engine only sees handed rows
//  14  a failed read reports 'unavailable' / unknown — never free capacity

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  dayFit, fitReason, firstFittingDay, resolveDuration, workersAvailableOn,
  FIT_BUFFER_MIN, type CandidateWork, type DayFitInput,
} from '../src/lib/dayFit'
import {
  recurrenceEligibilityFor, cadenceFromGap, mayRecommendRecurring, MAX_CADENCE_GAP_DAYS,
} from '../src/lib/serviceRecurrence'
import { recommendScheduleDays } from '../src/lib/route'
import { serviceHistory, readVisitLabor, MIN_SERVICE_SAMPLE, type LaborComparison } from '../src/lib/estimateVsActual'
import { buildSuggestions, type SuggestionContext } from '../src/lib/suggestions'
import type { Job, Quote, JobRecurrence, Property, Customer } from '../src/types'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => (cond ? ok(n) : fail(n, d))
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, Object.is(a, b), `expected ${String(b)}, got ${String(a)}`)
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ── Fixtures ─────────────────────────────────────────────────────────────────
// A committed route day: six 60-minute solo stops on an 8-hour day.
// estimateDayLoad charges 6×60 labour + 6×10 stops = 420 used, 60 spare.
const routeDay: DayFitInput = {
  visits: Array.from({ length: 6 }, () => ({ duration_minutes: 60, status: 'scheduled', crew_size: 1, service_type: 'Recurring Service A' })),
  capacityHours: 8, workers: 1,
}
const emptyDay: DayFitInput = { visits: [], capacityHours: 8, workers: 1 }
const project: CandidateWork = { minutes: 300, source: 'estimate', crewSize: 3 }   // ~5h × 3
const soloProject: CandidateWork = { minutes: 300, source: 'estimate', crewSize: 1 }
const shortVisit: CandidateWork = { minutes: 45, source: 'estimate', crewSize: 1 }
const unknownJob: CandidateWork = { minutes: null, source: 'unknown', crewSize: 1 }

console.log('\n1. A short job fits an open day:')
{
  const f = dayFit(shortVisit, emptyDay)
  eq('45m into an empty 8h day → fits', f.verdict, 'fits')
  check('…and the reason quotes real numbers', /Fits/.test(fitReason(f, shortVisit)), fitReason(f, shortVisit))
}

console.log('\n2. A large job does not fit a committed route day:')
{
  const f = dayFit(soloProject, routeDay)
  eq('5h solo into 60 spare minutes → over', f.verdict, 'over')
  check('…the reason names the ROUTE, structurally (≥3 stops), not by service name',
    /route/.test(fitReason(f, soloProject)), fitReason(f, soloProject))
  const crewed = dayFit(project, routeDay)
  eq('5h × 3 workers with 1 available → over', crewed.verdict, 'over')
}

console.log('\n3. The first day with genuine room is named instead:')
{
  const alt = firstFittingDay(soloProject, [
    { date: '2026-08-16', input: routeDay },
    { date: '2026-08-18', input: routeDay },
    { date: '2026-08-20', input: emptyDay },
  ])
  eq('…skips both full days and lands on the open one', alt?.date, '2026-08-20')
  eq('…with a clean fits verdict', alt?.fit.verdict, 'fits')
}

console.log('\n4. Unknown stays unknown — never 0, never 45:')
{
  const f = dayFit(unknownJob, emptyDay)
  eq('no duration → verdict unknown even on an EMPTY day', f.verdict, 'unknown')
  eq('…for the stated reason', f.unknownReason, 'duration_unknown')
  check('…and the sentence says review, not fits', /unknown.*review/i.test(fitReason(f, unknownJob)), fitReason(f, unknownJob))
  const r = resolveDuration(null, null)
  eq('resolveDuration(null, no history) → null minutes', r.minutes, null)
  eq('…source unknown', r.source, 'unknown')
  eq('resolveDuration(0, …) is unknown too — 0 is "not sized", not "instant"', resolveDuration(0, null).minutes, null)
}

console.log('\n5. Crew multiplies labour capacity:')
{
  // 3h × 4 workers = 12 labour-hours into an 8h day with 2 workers (16h pool,
  // empty) → fits with room; the same job with 1 worker available cannot.
  const fourCrew: CandidateWork = { minutes: 180, source: 'estimate', crewSize: 4 }
  const twoWorkers = dayFit(fourCrew, { visits: [], capacityHours: 8, workers: 2 })
  eq('12 labour-hours into a 16h pool → fits', twoWorkers.verdict, 'fits')
  const oneWorker = dayFit(fourCrew, { visits: [], capacityHours: 8, workers: 1 })
  eq('the same job with one worker → over (3h gap on a calendar is not 4 people)', oneWorker.verdict, 'over')
  // Labour accounting is real arithmetic, not a flag: candidate labour = (180+10)×4.
  eq('…candidate labour-minutes = (180+10)×4', twoWorkers.candidateLaborMin, 760)
  // The clock window still binds a crew: 11h together does not fit an 8h day.
  const marathon = dayFit({ minutes: 660, source: 'estimate', crewSize: 3 }, { visits: [], capacityHours: 8, workers: 3 })
  eq('an 11h crew job does not fit an 8h window however many people', marathon.verdict, 'over')
  // Workforce unknown + a crew job → unknown, stated; never a clock-only "fits".
  const unknownCrew = dayFit(project, { visits: [], capacityHours: 8, workers: null })
  eq('workers unknown + multi-worker job → unknown', unknownCrew.verdict, 'unknown')
  eq('…for the stated reason', unknownCrew.unknownReason, 'workforce_unknown')
  // A day with everyone booked off has no labour at all.
  eq('workers = 0 → nothing fits', dayFit(shortVisit, { visits: [], capacityHours: 8, workers: 0 }).verdict, 'over')
  // workersAvailableOn: PTO subtracts; an empty roster is the solo owner (1, not 0).
  const techs = [{ id: 't1', is_active: true }, { id: 't2', is_active: true }, { id: 't3', is_active: false }]
  eq('2 active techs, one on PTO that day → 1', workersAvailableOn('2026-08-20', techs, [{ technician_id: 't1', date: '2026-08-20' }]), 1)
  eq('no technician rows at all → the solo owner works (1)', workersAvailableOn('2026-08-20', [], []), 1)
}

console.log('\n6/7. Recurrence eligibility — the owner’s word first, evidence second:')
{
  const templates = [
    { name: 'Patio Installation', recurrence: 'one_time' },
    { name: 'Maintenance Visit', recurrence: 'recurring_ok' },
    { name: 'Route Service', recurrence: 'usually_recurring' },
  ]
  eq('configured one_time resolves', recurrenceEligibilityFor('Patio Installation', templates), 'one_time')
  eq('name matching is case/space-insensitive, never fuzzy', recurrenceEligibilityFor('  patio installation ', templates), 'one_time')
  eq('an unlisted service is unconfigured', recurrenceEligibilityFor('Something Else', templates), 'unconfigured')
  eq('a 7-day rhythm is weekly evidence', cadenceFromGap(7), 'weekly')
  eq('a 14-day rhythm is biweekly evidence', cadenceFromGap(14), 'biweekly')
  eq(`beyond ${MAX_CADENCE_GAP_DAYS} days there is NO cadence a plan can encode`, cadenceFromGap(90), null)
  eq('one_time + even perfect weekly evidence → never', mayRecommendRecurring('one_time', 'weekly'), false)
  eq('recurring_ok + weekly evidence → allowed', mayRecommendRecurring('recurring_ok', 'weekly'), true)
  eq('usually_recurring + no evidence → still no invented cadence', mayRecommendRecurring('usually_recurring', null), false)
  eq('unconfigured + real evidence → allowed (behaviour outranks absence of config)', mayRecommendRecurring('unconfigured', 'biweekly'), true)
}

// The advisor end-to-end: buildSuggestions over a hand-built context.
const mkJob = (id: string, date: string, svc: string, over: Partial<Job> = {}): Job => ({
  id, customer_id: 'cust1', property_id: null, quote_id: null, recurrence_id: null,
  title: svc, service_type: svc, status: 'completed', scheduled_date: date,
  start_time: null, duration_minutes: 60, actual_minutes: null, price: 200,
  is_initial_visit: false, crew_size: 1,
  customers: { id: 'cust1', name: 'Casey Fixture' } as unknown as Job['customers'],
  properties: null, ...over,
} as unknown as Job)

const baseCtx = (jobs: Job[], serviceTemplates: SuggestionContext['serviceTemplates']): SuggestionContext => ({
  today: '2026-08-13', crewCost: 40, targetRevPerHour: 60,
  pricingConfig: { baseCharge: 28, mowRatePer1000: 15, budgetMult: 0.85, recommendedMult: 1, premiumMult: 1.2, marketMult: 1, travelRate: 1.5, travelRatePerKm: 1.5 } as unknown as SuggestionContext['pricingConfig'],
  seasons: { lawn: null, snow: null } as unknown as SuggestionContext['seasons'],
  baseCoord: null, preferredDays: [], capacityHours: 8,
  jobs, quotes: [] as Quote[], recurrences: {} as Record<string, JobRecurrence>,
  properties: [] as Property[],
  customers: [{ id: 'cust1', name: 'Casey Fixture', created_at: '2026-01-01' } as unknown as Customer],
  invoices: [], lineItemsByJob: {}, neighborLeads: [],
  invoicedJobIds: new Set(jobs.map(j => j.id)),
  dismissedKeys: new Set(), workStart: '08:00', quoteOutcomes: [],
  serviceTemplates,
})
const convertCards = (ctx: SuggestionContext) => buildSuggestions(ctx).filter(s => s.id.startsWith('convert-'))

console.log('\n6b. End-to-end: one_time forbids, gaps that are not cadences forbid:')
{
  // The measured production failure: two projects 90 days apart, unconfigured.
  const farApart = baseCtx([mkJob('a', '2026-05-01', 'Patio Installation'), mkJob('b', '2026-07-30', 'Patio Installation')], [])
  eq('90-day-apart one-offs (unconfigured) → NO recurring card', convertCards(farApart).length, 0)
  // Weekly behaviour but the owner said one_time → still never.
  const weeklyButOneTime = baseCtx(
    [mkJob('a', '2026-07-16', 'Deep Clean'), mkJob('b', '2026-07-23', 'Deep Clean'), mkJob('c', '2026-07-30', 'Deep Clean')],
    [{ name: 'Deep Clean', recurrence: 'one_time' }])
  eq('weekly-looking visits of a one_time service → NO recurring card', convertCards(weeklyButOneTime).length, 0)
}

console.log('\n7b. End-to-end: a real cadence on an eligible service still converts:')
{
  const weekly = baseCtx(
    [mkJob('a', '2026-07-16', 'Maintenance Visit'), mkJob('b', '2026-07-23', 'Maintenance Visit'), mkJob('c', '2026-07-30', 'Maintenance Visit')],
    [{ name: 'Maintenance Visit', recurrence: 'recurring_ok' }])
  const cards = convertCards(weekly)
  eq('weekly-gap visits on a recurring_ok service → the card fires', cards.length, 1)
  check('…recommending weekly, from the observed gap', cards[0]?.action.label.includes('weekly'), cards[0]?.action.label)
  check('…and the why names the template support', cards[0]?.why.some(w => /service template/i.test(w)), JSON.stringify(cards[0]?.why))
  // Same behaviour, no template row at all — behaviour is evidence enough.
  const unconfigured = baseCtx(
    [mkJob('a', '2026-07-16', 'Weekly Service X'), mkJob('b', '2026-07-23', 'Weekly Service X'), mkJob('c', '2026-07-30', 'Weekly Service X')], [])
  eq('the same rhythm, unconfigured → still fires', convertCards(unconfigured).length, 1)
}

console.log('\n8. Service names control nothing:')
{
  // The SAME visit pattern under two arbitrary names → the same outcome.
  const nameA = baseCtx([mkJob('a', '2026-05-01', 'Zowtrix Prime'), mkJob('b', '2026-07-30', 'Zowtrix Prime')], [])
  const nameB = baseCtx([mkJob('a', '2026-05-01', 'Lawn Mowing'), mkJob('b', '2026-07-30', 'Lawn Mowing')], [])
  eq('a 90-day gap is no cadence whatever the service is called (invented name)', convertCards(nameA).length, 0)
  eq('…including an industry-sounding name', convertCards(nameB).length, 0)
  // And the new engines carry no keyword tables at all.
  for (const p of ['src/lib/dayFit.ts', 'src/lib/dayFitLoad.ts', 'src/lib/serviceRecurrence.ts']) {
    const src = read(p)
    check(`${p} never matches service names against industry words`,
      !/\b(mow|mulch|lawn|snow|paint|hvac|plumb|clean|pool|pest)\w*\s*[)|\]]*\s*\.test|\/(mow|mulch|lawn|snow|paint|hvac|plumb|clean|pool|pest)/i.test(src),
      'found what looks like a service-name keyword test')
  }
}

console.log('\n9. Learned duration only at the canonical threshold:')
{
  const cmp = (n: number, svc: string): LaborComparison[] =>
    Array.from({ length: n }, (_, i) =>
      readVisitLabor({ id: `v${i}`, status: 'completed', service_type: svc, duration_minutes: 30, actual_minutes: 25 + (i % 3) }).comparison!)
  const enough = serviceHistory('Fixture Service', cmp(MIN_SERVICE_SAMPLE, 'Fixture Service'))
  const few = serviceHistory('Fixture Service', cmp(MIN_SERVICE_SAMPLE - 1, 'Fixture Service'))
  check('the canonical primitive marks n≥MIN established', enough.established, `n=${enough.sampleSize}`)
  const rEnough = resolveDuration(null, enough)
  eq('…so resolveDuration uses the learned median', rEnough.source, 'learned')
  check('…a real number', (rEnough.minutes ?? 0) > 0, String(rEnough.minutes))
  const rFew = resolveDuration(null, few)
  eq(`n=${MIN_SERVICE_SAMPLE - 1} is NOT typical — stays unknown`, rFew.source, 'unknown')
  eq('…null minutes', rFew.minutes, null)
  // The job's own estimate outranks history — precedence, not blending.
  eq('an own estimate wins over history', resolveDuration(120, enough).minutes, 120)
  eq('…and is labelled as the estimate', resolveDuration(120, enough).source, 'estimate')
}

console.log('\n10. Suggestion surfaces cannot write (S36 doors stay the only doors):')
{
  for (const p of ['src/components/schedule/BestDaySuggestions.tsx', 'src/components/schedule/WeeklyScheduler.tsx', 'src/lib/dayFit.ts', 'src/lib/dayFitLoad.ts']) {
    const src = read(p)
    check(`${p} performs no writes`, !/\.(insert|update|upsert|delete)\s*\(/.test(src),
      'a suggestion surface must never write — scheduling goes through the S36-gated doors')
  }
}

console.log('\n11. A preferred day influences but cannot force an over-capacity day:')
{
  // Wednesday is the customer's preferred day AND heavily committed; Thursday is
  // open. With fit wired in, no lens may hand Wednesday out.
  const wed = '2026-08-19', thu = '2026-08-20' // Wed/Thu
  const jobs = Array.from({ length: 6 }, (_, i) => ({
    id: `w${i}`, scheduled_date: wed, lat: 51.04, lng: -114.07, durationMin: 60, value: 100,
  }))
  const dayInputs: Record<string, DayFitInput> = { [wed]: routeDay, [thu]: emptyDay }
  const modes = recommendScheduleDays({ lat: 51.041, lng: -114.071 }, jobs, {
    fromISO: '2026-08-13', preferredDays: [3, 4], base: { lat: 51.05, lng: -114.08 },
    targetHours: 5, targetValue: 1500,
    customerPreferredDays: [3], // Wednesday
    fitFor: date => dayFit(soloProject, dayInputs[date] ?? emptyDay),
  })
  check('density does not pick the preferred-but-full day', modes.density?.date !== wed, `picked ${modes.density?.date}`)
  check('revenue does not pick the preferred-but-full day', modes.revenue?.date !== wed, `picked ${modes.revenue?.date}`)
  check('…the fit verdict travels on the plan', modes.density?.fit?.verdict !== undefined, 'fit missing from DayPlan')
  // Same shape WITHOUT the fit oracle = the old behaviour (proves the lens gate
  // is doing the work, not the fixture).
  const ungated = recommendScheduleDays({ lat: 51.041, lng: -114.071 }, jobs, {
    fromISO: '2026-08-13', preferredDays: [3, 4], base: { lat: 51.05, lng: -114.08 },
    targetHours: 5, targetValue: 1500, customerPreferredDays: [3],
  })
  eq('(control) without fit, density still walks into the full preferred day', ungated.density?.date, wed)
}

console.log('\n12. Cancelled visits do not consume capacity; only open visits load:')
{
  const cancelled: DayFitInput = {
    visits: Array.from({ length: 6 }, () => ({ duration_minutes: 60, status: 'cancelled', crew_size: 1 })),
    capacityHours: 8, workers: 1,
  }
  eq('a day of cancelled visits is an open day', dayFit(soloProject, cancelled).verdict, 'fits')
  const src = read('src/lib/dayFitLoad.ts')
  check('the loader reads only scheduled/in_progress visits',
    /\.in\('status',\s*\['scheduled',\s*'in_progress'\]\)/.test(src), 'status filter missing')
}

console.log('\n13. Tenancy — every read scoped, the engine pure:')
{
  // Per-READ-BLOCK scoping, not a whole-file count: a count can be satisfied by
  // a code COMMENT that quotes the filter (this file's tenancy header does),
  // which would let a real read lose its scope unnoticed. Each supabase.from()
  // block must itself carry the filter, up to that read's closing paren-chain.
  const load = read('src/lib/dayFitLoad.ts')
  const blocks = load.split(/supabase\.from\(/).slice(1)
  // Six since Session 67: the four original reads plus worker_availability
  // (the standard week) and crews (names for the staffing warnings).
  check('the loader has its six reads', blocks.length === 6, `found ${blocks.length}`)
  for (const b of blocks) {
    const table = b.match(/^'([a-z_]+)'/)?.[1] ?? '?'
    check(`the ${table} read is tenant-scoped in ITS OWN call chain`,
      /jobs|business_settings|technicians|pto_entries|worker_availability|crews/.test(table)
      && /\.eq\('user_id', userId\)/.test(b.split(/\n\s*\n/)[0]),
      `no .eq('user_id', userId) inside the ${table} read`)
  }
  check('the engine itself does no I/O', !/supabase|from\(|fetch\(/i.test(read('src/lib/dayFit.ts')), 'dayFit must stay pure')
  check('the advisor loads templates tenant-scoped',
    /from\('service_templates'\)\.select\('name, recurrence'\)\.eq\('user_id', uid\)/.test(read('src/lib/suggestionsLoad.ts')),
    'templates read missing or unscoped')
}

console.log('\n14. Failed reads stay unknown — never free capacity:')
{
  const load = read('src/lib/dayFitLoad.ts')
  check('a failed jobs read → outcome unavailable', /jRes\.error\)\s*return \{ outcome: 'unavailable'/.test(load), '')
  check('a failed settings read → outcome unavailable', /sRes\.error\)\s*return \{ outcome: 'unavailable'/.test(load), '')
  // Session 67 added the weekly pattern to this same expression. The pattern
  // is part of the WORKFORCE read on purpose: if it could fail on its own, "no
  // pattern" would silently mean "everyone works every day" — an unknown
  // turning into the most optimistic answer available. verify:availability
  // pins the workforceKnown conjunction itself.
  check('a failed workforce read → workers null (unknown), not zero',
    /workforceKnown\s*\?\s*workersAvailableOn\(date, techs, pto, \{ patterns \}\)\s*:\s*null/.test(load), '')
  // And the advisor treats the templates read as load-bearing: a failed read
  // must not resurrect a suggestion the owner configured away.
  check('suggestionsLoad honesty gate includes the templates read',
    /tplRes\.error/.test(read('src/lib/suggestionsLoad.ts')), '')
}

console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ day-fit: every rule holds')
process.exit(failures ? 1 : 0)
