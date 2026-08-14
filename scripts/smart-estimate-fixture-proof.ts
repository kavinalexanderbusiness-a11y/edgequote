// ── Prove the multi-day path through REAL Postgres, in the fixture tenant ────
//   npx tsx scripts/smart-estimate-fixture-proof.ts
//
// `npm run verify:smart-estimate` proves the arithmetic and the contracts
// against hand-built fixtures — deterministic, offline, and blind to everything
// the database does on the way. This proves the other half: that Session 47's
// triggers, its generated `labour_minutes` column and this session's learner
// actually compose, on rows that went through the real schema.
//
// It is deliberately NOT wired into `npm run verify`: it writes, and the suite's
// contract is that a guard is safe to run anywhere. It uses the same fixture
// tenant every live guard uses, namespaces every row with this run's id, and
// deletes what it made.
//
// ⛔ NEVER the owner's book. openFixtureTenant aborts if the credentials resolve
// to a tenant not marked as a fixture.
//
// ⚠️ The jobs are created with actual_minutes NULL on purpose. Session 47's
// carry-forward trigger turns any pre-existing total into a `source='carried'`
// session on the first insert — and a carried session's worker count is the
// PLAN, which would (correctly) downgrade the whole job's labour to
// planned_crew and prove nothing about the measured path.

import { openFixtureTenant, isSkipped } from './lib/verify-fixture'
import { loadCompletedVisitLearning } from '../src/lib/estimateVsActualData'
import { serviceHistory } from '../src/lib/estimateVsActual'
import {
  buildWorkEstimate, describeConfidence, describeLaborBasis,
  formatEstimatedDuration, formatLaborHours,
} from '../src/lib/workEstimate'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, c: boolean, d = '') => (c ? ok(n) : fail(n, d))
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, Object.is(a, b), `expected ${String(b)}, got ${String(a)}`)

// Six comparable two-day projects. Day one 8h with two people, day two 4h with
// two. Elapsed 720 (1 day 4h on an 8-hour day); labour 1440 (24 labour-hours).
const DAYS = [
  { worked_on: '2026-05-04', minutes: 480, workers: 2 },
  { worked_on: '2026-05-05', minutes: 240, workers: 2 },
]
const JOBS = 6

async function main() {
  const t = await openFixtureTenant('smart-estimate-multi-day')
  if (isSkipped(t)) { console.log(`\n⏭  skipped: ${t.skipped}`); return }
  console.log(`\nFixture tenant ${t.uid.slice(0, 8)}… · run ${t.runId}`)

  const service = t.tag('FIT-OUT')
  const jobIds: string[] = []
  try {
    const customer = await t.fixtureCustomer()

    for (let i = 0; i < JOBS; i++) {
      const { data, error } = await t.db.from('jobs').insert({
        user_id: t.uid, customer_id: customer.id,
        title: t.tag(`PROJECT-${i}`), service_type: service,
        scheduled_date: '2026-05-04', status: 'completed',
        duration_minutes: 600, crew_size: 2,   // the PLAN: 10h, two people
        actual_minutes: null,                   // nothing to carry forward
      }).select('id').single()
      if (error) { fail(`job ${i} insert`, error.message); return }
      jobIds.push((data as { id: string }).id)

      for (const d of DAYS) {
        const { error: se } = await t.db.from('job_work_sessions').insert({
          user_id: t.uid, job_id: (data as { id: string }).id,
          worked_on: d.worked_on, minutes: d.minutes, workers: d.workers,
          source: 'manual',                     // hand-logged ⇒ attendance stated
        })
        if (se) { fail(`session insert (job ${i})`, se.message); return }
      }
    }
    ok(`${JOBS} two-day projects written through the real schema`)

    // ── What the DATABASE says, before any TypeScript touches it ─────────────
    const { data: jrows } = await t.db.from('jobs')
      .select('id, actual_minutes').eq('user_id', t.uid).in('id', jobIds)
    const totals = (jrows ?? []) as { id: string; actual_minutes: number | null }[]
    check('Session 47\'s trigger made jobs.actual_minutes the summed ELAPSED time',
      totals.length === JOBS && totals.every(j => j.actual_minutes === 720),
      JSON.stringify(totals.map(j => j.actual_minutes)))

    const { data: srows } = await t.db.from('job_work_sessions')
      .select('job_id, minutes, workers, labour_minutes, source')
      .eq('user_id', t.uid).in('job_id', jobIds)
    const sessions = (srows ?? []) as { minutes: number; workers: number; labour_minutes: number }[]
    check('…and the generated column is minutes × workers, per day',
      sessions.length === JOBS * 2 && sessions.every(s => s.labour_minutes === s.minutes * s.workers),
      JSON.stringify(sessions.slice(0, 2)))
    const dbLabour = sessions.reduce((s, r) => s + r.labour_minutes, 0) / JOBS
    eq('…so one project carries 1440 labour-minutes in the database', dbLabour, 1440)
    check('⛔ which is NOT actual_minutes × the planned crew of 2… identical here by design',
      720 * 2 === 1440, 'this fixture is deliberately a case where they agree')

    // ── What the LEARNER says, read back through the real loader ────────────
    const load = await loadCompletedVisitLearning(t.db, t.uid)
    if (load.outcome !== 'ok') { fail('the learning read', JSON.stringify(load)); return }
    const h = serviceHistory(service, load.learning.comparisons)
    const e = buildWorkEstimate(h, { capacityHours: 8 })

    console.log('\n  SMART ESTIMATE, from live rows:')
    console.log(`    ${describeConfidence(e)}`)
    console.log(`    ~${formatEstimatedDuration(e.suggestedElapsedMinutes, e.workdayMinutes)} on site`)
    console.log(`    Usually a crew of ${e.typicalCrewSize}, and a typical job carries about ` +
                `${formatLaborHours(e.suggestedLaborMinutes)} ${describeLaborBasis(e)}`)
    console.log(`    Based on ${e.sampleSize} comparable completed jobs\n`)

    eq('the bucket has all six', h.sampleSize, JOBS)
    eq('confidence is established', e.confidence, 'established')
    eq('elapsed is the summed session time', e.suggestedElapsedMinutes, 720)
    eq('…which is multi-day on an 8-hour day', e.scale, 'multi_day')
    eq('…and reads in Session 47\'s units', formatEstimatedDuration(720, e.workdayMinutes), '1 day 4h')
    check('⛔ nothing is clamped to the old 240-minute ceiling',
      (e.suggestedElapsedMinutes ?? 0) > 240, String(e.suggestedElapsedMinutes))
    eq('labour is the summed person-minutes', e.suggestedLaborMinutes, 1440)
    eq('…spoken as labour-hours', formatLaborHours(e.suggestedLaborMinutes), '24 labour-hours')
    eq('…and claimed as MEASURED, because every session was hand-logged',
      e.laborSource, 'work_sessions')
    eq('…worded as measured on screen', describeLaborBasis(e), 'actually worked')
    eq('typical crew is 2', e.typicalCrewSize, 2)
    eq('…backed by all six', e.laborSampleSize, JOBS)

    // ── The distinction the whole session turns on ───────────────────────────
    // Add a SEVENTH project whose two days had different crews. Elapsed 510,
    // labour 820 — a pair no job-level multiplication can produce.
    const { data: mixed } = await t.db.from('jobs').insert({
      user_id: t.uid, customer_id: customer.id,
      title: t.tag('PROJECT-MIXED'), service_type: t.tag('DECK'),
      scheduled_date: '2026-05-06', status: 'completed',
      duration_minutes: 480, crew_size: 1, actual_minutes: null,
    }).select('id').single()
    const mixedId = (mixed as { id: string }).id
    jobIds.push(mixedId)
    await t.db.from('job_work_sessions').insert([
      { user_id: t.uid, job_id: mixedId, worked_on: '2026-05-06', minutes: 200, workers: 1, source: 'manual' },
      { user_id: t.uid, job_id: mixedId, worked_on: '2026-05-07', minutes: 310, workers: 2, source: 'manual' },
    ])
    const load2 = await loadCompletedVisitLearning(t.db, t.uid)
    const c = load2.outcome === 'ok'
      ? load2.learning.comparisons.find(x => x.jobId === mixedId) : null
    eq('200m×1 then 310m×2 → elapsed 510', c?.actualMinutes, 510)
    eq('…and labour 820, which crew_size alone cannot produce', c?.laborMinutes, 820)
    check('⛔ NOT actual_minutes × the planned crew of 1 (which would say 510)',
      c?.laborMinutes !== c?.actualMinutes, 'the plan was used instead of the sessions')
    eq('…measured', c?.laborSource, 'work_sessions')
    eq('…and NO single crew is claimed, because it varied', c?.crewSize, null)
  } finally {
    // Sessions cascade with their job; the customer and the rest go with close().
    if (jobIds.length) await t.db.from('jobs').delete().eq('user_id', t.uid).in('id', jobIds)
    const { data: left } = await t.db.from('jobs')
      .select('id').eq('user_id', t.uid).like('title', `%${t.runId}%`)
    check('every fixture row this run made is gone', (left ?? []).length === 0,
      `${(left ?? []).length} left behind`)
    await t.close()
  }

  console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ multi-day work-session learning proven on live Postgres')
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.log(`\n✗ threw: ${String(e)}`); process.exit(1) })
