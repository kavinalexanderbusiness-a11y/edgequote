// ── Read-only reconciliation: which series are governed by a season, and which
//    future visits fall outside one ─────────────────────────────────────────
//   npx tsx scripts/season-reconcile.ts            (owner's live book, READ ONLY)
//
// ⛔ THIS SCRIPT WRITES NOTHING. No update, no insert, no delete, no RPC with a
// side effect. It exists to answer, with evidence, the question the production
// audit asked: why are recurring visits scheduled through winter when a season
// is configured?
//
// ⭐ IT USES THE APP'S OWN ENGINE. seasonForService / isWithinSeason /
// seasonEndDateFor are imported from src/lib/seasons — the same functions the
// product runs. A report that re-implemented the rule could only tell you what
// I think the rule is; this one tells you what the product actually does.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  settingsToSeasons, seasonForService, isWithinSeason, seasonEndDateFor,
  seasonLabel, type ServiceSeason, type ServiceSeasons,
} from '../src/lib/seasons'

const ROOT = join(__dirname, '..')
const env = Object.fromEntries(readFileSync(join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)
  .filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))

const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const EMAIL = env.PORTAL_RPC_OWNER_EMAIL
const PASSWORD = env.PORTAL_RPC_OWNER_PASSWORD
if (!URL_ || !ANON || !EMAIL || !PASSWORD) { console.error('missing credentials in .env.local'); process.exit(2) }

const today = new Date().toISOString().slice(0, 10)

async function main() {
  const auth = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })).json()
  if (!auth.access_token) { console.error('auth failed'); process.exit(2) }
  const H = { apikey: ANON, Authorization: `Bearer ${auth.access_token}` }
  const get = async (path: string) => {
    const r = await fetch(`${URL_}/rest/v1/${path}`, { headers: H })
    if (!r.ok) { console.error(`read failed ${path}: ${r.status}`); return [] }
    return r.json()
  }

  console.log('\n════ SEASON RECONCILIATION — read-only ════')
  console.log(`  as of ${today}\n`)

  // ── 1 · the configured seasons ────────────────────────────────────────────
  const bs = await get('business_settings?select=service_seasons&limit=1')
  const seasons: ServiceSeasons = settingsToSeasons(bs?.[0]?.service_seasons)
  const configured = bs?.[0]?.service_seasons
  console.log('── configured seasons (business_settings.service_seasons) ──')
  console.log(`  stored: ${configured ? JSON.stringify(configured).slice(0, 200) : 'NULL → defaults in use'}`)
  for (const k of Object.keys(seasons).sort()) {
    const s = seasons[k]
    console.log(`  ${k.padEnd(12)} ${seasonLabel(s).padEnd(22)} ${s.match ? `match=${JSON.stringify(s.match)}` : '(built-in hints)'}`)
  }

  // ── 2 · every series, and whether a season governs it ─────────────────────
  const recs = await get('job_recurrences?select=id,freq,interval_unit,interval_count,start_date,end_date,customer_id&order=start_date.asc&limit=1000')
  const jobs = await get('jobs?select=id,recurrence_id,service_type,title,scheduled_date,status,customers(name)&recurrence_id=not.is.null&order=scheduled_date.asc&limit=5000')

  const byRec = new Map<string, any[]>()
  for (const j of jobs) {
    if (!j.recurrence_id) continue
    const a = byRec.get(j.recurrence_id) ?? []
    a.push(j); byRec.set(j.recurrence_id, a)
  }

  interface Row {
    id: string; who: string; service: string; cadence: string
    start: string; end: string | null
    season: ServiceSeason | null; seasonKey: string
    future: number; outOfSeason: any[]; pastEnd: any[]
    seasonEnd: string | null
  }
  const rows: Row[] = []

  for (const r of recs) {
    const js = byRec.get(r.id) ?? []
    // The service name the season would be guessed from — the FIRST non-empty
    // service_type, falling back to the title, exactly as the product does when
    // it asks seasonForService about a visit.
    const svc = js.find((j: any) => j.service_type)?.service_type
      ?? js.find((j: any) => j.title)?.title ?? ''
    const season = seasonForService(svc, seasons)
    const seasonKey = season
      ? (Object.keys(seasons).find(k => seasons[k] === season) ?? season.label ?? 'custom')
      : 'NONE'
    const future = js.filter((j: any) => j.scheduled_date > today && j.status !== 'cancelled')
    const outOfSeason = season ? future.filter((j: any) => !isWithinSeason(j.scheduled_date, season)) : []
    const pastEnd = r.end_date ? future.filter((j: any) => j.scheduled_date > r.end_date) : []
    rows.push({
      id: r.id, who: js[0]?.customers?.name ?? '(no customer)', service: svc || '(unnamed)',
      cadence: `${r.freq ?? '?'}/${r.interval_unit ?? '?'}/${r.interval_count ?? '?'}`,
      start: r.start_date, end: r.end_date, season, seasonKey,
      future: future.length, outOfSeason, pastEnd,
      seasonEnd: season && r.start_date ? seasonEndDateFor(r.start_date, season) : null,
    })
  }

  console.log(`\n── ${rows.length} recurring series ──`)
  console.log('  ' + 'customer'.padEnd(22) + 'service'.padEnd(26) + 'cadence'.padEnd(18) + 'end_date'.padEnd(12) + 'season'.padEnd(10) + 'future  out')
  for (const r of rows) {
    const flag = r.seasonKey === 'NONE' ? '⛔' : r.outOfSeason.length ? '⚠️ ' : '  '
    console.log(`${flag}${r.who.slice(0, 20).padEnd(22)}${r.service.slice(0, 24).padEnd(26)}${r.cadence.padEnd(18)}${(r.end ?? '—').padEnd(12)}${r.seasonKey.padEnd(10)}${String(r.future).padStart(5)}${String(r.outOfSeason.length).padStart(5)}`)
  }

  // ── 3 · the finding ───────────────────────────────────────────────────────
  const ungoverned = rows.filter(r => r.seasonKey === 'NONE')
  const withFuture = ungoverned.filter(r => r.future > 0)
  const openEnded = rows.filter(r => !r.end)
  const outTotal = rows.reduce((n, r) => n + r.outOfSeason.length, 0)
  const pastEndTotal = rows.reduce((n, r) => n + r.pastEnd.length, 0)

  console.log('\n── findings ──')
  console.log(`  series with NO season resolved (name matched no hint):  ${ungoverned.length} / ${rows.length}`)
  console.log(`    …of those, with future visits already scheduled:      ${withFuture.length}`)
  console.log(`  series with NO end_date (open-ended):                   ${openEnded.length}`)
  console.log(`  future visits OUTSIDE their resolved season:            ${outTotal}`)
  console.log(`  future visits past their own end_date:                 ${pastEndTotal}`)

  if (ungoverned.length) {
    console.log('\n  ⛔ UNGOVERNED SERIES — the season is guessed from the service NAME, and')
    console.log('     these names match no hint, so NO season applies and nothing stops the')
    console.log('     series generating through winter:')
    for (const r of ungoverned) {
      console.log(`     • ${r.who} — "${r.service}" (${r.cadence}), ${r.future} future visit(s), end_date ${r.end ?? 'NONE'}`)
      const dates = (byRec.get(r.id) ?? []).filter((j: any) => j.scheduled_date > today).map((j: any) => j.scheduled_date)
      if (dates.length) console.log(`       next → last: ${dates[0]} → ${dates[dates.length - 1]}`)
    }
    // What WOULD be out of season if the owner's lawn season governed them.
    // Labelled hypothetical: this is exposure, not a claim about intent.
    let wouldBeOut = 0
    for (const r of ungoverned) {
      const js = (byRec.get(r.id) ?? []).filter((j: any) => j.scheduled_date > today && j.status !== 'cancelled')
      wouldBeOut += js.filter((j: any) => !isWithinSeason(j.scheduled_date, seasons.lawn)).length
    }
    console.log(`\n     HYPOTHETICAL (not a claim about intent): if the LAWN season`)
    console.log(`     ${seasonLabel(seasons.lawn)} governed these series, ${wouldBeOut} future visit(s) would be out of season.`)
  }

  if (outTotal) {
    console.log('\n  ⚠️ OUT-OF-SEASON FUTURE VISITS on series that DO resolve a season:')
    for (const r of rows.filter(x => x.outOfSeason.length)) {
      console.log(`     • ${r.who} — "${r.service}" [${r.seasonKey}] season ends ${r.seasonEnd ?? '?'}, end_date ${r.end ?? 'NONE'}`)
      for (const j of r.outOfSeason.slice(0, 8)) console.log(`         ${j.scheduled_date}  ${j.status}  ${j.title ?? ''}`)
      if (r.outOfSeason.length > 8) console.log(`         …and ${r.outOfSeason.length - 8} more`)
    }
  }

  console.log('\n⛔ Nothing was written. This report changes no row.\n')
}

main().catch(e => { console.error(e); process.exit(1) })
