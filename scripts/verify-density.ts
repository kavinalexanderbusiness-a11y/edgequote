// ── Verify: route density counts NEIGHBOURS, not a property's own visits ─────
//   npm run verify:density
//
// WHY THIS SCRIPT EXISTS
// routeDensityTravel() waives ALL travel at >= 3 nearby and half at >= 1. Those
// thresholds are written for NEIGHBOURING PROPERTIES. nearbyJobCount() was fed a
// list of JOBS — fetchLocatedUpcomingJobs selects from `jobs`, one row per visit,
// each carrying its property's coordinates — and it neither deduped by property
// nor excluded the target. So a property with 24 upcoming recurring visits
// contributed 24 to its own "nearby" count.
//
// Measured on live production: average count 38.1 against 2.0 real neighbouring
// properties (200 job rows spanning 16 properties — a 19x inflation). 15 of 16
// properties had travel 100% waived, including 3 with ZERO other properties within
// 5 km — waived by the weight of their own visits. The `>= 1` half-travel tier was
// effectively unreachable.
//
// None of that is a type error and none of it is visible in a build: the count is
// a valid number, it is simply counting the wrong noun. Only execution catches it.
//
// The thresholds are NOT changed here — the denominator is. That is the fix: the
// numbers 3 and 1 become meaningful again because they finally count what they
// were written to count.

import { nearbyJobCount, pointKey, type Coord } from '../src/lib/geo'
import { locatedStops, densityFor } from '../src/lib/routeDensity'
import { routeDensityTravel } from '../src/lib/pricing'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

// Real-world geometry: ~0.009° lat ≈ 1 km in Calgary.
const TARGET: Coord = { lat: 51.0447, lng: -114.0719 }
const KM = 0.009
const near = (n: number): Coord => ({ lat: TARGET.lat + KM * n, lng: TARGET.lng })
// One row PER VISIT, all at the same coordinate — exactly what the jobs table
// returns for a weekly customer.
const visits = (c: Coord, n: number) => Array.from({ length: n }, () => ({ lat: c.lat, lng: c.lng }))

// ── 1. ONE SAME-STOP RULE ────────────────────────────────────────────────────
console.log('\nThere is one rule for "same stop":')
{
  eq('pointKey rounds to 5 decimals', pointKey({ lat: 51.044712345, lng: -114.071987654 }), '51.04471,-114.07199')
  check('…and two points ~1 m apart are the same stop',
        pointKey({ lat: 51.04471, lng: -114.07199 }) === pointKey({ lat: 51.044714, lng: -114.071993 }),
        'the dedup rule no longer collapses the same property')
  // locatedStops must use that same rule — a second dedup rule is a second answer.
  eq('locatedStops dedupes 24 visits to 1 stop', locatedStops(visits(near(1), 24)).length, 1)
}

// ── 2. A PROPERTY IS NOT ITS OWN NEIGHBOUR ───────────────────────────────────
// The live case: 3 properties had zero neighbours and full travel waived.
console.log('\nA property\'s own visits are not neighbours:')
{
  const isolated = nearbyJobCount(TARGET, visits(TARGET, 24))
  eq('24 of my own visits = 0 neighbours', isolated.count, 0)
  eq('…and there is no "nearest" stop', isolated.nearestKm, null)

  // The travel waiver is the thing that was breaking.
  const t = routeDensityTravel(40, isolated.count)
  eq('a genuinely isolated property pays FULL travel', t.fee, 40)
  eq('…with no discount', t.discountPct, 0)
}

// ── 3. VISITS ARE NOT PROPERTIES ─────────────────────────────────────────────
console.log('\nA neighbour with many visits is still one neighbour:')
{
  // One neighbour 1 km away, visited weekly all season.
  const one = nearbyJobCount(TARGET, visits(near(1), 28))
  eq('28 visits to ONE neighbour = 1 neighbour', one.count, 1)
  eq('…nearest is that neighbour, ~1 km', one.nearestKm, 1)
  // 1 neighbour → the half-travel tier, which was previously unreachable.
  eq('…which earns the HALF-travel tier, not a full waiver', routeDensityTravel(40, one.count).discountPct, 0.5)

  // Three distinct neighbours → the full waiver the tier was written for.
  const three = nearbyJobCount(TARGET, [...visits(near(1), 10), ...visits(near(2), 10), ...visits(near(3), 10)])
  eq('30 visits across 3 neighbours = 3 neighbours', three.count, 3)
  eq('…which earns the full waiver', routeDensityTravel(40, three.count).discountPct, 1)
}

// ── 4. THE LIVE SHAPE, END TO END ────────────────────────────────────────────
// Reproduces production's proportions: a dense-looking count that is really one
// neighbour, next to the target's own heavy visit schedule.
console.log('\nThe live shape: 38 job rows, 2 real neighbours:')
{
  const jobs = [
    ...visits(TARGET, 24),    // my own weekly visits — must not count
    ...visits(near(1), 8),    // one real neighbour
    ...visits(near(2), 6),    // a second real neighbour
  ]
  eq('38 job rows resolve to 2 neighbours', nearbyJobCount(TARGET, jobs).count, 2)
  // Under the old counting this was 38 → full waiver. Now: 2 → half.
  eq('…so travel is halved, not waived', routeDensityTravel(40, nearbyJobCount(TARGET, jobs).count).discountPct, 0.5)

  // And the two density engines must now agree on the same input.
  const stops = locatedStops(jobs)
  const d = densityFor(TARGET, stops)
  eq('densityFor sees the same 2 neighbours within 5 km', d.within5km, 2)
  check('…and the two engines agree on the count',
        d.within5km === nearbyJobCount(TARGET, jobs).count,
        `densityFor says ${d.within5km}, nearbyJobCount says ${nearbyJobCount(TARGET, jobs).count}`)
}

// ── 5. THE RADIUS STILL BOUNDS THE COUNT ─────────────────────────────────────
console.log('\nDistance still decides:')
{
  const far = nearbyJobCount(TARGET, visits(near(50), 5))   // ~50 km away
  eq('a property 50 km away is not nearby', far.count, 0)
  const inside = nearbyJobCount(TARGET, [...visits(near(1), 2), ...visits(near(50), 2)])
  eq('only the in-radius neighbour counts', inside.count, 1)
  // An explicit radius still works.
  eq('a 1 km radius excludes the 2 km neighbour',
     nearbyJobCount(TARGET, visits(near(2), 3), 1).count, 0)
}

// ── 6. EMPTY AND NULL INPUTS ARE SAFE ────────────────────────────────────────
console.log('\nNo jobs, no claims:')
{
  eq('no jobs at all = 0', nearbyJobCount(TARGET, []).count, 0)
  eq('…and no nearest', nearbyJobCount(TARGET, []).nearestKm, null)
  eq('unlocated jobs are ignored', nearbyJobCount(TARGET, [{ lat: null, lng: null }]).count, 0)
  eq('…and a full-travel fee', routeDensityTravel(40, 0).fee, 40)
}

console.log('')
if (failures) { console.log(`✗ ${failures} density check(s) failed\n`); process.exit(1) }
console.log('✓ all density checks passed — neighbours are counted, not visits, and never yourself\n')
