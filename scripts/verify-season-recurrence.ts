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
import { resolveSeriesSeason, seasonTransitionVerdict, transitionIsBroken, effectiveSeriesEnd, seasonEndDateFor, isWithinSeason, settingsToSeasons, seasonKeys, SEASON_NONE, DEFAULT_SEASONS, type ServiceSeason, type ServiceSeasons } from '../src/lib/seasons'
import { bridgeSeasonForSeries, SEASON_DECLARATIONS_COMPLETE } from '../src/lib/legacySeasonInference'
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
  // ── THE MIGRATION BRIDGE, and the exact shape of its retirement ───────────
  // ⭐⭐ A DECLARATION ALWAYS WINS, through the bridge as much as through the
  // resolver. This is the property that makes a rename harmless TODAY, before
  // the column has landed and before the flag flips.
  eq('the bridge honours a declaration over any name',
    bridgeSeasonForSeries('lawn', 'Snow Removal', SEASONS), LAWN)
  eq('…including a contradicting one, in the other direction',
    bridgeSeasonForSeries('snow', 'Weekly Mowing', SEASONS), SNOW)
  eq('…and SEASON_NONE means no season, whatever the name says',
    bridgeSeasonForSeries(SEASON_NONE, 'Weekly Mowing', SEASONS), null)
  eq('…renaming a DECLARED series changes nothing',
    bridgeSeasonForSeries('pool', 'Anything At All', SEASONS),
    bridgeSeasonForSeries('pool', 'Pool Opening', SEASONS))

  // Only an UNDECLARED series may fall back, and only while the book is
  // mid-migration. This is the one behaviour the flag governs.
  eq('an undeclared series still falls back while declarations are incomplete',
    bridgeSeasonForSeries(null, 'Weekly Mowing', SEASONS),
    SEASON_DECLARATIONS_COMPLETE ? null : LAWN)
  eq('…and an unmatched name gets nothing either way',
    bridgeSeasonForSeries(null, 'Bi-weekly', SEASONS), null)

  const leg = strip(read('src/lib/legacySeasonInference.ts'))
  // ⚠️ Tolerates the `: boolean` annotation. The annotation is deliberate (a
  // literal type would make the end state untestable), and an assertion that
  // breaks on it would be pinning the spelling rather than the switch. WHETHER
  // the value is right for the book is section 9's live half, not this one.
  check('the completion flag exists and is a single named switch',
    /export const SEASON_DECLARATIONS_COMPLETE(\s*:\s*boolean)?\s*=\s*(true|false)/.test(leg),
    'the transition switch is gone or is no longer a single constant')
  // ⛔ THE RETIREMENT IS ONE LINE, and it is structurally ahead of the guess.
  check('⛔ flipping the flag removes the fallback entirely',
    /if \(SEASON_DECLARATIONS_COMPLETE\) return null\s*\n\s*const key = inferSeasonKeyFromName/.test(leg),
    'the flag no longer short-circuits the keyword guess')
  check('…and a declaration is resolved BEFORE the flag is even consulted',
    leg.indexOf("if (declared.source !== 'unknown') return declared.season")
      < leg.indexOf('if (SEASON_DECLARATIONS_COMPLETE)'),
    'the guess can run ahead of a declaration')
  // ⛔ ORDER, not merely presence. A guess inserted BETWEEN the declaration and
  // the flag still leaves both lines in place and in order — so checking the
  // pair is not enough. The guess must come AFTER the short-circuit, or
  // flipping the flag would not retire it.
  check('⛔ the keyword guess sits AFTER the flag short-circuit',
    leg.indexOf('if (SEASON_DECLARATIONS_COMPLETE) return null')
      < leg.indexOf('inferSeasonKeyFromName(serviceType'),
    'the guess can run before the flag is consulted, so completing the migration would not retire it')
  // ⚠️ CALLS, not occurrences: `export function inferSeasonKeyFromName(` is the
  // declaration and must not be counted as a use of it.
  eq('…and the bridge calls the guess exactly once',
    (leg.match(/inferSeasonKeyFromName\(serviceType/g) ?? []).length, 1)

  // ⛔⛔ THE RESOLVER ITSELF NEVER SEES A NAME. Not a flag, not a branch — no
  // parameter. That is what makes "a rename cannot move a season" structural.
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
  eq('⛔ NO file under src/ calls the keyword guess directly — only the bridge may', reaching, [])
  // ⚠️ The control must exercise the matcher on what it is HUNTING (a direct
  // call to the guess), not on what it PERMITS (the bridge). An earlier version
  // tested the permitted form and so proved nothing.
  check('[negative control] a direct call to the guess would be caught',
    /\binferSeasonKeyFromName\b/.test('const k = inferSeasonKeyFromName(x, y)'))
  check('[negative control] …and the bridge is NOT flagged',
    !/\binferSeasonKeyFromName\b/.test('const s = bridgeSeasonForSeries(null, x, y)'))
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

  // ⛔⛔ A SERIES WITH A CUSTOMER MUST NEVER READ AS AN ORPHAN.
  // ⚠️ This is a fixed bug with teeth: the customer was read as
  // `jobsOfThisSeries[0].customers.name`, so a series with ZERO generated jobs
  // rendered as "(no customer)" — and an orphan reads to the owner as a dead
  // row nobody needs to decide about. One real customer was mis-reported that
  // way. `job_recurrences.customer_id` was being selected and then ignored.
  check('⛔ the customer is read from the RECURRENCE, not through its jobs',
    /custById\.get\(r\.customer_id\)/.test(rec),
    'the report reads the customer through the jobs join again — a series with no '
    + 'visits will render as an orphan')
  check('…with the jobs join only as a fallback',
    rec.indexOf('custById.get(r.customer_id)') < rec.indexOf('js[0]?.customers?.name'),
    'the jobs join takes precedence over the series\' own customer')
  check('…and the customer names are actually fetched for those ids',
    /customers\?select=id,name&id=in\./.test(rec))
  check('⛔ and the report FAILS if any row with a customer_id cannot be named',
    /RECONCILIATION INTEGRITY FAILURE/.test(rec) && /process\.exitCode = 1/.test(rec),
    'a projection bug would be reported as an orphan instead of as a failure')
  // Negative control.
  check('[negative control] the jobs-join read would be caught',
    /js\[0\]\?\.customers\?\.name/.test('who: js[0]?.customers?.name ?? "(no customer)"'))

  // ⛔ The owner's evidence for THIS decision must not become a product rule.
  const NO_QUOTE_RULE = /quotes?\b[\s\S]{0,80}(season|infer|classif)/i
  check('⛔ the report never infers a season from quote history',
    !NO_QUOTE_RULE.test(rec),
    'quote history has become a classification input — it was owner evidence for '
    + 'three specific decisions, not a rule')
  // Negative control.
  check('[negative control] a write would be caught', /\.update\(/.test('x.update({a:1})'))
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 8 · the migration backfills only what a RULE can classify')

{
  // ⚠️ The proposal SQL had no guard at all until mutation testing pointed it
  // out: three separate ways to make the backfill overreach all scanned clean.
  const sql = read('supabase/proposals/recurrence_season_key.sql')
  const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

  check('the backfill exists and writes season_key', /update public\.job_recurrences[\s\S]*set season_key/.test(code))
  // (a) it only ever acts on a real suggestion…
  check('⛔ it refuses to write when the keyword produced nothing',
    /and sg\.season_key is not null/.test(code),
    'the backfill can assign a season to a row no rule classified')
  // (b) …and only when doing so strands no existing visit.
  check('⛔ it refuses to write when future visits would fall out of season',
    /and coalesce\(o\.n, 0\) = 0;/.test(code),
    'the backfill dropped its out-of-season guard and can now strand real visits')
  check('…and only fills rows nobody has declared',
    /and r\.season_key is null/.test(code))

  // ⛔ It sets the declaration and NOTHING else.
  check('⛔ the backfill writes no end_date', !/set[\s\S]{0,200}end_date\s*=/.test(code),
    'the migration bounds a series as a side effect; that is an owner-visible action')
  check('⛔ and deletes nothing at all', !/\bdelete\s+from\b/i.test(code),
    'the migration removes rows — history is never traded for a rule change')

  // ⛔ GENERIC, not a list. A migration that names rows works on one book only.
  const NAMES = /\b(sajjan|sarah\s+brown|bi-?weekly|general\s+upkeep)\b/i
  check('⛔ no customer or service name appears anywhere in the migration',
    !NAMES.test(sql), (sql.match(NAMES) ?? []).join(' '))
  check('[negative control] a hardcoded name would be caught', NAMES.test("-- Sajjan's series"))

  // The season windows come from the owner's settings, not from constants.
  check('the season windows are read from the owner\'s own settings',
    /jsonb_each\(coalesce\(b\.service_seasons/.test(code))
  check('…and a wrapping season is handled', /case when se\.start_md <= se\.end_md/.test(code))
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 9 · the transition can END — the flag cannot sit false unnoticed')

// ── Offline half: the two states are internally consistent ──────────────────
{
  const leg = strip(read('src/lib/legacySeasonInference.ts'))
  if (SEASON_DECLARATIONS_COMPLETE) {
    // END STATE. The guess must be unreachable, not merely unused.
    eq('⛔ with declarations COMPLETE, an undeclared series gets NOTHING',
      bridgeSeasonForSeries(null, 'Weekly Mowing', SEASONS), null)
    eq('…and an undeclared series with any name gets nothing',
      bridgeSeasonForSeries(null, 'Snow Removal', SEASONS), null)
    check('…and a declaration still resolves',
      bridgeSeasonForSeries('lawn', 'anything', SEASONS) === LAWN)
  } else {
    // TRANSITIONAL. The bridge exists, and its retirement is one line.
    check('the bridge is transitional and says so',
      /SEASON_DECLARATIONS_COMPLETE/.test(leg) && /return null/.test(leg))
    eq('…and while incomplete an undeclared series still falls back',
      bridgeSeasonForSeries(null, 'Weekly Mowing', SEASONS), LAWN)
  }
}

// ── The ratchet rule itself, driven over fixtures ───────────────────────────
// ⭐⭐ Extracted to lib/seasons so it CAN be tested. While it lived inside this
// guard it was unguarded by construction — a guard cannot mutation-test its own
// logic, which is exactly what mutation testing exposed.
{
  const V = (columnExists: boolean, undeclaredActive: number, flag: boolean) =>
    seasonTransitionVerdict({ columnExists, undeclaredActive, flag })
  eq('column absent + flag false → not started', V(false, 0, false), 'not-started')
  eq('rows undeclared + flag false → in progress', V(true, 3, false), 'in-progress')
  eq('every row declared + flag true → complete', V(true, 0, true), 'complete')
  // ⛔ THE TWO FAILURES, and both must be reported as broken.
  eq('⛔ every row declared but flag STILL FALSE → overdue', V(true, 0, false), 'flag-overdue')
  eq('⛔ rows undeclared but flag ALREADY TRUE → too early', V(true, 3, true), 'flag-too-early')
  eq('⛔ column absent but flag already true → too early', V(false, 0, true), 'flag-too-early')
  check('…and both are treated as failures', transitionIsBroken('flag-overdue') && transitionIsBroken('flag-too-early'))
  check('…while the three legitimate states are not',
    !transitionIsBroken('not-started') && !transitionIsBroken('in-progress') && !transitionIsBroken('complete'))
  // ⭐ A single undeclared row is enough to hold the transition.
  eq('one undeclared row keeps the flag down', V(true, 1, false), 'in-progress')
}

// ── Live half: the flag and the BOOK must agree ─────────────────────────────
// ⭐⭐ THIS IS THE RATCHET. Two failure directions, both fatal:
//   • every series declared, flag still false  → the transition silently never
//     ended, and the keyword guess lives on forever. THE point of this section.
//   • series still undeclared, flag already true → flipping early strips the
//     season from every un-migrated series at once.
async function liveTransitionCheck() {
  const envPath = join(ROOT, '.env.local')
  let env: Record<string, string> = {}
  try {
    env = Object.fromEntries(readFileSync(envPath, 'utf8').split(/\r?\n/)
      .filter(l => l && !l.startsWith('#') && l.includes('='))
      .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
  } catch { /* reported below */ }
  const url = env.NEXT_PUBLIC_SUPABASE_URL, anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const email = env.PORTAL_RPC_OWNER_EMAIL, pw = env.PORTAL_RPC_OWNER_PASSWORD
  if (!url || !anon || !email || !pw) {
    // ⚠️ NOT a pass. Reported as a live gap so nobody reads a green run as
    // proof the ratchet held — it was not attempted. (CI carries placeholder
    // credentials, exactly like verify:schema.)
    console.log('  ⚠ LIVE HALF NOT ATTEMPTED — no owner credentials in .env.local.')
    console.log('    The flag/book agreement is unproven here. Run locally before landing.')
    return
  }
  let token = ''
  try {
    const a = await (await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pw }),
    })).json()
    token = a.access_token ?? ''
  } catch { /* reported below */ }
  if (!token) { console.log('  ⚠ LIVE HALF NOT ATTEMPTED — could not authenticate.'); return }
  const H = { apikey: anon, Authorization: `Bearer ${token}` }

  // Does the column exist yet? A 400 means the migration has not been applied.
  const probe = await fetch(`${url}/rest/v1/job_recurrences?select=id,season_key&limit=1`, { headers: H })
  const columnExists = probe.ok
  if (!columnExists) {
    check('⛔ the flag is FALSE while season_key does not exist', SEASON_DECLARATIONS_COMPLETE === false,
      'declarations cannot be complete when the column has not been applied — flipping the flag now '
      + 'would strip the season from every live series at once')
    console.log('    (job_recurrences.season_key is not applied yet — the migration has not started)')
    return
  }

  // ⭐ ACTIVE series only. A series whose visits are all in the past cannot
  // generate anything, so it cannot schedule out of season; blocking the whole
  // transition on dead rows would make the ratchet impossible to satisfy.
  const rows = await (await fetch(
    `${url}/rest/v1/job_recurrences?select=id,season_key,end_date&limit=2000`, { headers: H })).json()
  const today = new Date().toISOString().slice(0, 10)
  const active = (Array.isArray(rows) ? rows : []).filter((r: any) => !r.end_date || r.end_date >= today)
  const undeclared = active.filter((r: any) => !r.season_key || !String(r.season_key).trim())

  console.log(`    live book: ${active.length} active series, ${undeclared.length} still undeclared`)
  // ⭐ The SAME pure rule the fixtures above drive. The guard does not restate
  // the ratchet in its own words — restating it is how the two come apart.
  const verdict = seasonTransitionVerdict({
    columnExists: true, undeclaredActive: undeclared.length, flag: SEASON_DECLARATIONS_COMPLETE,
  })
  check(`⛔ the flag and the book agree (verdict: ${verdict})`, !transitionIsBroken(verdict),
    verdict === 'flag-overdue'
      ? 'every active series has declared a season, but SEASON_DECLARATIONS_COMPLETE is still false — '
        + 'flip it in lib/legacySeasonInference so the keyword guess stops being reachable'
      : `${undeclared.length} active series have no declaration; flipping the flag strips their season`)
  if (verdict === 'in-progress') {
    console.log(`    ⏸ transition PAUSED, legitimately — ${undeclared.length} series await an owner decision.`)
    console.log('       npx tsx scripts/season-reconcile.ts names them and lists the choices.')
  }
}

// ⚠️ No top-level await: this file is transformed to CJS, where it is a syntax
// error. The summary runs inside the chain so the live half is always counted.
liveTransitionCheck()
  .catch(e => { failures++; console.log(`  ✗ the live transition check threw\n      ${String(e?.message ?? e).slice(0, 200)}`) })
  .then(() => {
    console.log('')
    if (failures) {
      console.log(`✗ season-recurrence: ${failures} rule${failures === 1 ? '' : 's'} broken`)
      process.exit(1)
    }
    console.log('✓ season-recurrence: every rule holds')
  })
