// Mutation-test verify:season-recurrence against the six classes the assignment
// names. CRLF-agnostic: a git checkout restores CRLF and a \n anchor then fails
// to apply — a mutation that never applied reports as "not caught" when nothing
// was tested.
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const S = 'src/lib/seasons.ts'
const R = 'src/lib/recurrence.ts'
const J = 'src/components/schedule/JobForm.tsx'

const MUTANTS = [
  // ── service-name inference returns ───────────────────────────────────────
  { n: 'INFERENCE RETURNS — a src/ module calls the keyword guess directly',
    f: 'src/lib/customerHealth.ts',
    from: "import { serviceCategory } from '@/lib/legacySeasonInference'",
    to: "import { serviceCategory, inferSeasonKeyFromName } from '@/lib/legacySeasonInference'\nvoid inferSeasonKeyFromName" },
  { n: 'BRIDGE — the keyword guess runs AHEAD of the declaration',
    f: 'src/lib/legacySeasonInference.ts',
    from: "  const declared = resolveSeriesSeason({ seasonKey: seasonKey ?? null }, seasons)\n  if (declared.source !== 'unknown') return declared.season\n  if (SEASON_DECLARATIONS_COMPLETE) return null",
    to: "  const k0 = inferSeasonKeyFromName(serviceType, seasons)\n  if (k0) return seasons[k0] ?? null\n  const declared = resolveSeriesSeason({ seasonKey: seasonKey ?? null }, seasons)\n  if (declared.source !== 'unknown') return declared.season\n  if (SEASON_DECLARATIONS_COMPLETE) return null" },
  { n: 'BRIDGE — the completion flag no longer retires the fallback',
    f: 'src/lib/legacySeasonInference.ts',
    from: '  if (SEASON_DECLARATIONS_COMPLETE) return null',
    to: '' },
  // ⭐ INVERTED WITH THE BRANCH. The old mutant flipped the flag TRUE too early;
  // the branch now ships it true, so the regression to guard against is the
  // opposite one — the end state quietly falling back out of the source.
  { n: 'FLAG REGRESSES — the branch stops carrying the end state',
    f: 'src/lib/legacySeasonInference.ts',
    from: 'export const SEASON_DECLARATIONS_COMPLETE: boolean = true',
    to: 'export const SEASON_DECLARATIONS_COMPLETE: boolean = false' },
  { n: 'INFERENCE RETURNS — the resolver input regains a service-name field',
    f: S,
    from: '  seasonKey?: string | null',
    to: '  seasonKey?: string | null\n  serviceType?: string | null' },

  // ── generic "Bi-weekly" bypasses season ──────────────────────────────────
  { n: 'GENERIC NAME BYPASSES — an unknown key silently resolves to a season',
    f: S,
    from: "    return { season: null, source: 'unknown', key }",
    to: "    return { season: seasons.lawn, source: 'declared', key }" },
  { n: 'GENERIC NAME BYPASSES — SEASON_NONE collapses into "nobody has said"',
    f: S,
    from: "  if (key === SEASON_NONE) return { season: null, source: 'declared-none', key }",
    to: '' },

  // ── cross-year season breaks ─────────────────────────────────────────────
  { n: 'CROSS-YEAR BREAKS — wrapping seasons treated as same-year',
    f: S,
    from: '  return s.startMonth > s.endMonth || (s.startMonth === s.endMonth && s.startDay > s.endDay)',
    to: '  return false' },
  { n: 'CROSS-YEAR BREAKS — a wrapping season ends in the START year',
    f: S,
    from: '  const year = startSegmentIsTail ? startYear + 1 : startYear',
    to: '  const year = startYear' },
  { n: 'CROSS-YEAR BREAKS — isWithinSeason loses the wrap branch',
    f: S,
    from: '  return md >= startMD || md <= endMD',
    to: '  return md >= startMD && md <= endMD' },

  // ── invalid past end date generated ──────────────────────────────────────
  { n: 'INVALID DATE — leap-day clamp removed (Feb 29 in a non-leap year)',
    f: S,
    from: '  return Math.min(day, new Date(year, month, 0).getDate())',
    to: '  return day' },
  { n: 'INVALID PAST END — the season may EXTEND past the owner\'s end date',
    f: S,
    from: '  return seasonEnd < owner ? seasonEnd : owner',
    to: '  return seasonEnd > owner ? seasonEnd : owner' },
  { n: 'INVALID PAST END — the season bound is dropped entirely',
    f: S,
    from: '  if (!owner) return seasonEnd',
    to: '  if (!owner) return null' },
  { n: 'INVALID PAST END — generation ignores the end date',
    f: R,
    from: '    if (endDate && iso > endDate) break',
    to: '' },

  // ── customer portal / routes / reminders consume invalid occurrences ─────
  { n: 'OUT-OF-SEASON CONSUMED — effectiveSeriesEnd returns the owner date only',
    f: S,
    from: '  if (!season) return owner',
    to: '  return owner\n  // eslint-disable-next-line no-unreachable\n  if (!season) return owner' },
  { n: 'UX — an undeclared series is rendered as year-round, not surfaced',
    f: J,
    from: "  const seasonNeedsSelection = seasonResolution.source === 'unknown'",
    to: '  const seasonNeedsSelection = false' },
  { n: 'UX — the Season control loses its Needs-selection option',
    f: J,
    from: "                  { value: '', label: 'Needs selection' },",
    to: '' },
  { n: 'UX — the declaration stops travelling with the series',
    f: J,
    from: '      seasonKey: seasonKeyChoice || null,',
    to: '' },

  // ── ⛔ A NAME IS NOT A KEY — the regression tsc cannot see ────────────────
  // Both are `string | null`, so each of these type-checks perfectly. Only the
  // source scan in verify:season-recurrence can tell them apart.
  { n: 'NAME RETURNS — a dormancy call site is fed the service name again',
    f: 'src/lib/suggestions.ts',
    from: 'isSeasonallyDormant(s.rec.season_key ?? null, ctx.seasons, ctx.today)',
    to: 'isSeasonallyDormant(s.rep.service_type, ctx.seasons, ctx.today)' },
  { n: 'NAME RETURNS — the name travels in a service-ish variable instead',
    f: 'src/lib/reactivation.ts',
    from: '          seasonKey: rec?.season_key ?? null,',
    to: '          seasonKey: recService,' },
  { n: 'DEPLOY ORDER — the rollout order disappears from the flag',
    f: 'src/lib/legacySeasonInference.ts',
    from: ' *   1. apply job_recurrences.season_key          (supabase/proposals/recurrence_season_key.sql)',
    to: '' },
  // ⚠️ Caught by verify:signals, not season-recurrence — an undeclared series
  // must SURFACE, never be hidden as dormant. Different guard, so it names one.
  { n: 'DORMANCY HIDES — an undeclared series is treated as dormant, not surfaced',
    f: 'src/lib/signals/lifecycle.ts',
    from: '  const season = resolveSeriesSeason({ seasonKey: seasonKey ?? null }, seasons).season\n  return !!season && !isWithinSeason(today, season)',
    to: '  const season = resolveSeriesSeason({ seasonKey: seasonKey ?? null }, seasons).season\n  if (!season) return true\n  return !isWithinSeason(today, season)',
    g: ['scripts/verify-signals.ts'] },
]

let caught = 0, missed = 0
for (const m of MUTANTS) {
  const raw = readFileSync(m.f, 'utf8')
  const crlf = raw.includes('\r\n')
  const norm = crlf ? raw.replace(/\r\n/g, '\n') : raw
  if (!norm.includes(m.from)) { console.log(`?? ${m.n}\n   ANCHOR NOT FOUND in ${m.f}`); missed++; continue }
  writeFileSync(m.f, (() => { const x = norm.replace(m.from, m.to); return crlf ? x.replace(/\n/g, '\r\n') : x })())
  let failed = false, out = ''
  // ⭐ A mutant is CAUGHT if ANY of its named guards fails. Defaults to the
  // season-recurrence guard; a mutant whose damage shows elsewhere says so.
  for (const g of (m.g ?? ['scripts/verify-season-recurrence.ts'])) {
    try { execSync(`npx tsx ${g}`, { stdio: 'pipe' }) }
    catch (e) { failed = true; out += (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '') }
  }
  writeFileSync(m.f, raw)
  if (failed) {
    caught++
    console.log(`✓ CAUGHT  ${m.n}`)
    for (const b of out.split('\n').filter(l => l.includes('✗')).slice(0, 2)) console.log(`            ${b.trim().slice(0, 118)}`)
  } else { missed++; console.log(`✗ MISSED  ${m.n}  <-- the guard cannot detect this`) }
}
console.log(`\nmutation score: ${caught}/${caught + missed} caught`)
