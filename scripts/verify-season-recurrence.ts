// ── Verify: a series' season is DECLARED, and it bounds what gets generated ──
//   npm run verify:season-recurrence
//
// WHY THIS SCRIPT EXISTS
// Production audit, 2026-08-29: recurring visits scheduled through winter under
// a configured season. Measured on the live book with the product's own engine
// (scripts/season-reconcile.ts, read-only):
//
//   14 series named "…Mowing" / "Lawn Mowing" → matched 'mow'/'lawn' → lawn
//                                               season, end_date 2026-10-31 ✅
//    1 series named "Bi-weekly"               → matched NOTHING → no season, no
//                                               end_date, 24 future visits
//                                               generated through to 2027-07-31
//    1 series named "General Upkeep"          → matched NOTHING → no season
//
// ⭐⭐ Identical cadence, identical intent, opposite outcome — decided entirely
// by what the owner typed in a name field. The arithmetic in lib/seasons was
// never wrong; the INPUT was. Governance was accidental.
//
// THE RULES PINNED
//   1  a DECLARED season always wins — the service name is never consulted
//      when a declaration exists                                 ← the point
//   2  "no season" is a DECISION (SEASON_NONE), distinct from "nobody has said"
//   3  a season BOUNDS generation, and can only ever shorten it
//   4  cross-year seasons (Nov→Mar) and leap years resolve correctly
//   5  renaming a service cannot change when the series runs
//   6  ⛔ no visit is generated past the effective end — the winter case
//   7  the reconciliation report is READ-ONLY

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  resolveSeriesSeason, effectiveSeriesEnd, seasonEndDateFor, isWithinSeason,
  settingsToSeasons, seasonKeys, SEASON_NONE, DEFAULT_SEASONS,
  type ServiceSeason, type ServiceSeasons,
} from '../src/lib/seasons'
import { generateOccurrences } from '../src/lib/recurrence'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const bad = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, c: boolean, d = '') => c ? ok(n) : bad(n, d)
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const SCHEME = 'SCHEME'
/** ⚠️ `://` is not a comment. A naive line-comment strip deletes the rest of a
 *  line from the `//` of a URL, which silently removes what a scan is hunting. */
const strip = (s: string) => s
  .replace(/:\/\//g, SCHEME).replace(/\/\/[^\n\r]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .split(SCHEME).join('://')

// ── Fixtures. ⛔ No production row is read or written by this guard. ─────────
const LAWN: ServiceSeason = { startMonth: 4, startDay: 15, endMonth: 10, endDay: 31, label: 'Lawn' }
const SNOW: ServiceSeason = { startMonth: 11, startDay: 1, endMonth: 3, endDay: 31, label: 'Snow' }
const POOL: ServiceSeason = { startMonth: 5, startDay: 1, endMonth: 9, endDay: 15, label: 'Pool', match: ['pool'] }
const LEAPY: ServiceSeason = { startMonth: 3, startDay: 1, endMonth: 2, endDay: 29, label: 'Leap' }
const SEASONS: ServiceSeasons = { lawn: LAWN, snow: SNOW, pool: POOL, leap: LEAPY }

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 1 · a DECLARED season wins — the name is never consulted')

{
  // ⭐ THE HEADLINE. A series named "Snow Removal" that DECLARES lawn is a lawn
  // series. If the name could still win, renaming would move the season.
  const r = resolveSeriesSeason({ seasonKey: 'lawn' }, SEASONS)
  eq('a declared season beats a contradicting name', r.season, LAWN)
  eq('…and says it was declared', r.source, 'declared')
}

{
  // The production case: a name that matches NOTHING still resolves, because the
  // series declared its season.
  const r = resolveSeriesSeason({ seasonKey: 'lawn' }, SEASONS)
  eq('"Bi-weekly" resolves when it declares lawn', r.season, LAWN)
  const g = resolveSeriesSeason({ seasonKey: 'lawn' }, SEASONS)
  eq('…and so does "General Upkeep"', g.season, LAWN)
}

{
  // Renaming cannot change governance.
  const before = resolveSeriesSeason({ seasonKey: 'pool' }, SEASONS)
  const after = resolveSeriesSeason({ seasonKey: 'pool' }, SEASONS)
  eq('renaming a declared series changes nothing', after.season, before.season)
  eq('…still the pool season', after.season, POOL)
}

{
  // ⛔ A key naming a season the business does not have is NOT downgraded to a
  // guess — answering with a different season would be worse than admitting it.
  const r = resolveSeriesSeason({ seasonKey: 'holiday_lights' }, SEASONS)
  eq('an unknown key does not fall back to the name', r.season, null)
  eq('…and reports itself unresolved', r.source, 'unknown')
  eq('…while remembering what was asked for', r.key, 'holiday_lights')
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 2 · "no season" is a DECISION, not an absence')

{
  const none = resolveSeriesSeason({ seasonKey: SEASON_NONE }, SEASONS)
  eq('SEASON_NONE means no season even for a lawn-shaped name', none.season, null)
  eq('…and is reported as a decision', none.source, 'declared-none')

  const silent = resolveSeriesSeason({ seasonKey: null }, SEASONS)
  eq('an undeclared series is NOT the same answer', silent.source, 'unknown')
  check('…the two are distinguishable', none.source !== silent.source)
}

{
  // ⛔⛔ THERE IS NO INFERENCE LEFT AT RUNTIME. Not a disabled branch, not a
  // flag — the resolver has no parameter for a service name and no code path
  // that reads one. An undeclared series answers `unknown`, always.
  const undeclared = resolveSeriesSeason({ seasonKey: null }, SEASONS)
  eq('an undeclared series never resolves to a season', undeclared.season, null)
  eq('…and never claims a source it did not use', undeclared.source, 'unknown')
  eq('…and an empty declaration is not a declaration',
    resolveSeriesSeason({ seasonKey: '   ' }, SEASONS).source, 'unknown')
  // ⭐ A declaration resolves with no fallback in play at all — the end state.
  eq('a declaration resolves on its own', resolveSeriesSeason({ seasonKey: 'lawn' }, SEASONS).season, LAWN)

  // The resolver's INPUT has no field a name could arrive through.
  const iface = strip(read('src/lib/seasons.ts')).split('interface SeriesSeasonInput')[1]?.split('}')[0] ?? ''
  check('⛔ the resolver input has no service-name field at all',
    iface.length > 0 && !/serviceType|serviceName|title/i.test(iface), iface.trim())
  check('[negative control] the field matcher works', /serviceType/i.test('  serviceType?: string'))
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 3 · a season BOUNDS the series, and only shortens it')

{
  eq('with no season the owner\'s end date stands',
    effectiveSeriesEnd('2026-05-01', '2026-12-31', null), '2026-12-31')
  eq('with no season and no end date there is no bound',
    effectiveSeriesEnd('2026-05-01', null, null), null)
  eq('a season supplies the bound when the owner gave none',
    effectiveSeriesEnd('2026-05-01', null, LAWN), '2026-10-31')
  eq('the season wins when it is EARLIER',
    effectiveSeriesEnd('2026-05-01', '2026-12-31', LAWN), '2026-10-31')
  eq('⛔ the season NEVER extends past the owner\'s date',
    effectiveSeriesEnd('2026-05-01', '2026-06-30', LAWN), '2026-06-30')
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 4 · cross-year seasons and leap years')

{
  // Snow: Nov 1 → Mar 31. A November start ends the FOLLOWING March.
  eq('a Nov start ends next March', seasonEndDateFor('2026-11-10', SNOW), '2027-03-31')
  eq('…a January start ends the SAME March', seasonEndDateFor('2027-01-10', SNOW), '2027-03-31')
  eq('…and the bound follows', effectiveSeriesEnd('2026-11-10', null, SNOW), '2027-03-31')
  check('a December date is in the snow season', isWithinSeason('2026-12-25', SNOW))
  check('…and so is February', isWithinSeason('2027-02-14', SNOW))
  check('⛔ but July is not', !isWithinSeason('2026-07-04', SNOW))
}

{
  // Leap: a season ending Feb 29 must clamp in a non-leap year rather than
  // producing '2027-02-29', which is not a date.
  eq('Feb 29 clamps to Feb 28 in a non-leap year', seasonEndDateFor('2026-03-05', LEAPY), '2027-02-28')
  eq('…and stays Feb 29 in a leap year', seasonEndDateFor('2027-03-05', LEAPY), '2028-02-29')
  for (const d of [seasonEndDateFor('2026-03-05', LEAPY), seasonEndDateFor('2027-03-05', LEAPY)]) {
    check(`${d} is a real date`, !Number.isNaN(new Date(`${d}T00:00:00`).getTime()), d)
  }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 5 · ⛔ nothing is generated past the effective end — the winter case')

{
  // ⭐⭐ THE PRODUCTION DEFECT, reproduced and then fixed by a declaration.
  // Sajjan: biweekly, started 2026-04-18, no end date, service named "Bi-weekly".
  const START = '2026-04-18'
  const undeclaredEnd = effectiveSeriesEnd(START, null, resolveSeriesSeason({ seasonKey: null }, SEASONS).season)
  eq('undeclared + unmatched name ⇒ NO bound (the live defect)', undeclaredEnd, null)
  const runaway = generateOccurrences(START, 'week', 2, undeclaredEnd, null)
  check('…so generation runs past the season, into winter', runaway.some(d => d > '2026-10-31'),
    `last generated ${runaway[runaway.length - 1]}`)
  check('…and even into the following year', runaway.some(d => d >= '2027-01-01'),
    `last generated ${runaway[runaway.length - 1]}`)

  // The same series, declaring lawn.
  const declaredEnd = effectiveSeriesEnd(START, null, resolveSeriesSeason({ seasonKey: 'lawn' }, SEASONS).season)
  eq('declaring the season supplies the bound', declaredEnd, '2026-10-31')
  const bounded = generateOccurrences(START, 'week', 2, declaredEnd, null)
  eq('⛔ NOT ONE visit past the season end', bounded.filter(d => d > '2026-10-31'), [])
  check('…and the series still runs a real season', bounded.length >= 12, String(bounded.length))
  check('…every generated date is in season',
    bounded.every(d => isWithinSeason(d, LAWN)), bounded.filter(d => !isWithinSeason(d, LAWN)).join(','))
  eq('…the last visit is on or before the end', bounded[bounded.length - 1] <= '2026-10-31', true)
}

{
  // A wrapping season generates ACROSS the new year — the bound must not cut it
  // off in December.
  const dates = generateOccurrences('2026-11-05', 'week', 1, effectiveSeriesEnd('2026-11-05', null, SNOW), null)
  check('a snow series runs into the new year', dates.some(d => d.startsWith('2027-')), dates.join(',').slice(0, 80))
  eq('…and stops at the March end', dates.filter(d => d > '2027-03-31'), [])
  check('…every date is in the snow season', dates.every(d => isWithinSeason(d, SNOW)))
}

{
  // ⛔ An end date BEFORE the start must not generate a phantom past visit.
  const past = generateOccurrences('2026-05-01', 'week', 1, '2026-04-01', null)
  eq('an end date before the start generates nothing', past, [])
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 6 · the shape of the model')

{
  eq('the configured seasons round-trip off business_settings',
    seasonKeys(settingsToSeasons({ lawn: LAWN, snow: SNOW, pool: POOL })), ['lawn', 'pool', 'snow'])
  eq('…and a missing setting falls back to the defaults',
    seasonKeys(settingsToSeasons(null)), seasonKeys(DEFAULT_SEASONS))
  check('SEASON_NONE is not a real season key',
    !seasonKeys(SEASONS).includes(SEASON_NONE))
}

{
  const src = strip(read('src/lib/seasons.ts'))
  // ⛔⛔ THE QUARANTINE. The runtime seasons module must not read a service name
  // at all, and must not reach the legacy keyword module.
  check('⛔ the runtime seasons module never reads a service name',
    !/input\.serviceType|serviceType|serviceName/.test(src),
    'lib/seasons reads a service name again')
  check('⛔ …and does not import the quarantined inference',
    !/legacySeasonInference/.test(src.replace(/\/\/[^\n]*/g, '')),
    'lib/seasons imports the keyword guess')
  // No file under src/ may import the season RESOLVER or the suggestion helper.
  // (serviceCategory and the hint lists are permitted: duplicate-detection and a
  // settings collision warning, neither of which resolves a season.)
  const SRC: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(join(ROOT, d))) {
      const rel = `${d}/${e}`
      if (statSync(join(ROOT, rel)).isDirectory()) { walk(rel); continue }
      if (/\.(ts|tsx)$/.test(e)) SRC.push(rel)
    }
  }
  walk('src')
  const reaching = SRC.filter(f => f !== 'src/lib/legacySeasonInference.ts')
    .filter(f => /\b(seasonForService|inferSeasonKeyFromName)\b/.test(strip(read(f))))
  eq('⛔ NO file under src/ resolves a season from a name', reaching, [])
  check('[negative control] a reintroduced call would be caught',
    /\b(seasonForService|inferSeasonKeyFromName)\b/.test('const s = seasonForService(x, y)'))
  check('⛔ the resolver has no industry keyword of its own',
    !/\b(mow|snow|plow|pool|pest|lawn)\b/i.test(src.split('export function resolveSeriesSeason')[1]?.split('export function seasonKeys')[0] ?? ''),
    'resolveSeriesSeason names a trade')
  check('[negative control] the keyword matcher works', /\bmow\b/i.test('weekly mow'))
}

{
  const jfRaw = read('src/components/schedule/JobForm.tsx')
  const jf = strip(jfRaw)
  check('the job form resolves from the declaration, not the name',
    /resolveSeriesSeason\(\{\s*seasonKey/.test(jf),
    'JobForm still asks seasonForService directly')

  // ── Point 3: the canonical fact is a CONTROL, not a hidden column ─────────
  check('the series editor offers a Season control',
    /<Select label="Season"/.test(jfRaw), 'no Season selector is rendered')
  check('…listing every configured season',
    /seasonKeys\(seasons\)\.map/.test(jf), 'the selector does not enumerate configured seasons')
  check('…offering Year-round explicitly',
    /value: SEASON_NONE, label: 'Year-round/.test(jfRaw))
  check('…and offering "Needs selection" as a real option',
    /label: 'Needs selection'/.test(jfRaw))
  // ⛔ THE ONE THAT MATTERS: unknown must be SURFACED, never rendered as
  // year-round. A series nobody declared is how winter visits happened.
  check('⛔ an undeclared series is surfaced, not silently year-round',
    /seasonNeedsSelection\s*=\s*seasonResolution\.source === 'unknown'/.test(jf)
    && /\{seasonNeedsSelection && \(/.test(jfRaw),
    'the editor does not distinguish "needs selection" from year-round')
  check('…and says what happens if it is left unset',
    /nothing stops it from repeating out of\s+season/.test(jfRaw))
  // ⚠️ Anchored on the PAYLOAD, not on the expression. `seasonKey:
  // seasonKeyChoice || null` appears twice — once resolving the season for the
  // form, once emitting it to the caller — so a loose match stayed green while
  // the emit was deleted. Mutation testing found exactly that. The trailing
  // comma is what distinguishes the object property from the call argument.
  check('the declaration travels with the series to the caller',
    /seasonKey: seasonKeyChoice \|\| null,/.test(jf),
    'the recurrence payload no longer carries the declaration')
  check('…and it is emitted alongside the other end rules',
    /endCount:[\s\S]{0,400}?seasonKey: seasonKeyChoice/.test(jf))
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 7 · the reconciliation report is READ-ONLY')

{
  const rec = strip(read('scripts/season-reconcile.ts'))
  check('⛔ it performs no write of any kind',
    !/\.(update|insert|upsert|delete)\(|method:\s*'(POST|PATCH|PUT|DELETE)'/i.test(
      rec.replace(/grant_type=password[\s\S]{0,200}?\}\)/, '')),
    'the read-only report can write')
  check('…and it uses the product\'s own engine rather than a copy',
    /from '\.\.\/src\/lib\/seasons'/.test(read('scripts/season-reconcile.ts')))
  // Negative control.
  check('[negative control] a write would be caught', /\.update\(/.test('x.update({a:1})'))
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('')
if (failures) {
  console.log(`✗ season-recurrence: ${failures} rule${failures === 1 ? '' : 's'} broken`)
  process.exit(1)
}
console.log('✓ season-recurrence: every rule holds')
