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

import { generateOccurrences, visitsBeyondEnd } from '../src/lib/recurrence'
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

    // ── Cleanup — measured, not assumed ──────────────────────────────────────
    await db.from('jobs').delete().eq('recurrence_id', recId)
    await db.from('job_recurrences').delete().eq('id', recId)
    const { count: leftJobs } = await db.from('jobs').select('id', { count: 'exact', head: true }).eq('user_id', uid).like('title', `%${t.runId}%`)
    const { count: leftRecs } = await db.from('job_recurrences').select('id', { count: 'exact', head: true }).eq('id', recId)
    H('8. Residue')
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
