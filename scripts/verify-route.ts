// ── Routing engine characterization — run by CI (npm run verify:route) ──
//
// lib/route.ts is THE place a day's route is ordered and timed — used by both the
// Route Planner and the calendar Day Ops panel "so they can never order a day
// differently." Every function here was untested. These are wrong-VALUE surfaces tsc
// can't see: a bad ETA tells a customer the wrong arrival, a bad dayLoad hides an
// overbooked day, a route that silently drops past Google's 9-waypoint cap sends the
// crew a broken link exactly when a big day needs it.
//
// The sequencing/ETA functions take an injectable distance/speed model — so these tests
// feed a deterministic Manhattan distance and a fixed speed, characterizing the ORDERING
// and CLOCK logic without coupling to floating-point haversine. CHARACTERIZATION only:
// expected values were read from the implementation; no production change.

import {
  timeToMinutes, minutesToTime12, legMinutes, dayLoad, estimateDayLoad,
  computeDayEtas, nearestNeighborRoute, sequenceRoute, roundTripMapsUrl, directionsUrl,
  MAX_MAPS_WAYPOINTS, DEFAULT_JOB_MIN, type RouteStop,
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
function ok(name: string, cond: boolean) { check(name, cond, true) }

// A deterministic, symmetric distance (Manhattan on lat+lng) so route ORDERING is
// predictable by hand — the real haversine is exercised elsewhere; here we pin logic.
const manhattan = (a: Coord, b: Coord) => Math.abs(a.lat - b.lat) + Math.abs(a.lng - b.lng)
const BASE: Coord = { lat: 0, lng: 0 }
const stop = (o: Partial<RouteStop>): RouteStop => ({ jobId: '', title: '', address: '', propertyId: null, lat: null, lng: null, ...o })

// ═══════════════════════════════════════════════════════════════════════════
H('1. time primitives — the clock every ETA is built on')
check('parses HH:MM to minutes', timeToMinutes('14:30'), 870)
check('a single-digit hour parses', timeToMinutes('9:05'), 545)
check('missing/garbage defaults to 08:00 (480), never NaN', [timeToMinutes(null), timeToMinutes('nonsense')], [480, 480])
check('an out-of-range time is clamped to 23:59, never overflows the day', timeToMinutes('25:00'), 1439)
check('formats midnight as 12:00 AM', minutesToTime12(0), '12:00 AM')
check('formats noon as 12:00 PM', minutesToTime12(720), '12:00 PM')
check('formats afternoon in 12-hour', minutesToTime12(870), '2:30 PM')
check('wraps a negative into the previous evening', minutesToTime12(-60), '11:00 PM')
check('1440 wraps back to midnight', minutesToTime12(1440), '12:00 AM')

// ═══════════════════════════════════════════════════════════════════════════
H('2. legMinutes — one place a distance becomes drive time')
check('default model is 2 min/km, no overhead', legMinutes(10), 20)
check('a learned min/km is honoured', legMinutes(10, { minPerKm: 3 }), 30)
check('per-stop overhead adds on top', legMinutes(10, { minPerKm: 2, overheadMin: 5 }), 25)
check('a negative distance never yields negative time', legMinutes(-5), 0)

// ═══════════════════════════════════════════════════════════════════════════
H('3. dayLoad — capacity state, incl. the blocked-day subtlety')
check('lots of spare → room', dayLoad(300, 8), { state: 'room', spareMin: 180 })
check('under 60 min spare → full', dayLoad(440, 8), { state: 'full', spareMin: 40 })
check('over capacity → overloaded', dayLoad(500, 8), { state: 'overloaded', spareMin: -20 })
check('null capacity falls back to an 8h day', dayLoad(300, null), { state: 'room', spareMin: 180 })
// The load-bearing distinction: an EXPLICIT 0 is a BLOCKED day (zero labour), so any
// booked work is genuinely over — it must NOT fall back to 8h. A NEGATIVE means "unknown".
check('capacity 0 is a blocked day: booked work reads overloaded (no 8h fallback)',
  dayLoad(100, 0), { state: 'overloaded', spareMin: -100 })
check('a negative capacity is treated as unknown → 8h default, not blocked',
  dayLoad(100, -1), { state: 'room', spareMin: 380 })

// ═══════════════════════════════════════════════════════════════════════════
H('4. estimateDayLoad — the calendar/rain-delay load (one definition)')
check('labour + 10 min/stop drive allowance, with pct',
  estimateDayLoad([{ duration_minutes: 60 }, { duration_minutes: 30 }], 8),
  { state: 'room', spareMin: 370, usedMin: 110, capMin: 480, pct: 23 })
check('a cancelled visit frees its time',
  estimateDayLoad([{ duration_minutes: 60 }, { duration_minutes: 9999, status: 'cancelled' }], 8).usedMin, 70)
check('a null duration falls back to DEFAULT_JOB_MIN',
  estimateDayLoad([{ duration_minutes: null }], 8).usedMin, DEFAULT_JOB_MIN + 10)
check('a blocked day (cap 0) with work reads 100% overloaded',
  estimateDayLoad([{ duration_minutes: 60 }], 0), { state: 'overloaded', spareMin: -70, usedMin: 70, capMin: 0, pct: 100 })

// ═══════════════════════════════════════════════════════════════════════════
H('5. computeDayEtas — walk the route: drive, work, drive on')
const etas = computeDayEtas('08:00',
  [{ jobId: 'A', legKm: 5 }, { jobId: 'B', legKm: 2 }, { jobId: 'C', legKm: null }],
  { A: 30, B: 60 })  // C has no duration → DEFAULT_JOB_MIN; C has null legKm → fallback 10-min leg
check('arrivals chain drive+work; null legKm uses the fallback leg; missing duration uses the default',
  etas,
  // Key order mirrors the function's return ({stops, finishMin, finish, startMin}) so the
  // stringify comparison matches — the values are what characterize the clock.
  { stops: [
      { jobId: 'A', arrivalMin: 490, arrival: '8:10 AM' },   // +legMinutes(5)=10
      { jobId: 'B', arrivalMin: 524, arrival: '8:44 AM' },   // +30 work, +legMinutes(2)=4
      { jobId: 'C', arrivalMin: 594, arrival: '9:54 AM' },   // +60 work, +10 fallback leg
    ],
    finishMin: 639, finish: '10:39 AM', startMin: 480 })     // +45 default work
check('a null start defaults to the 08:00 work start', computeDayEtas(null, [], {}).startMin, 480)

// ═══════════════════════════════════════════════════════════════════════════
H('6. nearestNeighborRoute — greedy order (deterministic distance)')
const nn = nearestNeighborRoute(BASE, [
  stop({ jobId: 'C', lat: 0, lng: 3 }),
  stop({ jobId: 'A', lat: 0, lng: 1 }),
  stop({ jobId: 'B', lat: 0, lng: 2 }),
], manhattan)
check('visits the nearest unvisited stop each step (A→B→C, not input order)',
  nn.ordered.map(s => s.jobId), ['A', 'B', 'C'])
check('assigns 1-based visit order', nn.ordered.map(s => s.order), [1, 2, 3])
check('one-way total km (base→…→last)', nn.totalKm, 3)

// ═══════════════════════════════════════════════════════════════════════════
H('7. sequenceRoute — honour the owner\'s manual order')
const seq = sequenceRoute(BASE,
  [stop({ jobId: 'A', lat: 0, lng: 1 }), stop({ jobId: 'B', lat: 0, lng: 2 }), stop({ jobId: 'U' })],
  ['B', 'A', 'U', 'ghost'], manhattan)  // U is unlocated; 'ghost' isn't a real stop
check('emits stops in the given sequence', seq.ordered.map(s => s.jobId), ['B', 'A', 'U'])
check('an unlocated stop keeps a null leg (ETA engine applies its fallback)',
  seq.ordered.map(s => s.legKm), [2, 1, null])
check('an id not in the stop set is skipped, not invented', seq.ordered.length, 3)

// ═══════════════════════════════════════════════════════════════════════════
H('8. Maps URLs — the 9-waypoint cap is a real Google limit')
const many = Array.from({ length: 12 }, (_, i) => ({ lat: i, lng: i, address: `${i} Test Rd` }))
const url = new URL(roundTripMapsUrl(BASE, many))
check('round trip: origin === destination === base', [url.searchParams.get('origin'), url.searchParams.get('destination')], ['0,0', '0,0'])
check('waypoints are capped at Google\'s limit of 9 (beyond that the link fails)',
  url.searchParams.get('waypoints')!.split('|').length, MAX_MAPS_WAYPOINTS)
check('a stop with a street address uses the address, not a dropped pin',
  new URL(roundTripMapsUrl(BASE, [{ lat: 5, lng: 6, address: '7 Elm St' }])).searchParams.get('waypoints'), '7 Elm St')
check('a stop with neither address nor coords is dropped from the link',
  new URL(roundTripMapsUrl(BASE, [{ lat: null, lng: null, address: null }])).searchParams.get('waypoints'), null)
check('directionsUrl prefers the destination address over coordinates',
  new URL(directionsUrl({ lat: 5, lng: 6, address: '7 Elm St' })).searchParams.get('destination'), '7 Elm St')
check('directionsUrl falls back to coordinates when there is no address',
  new URL(directionsUrl({ lat: 5, lng: 6, address: null })).searchParams.get('destination'), '5,6')

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
