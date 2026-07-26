// ── Route engine verification — npm run verify:route ────────────────────────
//
// lib/route.ts is THE routing brain: stop ordering (nearest-neighbour + 2-opt),
// km estimates, drive-minutes, the day ETAs a customer is told ("we'll be there
// around 9:40"), the day-load capacity signal, the Open-in-Maps links, and the
// three-lens schedule recommender. Every output is a TIME, a DISTANCE or a DAY
// a human acts on — a regression is a wrong promise to a customer or a day
// booked against the owner's own economics, and tsc/next build stay green
// through all of it. Nothing exercised the module.
//
// CHARACTERIZATION tests, expected values captured from the module itself. The
// ordering checks inject a synthetic 1-D distance function — DistFn injection is
// part of the engine's contract (cached real-road distances ride the same seam),
// and it makes expected distances exact instead of haversine-approximate. The
// impure wrappers (optimizeRoute's fetch, geocodeMissingStops) are deliberately
// not driven: their pure fallbacks ARE the functions pinned here.

import {
  nearestNeighborRoute, routeKmEstimate, sequenceRoute, roundTripMapsUrl,
  clusterKmEstimate, legMinutes, routeStats, timeToMinutes, minutesToTime12,
  computeDayEtas, roughFinishEstimate, dayLoad, estimateDayLoad, directionsUrl,
  recommendScheduleDays, MAX_MAPS_WAYPOINTS, AVG_SPEED_KM_PER_MIN,
  DEFAULT_WORK_START, DEFAULT_JOB_MIN, type RouteStop,
} from '../src/lib/route'
import type { Coord } from '../src/lib/geo'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}

// Synthetic 1-D distance (|Δlat| as km): exact numbers, and it exercises the
// DistFn injection contract every caller with cached road distances relies on.
const lineDist = (a: Coord, b: Coord) => Math.abs(a.lat - b.lat)
const P = (lat: number, lng = 0): Coord => ({ lat, lng })
const stop = (id: string, lat: number | null, lng: number | null = 0, addr: string | null = null): RouteStop =>
  ({ jobId: id, title: id, lat, lng: lat == null ? null : lng, address: addr } as RouteStop)

// ═══════════════════════════════════════════════════════════════════════════
H('1. ORDERING — nearest-neighbour visits in distance order, with per-leg km')
check('base 0 with stops at 3,1,2 → visits 1,2,3, legs of 1 km each, total 3',
  nearestNeighborRoute(P(0), [stop('a', 3), stop('b', 1), stop('c', 2)], lineDist), {
    ordered: [
      { jobId: 'b', title: 'b', lat: 1, lng: 0, address: null, order: 1, legKm: 1 },
      { jobId: 'c', title: 'c', lat: 2, lng: 0, address: null, order: 2, legKm: 1 },
      { jobId: 'a', title: 'a', lat: 3, lng: 0, address: null, order: 3, legKm: 1 },
    ], totalKm: 3,
  })
check('no stops → empty route, 0 km', nearestNeighborRoute(P(0), [], lineDist), { ordered: [], totalKm: 0 })
check('routeKmEstimate agrees with the same core', routeKmEstimate(P(0), [P(3), P(1), P(2)], lineDist), 3)
check('routeKmEstimate of nothing is 0', routeKmEstimate(P(0), [], lineDist), 0)
// A zigzag layout greedy-NN alone would leave crossed; 2-opt untangles it to a
// clean out-and-back. 2.3 km is the polished figure — greedy-only reads ~6.5.
check('2-opt untangles a zigzag (near/far/near/far pairs → 2.3 km, not ~6.5)',
  routeKmEstimate({ lat: 51.0, lng: -114.0 }, [
    { lat: 51.001, lng: -114.0 }, { lat: 51.02, lng: -114.0 },
    { lat: 51.002, lng: -114.0 }, { lat: 51.021, lng: -114.0 },
  ]), 2.3)

// ═══════════════════════════════════════════════════════════════════════════
H('2. FIXED SEQUENCE — the owner\'s drag order, same shape as the optimizer')
check('honours the given order, skips unknown ids, null legKm for un-located stops',
  sequenceRoute(P(0), [stop('a', 1), stop('b', null, null), stop('c', 2)], ['c', 'ghost', 'b', 'a'], lineDist), {
    ordered: [
      { jobId: 'c', title: 'c', lat: 2, lng: 0, address: null, order: 1, legKm: 2 },
      { jobId: 'b', title: 'b', lat: null, lng: null, address: null, order: 2, legKm: null },
      { jobId: 'a', title: 'a', lat: 1, lng: 0, address: null, order: 3, legKm: 1 },
    ], totalKm: 3,
  })

// ═══════════════════════════════════════════════════════════════════════════
H('3. CLUSTER ESTIMATE — deterministic westmost start, order-independent')
const CL = [P(1, -3), P(2, -1), P(3, -2)]
check('walks from the westmost point', clusterKmEstimate(CL, lineDist), 2)
check('shuffling the input changes NOTHING (or the optimizer\'s cost landscape goes noisy)',
  clusterKmEstimate([CL[2], CL[0], CL[1]], lineDist), 2)
check('fewer than two points → 0', clusterKmEstimate([P(1)], lineDist), 0)

// ═══════════════════════════════════════════════════════════════════════════
H('4. MINUTES — the one place distance becomes drive time')
check(`legacy default is 2 min/km (1/AVG_SPEED ${AVG_SPEED_KM_PER_MIN})`, legMinutes(5), 10)
check('rounds to whole minutes', legMinutes(2.6), 5)
check('a learned speed model overrides both rate and overhead (5 + 5×1)', legMinutes(5, { minPerKm: 1, overheadMin: 3 }), 8)
check('negative km clamps to 0 drive — overhead still applies', legMinutes(-4, { minPerKm: 2, overheadMin: 5 }), 5)
check('routeStats: avg leg, drive minutes, and 1-km union-find clusters (2 near + 1 far = 2)',
  routeStats([{ lat: 51.0, lng: -114.0 }, { lat: 51.005, lng: -114.0 }, { lat: 51.5, lng: -114.0 }], 12.34),
  { avgLegKm: 4.1, driveMinutes: 25, clusters: 2 })
check('routeStats of nothing', routeStats([], 0), { avgLegKm: 0, driveMinutes: 0, clusters: 0 })

// ═══════════════════════════════════════════════════════════════════════════
H('5. CLOCK MATH — parsing, 12-hour rendering, wrapping')
check('08:30 → 510', timeToMinutes('08:30'), 510)
check(`garbage/null fall back to 8:00 (${DEFAULT_WORK_START})`, { g: timeToMinutes('zz'), n: timeToMinutes(null) }, { g: 480, n: 480 })
check('an impossible 25:99 clamps to 23:59', timeToMinutes('25:99'), 1439)
check('midnight renders 12:00 AM', minutesToTime12(0), '12:00 AM')
check('noon renders 12:00 PM', minutesToTime12(720), '12:00 PM')
check('749 → 12:29 PM', minutesToTime12(749), '12:29 PM')
check('past midnight wraps (1500 → 1:00 AM)', minutesToTime12(1500), '1:00 AM')
check('negative wraps backward (−30 → 11:30 PM)', minutesToTime12(-30), '11:30 PM')

// ═══════════════════════════════════════════════════════════════════════════
H('6. DAY ETAs — the arrival times a customer is actually told')
check('drive each leg, work the stop, drive on; null legKm uses the 10-min fallback; unknown duration uses 45',
  computeDayEtas('08:00', [{ jobId: 'a', legKm: 5 }, { jobId: 'b', legKm: null }, { jobId: 'c', legKm: 2.6 }], { a: 30, c: 60 }), {
    stops: [
      { jobId: 'a', arrivalMin: 490, arrival: '8:10 AM' },   // +10 drive
      { jobId: 'b', arrivalMin: 530, arrival: '8:50 AM' },   // +30 work, +10 fallback leg
      { jobId: 'c', arrivalMin: 580, arrival: '9:40 AM' },   // +45 DEFAULT_JOB_MIN, +5 drive
    ],
    finishMin: 640, finish: '10:40 AM', startMin: 480,
  })
check('a learned speed model shifts every arrival (9:15 start + 5 + 10×1 → 9:30)',
  computeDayEtas('09:15', [{ jobId: 'a', legKm: 10 }], { a: 45 }, { minPerKm: 1, overheadMin: 5 }),
  { stops: [{ jobId: 'a', arrivalMin: 570, arrival: '9:30 AM' }], finishMin: 615, finish: '10:15 AM', startMin: 555 })
check(`rough estimate: start + labour + ${'10'}/stop (${DEFAULT_JOB_MIN} is not used here)`,
  roughFinishEstimate('08:00', 180, 4), { finishMin: 700, finish: '11:40 AM' })

// ═══════════════════════════════════════════════════════════════════════════
H('7. DAY LOAD — capacity semantics, including the blocked-day zero')
check('null capacity falls back to 8 h', dayLoad(300, null), { state: 'room', spareMin: 180 })
// The load-bearing rule: an EXPLICIT 0 is a blocked day and must NOT default to
// 8 h — booked work on a blocked day is genuinely over capacity.
check('an EXPLICIT 0 capacity means blocked — work on it is overloaded, never "room"',
  dayLoad(60, 0), { state: 'overloaded', spareMin: -60 })
check('exactly 60 spare is still "room"', dayLoad(420, 8), { state: 'room', spareMin: 60 })
check('59 spare is "full"', dayLoad(421, 8), { state: 'full', spareMin: 59 })
check('one minute over is "overloaded"', dayLoad(481, 8), { state: 'overloaded', spareMin: -1 })
check('estimateDayLoad: cancelled visits excluded, 45-min default, +10 per stop',
  estimateDayLoad([{ duration_minutes: 60 }, { duration_minutes: null }, { duration_minutes: 30, status: 'cancelled' }], 8),
  { state: 'room', spareMin: 355, usedMin: 125, capMin: 480, pct: 26 })
check('estimateDayLoad on a blocked day reads 100% and overloaded',
  estimateDayLoad([{ duration_minutes: 60 }], 0), { state: 'overloaded', spareMin: -70, usedMin: 70, capMin: 0, pct: 100 })

// ═══════════════════════════════════════════════════════════════════════════
H('8. MAPS LINKS — named places over dropped pins, and the 9-waypoint cap')
check('round-trip URL prefers the street address and falls back to coords',
  roundTripMapsUrl(P(51.1, -114.1), [stop('a', 51.2, -114.2, '123 Main St SW'), stop('b', 51.3, -114.3)]),
  'https://www.google.com/maps/dir/?api=1&origin=51.1%2C-114.1&destination=51.1%2C-114.1&waypoints=123+Main+St+SW%7C51.3%2C-114.3&travelmode=driving')
check(`waypoints are capped at ${MAX_MAPS_WAYPOINTS} (past that, Google's link silently fails)`,
  new URL(roundTripMapsUrl(P(0, 0), Array.from({ length: 12 }, (_, i) => stop(String(i), 10 + i, 5))))
    .searchParams.get('waypoints')!.split('|').length, 9)
check('single-stop directions use the address as destination',
  directionsUrl({ lat: 51.2, lng: -114.2, address: '123 Main St SW' }, P(51.1, -114.1)),
  'https://www.google.com/maps/dir/?api=1&origin=51.1%2C-114.1&destination=123+Main+St+SW&travelmode=driving')
check('no base → no origin param; coords as destination',
  directionsUrl({ lat: 51.2, lng: -114.2 }, null),
  'https://www.google.com/maps/dir/?api=1&destination=51.2%2C-114.2&travelmode=driving')

// ═══════════════════════════════════════════════════════════════════════════
H('9. THE SCHEDULE RECOMMENDER — three lenses over the same scored days')
// Mon: two nearby cheap jobs (a tight cluster). Tue: one far rich job. Wed:
// empty, but the customer's preferred weekday. Each lens should pick a
// DIFFERENT day — that divergence is the feature.
const SCHED_JOBS = [
  { scheduled_date: '2026-07-20', lat: 51.001, lng: -114.0, durationMin: 60, value: 100 },
  { scheduled_date: '2026-07-20', lat: 51.002, lng: -114.0, durationMin: 60, value: 100 },
  { scheduled_date: '2026-07-21', lat: 51.3, lng: -114.3, durationMin: 240, value: 900 },
]
const modes = recommendScheduleDays({ lat: 51.0, lng: -114.0 }, SCHED_JOBS as never, {
  fromISO: '2026-07-20', horizonDays: 3, preferredDays: [1, 2, 3], base: { lat: 51.05, lng: -114.05 },
  targetHours: 1, targetValue: 80, customerPreferredDays: [3], customerAvoidDays: [],
})
check('every scored day carries the full plan (counts, hours, revenue, marginal driving)',
  modes.days, [
    { date: '2026-07-20', weekday: 'Monday', weekdayIdx: 1, isPreferred: true, jobCount: 2, plannedHours: 3, scheduledRevenue: 280, nearbyCount: 2, addedDriveMin: 0, customerPreferred: false },
    { date: '2026-07-21', weekday: 'Tuesday', weekdayIdx: 2, isPreferred: true, jobCount: 1, plannedHours: 5, scheduledRevenue: 980, nearbyCount: 0, addedDriveMin: 26, customerPreferred: false },
    { date: '2026-07-22', weekday: 'Wednesday', weekdayIdx: 3, isPreferred: true, jobCount: 0, plannedHours: 1, scheduledRevenue: 80, nearbyCount: 0, addedDriveMin: 13, customerPreferred: true },
  ])
check('density joins the tight Monday cluster', modes.density?.date, '2026-07-20')
check('balanced spreads to the empty Wednesday', modes.balanced?.date, '2026-07-22')
check('revenue stacks the rich Tuesday', modes.revenue?.date, '2026-07-21')
check('a customer\'s avoid-weekday is excluded from scoring entirely',
  recommendScheduleDays(P(0), [] as never, { fromISO: '2026-07-20', horizonDays: 3, preferredDays: [], customerAvoidDays: [1] })
    .days.map(d => d.date), ['2026-07-21', '2026-07-22'])
check('no scoreable day in the horizon → null recommendations',
  recommendScheduleDays(P(0), [] as never, { fromISO: '2026-07-20', horizonDays: 2, preferredDays: [5] }).density, null)

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
