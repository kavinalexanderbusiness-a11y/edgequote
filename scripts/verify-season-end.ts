// ── Verify: Season End on a recurring series, against the LIVE database ──────
//   npm run verify:season-end
//
// WHY THIS SCRIPT EXISTS (Session 39). Season End is stored as a plain
// end_date on job_recurrences, and the schedule editor reconciles a series
// against a (re-)asserted end by deleting exactly the visits that
// visitsBeyondEnd names. verify:recurrence pins that predicate in memory;
// this guard proves the same contract HOLDS THROUGH POSTGRES — RLS, real
// deletes, real read-backs — because the production incident was precisely a
// database state (visits past the series' own end_date) that no pure test
// could have seen. It also pins the two save-honesty facts the page now
// relies on: a zero-row UPDATE returns success-with-no-rows (the page must
// treat that as failure), and another tenant's series is unreachable.
//
// Writes ONLY into the marked fixture tenant (scripts/lib/verify-fixture) —
// never the owner's book. Skips cleanly where no live credentials exist (CI).

import { generateOccurrences, visitsBeyondEnd, partitionSeriesVisits } from '../src/lib/recurrence'
import { loadVisitEncumbrances } from '../src/lib/seriesHistory'
import { seasonEndDateFor, DEFAULT_SEASONS } from '../src/lib/seasons'
import { openFixtureTenant, isSkipped } from './lib/verify-fixture'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}

async function main() {
  const t = await openFixtureTenant('verify:season-end')
  if (isSkipped(t)) {
    console.log(`  ⚠ live half skipped: ${t.skipped}`)
    console.log('\n  PASS 0 FAIL 0 (skipped)')
    return
  }
  const { db, uid, tag } = t
  try {
    const { id: customerId } = await t.fixtureCustomer()

    // A series shaped like the production bug: created open-ended, its future
    // visits later walked past what will become the season end (Oct 31).
    const { data: recRow, error: recErr } = await db.from('job_recurrences').insert({
      user_id: uid, customer_id: customerId, freq: 'weekly', interval_unit: 'week',
      interval_count: 1, start_date: '2026-06-19', end_date: null, end_count: null,
    }).select('id').single()
    if (recErr || !recRow) throw new Error('could not create fixture recurrence: ' + recErr?.message)
    const recId = (recRow as { id: string }).id

    const visit = (date: string, status: string) => ({
      user_id: uid, customer_id: customerId, recurrence_id: recId,
      title: tag('VISIT'), service_type: tag('SERVICE'),
      scheduled_date: date, status,
    })
    const { error: insErr } = await db.from('jobs').insert([
      visit('2026-07-02', 'completed'),
      visit('2026-08-14', 'scheduled'),   // the anchor an editor would hold open
      visit('2026-10-31', 'scheduled'),   // ON the end — the season's last stop
      visit('2026-11-06', 'scheduled'),   // ghosts — the production incident
      visit('2026-11-14', 'scheduled'),
      visit('2026-11-20', 'completed'),   // finished work past the end — history
      visit('2026-11-22', 'cancelled'),   // a called-off visit — also a record
    ])
    if (insErr) throw new Error('could not create fixture visits: ' + insErr.message)

    const readSeries = async () => {
      const { data, error } = await db.from('jobs')
        .select('id, scheduled_date, status').eq('recurrence_id', recId)
        .order('scheduled_date')
      if (error) throw new Error('series read failed: ' + error.message)
      return (data as { id: string; scheduled_date: string; status: string }[]) ?? []
    }

    // ── 1. never → Season End: the rule lands, and it PROVABLY lands ─────────
    H('1. never → Season End persists (update proven by read-back, not assumed)')
    const { data: upd1, error: upd1Err } = await db.from('job_recurrences')
      .update({ end_date: '2026-10-31' }).eq('id', recId).select('id, end_date')
    check('update touched exactly the one series', upd1Err ? 'error' : upd1?.length, 1)
    check('read-back carries the season end', (upd1 as { end_date: string }[] | null)?.[0]?.end_date, '2026-10-31')

    // ── 2. Reconcile: the REAL predicate names the ghosts, Postgres removes them
    H('2. Reconcile removes only the safe ghosts — history survives the delete')
    const before = await readSeries()
    const anchorId = before.find(j => j.scheduled_date === '2026-08-14')!.id
    const ghosts = visitsBeyondEnd(before, '2026-10-31', { anchorId, protectedIds: new Set() })
    check('the predicate names exactly the two ghost dates',
      before.filter(j => ghosts.includes(j.id)).map(j => j.scheduled_date), ['2026-11-06', '2026-11-14'])
    const { error: delErr } = await db.from('jobs').delete().in('id', ghosts)
    check('the delete succeeds', delErr ?? null, null)
    const after = await readSeries()
    check('scheduled visits now end ON the season end',
      after.filter(j => j.status === 'scheduled').map(j => j.scheduled_date), ['2026-08-14', '2026-10-31'])
    check('completed visits are intact — including the one PAST the end',
      after.filter(j => j.status === 'completed').map(j => j.scheduled_date), ['2026-07-02', '2026-11-20'])
    check('the cancelled record is intact', after.some(j => j.status === 'cancelled' && j.scheduled_date === '2026-11-22'), true)

    // ── 3. Season End → earlier fixed date: boundary stays exclusive ─────────
    H('3. Season End → earlier fixed date (and the on-the-date visit survives)')
    await db.from('job_recurrences').update({ end_date: '2026-08-14' }).eq('id', recId)
    const mid = await readSeries()
    const ghosts2 = visitsBeyondEnd(mid, '2026-08-14', { anchorId })
    check('only the Oct 31 visit is now past the end',
      mid.filter(j => ghosts2.includes(j.id)).map(j => j.scheduled_date), ['2026-10-31'])
    check('the anchor ON the new end date is untouched', ghosts2.includes(anchorId), false)

    // ── 4. back to Season End: idempotent — nothing left to reconcile ────────
    H('4. fixed date → Season End again is idempotent after reconcile')
    await db.from('job_recurrences').update({ end_date: '2026-10-31' }).eq('id', recId)
    await db.from('jobs').delete().in('id', ghosts2)
    check('re-asserting the same end finds nothing further to remove',
      visitsBeyondEnd(await readSeries(), '2026-10-31', { anchorId }), [])

    // ── 5. Season End → never ends: nothing is ever reconciled away ──────────
    H('5. Season End → never ends')
    const { data: upd5 } = await db.from('job_recurrences')
      .update({ end_date: null }).eq('id', recId).select('end_date')
    check('the end clears (one row back, end_date null)',
      (upd5 as { end_date: string | null }[] | null)?.map(r => r.end_date), [null])
    check('with no end there are no ghosts, by construction',
      visitsBeyondEnd(await readSeries(), null), [])
    check('open-ended generation still fills the rolling horizon',
      generateOccurrences('2026-06-19', 'week', 1, null, null).length, 26)

    // ── 6. Save honesty: the exact silent-failure shape the page now detects ─
    H('6. Zero rows updated is SILENT at the database — the page must check')
    const { data: updGhost, error: updGhostErr } = await db.from('job_recurrences')
      .update({ end_date: '2026-12-25' }).eq('id', '00000000-0000-0000-0000-000000000000').select('id')
    check('no error is raised for a row that does not exist', updGhostErr ?? null, null)
    check('…and zero rows come back — the only failure signal there is', updGhost?.length, 0)

    // ── 7. Tenant isolation: another tenant's series is unreachable ──────────
    H('7. Tenant isolation (RLS) — the fixture session sees only its own book')
    const { data: foreign } = await db.from('job_recurrences').select('id').neq('user_id', uid)
    check('zero recurrences visible outside this tenant', foreign?.length ?? -1, 0)
    const { data: anonRead } = await t.anon.from('job_recurrences').select('id').eq('id', recId)
    check('anon sees no recurrence at all', anonRead?.length ?? -1, 0)

    // ── 8. Season End resolves from the SERIES, not the open visit ───────────
    // The editor reads job_recurrences.start_date for this. Proven against the
    // stored row because the bug was exactly a disagreement between what the
    // series is and which visit happened to be open: an open-ended series
    // pre-creates visits PAST the season end, and resolving from one of those
    // stored NEXT year's end — a full extra season instead of a cutoff.
    H('8. Season End is a property of the SERIES (resolved from start_date)')
    await db.from('job_recurrences').update({ end_date: null }).eq('id', recId)
    const { data: recRead } = await db.from('job_recurrences')
      .select('start_date').eq('id', recId).maybeSingle()
    const startDate = (recRead as { start_date: string } | null)?.start_date
    check('the series start is the one the fixture created', startDate, '2026-06-19')
    const fromSeries = seasonEndDateFor(startDate!, DEFAULT_SEASONS.lawn)
    check('resolved from the series start → this season\'s end', fromSeries, '2026-10-31')
    const late = (await readSeries()).filter(j => j.scheduled_date > '2026-10-31').map(j => j.scheduled_date)
    check('the series really does hold visits past that end (the bug\'s setup)', late.length > 0, true)
    for (const openVisit of late) {
      check(`standing on ${openVisit}, the series end is still ${fromSeries}`,
        seasonEndDateFor(startDate!, DEFAULT_SEASONS.lawn), fromSeries)
      check(`…while resolving from that visit would have said next year`,
        seasonEndDateFor(openVisit, DEFAULT_SEASONS.lawn) > fromSeries, true)
    }

    // ── 9. Ending a series is HISTORY-SAFE — proven through Postgres ─────────
    // §2 proves an end-date reconcile spares history. This proves the other,
    // far more destructive gesture: "Does not repeat" on a job that has a
    // series. That path used to delete every sibling outright, and it is what
    // took 67 of one customer's visits — four of them completed or cancelled.
    //
    // It runs the removal exactly as the page does (partition → delete only the
    // replaceable → detach the rest → drop the rule) against real rows, real
    // cascades and real RLS, and reads back what survived.
    H('9. "Does not repeat" removes placeholders and keeps every record')
    const { data: rec2Row, error: rec2Err } = await db.from('job_recurrences').insert({
      user_id: uid, customer_id: customerId, freq: 'weekly', interval_unit: 'week',
      interval_count: 1, start_date: '2026-06-19', end_date: null, end_count: null,
    }).select('id').single()
    if (rec2Err || !rec2Row) throw new Error('could not create removal fixture: ' + rec2Err?.message)
    const rec2 = (rec2Row as { id: string }).id
    const v2 = (date: string, status: string) => ({
      user_id: uid, customer_id: customerId, recurrence_id: rec2,
      title: tag('RMV'), service_type: tag('SERVICE'), scheduled_date: date, status,
    })
    const { data: madeRows, error: mkErr } = await db.from('jobs').insert([
      v2('2026-08-14', 'scheduled'),   // the anchor under the editor
      v2('2026-07-02', 'completed'),   // finished work
      v2('2026-07-09', 'scheduled'),   // a past placeholder — still the book's record
      v2('2026-08-14', 'in_progress'), // being worked right now
      v2('2026-08-21', 'cancelled'),   // deliberately called off
      v2('2026-09-04', 'scheduled'),   // will carry a work session
      v2('2026-09-18', 'scheduled'),   // will carry a photo and NOTHING else
      v2('2026-11-06', 'scheduled'),   // bare future placeholders — the only fair game
      v2('2026-11-14', 'scheduled'),
    ]).select('id, scheduled_date, status')
    if (mkErr || !madeRows) throw new Error('could not create removal visits: ' + mkErr?.message)
    const made = madeRows as { id: string; scheduled_date: string; status: string }[]
    const pick = (date: string, status: string) => made.find(j => j.scheduled_date === date && j.status === status)!
    const anchor2 = pick('2026-08-14', 'scheduled').id
    const worked = pick('2026-09-04', 'scheduled').id
    // A future visit that is `scheduled`, carries no logged time, and is spared
    // ONLY because a record points at it. Without it this section could not tell
    // the history lookup from the status check — both would spare `worked`.
    const shot = pick('2026-09-18', 'scheduled').id
    const { error: phErr } = await db.from('job_photos')
      .insert({ user_id: uid, job_id: shot, storage_path: `${t.runId}/proof.jpg`, kind: 'after' })
    check('a proof photo can be attached to a scheduled visit', phErr ?? null, null)

    // Logged time makes a merely-`scheduled` visit history. actual_minutes is the
    // database-enforced sum of these rows, so this is the real signal.
    const { error: wsErr } = await db.from('job_work_sessions')
      .insert({ user_id: uid, job_id: worked, worked_on: '2026-09-04', minutes: 75 })
    check('a work session can be logged against a scheduled visit', wsErr ?? null, null)

    const readRemoval = async () => {
      const { data, error } = await db.from('jobs')
        .select('id, scheduled_date, status, actual_minutes, recurrence_id')
        .in('id', made.map(j => j.id)).order('scheduled_date')
      if (error) throw new Error('removal series read failed: ' + error.message)
      return (data as { id: string; scheduled_date: string; status: string; actual_minutes: number | null; recurrence_id: string | null }[]) ?? []
    }
    const live = await readRemoval()
    check('the logged time landed on the job row', live.find(j => j.id === worked)?.actual_minutes, 75)

    // The database's own answer to "which visits carry history".
    const enc = await loadVisitEncumbrances(
      db as unknown as Parameters<typeof loadVisitEncumbrances>[0],
      live.filter(j => j.id !== anchor2).map(j => j.id))
    check('every history table was reachable — the answer is known, not assumed', enc.complete, true)
    check('the work-session visit is named as encumbered', enc.ids.has(worked), true)
    check('so is the photographed one — proof of work counts as history', enc.ids.has(shot), true)
    check('a bare placeholder is NOT named — the lookup is not blanket protection',
      enc.ids.has(pick('2026-11-06', 'scheduled').id), false)

    const TODAY = '2026-08-14' // fixed, never the clock — a guard must not drift at midnight
    const plan9 = partitionSeriesVisits(live, { anchorId: anchor2, protectedIds: enc.ids, todayISO: TODAY })
    check('only the two bare future placeholders are replaceable',
      plan9.replaceable.map(j => j.scheduled_date).sort(), ['2026-11-06', '2026-11-14'])
    check('in-progress, cancelled, logged-time and photographed visits are preserved',
      plan9.preserved.map(j => j.status).sort(), ['cancelled', 'in_progress', 'scheduled', 'scheduled'])
    check('…and the photographed one is spared by the RECORD alone, not its status',
      plan9.preserved.some(j => j.id === shot), true)
    check('the past is untouched, worked or not',
      plan9.untouched.map(j => j.scheduled_date).sort(), ['2026-07-02', '2026-07-09'])

    // Execute it the way the page does, counting rows at every step.
    const removeIds = plan9.replaceable.map(j => j.id)
    const { data: gone, error: goneErr } = await db.from('jobs').delete().in('id', removeIds).select('id')
    check('the delete removes exactly the placeholders it named', goneErr ? -1 : gone?.length, removeIds.length)
    const detachIds = [anchor2, ...plan9.preserved.map(j => j.id), ...plan9.untouched.map(j => j.id)]
    const { data: detached, error: detErr } = await db.from('jobs')
      .update({ recurrence_id: null }).in('id', detachIds).select('id')
    check('every surviving visit is detached, and the count proves it', detErr ? -1 : detached?.length, detachIds.length)
    const { data: recGone } = await db.from('job_recurrences').delete().eq('id', rec2).select('id')
    check('the rule itself is removed, one row', recGone?.length, 1)

    const after9 = await readRemoval()
    check('seven visits survive — everything except the two placeholders', after9.length, 7)
    check('the photographed visit survived', after9.some(j => j.id === shot), true)
    check('the completed visit is intact', after9.some(j => j.status === 'completed'), true)
    check('the in-progress visit is intact', after9.some(j => j.status === 'in_progress'), true)
    check('the cancelled record is intact', after9.some(j => j.status === 'cancelled'), true)
    check('the past placeholder is intact — a removal does not rewrite the book',
      after9.some(j => j.scheduled_date === '2026-07-09'), true)
    check('no survivor still belongs to the deleted series', after9.every(j => j.recurrence_id === null), true)
    const { data: wsLeft } = await db.from('job_work_sessions').select('id, minutes').eq('job_id', worked)
    check('the work session survived the removal', wsLeft?.length, 1)
    check('…with its minutes, and the job still reports them',
      after9.find(j => j.id === worked)?.actual_minutes, 75)
    const { data: phLeft } = await db.from('job_photos').select('id').eq('job_id', shot)
    check('the proof photo is still attached to its visit', phLeft?.length, 1)

    // ── 10. Why that protection is load-bearing, and why counting is ─────────
    H('10. The cascade is real, and a no-op write is silent')
    const { data: doomedRow } = await db.from('jobs').insert({
      user_id: uid, customer_id: customerId, title: tag('CASCADE'),
      scheduled_date: '2026-09-11', status: 'scheduled',
    }).select('id').single()
    const doomed = (doomedRow as { id: string }).id
    await db.from('job_work_sessions').insert({ user_id: uid, job_id: doomed, worked_on: '2026-09-11', minutes: 30 })
    const { count: before10 } = await db.from('job_work_sessions')
      .select('id', { count: 'exact', head: true }).eq('job_id', doomed)
    check('the doomed visit has a work session', before10, 1)
    await db.from('jobs').delete().eq('id', doomed)
    const { count: after10 } = await db.from('job_work_sessions')
      .select('id', { count: 'exact', head: true }).eq('job_id', doomed)
    check('deleting the VISIT destroys its work session — the delete is never soft', after10, 0)
    // The same silent shape §6 proves for the rule, on the detach write.
    const { data: noopDetach, error: noopErr } = await db.from('jobs')
      .update({ recurrence_id: null }).eq('id', '00000000-0000-0000-0000-000000000000').select('id')
    check('detaching a row that does not exist raises no error', noopErr ?? null, null)
    check('…and returns zero rows — the page must count, not assume', noopDetach?.length, 0)

    // ── Cleanup — measured, not assumed ──────────────────────────────────────
    await db.from('jobs').delete().eq('recurrence_id', recId)
    await db.from('job_recurrences').delete().eq('id', recId)
    // §9's survivors are detached by design, so they are cleaned up by id.
    await db.from('jobs').delete().in('id', made.map(j => j.id))
    const { count: leftJobs } = await db.from('jobs').select('id', { count: 'exact', head: true }).eq('user_id', uid).like('title', `%${t.runId}%`)
    const { count: leftRecs } = await db.from('job_recurrences').select('id', { count: 'exact', head: true }).eq('id', recId)
    H('11. Residue')
    check('no fixture visits left behind', leftJobs ?? -1, 0)
    check('no fixture recurrence left behind', leftRecs ?? -1, 0)
  } finally {
    await t.close()
  }
}

main().then(() => {
  console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
  if (fail > 0) process.exit(1)
}).catch(e => {
  console.error('\n💥 verify:season-end crashed:', e)
  process.exit(1)
})
