// ── Read-only season reconciliation + migration classification ──────────────
//   npx tsx scripts/season-reconcile.ts            (owner's live book, READ ONLY)
//
// ⛔ THIS SCRIPT WRITES NOTHING. No update, insert, delete, or side-effecting
// RPC. It answers two questions with evidence:
//
//   1. WHICH SEASON should each existing series declare? (the migration input)
//   2. WHICH FUTURE VISITS are invalid under that season, and what should
//      happen to them? (the repair input)
//
// ⭐ IT USES THE PRODUCT'S OWN ENGINE for resolution and season arithmetic, so
// it reports what the app does rather than what the author believes it does.
// The ONE thing it does differently is deliberate: it calls the QUARANTINED
// legacy keyword inference (lib/seasons/legacyInference) to SUGGEST a season for
// series that have no declaration. That inference is no longer reachable at
// runtime — this script and the migration backfill are its only two callers,
// and it is used ONCE, as a proposal a human accepts or corrects.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  settingsToSeasons, isWithinSeason, seasonEndDateFor, seasonLabel,
  effectiveSeriesEnd, resolveSeriesSeason, SEASON_NONE,
  type ServiceSeason, type ServiceSeasons,
} from '../src/lib/seasons'
import { inferSeasonKeyFromName } from '../src/lib/legacySeasonInference'

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

/** How a suggestion was reached, and how much it is worth. */
type Confidence = 'keyword' | 'declared' | 'none'
/** What the migration should do with this series. */
type Verdict = 'AUTO-SAFE' | 'OWNER REVIEW' | 'YEAR-ROUND'

async function main() {
  const auth = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })).json()
  if (!auth.access_token) { console.error('auth failed'); process.exit(2) }
  const H = { apikey: ANON, Authorization: `Bearer ${auth.access_token}` }
  const get = async (p: string) => {
    const r = await fetch(`${URL_}/rest/v1/${p}`, { headers: H })
    if (!r.ok) { console.error(`read failed ${p}: ${r.status}`); return [] as any[] }
    return r.json()
  }

  console.log('\n════ SEASON RECONCILIATION — read-only ════')
  console.log(`  as of ${today}\n`)

  const bs = await get('business_settings?select=service_seasons&limit=1')
  const seasons: ServiceSeasons = settingsToSeasons(bs?.[0]?.service_seasons)
  console.log('── configured seasons ──')
  for (const k of Object.keys(seasons).sort()) console.log(`  ${k.padEnd(10)} ${seasonLabel(seasons[k])}`)

  // season_key may not exist yet (the column is proposed, not applied). Ask for
  // it, and fall back to a query without it rather than reporting nothing.
  let recs = await get('job_recurrences?select=id,freq,interval_unit,interval_count,start_date,end_date,customer_id,season_key&limit=1000')
  let hasSeasonKey = true
  if (!Array.isArray(recs) || recs.length === 0) {
    const probe = await get('job_recurrences?select=id&limit=1')
    if (Array.isArray(probe) && probe.length > 0) {
      hasSeasonKey = false
      recs = await get('job_recurrences?select=id,freq,interval_unit,interval_count,start_date,end_date,customer_id&limit=1000')
    }
  }
  console.log(`\n  job_recurrences.season_key column: ${hasSeasonKey ? 'PRESENT' : 'NOT APPLIED YET (all series undeclared)'}`)

  const jobs = await get('jobs?select=id,recurrence_id,service_type,title,scheduled_date,status,customers(name)&recurrence_id=not.is.null&order=scheduled_date.asc&limit=5000')
  const byRec = new Map<string, any[]>()
  for (const j of jobs) {
    const a = byRec.get(j.recurrence_id) ?? []; a.push(j); byRec.set(j.recurrence_id, a)
  }

  interface Row {
    id: string; who: string; service: string; cadence: string
    start: string; end: string | null
    existingKey: string | null
    suggested: string | null; confidence: Confidence
    verdict: Verdict; why: string
    invalid: any[]           // future visits out of season under the suggestion
    removable: any[]         // …of those, the ones S39 rules allow removing
  }
  const rows: Row[] = []

  for (const r of recs) {
    const js = byRec.get(r.id) ?? []
    const svc = js.find((j: any) => j.service_type)?.service_type
      ?? js.find((j: any) => j.title)?.title ?? ''
    const existingKey: string | null = hasSeasonKey ? (r.season_key ?? null) : null

    // Resolution as the RUNTIME now does it: declaration only, no inference.
    const runtime = resolveSeriesSeason({ seasonKey: existingKey }, seasons)

    // The one-time migration suggestion, from the quarantined keyword list.
    const suggestedKey = existingKey ?? inferSeasonKeyFromName(svc, seasons)
    const confidence: Confidence = existingKey ? 'declared' : suggestedKey ? 'keyword' : 'none'
    const season: ServiceSeason | null = suggestedKey && suggestedKey !== SEASON_NONE
      ? (seasons[suggestedKey] ?? null) : null

    const future = js.filter((j: any) => j.scheduled_date > today && j.status !== 'cancelled')
    const invalid = season ? future.filter((j: any) => !isWithinSeason(j.scheduled_date, season)) : []
    // S39's removal rule, restated: only a SCHEDULED, non-anchor visit strictly
    // past the end may ever be removed. Completed / in-progress / invoiced
    // history is never traded for a rule change.
    const anchorId = js[0]?.id
    const removable = invalid.filter((j: any) => j.status === 'scheduled' && j.id !== anchorId)

    // ── YEAR-ROUND, only on POSITIVE evidence ────────────────────────────────
    // ⚠️ Evidence is COMPLETED work only. The auto-generated future visits are
    // the defect itself — treating them as proof the owner works all winter
    // would launder the bug into a declaration.
    const done = js.filter((j: any) => j.status === 'completed')
    const inAny = (d: string, keys: string[]) => keys.some(k => isWithinSeason(d, seasons[k]))
    const seasonalKeys = Object.keys(seasons)
    const doneOutsideEverySeason = done.filter((j: any) => !inAny(j.scheduled_date, seasonalKeys))
    const worksBothWindows = seasonalKeys.length >= 2
      && seasonalKeys.every(k => done.some((j: any) => isWithinSeason(j.scheduled_date, seasons[k])))

    let verdict: Verdict, why: string
    if (existingKey) { verdict = 'AUTO-SAFE'; why = `already declared "${existingKey}"` }
    else if (doneOutsideEverySeason.length > 0 || worksBothWindows) {
      verdict = 'YEAR-ROUND'
      why = `completed work spans every configured season (${done.length} completed)`
    } else if (suggestedKey && invalid.length === 0) {
      verdict = 'AUTO-SAFE'
      why = `keyword suggests "${suggestedKey}" and no future visit falls outside it`
    } else if (suggestedKey) {
      verdict = 'OWNER REVIEW'
      why = `keyword suggests "${suggestedKey}" but ${invalid.length} future visit(s) fall outside it`
    } else {
      verdict = 'OWNER REVIEW'
      why = 'no keyword matched — a human must say which season applies'
    }

    rows.push({
      id: r.id, who: js[0]?.customers?.name ?? '(no customer)', service: svc || '(unnamed)',
      cadence: `${r.freq ?? '?'}/${r.interval_unit ?? '?'}/${r.interval_count ?? '?'}`,
      start: r.start_date, end: r.end_date, existingKey,
      suggested: suggestedKey, confidence, verdict, why, invalid, removable,
    })
    void runtime
  }

  // ── 1 · the classification the migration needs ────────────────────────────
  console.log('\n════ 1 · MIGRATION CLASSIFICATION ════')
  console.log('  ' + 'series id'.padEnd(10) + 'customer'.padEnd(20) + 'service'.padEnd(22)
    + 'existing'.padEnd(10) + 'suggested'.padEnd(11) + 'source'.padEnd(9) + 'invalid  verdict')
  for (const r of rows.sort((a, b) => a.verdict.localeCompare(b.verdict) || b.invalid.length - a.invalid.length)) {
    console.log('  ' + r.id.slice(0, 8).padEnd(10) + r.who.slice(0, 18).padEnd(20)
      + r.service.slice(0, 20).padEnd(22) + (r.existingKey ?? '—').padEnd(10)
      + (r.suggested ?? '—').padEnd(11) + r.confidence.padEnd(9)
      + String(r.invalid.length).padStart(6) + '   ' + r.verdict)
  }

  const by = (v: Verdict) => rows.filter(r => r.verdict === v)
  console.log(`\n  AUTO-SAFE    ${String(by('AUTO-SAFE').length).padStart(3)}  backfill these; the suggestion strands no existing visit`)
  console.log(`  OWNER REVIEW ${String(by('OWNER REVIEW').length).padStart(3)}  a human declares the season`)
  console.log(`  YEAR-ROUND   ${String(by('YEAR-ROUND').length).padStart(3)}  completed work spans every season ⇒ propose '${SEASON_NONE}'`)
  for (const r of by('OWNER REVIEW')) console.log(`     • ${r.who} — "${r.service}": ${r.why}`)
  for (const r of by('YEAR-ROUND')) console.log(`     • ${r.who} — "${r.service}": ${r.why}`)

  // ── 2 · the invalid future occurrences, named ─────────────────────────────
  console.log('\n════ 2 · INVALID FUTURE OCCURRENCES ════')
  const affected = rows.filter(r => r.invalid.length > 0)
  if (!affected.length) console.log('  none under the suggested seasons.')
  for (const r of affected) {
    const seasonKey = r.suggested!
    const season = seasons[seasonKey]
    const seasonEnd = seasonEndDateFor(r.start, season)
    const effEnd = effectiveSeriesEnd(r.start, r.end, season)
    console.log(`\n  ${r.who} — "${r.service}"  [series ${r.id.slice(0, 8)}]`)
    console.log(`    cadence ${r.cadence} · start ${r.start} · end_date ${r.end ?? 'NONE'}`)
    console.log(`    suggested season "${seasonKey}" ${seasonLabel(season)} → season end ${seasonEnd}`)
    console.log(`    EFFECTIVE END would become ${effEnd}`)
    console.log(`    ${r.invalid.length} invalid future visit(s):`)
    for (const j of r.invalid) {
      const safe = r.removable.some((x: any) => x.id === j.id)
      console.log(`      ${j.scheduled_date}  ${String(j.status).padEnd(11)} ${safe ? 'removable' : '⛔ PROTECTED (not scheduled, or the series anchor)'}  ${j.id.slice(0, 8)}`)
    }
    console.log(`    PROPOSED ACTION — owner chooses:`)
    console.log(`      keep      → declare "${seasonKey}" and leave every visit where it is`)
    console.log(`      remove    → declare "${seasonKey}", set end_date ${effEnd}, remove ${r.removable.length} removable visit(s)`)
    console.log(`      regenerate→ declare "${seasonKey}", set end_date ${effEnd}, then re-plan within season`)
    console.log(`    ⛔ NOTHING is removed without Kavin's explicit approval.`)
  }

  console.log('\n⛔ Nothing was written. This report changes no row.\n')
}

main().catch(e => { console.error(e); process.exit(1) })
