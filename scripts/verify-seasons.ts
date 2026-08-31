// ── Verify: the seasons engine works for trades that aren't lawn care ────────
//   npm run verify:seasons
//
// ⭐⭐ RE-POINTED AT THE CUTOVER (S110). These checks used to drive the RUNTIME
// season resolver. The runtime no longer infers anything from a name — a series
// declares its season (job_recurrences.season_key) — so driving the runtime here
// would now assert only that a declaration-free call returns null, which proves
// nothing about any trade.
//
// What still needs proving is the MIGRATION SUGGESTER: `inferSeasonKeyFromName`
// is what season-reconcile.ts offers a human and what the one-time backfill
// applies. If it silently stopped recognising a pool business, the owner would be
// handed "no suggestion" for every pool series and would never know why. So the
// same cases now assert the SUGGESTION (a season KEY) rather than a resolved season.
//
// WHY THIS SCRIPT EXISTS
// seasonForService used to map a service to its season by HARDCODED English lawn/
// snow keywords. A genuinely seasonal non-lawn trade (a pool company: opens in
// spring, closes in fall) matched nothing, fell to year-round with no season end,
// and the reactivation engine could not tell "their season ended" from "we lost
// them" — so it flagged every off-season pool customer as lapsed. tsc and next
// build both pass with that bug present, because a wrong season is a wrong VALUE,
// not a type error. The only way to catch it is to exercise the engine.
//
// It runs the REAL engine (no copies, no mocks) for a lawn business and a pool
// business and asserts: the lawn business is byte-for-byte unchanged, and the pool
// business now gets a real season with a real end date. Deterministic, no network,
// no API key — runs in CI beside the other verifiers.

import { seasonEndDateFor, settingsToSeasons, DEFAULT_SEASONS, DEFAULT_LAWN_SEASON, DEFAULT_SNOW_SEASON, type ServiceSeasons } from '../src/lib/seasons'
import { serviceCategory, inferSeasonKeyFromName } from '../src/lib/legacySeasonInference'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))

// ── 1. LAWN BUSINESS — must behave EXACTLY as before the change ───────────────
console.log('\nLawn business (default seasons) — nothing may change:')
{
  const S = DEFAULT_SEASONS
  check('"Weekly Mowing" → lawn season',
    inferSeasonKeyFromName('Weekly Mowing', S) === 'lawn')
  check('"Fertilization" → lawn season',
    inferSeasonKeyFromName('Fertilization', S) === 'lawn')
  check('"Snow Removal" → snow season',
    inferSeasonKeyFromName('Snow Removal', S) === 'snow')
  check('"Snow Plowing" → snow season',
    inferSeasonKeyFromName('Snow Plowing', S) === 'snow')
  check('snow-before-lawn priority preserved ("Lawn & Snow Combo" → snow)',
    inferSeasonKeyFromName('Lawn & Snow Combo', S) === 'snow',
    `got ${JSON.stringify(inferSeasonKeyFromName('Lawn & Snow Combo', S))}`)
  check('unrelated service → no season (year-round)',
    inferSeasonKeyFromName('One-off Cleanup', S) === null)
  check('serviceCategory unchanged: "Weekly Mowing" → lawn',
    serviceCategory('Weekly Mowing') === 'lawn')
  check('serviceCategory unchanged: "Snow Removal" → snow',
    serviceCategory('Snow Removal') === 'snow')
  // The exact end date a lawn series gets — the number reactivation depends on.
  check('lawn season end date for an Apr 20 start = Oct 31',
    seasonEndDateFor('2026-04-20', S.lawn) === '2026-10-31',
    seasonEndDateFor('2026-04-20', S.lawn))
}

// ── 2. POOL BUSINESS — the bug being fixed ────────────────────────────────────
// A pool company defines its season in the EXISTING service_seasons jsonb: a "pool"
// key with owner match keywords. No industry picker, no schema change, no code edit.
console.log('\nPool business (owner-defined pool season) — the fix:')
{
  const rawFromDb = {
    lawn: DEFAULT_LAWN_SEASON,
    snow: DEFAULT_SNOW_SEASON,
    pool: { label: 'Pool season', match: ['pool', 'open', 'clos'], startMonth: 5, startDay: 1, endMonth: 9, endDay: 30 },
  }
  const S = settingsToSeasons(rawFromDb)
  check('settingsToSeasons PRESERVES the custom "pool" key (was silently dropped)',
    !!S.pool && S.pool.startMonth === 5,
    `pool = ${JSON.stringify(S.pool)}`)
  check('"Pool Opening" → pool season (was null → year-round → false "lapsed")',
    inferSeasonKeyFromName('Pool Opening', S) === 'pool',
    `got ${JSON.stringify(inferSeasonKeyFromName('Pool Opening', S))}`)
  check('"Weekly Pool Cleaning" → pool season',
    inferSeasonKeyFromName('Weekly Pool Cleaning', S) === 'pool')
  check('pool season has a real END date (May 1 start → Sep 30)',
    seasonEndDateFor('2026-05-01', S.pool) === '2026-09-30',
    seasonEndDateFor('2026-05-01', S.pool))
  // The pool business may ALSO leave the lawn/snow defaults in place; they must not
  // hijack a pool service, and a lawn service must still resolve if they offer one.
  check('a pool business still resolves "Weekly Mowing" → lawn (defaults intact)',
    inferSeasonKeyFromName('Weekly Mowing', S) === 'lawn')
}

// ── 3. YEAR-ROUND TRADE — genuinely no season (must NOT invent one) ───────────
// A plumber/electrician has no season. seasonForService must return null so the
// health engine judges them by cadence, not by a season end that doesn't exist.
console.log('\nYear-round trade (plumber, no season defined) — must stay seasonless:')
{
  const S = DEFAULT_SEASONS
  check('"Drain Cleaning" → no season', inferSeasonKeyFromName('Drain Cleaning', S) === null)
  check('"Water Heater Install" → no season', inferSeasonKeyFromName('Water Heater Install', S) === null)
  check('"Panel Upgrade" → no season', inferSeasonKeyFromName('Panel Upgrade', S) === null)
}

// ── 4. LEGACY DATA — stored seasons predating `match` ─────────────────────────
// Every existing install has {lawn:{dates}, snow:{dates}} with NO match arrays.
// They must resolve identically to a fresh default install.
console.log('\nLegacy stored seasons (no match arrays) — identical to defaults:')
{
  const legacy = { lawn: { startMonth: 4, startDay: 15, endMonth: 10, endDay: 31 }, snow: { startMonth: 11, startDay: 1, endMonth: 3, endDay: 31 } }
  const S: ServiceSeasons = settingsToSeasons(legacy)
  check('"Weekly Mowing" → lawn (fallback hint path)', inferSeasonKeyFromName('Weekly Mowing', S) === 'lawn')
  check('"Snow Removal" → snow (fallback hint path)', inferSeasonKeyFromName('Snow Removal', S) === 'snow')
  check('garbage input → safe defaults', settingsToSeasons(null).lawn.startMonth === 4)
}

// ── 5. RESOLUTION ORDER — deterministic across save/reload ────────────────────
// Postgres jsonb canonicalises key order, so which of two overlapping custom
// seasons wins must NOT depend on in-memory insertion order — the engine sorts.
console.log('\nOverlapping custom seasons — same winner before and after a save/reload:')
{
  const a = { label: 'Pest', match: ['spray'], startMonth: 4, startDay: 1, endMonth: 8, endDay: 31 }
  const b = { label: 'Sprinkler', match: ['spray'], startMonth: 5, startDay: 1, endMonth: 9, endDay: 30 }
  // Same seasons, two insertion orders (pre-save vs post-jsonb-roundtrip).
  const orderOne = settingsToSeasons({ lawn: DEFAULT_LAWN_SEASON, snow: DEFAULT_SNOW_SEASON, 'custom-2': a, 'custom-1': b })
  const orderTwo = settingsToSeasons({ lawn: DEFAULT_LAWN_SEASON, snow: DEFAULT_SNOW_SEASON, 'custom-1': b, 'custom-2': a })
  const w1 = inferSeasonKeyFromName('Spring Spray Treatment', orderOne)
  const w2 = inferSeasonKeyFromName('Spring Spray Treatment', orderTwo)
  // ⭐ 'custom-1' is the Sprinkler season; sorted keys make the winner stable
  // across a jsonb round-trip, which is the whole point of this case.
  check('winner is identical regardless of object key order',
    w1 === w2 && w1 === 'custom-1',
    `orderOne → ${w1}, orderTwo → ${w2} (sorted keys: custom-1 first)`)
}

// ── 6. IMPOSSIBLE DAYS — clamp to the month's real end, never an invalid date ──
// The editor caps days at 31 with no month awareness, so "Feb 30" can reach the
// store; unclamped, seasonEndDateFor emitted '2027-02-30', which crashes
// formatDate at render and is rejected by the job_recurrences insert.
console.log('\nMonth-impossible end days — clamped to a real date:')
{
  const feb30 = { label: 'Odd', match: ['odd'], startMonth: 11, startDay: 1, endMonth: 2, endDay: 30 }
  check('Feb 30 in a non-leap year → Feb 28', seasonEndDateFor('2026-12-01', feb30) === '2027-02-28', seasonEndDateFor('2026-12-01', feb30))
  const feb29 = { ...feb30, endDay: 29 }
  check('Feb 29 in a leap year stays Feb 29', seasonEndDateFor('2027-12-01', feb29) === '2028-02-29', seasonEndDateFor('2027-12-01', feb29))
  const sep31 = { label: 'Odd2', match: ['odd'], startMonth: 5, startDay: 1, endMonth: 9, endDay: 31 }
  check('Sep 31 → Sep 30', seasonEndDateFor('2026-05-01', sep31) === '2026-09-30', seasonEndDateFor('2026-05-01', sep31))
  check('valid dates untouched (Oct 31 stays Oct 31)', seasonEndDateFor('2026-04-20', DEFAULT_LAWN_SEASON) === '2026-10-31')
}

console.log('')
if (failures) { console.log(`✗ ${failures} check(s) failed\n`); process.exit(1) }
console.log('✓ all seasons checks passed — lawn unchanged, non-lawn trades now seasonal\n')
