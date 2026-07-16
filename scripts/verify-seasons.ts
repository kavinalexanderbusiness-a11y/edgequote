// ── Verify: the seasons engine works for trades that aren't lawn care ────────
//   npm run verify:seasons
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

import {
  seasonForService, seasonEndDateFor, settingsToSeasons, serviceCategory,
  DEFAULT_SEASONS, DEFAULT_LAWN_SEASON, DEFAULT_SNOW_SEASON, type ServiceSeasons,
} from '../src/lib/seasons'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))

// ── 1. LAWN BUSINESS — must behave EXACTLY as before the change ───────────────
console.log('\nLawn business (default seasons) — nothing may change:')
{
  const S = DEFAULT_SEASONS
  check('"Weekly Mowing" → lawn season',
    seasonForService('Weekly Mowing', S) === S.lawn)
  check('"Fertilization" → lawn season',
    seasonForService('Fertilization', S) === S.lawn)
  check('"Snow Removal" → snow season',
    seasonForService('Snow Removal', S) === S.snow)
  check('"Snow Plowing" → snow season',
    seasonForService('Snow Plowing', S) === S.snow)
  check('snow-before-lawn priority preserved ("Lawn & Snow Combo" → snow)',
    seasonForService('Lawn & Snow Combo', S) === S.snow,
    `got ${JSON.stringify(seasonForService('Lawn & Snow Combo', S))}`)
  check('unrelated service → no season (year-round)',
    seasonForService('One-off Cleanup', S) === null)
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
    seasonForService('Pool Opening', S) === S.pool,
    `got ${JSON.stringify(seasonForService('Pool Opening', S))}`)
  check('"Weekly Pool Cleaning" → pool season',
    seasonForService('Weekly Pool Cleaning', S) === S.pool)
  check('pool season has a real END date (May 1 start → Sep 30)',
    seasonEndDateFor('2026-05-01', S.pool) === '2026-09-30',
    seasonEndDateFor('2026-05-01', S.pool))
  // The pool business may ALSO leave the lawn/snow defaults in place; they must not
  // hijack a pool service, and a lawn service must still resolve if they offer one.
  check('a pool business still resolves "Weekly Mowing" → lawn (defaults intact)',
    seasonForService('Weekly Mowing', S) === S.lawn)
}

// ── 3. YEAR-ROUND TRADE — genuinely no season (must NOT invent one) ───────────
// A plumber/electrician has no season. seasonForService must return null so the
// health engine judges them by cadence, not by a season end that doesn't exist.
console.log('\nYear-round trade (plumber, no season defined) — must stay seasonless:')
{
  const S = DEFAULT_SEASONS
  check('"Drain Cleaning" → no season', seasonForService('Drain Cleaning', S) === null)
  check('"Water Heater Install" → no season', seasonForService('Water Heater Install', S) === null)
  check('"Panel Upgrade" → no season', seasonForService('Panel Upgrade', S) === null)
}

// ── 4. LEGACY DATA — stored seasons predating `match` ─────────────────────────
// Every existing install has {lawn:{dates}, snow:{dates}} with NO match arrays.
// They must resolve identically to a fresh default install.
console.log('\nLegacy stored seasons (no match arrays) — identical to defaults:')
{
  const legacy = { lawn: { startMonth: 4, startDay: 15, endMonth: 10, endDay: 31 }, snow: { startMonth: 11, startDay: 1, endMonth: 3, endDay: 31 } }
  const S: ServiceSeasons = settingsToSeasons(legacy)
  check('"Weekly Mowing" → lawn (fallback hint path)', seasonForService('Weekly Mowing', S) === S.lawn)
  check('"Snow Removal" → snow (fallback hint path)', seasonForService('Snow Removal', S) === S.snow)
  check('garbage input → safe defaults', settingsToSeasons(null).lawn.startMonth === 4)
}

console.log('')
if (failures) { console.log(`✗ ${failures} check(s) failed\n`); process.exit(1) }
console.log('✓ all seasons checks passed — lawn unchanged, non-lawn trades now seasonal\n')
