// ── Verify: the signals sweep dates every tenant in THEIR OWN zone ──────────
//   npm run verify:cron-tenant-time
//
// WHY THIS SCRIPT EXISTS
// /api/cron/signals computed ONE date — `localTodayISO()`, the server's clock,
// which is UTC on Vercel — and applied it to every tenant it swept. Two
// businesses can be on different calendar days at the same instant, so a single
// date is wrong for at least one of them whenever the sweep straddles a local
// midnight. That one value decided `hasUpcoming`, `pastReal`, seasonal dormancy,
// the ran-out day count, and the `detected_on` every row is filed under.
//
// ⭐⭐ THESE ARE BEHAVIOUR TESTS, NOT SOURCE SCANS. They call the SAME helpers
// the route calls — tenantTodayISO / safeTimeZone / isSeasonallyDormant — and
// assert what the sweep would CONCLUDE. A test that grepped the route for
// `tenantTodayISO` would pass on a file that imported it and never used it.
//
// ⛔ Pure: no network, no database, no clock of its own. Every instant is fixed.

import { safeTimeZone, tenantTodayISO, tenantDateISO, hasDstTransition, tenantDayLengthHours, FALLBACK_TIME_ZONE } from '../src/lib/tenantTime'
import { isSeasonallyDormant } from '../src/lib/signals'
import { DEFAULT_SEASONS } from '../src/lib/seasons'

let pass = 0, fail = 0
const H = (t: string) => console.log(`\n═══ ${t} ═══`)
const eq = (n: string, a: unknown, b: unknown) => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (ok) { pass++; console.log(`  ✅ ${n}`) }
  else { fail++; console.log(`  ❌ ${n}\n     expected: ${JSON.stringify(b)}\n     actual:   ${JSON.stringify(a)}`) }
}
const ok = (n: string, c: boolean, d = '') => eq(n + (c || !d ? '' : ` — ${d}`), c, true)

const WEST = 'America/Edmonton'   // UTC−7 / −6
const EAST = 'Pacific/Auckland'   // UTC+12 / +13

// ═══════════════════════════════════════════════════════════════════════════
H('1. TWO TENANTS, ONE INSTANT, OPPOSITE DATES — and opposite verdicts')
// 04:00 UTC on Nov 1 2026. In Edmonton it is still 22:00 on Oct 31; in Auckland
// it is already 17:00 on Nov 1. The lawn season ends Oct 31, so this single
// instant sits on OPPOSITE SIDES of the season boundary for the two tenants.
{
  const instant = new Date('2026-11-01T04:00:00Z')
  const west = tenantTodayISO(WEST, instant)
  const east = tenantTodayISO(EAST, instant)
  eq('the western tenant is still on Oct 31', west, '2026-10-31')
  eq('the eastern tenant is already on Nov 1', east, '2026-11-01')
  ok('⭐ same instant, different calendar dates', west !== east)

  // The consequence the sweep actually draws, through the real detector.
  const westDormant = isSeasonallyDormant('Weekly Mowing', DEFAULT_SEASONS, west)
  const eastDormant = isSeasonallyDormant('Weekly Mowing', DEFAULT_SEASONS, east)
  eq('west: still in season, so NOT dormant', westDormant, false)
  eq('east: season has closed, so dormant', eastDormant, true)
  ok('⛔ the verdict genuinely differs by tenant', westDormant !== eastDormant)

  // ⛔ THE DEFECT, MADE VISIBLE. One server date for everyone collapses the two
  // answers into one — and the answer the western tenant gets is FALSE for them:
  // they are told their mowing season has ended while it is still October there.
  const serverDate = tenantDateISO('UTC', instant)
  eq('a single server date would be Nov 1 for everyone', serverDate, '2026-11-01')
  const collapsedWest = isSeasonallyDormant('Weekly Mowing', DEFAULT_SEASONS, serverDate)
  eq('⛔ …which marks the WESTERN tenant dormant a day early', collapsedWest, true)
  ok('⛔ that is the wrong answer for them', collapsedWest !== westDormant)
}

// ═══════════════════════════════════════════════════════════════════════════
H('2. UTC ROLLOVER — the half hour where the server has changed day and the tenant has not')
{
  const instant = new Date('2026-06-15T00:30:00Z')
  const serverDate = tenantDateISO('UTC', instant)
  const west = tenantTodayISO(WEST, instant)
  eq('server (UTC) has rolled over', serverDate, '2026-06-15')
  eq('the western tenant has not', west, '2026-06-14')

  // The exact comparison the route makes for `hasUpcoming`. A visit on Jun 14 is
  // still today's work for this tenant; under the server date it has silently
  // become the past, and the customer reads as having nothing booked.
  const visit = '2026-06-14'
  eq('under the TENANT date the visit is still upcoming', visit >= west, true)
  eq('⛔ under the SERVER date it has already become the past', visit >= serverDate, false)
}

// ═══════════════════════════════════════════════════════════════════════════
H('3. DST — a transition must not lose or invent a day')
{
  // Edmonton springs forward 2026-03-08 (23h) and falls back 2026-11-01 (25h).
  ok('spring-forward day is detected as a transition', hasDstTransition(WEST, '2026-03-08'))
  eq('…and is 23 hours long', tenantDayLengthHours(WEST, '2026-03-08'), 23)
  ok('fall-back day is detected as a transition', hasDstTransition(WEST, '2026-11-01'))
  eq('…and is 25 hours long', tenantDayLengthHours(WEST, '2026-11-01'), 25)
  ok('[negative control] an ordinary day is not a transition', !hasDstTransition(WEST, '2026-06-15'))
  eq('…and is 24 hours long', tenantDayLengthHours(WEST, '2026-06-15'), 24)

  // Dates either side of the spring-forward instant stay contiguous: the short
  // day must still be exactly one calendar day, never skipped.
  eq('just before the jump it is Mar 8', tenantDateISO(WEST, new Date('2026-03-08T08:59:00Z')), '2026-03-08')
  eq('just after the jump it is still Mar 8', tenantDateISO(WEST, new Date('2026-03-08T09:01:00Z')), '2026-03-08')
  eq('the evening before was Mar 7', tenantDateISO(WEST, new Date('2026-03-08T06:00:00Z')), '2026-03-07')

  // The fall-back hour repeats; both passes are still the same calendar day.
  eq('first pass through 01:30 local is Nov 1', tenantDateISO(WEST, new Date('2026-11-01T07:30:00Z')), '2026-11-01')
  eq('second pass through 01:30 local is also Nov 1', tenantDateISO(WEST, new Date('2026-11-01T08:30:00Z')), '2026-11-01')
}

// ═══════════════════════════════════════════════════════════════════════════
H('4. FALLBACK POLICY — an unset zone is the shared fallback, never UTC by accident')
{
  eq('a null zone falls back', safeTimeZone(null), FALLBACK_TIME_ZONE)
  eq('an unparseable zone falls back', safeTimeZone('Mars/Olympus_Mons'), FALLBACK_TIME_ZONE)
  eq('a real zone is kept', safeTimeZone(EAST), EAST)

  // A tenant who has never set a zone must be dated like the rest of the product
  // dates them — by the fallback — and at this instant that is NOT the UTC date.
  const instant = new Date('2026-11-01T04:00:00Z')
  const unset = tenantTodayISO(safeTimeZone(null), instant)
  eq('an unset tenant gets the fallback date', unset, tenantTodayISO(FALLBACK_TIME_ZONE, instant))
  ok('⛔ …which is NOT the UTC date at this instant', unset !== tenantDateISO('UTC', instant))
}

// ═══════════════════════════════════════════════════════════════════════════
H('5. [negative control] the tests are not trivially always-different')
{
  // ⚠️ The window where BOTH zones share a date is narrow and had to be computed,
  // not guessed: Edmonton is UTC−6 and Auckland UTC+12 in June, so they agree only
  // for UTC 06:00–11:59. The first draft used 12:00Z — at which Auckland has
  // ALREADY rolled to the next day — and this control caught it.
  const calm = new Date('2026-06-15T08:00:00Z')
  eq('west and east agree at a calm instant', tenantTodayISO(WEST, calm), tenantTodayISO(EAST, calm))
  eq('…and so does the server', tenantDateISO('UTC', calm), tenantTodayISO(WEST, calm))
}

console.log('')
if (fail) { console.log(`✗ cron-tenant-time: ${fail} check(s) failed (${pass} held)\n`); process.exit(1) }
console.log(`✓ cron-tenant-time: every tenant is dated in its own zone (${pass} checks)\n`)
