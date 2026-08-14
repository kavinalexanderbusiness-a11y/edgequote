// ── Seed / inspect / drop a bug-shaped recurring series in the FIXTURE tenant ─
//   npx tsx scripts/season-fixture.ts seed    → prints the recurrence id
//   npx tsx scripts/season-fixture.ts show <recurrenceId>
//   npx tsx scripts/season-fixture.ts drop <recurrenceId>
//
// The shape the owner reported: an open-ended weekly lawn series whose rolling
// horizon already reaches past the season end, plus completed and cancelled
// visits out there that must survive whatever the editor does. Exists so the
// mobile/CDP pass can drive the REAL editor without touching the owner's book.
import { openFixtureTenant, isSkipped } from './lib/verify-fixture'

const [cmd, arg] = process.argv.slice(2)

async function main() {
  const t = await openFixtureTenant('season-fixture')
  if (isSkipped(t)) { console.log('SKIP ' + t.skipped); return }
  const { db, uid, tag } = t
  try {
    if (cmd === 'seed') {
      const { id: customerId } = await t.fixtureCustomer()
      const { data: rec, error: recErr } = await db.from('job_recurrences').insert({
        user_id: uid, customer_id: customerId, freq: 'weekly', interval_unit: 'week',
        interval_count: 1, start_date: '2026-06-19', end_date: null, end_count: null,
      }).select('id').single()
      if (recErr || !rec) throw new Error('recurrence insert failed: ' + recErr?.message)
      const recId = (rec as { id: string }).id
      const v = (date: string, status: string) => ({
        user_id: uid, customer_id: customerId, recurrence_id: recId,
        title: tag('Lawn mowing'), service_type: 'Lawn Mowing',
        scheduled_date: date, status, duration_minutes: 60, crew_size: 1,
      })
      const { error } = await db.from('jobs').insert([
        v('2026-07-02', 'completed'),
        v('2026-08-14', 'scheduled'),   // the next upcoming visit — what ?focus= opens
        v('2026-08-21', 'scheduled'),
        v('2026-10-30', 'scheduled'),   // the season's last legitimate stop
        v('2026-11-06', 'scheduled'),   // ghosts past the season end
        v('2026-11-13', 'scheduled'),
        v('2026-11-20', 'completed'),   // finished work past the end — history
        v('2026-11-27', 'cancelled'),
      ])
      if (error) throw new Error('jobs insert failed: ' + error.message)
      console.log('RECURRENCE_ID=' + recId)
      return
    }
    // The fixture tenant has NO business_settings row — that absence is exactly
    // what /dashboard treats as "brand new" and redirects to /setup, so the real
    // editor is unreachable in a browser without one. Created only for the
    // duration of a UI run and removed by `settings-off`, so the tenant is left
    // as it was found and no other guard sees a shape it did not expect.
    // UPSERT, never update: an update matching no row reports success (0 rows,
    // no error) and would leave the redirect in place with nothing to show it.
    if (cmd === 'settings-on') {
      const { error } = await db.from('business_settings').upsert({
        user_id: uid,
        service_seasons: { lawn: { startMonth: 4, startDay: 15, endMonth: 10, endDay: 31, label: 'Lawn' } },
      }, { onConflict: 'user_id' }).select('user_id')
      if (error) throw new Error('settings upsert failed: ' + error.message)
      const { data } = await db.from('business_settings').select('service_seasons').eq('user_id', uid).maybeSingle()
      console.log('SETTINGS_ON ' + JSON.stringify((data as { service_seasons: unknown } | null)?.service_seasons))
      return
    }
    if (cmd === 'settings-off') {
      await db.from('business_settings').delete().eq('user_id', uid)
      const { data } = await db.from('business_settings').select('user_id').eq('user_id', uid).maybeSingle()
      console.log('SETTINGS_OFF residual: ' + (data ? 'STILL PRESENT' : 'none'))
      return
    }
    if (cmd === 'show') {
      const { data: r } = await db.from('job_recurrences')
        .select('start_date, end_date, end_count, interval_unit, interval_count').eq('id', arg).maybeSingle()
      const { data: j } = await db.from('jobs')
        .select('scheduled_date, status').eq('recurrence_id', arg).order('scheduled_date')
      console.log('RULE ' + JSON.stringify(r))
      console.log('VISITS ' + JSON.stringify((j ?? []).map((x: { scheduled_date: string; status: string }) => `${x.scheduled_date}:${x.status}`)))
      return
    }
    if (cmd === 'drop') {
      await db.from('jobs').delete().eq('recurrence_id', arg)
      await db.from('job_recurrences').delete().eq('id', arg)
      const { count } = await db.from('jobs').select('id', { count: 'exact', head: true }).eq('recurrence_id', arg)
      console.log('DROPPED, residual visits: ' + (count ?? 0))
      return
    }
    console.log('usage: seed | show <id> | drop <id>')
  } finally {
    await t.close()
  }
}

main().catch(e => { console.error('crashed:', e); process.exit(1) })
