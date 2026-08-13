// ── Season End audit — READ-ONLY, names the series the old editor mis-ended ──
//   npx tsx scripts/season-end-audit.ts
//
// WHY (Session 39). Until this session, picking "Season end" resolved the date
// from whichever VISIT was open rather than from the series. An open-ended
// series pre-creates a rolling horizon, so visits past the season end already
// existed; standing on one of those made seasonEndDateFor take its "you must
// mean next season" branch and store NEXT year's end. The series then ran a
// full extra year and the owner, quite reasonably, reported that Season End
// "does not actually work".
//
// The code fix stops new occurrences. It does NOT rewrite rows that already
// carry the wrong end — this reports them so the repair is a decision with
// numbers attached, not a guess. It only ever SELECTs: no row is changed here,
// and the in-product repair (re-open the series, pick "Season end", save) now
// resolves correctly and reconciles the strays through the ordinary path that
// protects completed, cancelled and invoiced work.
//
// A series ending on a date the owner simply TYPED is not a defect — only a
// series whose end sits in a LATER season than its own start is reported.
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { settingsToSeasons, seasonForService, seasonEndDateFor } from '../src/lib/seasons'

config({ path: '.env.local' })

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const email = process.env.BACKFILL_OWNER_EMAIL
  const password = process.env.BACKFILL_OWNER_PASSWORD
  if (!url || !anon || !email || !password) { console.log('⚠ skipped: no live credentials in .env.local'); return }

  const db = createClient(url, anon)
  const { data: auth, error: authErr } = await db.auth.signInWithPassword({ email, password })
  if (authErr || !auth.user) { console.log('⚠ skipped: sign-in failed — ' + authErr?.message); return }
  const uid = auth.user.id

  try {
    const { data: bs } = await db.from('business_settings').select('service_seasons').eq('user_id', uid).maybeSingle()
    const seasons = settingsToSeasons((bs as { service_seasons: unknown } | null)?.service_seasons)

    const { data: recs } = await db.from('job_recurrences')
      .select('id, start_date, end_date, interval_unit, interval_count').eq('user_id', uid)
    const rows = (recs ?? []) as { id: string; start_date: string; end_date: string | null; interval_unit: string; interval_count: number }[]

    let hit = 0, ghosts = 0, protectedRows = 0
    for (const r of rows) {
      if (!r.end_date) continue
      const { data: js } = await db.from('jobs')
        .select('scheduled_date, status, service_type').eq('recurrence_id', r.id).order('scheduled_date')
      const visits = (js ?? []) as { scheduled_date: string; status: string; service_type: string | null }[]
      if (!visits.length) continue
      const season = seasonForService(visits.find(v => v.service_type)?.service_type ?? null, seasons)
      if (!season) continue
      const correct = seasonEndDateFor(r.start_date, season)
      // Only a LATER-season end is the fingerprint. An earlier hand-typed date
      // is an ordinary "Specific date" choice and none of this audit's business.
      if (r.end_date <= correct) continue

      const beyond = visits.filter(v => v.scheduled_date > correct)
      const removable = beyond.filter(v => v.status === 'scheduled')
      const keep = beyond.length - removable.length
      hit++; ghosts += removable.length; protectedRows += keep
      console.log(`\nSERIES ${r.id}`)
      console.log(`   every ${r.interval_count} ${r.interval_unit} from ${r.start_date}`)
      console.log(`   stored end ${r.end_date}  →  its own season ends ${correct}`)
      console.log(`   ${visits.length} visits; ${beyond.length} past the true season end`)
      console.log(`   ${removable.length} merely 'scheduled' (safe to reconcile) · ${keep} completed/cancelled (kept, always)`)
      console.log(`   runs to ${visits[visits.length - 1].scheduled_date}`)
    }

    console.log(`\n${'═'.repeat(64)}`)
    if (!hit) console.log('  No series carries an end date from a later season. Nothing to repair.')
    else console.log(`  ${hit} series ended in a LATER season than they start in.\n`
      + `  ${ghosts} scheduled visits sit past the true season end; ${protectedRows} finished/cancelled visits out there stay put.\n`
      + `  Repair in-product: open each series, set Ends → "Season end", save. Nothing here changed anything.`)
  } finally {
    // Scoped sign-out. A default (global) signOut revokes every session this
    // account holds — including the owner's phone. See Session 34.
    await db.auth.signOut({ scope: 'local' })
  }
}

main().catch(e => { console.error('season-end-audit crashed:', e); process.exit(1) })
