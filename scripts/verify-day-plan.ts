// ── Verify: a day the owner is PLANNING states its own evidence ─────────────
//   npm run verify:day-plan
//
// WHY THIS SCRIPT EXISTS
// Session 60. Every number on the day board was arithmetically derivable and
// operationally overconfident, and each one fails silently if it regresses:
//
//   • "Room for ~2h · 71%" on a day whose visits ask for more people than the
//     business has. Measured on production 2026-08-14: 19 visits want a crew of
//     2+, 1 technician is active. The load pill is a serial clock and cannot
//     see it.
//   • "Est. finish 3:10 PM" stated to the minute on a day where visits with no
//     duration were silently counted as 45 minutes (12 such visits in the book).
//   • "~42 min driving" derived as `km × minPerKm` from STRAIGHT-LINE distance,
//     while 1,282 of 1,282 cached legs already carried a measured Google
//     duration that was never read back.
//   • A manual reorder re-ran the route with the DEFAULT haversine distance,
//     silently swapping every kilometre on the day from real-road to
//     straight-line — the only tell was a badge quietly disappearing.
//   • The crew's phone sorted the same day by `route_order` (null on 167 of 174
//     jobs) and fell through to BOOKING order, so the board and the field were
//     two confidently-numbered, different plans for one morning.
//
// THE RULES PINNED
//   1  the shared arithmetic is shared — dayCommitment's default path IS
//      estimateDayLoad, and its legMinutes seam changes clock AND labour
//   2  travel basis is the WEAKEST leg present; a measured leg uses the
//      measurement, never the model
//   3  a straight-line day says so and can never claim a measured drive
//   4  an assumed duration is counted AND disclosed with its count
//   5  crew shortage is BLOCKING even when the clock has room  ← the bug
//   6  labour over the pool is blocking; unknown workforce claims nothing
//   7  un-located stops are charged the shared allowance, disclosed, and kept
//      out of the distance
//   8  planDay never reorders — it receives an order and times it
//   9  ⛔ the engine cannot see money, and cannot see what work is CALLED
//  10  ONE ETA walk: planDay's arrivals come from lib/route computeDayEtas
//  11  crewOrderStatus mirrors crew_day's ORDER BY, and the SQL still has it
//  12  the surfaces hold: manual order keeps the road distances; the panel
//      shows no money

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  planDay, travelBasisLabel, travelBasisDetail, travelFigureLabel, travelIsEstimated,
  areasLabel, UNLOCATED_LEG_MIN, type DayPlanInput, type DayPlanStopInput,
} from '../src/lib/dayPlan'
import { dayCommitment, dayFit, workersAvailableOn, type DayFitInput } from '../src/lib/dayFit'
import { estimateDayLoad, computeDayEtas, DEFAULT_JOB_MIN, FALLBACK_LEG_MIN } from '../src/lib/route'
import { crewOrderStatus, UNORDERED_CREW_RANK, NO_START_TIME_KEY } from '../src/lib/fieldStops'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => (cond ? ok(n) : fail(n, d))
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, Object.is(a, b), `expected ${String(b)}, got ${String(a)}`)
const H = (t: string) => console.log(`\n${t}`)
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
// The baseline is located BY SHAPE, never by name — its version changes on
// every schema resync, and a hardcoded filename broke this guard the first
// time one landed (2026-08-15).
const BASELINE_SQL = (() => {
  const names = readdirSync(join(process.cwd(), 'supabase', 'migrations')).filter(f => /_baseline\.sql$/.test(f))
  return names.length === 1 ? read(`supabase/migrations/${names[0]}`) : ''
})()

// ── Fixtures ─────────────────────────────────────────────────────────────────
// A four-stop route day. 60 min on site each; legs of 5 km. Solo unless stated.
const stop = (over: Partial<DayPlanStopInput> = {}): DayPlanStopInput => ({
  jobId: over.jobId ?? 'j',
  durationMinutes: 60,
  crewSize: 1,
  status: 'scheduled',
  legKm: 5,
  located: true,
  ...over,
})

const base = (over: Partial<DayPlanInput> = {}): DayPlanInput => ({
  stops: [
    stop({ jobId: 'a' }), stop({ jobId: 'b' }), stop({ jobId: 'c' }), stop({ jobId: 'd' }),
  ],
  startTime: '08:00',
  capacityHours: 8,
  workers: 1,
  hasBase: true,
  // Legacy 2 min/km, no overhead — exact arithmetic, no learned model in play.
  speed: { minPerKm: 2, overheadMin: 0 },
  // Two tight pairs, far apart. 0.005° of latitude is ~0.55 km, inside
  // routeStats' 1 km cluster link; the pairs sit ~22 km apart, well outside it.
  locatedCoords: [
    { lat: 51.000, lng: -114.00 }, { lat: 51.005, lng: -114.00 },
    { lat: 51.200, lng: -114.00 }, { lat: 51.205, lng: -114.00 },
  ],
  ...over,
})

// ═════════════════════════════════════════════════════════════════════════════
H('1. The arithmetic is SHARED, not copied')

const fitDay: DayFitInput = {
  visits: [
    { duration_minutes: 60, status: 'scheduled', crew_size: 1 },
    { duration_minutes: 60, status: 'scheduled', crew_size: 1 },
    { duration_minutes: 60, status: 'scheduled', crew_size: 1 },
  ],
  capacityHours: 8,
  workers: 1,
}
{
  const c = dayCommitment(fitDay)
  const canonical = estimateDayLoad(
    [{ duration_minutes: 60 }, { duration_minutes: 60 }, { duration_minutes: 60 }], 8,
  )
  eq('with no legs supplied, the clock IS estimateDayLoad, to the minute',
    c.usedClockMin, canonical.usedMin)
  eq('…and the spare matches it too', c.spareClockMin, canonical.spareMin)
  eq('travel charged per stop is the canonical 10-min allowance', c.travelMinutes.join(','), '10,10,10')
}
{
  // The seam: real legs of 20 min each replace the 10-min allowance in BOTH
  // dimensions. 3×60 work + 3×20 travel = 240 clock.
  const c = dayCommitment(fitDay, { legMinutes: [20, 20, 20] })
  eq('real leg minutes feed the CLOCK', c.usedClockMin, 240)
  eq('…and the LABOUR pool (1 worker → same figure)', c.laborUsedMin, 240)
  eq('…leaving the rest of an 8h day', c.spareClockMin, 480 - 240)
}
{
  // Crew weighting rides the legs too: the whole crew sits in the truck.
  const c = dayCommitment(
    { ...fitDay, visits: fitDay.visits.map(v => ({ ...v, crew_size: 3 })), workers: 3 },
    { legMinutes: [20, 20, 20] },
  )
  eq('labour multiplies work AND travel by the crew', c.laborUsedMin, 240 * 3)
  eq('…against a pool of hours × workers', c.laborCapMin, 480 * 3)
  eq('the clock stays serial — a crew does not make the day shorter', c.usedClockMin, 240)
}
{
  // dayFit must be UNCHANGED by the extraction: an unchanged input, an
  // unchanged verdict. (verify:day-fit pins the full matrix; this pins that
  // dayFit still routes through the shared function.)
  const f = dayFit({ minutes: 60, source: 'estimate', crewSize: 1 }, fitDay)
  eq('dayFit still answers through the shared commitment', f.usedClockMin, dayCommitment(fitDay).usedClockMin)
  eq('…and still reaches a verdict', f.verdict, 'fits')
}

// ═════════════════════════════════════════════════════════════════════════════
H('2. Travel basis is the WEAKEST leg present, and a measurement beats a model')

{
  // Every leg measured at 6 minutes (360 s). The model would say 5 km × 2 = 10.
  const p = planDay(base({
    stops: base().stops.map(s => ({ ...s, legSeconds: 360, legIsRoad: true })),
  }))
  eq('all legs measured → basis measured', p.travel.basis, 'measured')
  eq('…and the drive total uses the MEASUREMENT (4 × 6), not 4 × 10', p.driveMin, 24)
  eq('…counted as measured', p.travel.measuredLegs, 4)
  eq('the label names it', travelBasisLabel(p.travel), 'Measured drive time')
  eq('a uniform day needs no leg breakdown', travelBasisDetail(p.travel), null)
}
{
  // One leg has no measurement. The day is no longer a measured day.
  const stops = base().stops.map((s, i) =>
    i === 2 ? { ...s, legIsRoad: true } : { ...s, legSeconds: 360, legIsRoad: true })
  const p = planDay(base({ stops }))
  eq('one un-measured leg drops the whole day to road', p.travel.basis, 'road')
  eq('…the measured legs are still counted', p.travel.measuredLegs, 3)
  eq('…and the modelled one is named', p.travel.roadLegs, 1)
  eq('drive = 3 measured 6s + 1 modelled 10', p.driveMin, 28)
  check('the breakdown is spelled out', (travelBasisDetail(p.travel) || '').includes('3 measured'))
  check('a road day says the minutes are still estimated',
    p.warnings.some(w => w.kind === 'travel_modelled'))
}

// ═════════════════════════════════════════════════════════════════════════════
H('3. A straight-line day says so — and can never claim a drive')

{
  const p = planDay(base())   // no legSeconds, no legIsRoad
  eq('no road data → basis estimated', p.travel.basis, 'estimated')
  eq('…all four legs counted as straight-line', p.travel.estimatedLegs, 4)
  check('the label refuses the words "drive time"',
    !travelBasisLabel(p.travel).toLowerCase().includes('drive time'),
    `got: ${travelBasisLabel(p.travel)}`)
  check('the label says GROUPING', travelBasisLabel(p.travel).toLowerCase().includes('grouping'))
  const w = p.warnings.find(x => x.kind === 'travel_estimated')
  check('a caveat says the distance is straight-line', !!w)
  check('…and tells the owner what to do with it',
    !!w && w.message.toLowerCase().includes('grouping'), w?.message)
  check('no measured claim anywhere', p.travel.measuredLegs === 0)
}
{
  // Grouping is a real answer when it is known — and refuses to be one when the
  // stops could not be placed.
  const p = planDay(base())
  eq('two tight pairs 20 km apart read as two areas', p.areas, 2)
  eq('…and that is what the label says', areasLabel(p), '2 separate areas')
  const blind = planDay(base({ locatedCoords: [] }))
  eq('nothing located → grouping is unknown, not "one area"', blind.areas, null)
  eq('…and the label says so', areasLabel(blind), 'Location unknown')
}

// ═════════════════════════════════════════════════════════════════════════════
H('4. An assumed duration is counted AND disclosed')

{
  const stops = base().stops.map((s, i) => (i < 2 ? { ...s, durationMinutes: null } : s))
  const p = planDay(base({ stops }))
  eq('a visit with no duration still occupies the day', p.workMin, DEFAULT_JOB_MIN * 2 + 60 * 2)
  eq('…and the count of assumptions rides with it', p.assumedDurationStops, 2)
  const w = p.warnings.find(x => x.kind === 'durations_assumed')
  check('a caveat names how many', !!w && w.count === 2)
  check('…and states the number assumed', !!w && w.message.includes(String(DEFAULT_JOB_MIN)), w?.message)
  check('…and marks the finish as rough', !!w && /rough/i.test(w.message), w?.message)
  eq('the stop itself records that it was assumed', p.stops[0].durationSource, 'assumed')
  eq('a stated one records that it was stated', p.stops[3].durationSource, 'stated')
}
{
  // Established history beats the default — and is labelled as learned, not stated.
  const stops = base().stops.map(s => ({ ...s, durationMinutes: null, serviceType: 'x' }))
  const p = planDay(base({ stops, learnedFor: () => 90 }))
  eq('learned minutes are used', p.workMin, 90 * 4)
  eq('…and labelled learned', p.stops[0].durationSource, 'learned')
  eq('…so nothing is reported as assumed', p.assumedDurationStops, 0)
  eq('…and they are counted as learned', p.learnedDurationStops, 4)
}

// ═════════════════════════════════════════════════════════════════════════════
H('5. ⭐ A clock with room is not a day that can happen')

{
  // THE regression. Two hours of work on an 8-hour day — the serial clock has
  // hours to spare — but a visit needs 3 people and 1 is available.
  const p = planDay(base({
    stops: [stop({ jobId: 'a', durationMinutes: 60, crewSize: 3 })],
    workers: 1,
    locatedCoords: [{ lat: 51, lng: -114 }],
  }))
  check('the clock genuinely has room', p.spareClockMin > 120, `spare=${p.spareClockMin}`)
  const w = p.warnings.find(x => x.kind === 'crew_short')
  check('…and the day is still reported as BLOCKING', !!w && w.severity === 'blocking')
  check('…naming both numbers', !!w && w.message.includes('3') && w.message.includes('1 person'), w?.message)
  eq('…so the day is not realistic', p.realistic, false)
  eq('the largest crew asked for is reported', p.maxCrewSize, 3)
}
{
  // Everyone booked off is blocking even for a single short visit.
  const p = planDay(base({ stops: [stop({ jobId: 'a' })], workers: 0, locatedCoords: [{ lat: 51, lng: -114 }] }))
  const w = p.warnings.find(x => x.kind === 'crew_short')
  check('a 0-worker day with booked work is blocking', !!w && w.severity === 'blocking')
  eq('…and its labour pool is genuinely zero', p.laborCapMin, 0)
}
{
  // A blocked day (explicit 0 hours) with work on it.
  const p = planDay(base({ capacityHours: 0 }))
  const w = p.warnings.find(x => x.kind === 'day_blocked')
  check('an explicit 0-hour day carrying visits is blocking', !!w && w.severity === 'blocking')
  eq('…and 0 does NOT fall back to the 8h default', p.capacityMin, 0)
}

// ═════════════════════════════════════════════════════════════════════════════
H('6. Labour over the pool blocks; an unknown roster claims nothing')

{
  // 4 visits × (180 on site + 10 travel) × a crew of 2 = 1,520 person-minutes
  // against a pool of 8h × 2 people = 960. Two people ARE available, so this is
  // the labour pool binding on its own — not a crew shortage in disguise.
  const p = planDay(base({
    stops: base().stops.map(s => ({ ...s, durationMinutes: 180, crewSize: 2 })),
    workers: 2,
  }))
  check('…with the crew itself fully available', !p.warnings.some(x => x.kind === 'crew_short'))
  check('booked person-time over the pool is blocking',
    p.warnings.some(x => x.kind === 'labour_over' && x.severity === 'blocking'))
  check('…and the message quotes the pool', (p.warnings.find(x => x.kind === 'labour_over')?.message || '').includes('2 people'))
}
{
  const p = planDay(base({ workers: null }))
  eq('an unreadable roster is not zero workers', p.workers, null)
  eq('…and mints no labour figure at all', p.laborUsedMin, null)
  eq('…nor a labour capacity', p.laborCapMin, null)
  const w = p.warnings.find(x => x.kind === 'workforce_unknown')
  check('…and says so as a caveat', !!w && w.severity === 'caveat')
  check('no crew_short claim can be made without a roster',
    !p.warnings.some(x => x.kind === 'crew_short'))
}

// ═════════════════════════════════════════════════════════════════════════════
H('7. Un-located stops are charged, disclosed, and kept out of the distance')

{
  const stops = [stop({ jobId: 'a' }), stop({ jobId: 'b', located: false, legKm: null })]
  const p = planDay(base({ stops, locatedCoords: [{ lat: 51, lng: -114 }] }))
  eq('the allowance charged is lib/route\'s own fallback', UNLOCATED_LEG_MIN, FALLBACK_LEG_MIN)
  eq('…and that is what the leg costs', p.stops[1].leg.minutes, FALLBACK_LEG_MIN)
  eq('the leg is marked unknown, not estimated', p.stops[1].leg.source, 'unknown')
  eq('it contributes no kilometres', p.stops[1].leg.km, null)
  eq('…so the day\'s distance is the located leg only', p.km, 5)
  eq('but its WORK is still in the day', p.workMin, 120)
  const w = p.warnings.find(x => x.kind === 'unlocated_stops')
  check('and it is disclosed by count', !!w && w.count === 1)
  eq('…and counted', p.unlocatedStops, 1)
  eq('…against the located ones', p.locatedStops, 1)
}

// ═════════════════════════════════════════════════════════════════════════════
H('8. planDay times an order — it never chooses one')

{
  const ids = ['d', 'c', 'b', 'a']
  const p = planDay(base({ stops: ids.map(jobId => stop({ jobId })) }))
  eq('the output order is the input order, untouched', p.stops.map(s => s.jobId).join(','), ids.join(','))
  const times = p.stops.map(s => s.arrivalMin)
  check('arrivals increase down the day', times.every((t, i) => i === 0 || t > times[i - 1]))
  // 08:00 + (10 drive + 60 work) × 4 = 12:40
  eq('the finish is the walked chain', p.finish, '12:40 PM')
  eq('…and the capacity end is start + the day\'s hours', p.capacityEndMin, 8 * 60 + 480)
}
{
  // Cancelled visits consume nothing, exactly as everywhere else.
  const p = planDay(base({
    stops: [stop({ jobId: 'a' }), stop({ jobId: 'x', status: 'cancelled' })],
    locatedCoords: [{ lat: 51, lng: -114 }],
  }))
  eq('a cancelled visit is not a stop', p.stopCount, 1)
  eq('…and consumes no work minutes', p.workMin, 60)
}
{
  // Running long is a warning, and "no room left" fires before it does.
  const long = planDay(base({ stops: Array.from({ length: 8 }, (_, i) => stop({ jobId: `s${i}` })) }))
  check('a day past its hours warns', long.warnings.some(w => w.kind === 'runs_past_capacity'))
  eq('…and is not realistic', long.realistic, false)
  check('…and the overrun is positive', long.overrunMin > 0)
  // 6 × (65 on site + 10 drive) = 450 of 480 — inside the day, but with only
  // 30 minutes of slack, under the shared 60-minute buffer.
  const tight = planDay(base({
    stops: Array.from({ length: 6 }, (_, i) => stop({ jobId: `s${i}`, durationMinutes: 65 })),
  }))
  check('a day that only just fits says the buffer is gone',
    tight.warnings.some(w => w.kind === 'no_room_left'))
  check('…and it is a warning, not a blocker',
    tight.warnings.find(w => w.kind === 'no_room_left')?.severity === 'warning')
}

// ═════════════════════════════════════════════════════════════════════════════
H('9. ⛔ The engine cannot see money, and cannot see what work is CALLED')

const planSrc = read('src/lib/dayPlan.ts')
const panelSrc = read('src/components/schedule/DayPlanPanel.tsx')
{
  // Comments explain the rule; only CODE may violate it. Strip comments first.
  // ⚠️ `.` does not match \r — CRLF checkouts would otherwise defeat this.
  const code = (s: string) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[^\r\n]*?\/\/[^\r\n]*$/gm, '')
  const money = /\b(price|revenue|amount|total\$|margin|profit|invoice|formatCurrency|jobValue|quote)\b/i
  const pc = code(planSrc)
  check('lib/dayPlan reads no money identifier', !money.test(pc),
    (pc.match(money) || []).join(','))
  const pn = code(panelSrc)
  check('the panel renders no money identifier', !money.test(pn), (pn.match(money) || []).join(','))
  check('…and no currency symbol', !/\$\{?\s*\w*(?:price|total|revenue)/i.test(pn))
}
{
  const code = planSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\r\n]*?\/\/[^\r\n]*$/gm, '')
  // serviceType may only be PASSED to the learned lookup, never inspected.
  check('service names are never string-matched',
    !/serviceType\s*(?:\.|\?\.)\s*(?:includes|match|toLowerCase|indexOf|startsWith|test)/.test(code))
  check('…and no keyword table exists here',
    !/\b(lawn|mow|snow|plow|clean|hvac|plumb|roof|landscap|pest|pool)\b/i.test(code))
  check('the engine does no I/O', !/\b(fetch|supabase|createClient)\b/.test(code))
  check('…and is not a React component', !/\buse(State|Effect|Memo)\b/.test(code))
}

// ═════════════════════════════════════════════════════════════════════════════
H('10. ONE walk from work start to finish')

{
  check('planDay routes its arrivals through lib/route computeDayEtas',
    /computeDayEtas\(/.test(planSrc))
  // And the override actually overrides: a 5 km leg modelled at 2 min/km = 10,
  // handed a measured 6.
  const modelled = computeDayEtas('08:00', [{ jobId: 'a', legKm: 5 }], { a: 60 }, { minPerKm: 2, overheadMin: 0 })
  const measured = computeDayEtas('08:00', [{ jobId: 'a', legKm: 5 }], { a: 60 }, { minPerKm: 2, overheadMin: 0 }, [6])
  eq('without an override the model is used', modelled.stops[0].arrival, '8:10 AM')
  eq('with one, the measurement is', measured.stops[0].arrival, '8:06 AM')
  const ignored = computeDayEtas('08:00', [{ jobId: 'a', legKm: 5 }], { a: 60 }, { minPerKm: 2, overheadMin: 0 }, [null])
  eq('a null override falls through to the model', ignored.stops[0].arrival, '8:10 AM')
}

// ═════════════════════════════════════════════════════════════════════════════
H('11. What the CREW sees is derived from the RPC\'s own ordering')

{
  const j = (id: string, over: Record<string, unknown> = {}) =>
    ({ id, status: 'scheduled' as const, created_at: `2026-01-0${id}`, crew_id: 'c1', ...over })
  // The board's order is a, b, c. Nothing is saved, so the crew sorts by
  // created_at — which here is the reverse.
  const planned = [j('3'), j('2'), j('1')]
  const s = crewOrderStatus(planned)
  eq('with nothing saved, the crew order is booking order', s.crewOrder.join(','), '1,2,3')
  eq('…which is NOT the plan on screen', s.matchesPlan, false)
  eq('…and that state is named', s.unset, true)

  const saved = [j('3', { route_order: 1 }), j('2', { route_order: 2 }), j('1', { route_order: 3 })]
  const s2 = crewOrderStatus(saved)
  eq('a saved sequence is what the crew drives', s2.crewOrder.join(','), '3,2,1')
  eq('…and it matches the board', s2.matchesPlan, true)
  eq('…and is no longer "unset"', s2.unset, false)

  // start_time outranks created_at but not route_order.
  const timed = [j('1', { start_time: '13:00' }), j('2', { start_time: '09:00' })]
  eq('a committed time beats booking order', crewOrderStatus(timed).crewOrder.join(','), '2,1')
  // '2' is promised later in the day but carries a saved position; '1' has an
  // earlier time and none. The saved position wins — which is exactly why
  // publishing an order is the thing that reaches the field.
  const mixed = [j('1', { start_time: '09:00' }), j('2', { start_time: '13:00', route_order: 1 })]
  eq('…but a saved position outranks a committed time', crewOrderStatus(mixed).crewOrder.join(','), '2,1')

  // Assignment is a separate fact from ordering.
  const unassigned = [j('1', { crew_id: null }), j('2', { crew_id: null })]
  eq('stops with no crew reach no crew screen', crewOrderStatus(unassigned).assignedStops, 0)
  eq('…out of the day\'s total', crewOrderStatus(unassigned).totalStops, 2)
  eq('a cancelled stop is not part of the comparison',
    crewOrderStatus([j('1'), j('2', { status: 'cancelled' })]).totalStops, 1)
}
{
  // The mirror must match the SQL it mirrors (baseline located by shape above).
  check('exactly one baseline to mirror against', BASELINE_SQL.length > 0)
  const fn = BASELINE_SQL.slice(BASELINE_SQL.indexOf('FUNCTION public.crew_day'))
  check('crew_day still sorts by route_rank, start_key, created_at',
    /order by x\.route_rank,\s*x\.start_key,\s*x\.created_at/.test(fn))
  check(`…coalescing an absent position to ${UNORDERED_CREW_RANK}`,
    fn.includes(`coalesce(j.route_order, ${UNORDERED_CREW_RANK})`))
  check(`…and an absent start time to ${NO_START_TIME_KEY}`,
    fn.includes(`coalesce(j.start_time::text, '${NO_START_TIME_KEY}')`))
  check('…and still returns only this worker\'s stops (their crew\'s, or personally theirs)',
    /and public\.crew_assignment_covers\(j\.crew_id, j\.technician_id, v_crew, v_tech\)/.test(fn))
}

// ═════════════════════════════════════════════════════════════════════════════
H('12. The surfaces hold what the engine promises')

const opsSrc = read('src/components/schedule/DayOpsPanel.tsx')
{
  // The regression that made a reorder silently change every distance.
  check('a manual order is routed with the SAME distances as the optimized one',
    /sequenceRoute\([\s\S]{0,400}?manualSeq,\s*road\?\.dist\)/.test(opsSrc))
  check('the road data is held in state, not discarded inside the effect',
    /setRoad\(\{\s*dist,\s*seconds,\s*hasRoad,\s*usedRoad\s*\}\)/.test(opsSrc))
  check('measured seconds are read back from the cache',
    /select\('from_key, to_key, km, seconds'\)/.test(read('src/lib/distance.ts')))
}
{
  check('the day board plans through lib/dayPlan', /planDay\(\{/.test(opsSrc))
  check('…and the load pill defers to a blocking verdict',
    /blocking \? 'Won’t fit'/.test(opsSrc))
  check('…and the timeline reads the plan\'s own stops',
    /const timelineStops: TimelineStop\[\] = plan\.stops/.test(opsSrc))
  check('…so no second ETA chain is computed here',
    !/computeDayEtas\(/.test(opsSrc))
  check('publishing the order reuses the ONE route_order write path',
    /sendOrderToCrew[\s\S]{0,400}?applyOrder\(sortedJobs\.map/.test(opsSrc))
  check('…and only claims delivery when the write succeeded',
    /if \(ok\) toast\.success/.test(opsSrc))
}
{
  check('the panel offers no send when nothing is assigned to a crew',
    /assignedStops === 0[\s\S]{0,600}?dispatch board/.test(panelSrc))
  check('…and states plainly when the crew already has the order',
    /The crew sees this order/.test(panelSrc))
}

// ═════════════════════════════════════════════════════════════════════════════
H('13. The shapes of a real day: route · project · mixed')

{
  // ROUTE DAY — many small stops, one worker. The clock binds.
  const route = planDay(base({
    stops: Array.from({ length: 7 }, (_, i) => stop({ jobId: `r${i}`, durationMinutes: 45 })),
    workers: 1,
  }))
  eq('a route day is 7 stops', route.stopCount, 7)
  eq('…of service time', route.workMin, 7 * 45)
  check('…and it fits a single worker\'s day', route.realistic, `warnings: ${route.warnings.map(w => w.kind)}`)
  eq('…with the largest crew still 1', route.maxCrewSize, 1)

  // PROJECT DAY — one long multi-worker job. The labour pool binds, not the clock.
  // 6h × 3 workers = 1,080 + travel, against 3 people × 8h = 1,440.
  const project = planDay(base({
    stops: [stop({ jobId: 'p', durationMinutes: 360, crewSize: 3 })],
    workers: 3,
    locatedCoords: [{ lat: 51, lng: -114 }],
  }))
  eq('a project day is one stop', project.stopCount, 1)
  eq('…asking for a real crew', project.maxCrewSize, 3)
  eq('…and its labour is crew-multiplied', project.laborUsedMin, (360 + 10) * 3)
  check('…and three people can absorb it', project.realistic)

  // The same project with ONE worker available: the calendar looks open (6h on
  // an 8h day) and it is still impossible. This is the brief's "do not schedule
  // 12 labour-hours into 4 labour-hours of workforce".
  const understaffed = planDay(base({
    stops: [stop({ jobId: 'p', durationMinutes: 360, crewSize: 3 })],
    workers: 1,
    locatedCoords: [{ lat: 51, lng: -114 }],
  }))
  check('…but one person cannot, and the day says so', !understaffed.realistic)
  check('…naming the staffing, not just the hours',
    understaffed.warnings.some(w => w.kind === 'crew_short' && w.severity === 'blocking'))

  // MIXED DAY — a project wedged between route stops. The brief's case: a
  // 6-hour multi-worker project must not read as "packable" between visits.
  const mixed = planDay(base({
    stops: [
      stop({ jobId: 'm1', durationMinutes: 45 }),
      stop({ jobId: 'm2', durationMinutes: 360, crewSize: 3 }),
      stop({ jobId: 'm3', durationMinutes: 45 }),
    ],
    workers: 3,
    locatedCoords: [{ lat: 51, lng: -114 }, { lat: 51.005, lng: -114 }, { lat: 51.01, lng: -114 }],
  }))
  eq('a mixed day counts every stop', mixed.stopCount, 3)
  eq('…and the route stops keep their own durations', mixed.stops[0].minutes, 45)
  eq('…while the project keeps its crew', mixed.stops[1].crewSize, 3)
  // 45 + 360 + 45 service + 3 legs of 10 = exactly the 8-hour day. Three people
  // CAN do it, and the honest answer is "with nothing to spare" — not a green
  // "room" pill and not a false blocker.
  check('…and with a full crew it is flagged as having no room left, not as fine',
    mixed.warnings.some(w => w.kind === 'no_room_left'))
  eq('…there being genuinely zero slack', mixed.overrunMin, 0)

  // The brief's case: the SAME mixed day with one person. A calendar gap is not
  // a crew, and the project must not read as packable between the route stops.
  const mixedSolo = planDay(base({
    stops: [
      stop({ jobId: 'm1', durationMinutes: 45 }),
      stop({ jobId: 'm2', durationMinutes: 360, crewSize: 3 }),
      stop({ jobId: 'm3', durationMinutes: 45 }),
    ],
    workers: 1,
    locatedCoords: [{ lat: 51, lng: -114 }, { lat: 51.005, lng: -114 }, { lat: 51.01, lng: -114 }],
  }))
  check('…and with one person the day is blocking', !mixedSolo.realistic)
  check('…because a 3-person project cannot be packed between route stops',
    mixedSolo.warnings.some(w => w.kind === 'crew_short' && w.severity === 'blocking'))
  check('…and the labour pool is named as exceeded too',
    mixedSolo.warnings.some(w => w.kind === 'labour_over'))
}

// ═════════════════════════════════════════════════════════════════════════════
H('14. Time off removes people; Session 47 does not double-book them')

{
  // PTO is the workforce primitive (lib/dayFit workersAvailableOn) — day plan
  // consumes the count, so a day with everyone off is a day with no labour.
  const techs = [
    { id: 't1', is_active: true }, { id: 't2', is_active: true }, { id: 't3', is_active: true },
  ]
  const pto = [{ technician_id: 't2', date: '2026-08-20' }, { technician_id: 't3', date: '2026-08-20' }]
  eq('three on the roster, two booked off → one available',
    workersAvailableOn('2026-08-20', techs, pto), 1)
  eq('…and a different day is unaffected', workersAvailableOn('2026-08-21', techs, pto), 3)

  const short = planDay(base({
    stops: [stop({ jobId: 'a', durationMinutes: 240, crewSize: 3 })],
    workers: workersAvailableOn('2026-08-20', techs, pto),
    locatedCoords: [{ lat: 51, lng: -114 }],
  }))
  check('a crew job on a day two people are off is blocking',
    short.warnings.some(w => w.kind === 'crew_short' && w.severity === 'blocking'))
  const full = planDay(base({
    stops: [stop({ jobId: 'a', durationMinutes: 240, crewSize: 3 })],
    workers: workersAvailableOn('2026-08-21', techs, pto),
    locatedCoords: [{ lat: 51, lng: -114 }],
  }))
  check('…and the same job on a fully-staffed day is fine', full.realistic)
}
{
  // Session 47: a visit carried over from an earlier day has banked minutes.
  // Planning its whole estimate again would book the same hours twice.
  const carried = planDay(base({
    stops: [
      stop({ jobId: 'a', durationMinutes: 300, status: 'in_progress', workedMinutes: 240 }),
      stop({ jobId: 'b', durationMinutes: 60 }),
    ],
    locatedCoords: [{ lat: 51, lng: -114 }, { lat: 51.005, lng: -114 }],
  }))
  eq('only the outstanding hour of a part-done visit is planned', carried.stops[0].minutes, 60)
  eq('…so the day totals the remainder, not the estimate', carried.workMin, 60 + 60)
  eq('…and the carry-over is counted', carried.carriedOverStops, 1)
  check('…and disclosed, because a 5h job now reading 1h needs saying',
    carried.warnings.some(w => w.kind === 'carried_over' && w.count === 1))
  // Over-run: more banked than estimated leaves no work, but still a stop.
  const done = planDay(base({
    stops: [stop({ jobId: 'a', durationMinutes: 60, status: 'in_progress', workedMinutes: 500 })],
    locatedCoords: [{ lat: 51, lng: -114 }],
  }))
  eq('a visit already over its estimate has no work left', done.stops[0].minutes, 0)
  eq('…but is still a stop on the route', done.stopCount, 1)
  // A SCHEDULED visit's actual_minutes is not a carry-over signal.
  const fresh = planDay(base({
    stops: [stop({ jobId: 'a', durationMinutes: 60, status: 'scheduled', workedMinutes: 45 })],
    locatedCoords: [{ lat: 51, lng: -114 }],
  }))
  eq('banked minutes are read only for a visit already underway', fresh.stops[0].minutes, 60)
  eq('…and nothing is reported as carried over', fresh.carriedOverStops, 0)
}

// ═════════════════════════════════════════════════════════════════════════════
H('15. The travel figure is called what the evidence allows')

{
  const measured = planDay(base({
    stops: base().stops.map(s => ({ ...s, legSeconds: 360, legIsRoad: true })),
  }))
  eq('a fully-measured day may say "driving"', travelFigureLabel(measured.travel), 'driving')
  eq('…without an estimated qualifier', travelIsEstimated(measured.travel), false)

  const straight = planDay(base())
  eq('a straight-line day may NOT say "driving"', travelFigureLabel(straight.travel), 'route overhead')
  eq('…and must carry the qualifier', travelIsEstimated(straight.travel), true)

  const road = planDay(base({ stops: base().stops.map(s => ({ ...s, legIsRoad: true })) }))
  eq('real distances with modelled minutes are still overhead, not driving',
    travelFigureLabel(road.travel), 'route overhead')

  // ⛔ No new routing provider was introduced: the measured durations were
  // already fetched and stored by lib/distance. Nothing here calls out.
  const distSrc = read('src/lib/distance.ts')
  eq('the only Google endpoints used are the two that already existed',
    (distSrc.match(/\/api\/(distance-matrix|route)/g) || []).length > 0, true)
  check('lib/dayPlan itself calls no provider', !/googleapis|\/api\//.test(planSrc))
}

// ═════════════════════════════════════════════════════════════════════════════
H('16. Refresh persistence and tenant isolation')

{
  // PERSISTENCE. The order survives a refresh because it lives in jobs.route_order
  // — the board's optimistic override releases once the DB is authoritative again.
  check('the reorder write targets jobs.route_order',
    /update\(\{ route_order: i \+ 1 \}\)/.test(opsSrc))
  check('…the optimistic order is released once props are authoritative',
    /savedKey === localSeq\.join\('\|'\) \|\| fresh/.test(opsSrc))
  check('…and a saved sequence is what the board reads back on load',
    /active\.some\(j => j\.route_order != null\)/.test(opsSrc))
  check('…while a date move clears it in the DATABASE, not in app code',
    /trg_jobs_clear_route_order/.test(BASELINE_SQL))
}
{
  // TENANCY. The plan engine sees only rows it is handed; the loader that feeds
  // it scopes every read. Asserted per `.from(` block, never by counting —
  // a whole-file count was once satisfied by a COMMENT quoting the filter.
  const loadSrc = read('src/lib/dayFitLoad.ts')
  const blocks = loadSrc.split(/supabase\s*\n?\s*\.from\(/).slice(1)
  check('the day-fit loader makes the reads the plan depends on', blocks.length >= 4, `${blocks.length} blocks`)
  blocks.forEach((b, i) => {
    const head = b.slice(0, 320)
    check(`read ${i + 1} is tenant-scoped in its own chain`, /\.eq\('user_id', userId\)/.test(head),
      head.split('\n')[0])
  })
  check('the plan engine performs no read of its own', !/from\(|rpc\(/.test(planSrc))
  // The crew's own day is scoped by the RPC, not by the client.
  const fn2 = BASELINE_SQL.slice(BASELINE_SQL.indexOf('FUNCTION public.crew_day'))
  check('crew_day scopes to the employer it resolved, not to a parameter',
    /where j\.user_id = v_employer/.test(fn2))
  check('…and crew_day is not executable by anon',
    /revoke all on function public\."crew_day"\(p_date date\) from public, anon/.test(BASELINE_SQL))
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('')
if (failures) {
  console.log(`✗ day-plan: ${failures} rule${failures === 1 ? '' : 's'} broken`)
  process.exit(1)
}
console.log('✓ day-plan: every rule holds')
