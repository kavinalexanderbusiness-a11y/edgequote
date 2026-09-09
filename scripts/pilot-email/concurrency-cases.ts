import assert from 'node:assert/strict'
import { DisposableSession, type Database, type TestResult } from './database'

type Verdict = { code: string; [key: string]: unknown }
const noon = `case when extract(hour from clock_timestamp() at time zone 'UTC')::int=12 then 'Etc/UTC'
  when extract(hour from clock_timestamp() at time zone 'UTC')::int>12 then 'Etc/GMT+'||(extract(hour from clock_timestamp() at time zone 'UTC')::int-12)::text
  else 'Etc/GMT'||(extract(hour from clock_timestamp() at time zone 'UTC')::int-12)::text end`
const scalar = async (db: Database, sql: string, args: unknown[] = []) => (await db.query<{ value: unknown }>(sql, args)).rows[0]?.value
const rpc = async (db: Database, sql: string, args: unknown[] = []): Promise<Verdict> => {
  const result = await scalar(db, sql, args)
  assert.ok(result && typeof result === 'object')
  return result as Verdict
}

// Pass requires an actual advisory lock waiter blocked by the expected other
// PostgreSQL backend. A sleep or "promise not yet settled" cannot pass this.
async function lockBarrier(observer: Database, waiter: number, holder: number) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const row = (await observer.query<{ blocked: boolean; advisory: boolean }>(`select
      $2::int=any(pg_blocking_pids($1::int)) as blocked,
      exists(select 1 from pg_locks where pid=$1::int and locktype='advisory' and not granted) as advisory`, [waiter, holder])).rows[0]
    if (row.blocked && row.advisory) return { waiter, holder, evidence: 'pg_blocking_pids + ungranted advisory lock' }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Expected separate-session advisory lock barrier was not observed')
}

async function seed(db: Database, tag: number, twoSteps = false) {
  const id = (n: number) => `11111111-1111-4111-8111-${String(tag * 100 + n).padStart(12, '0')}`
  const owner = id(1), customer = id(2), customer2 = id(3), quote = id(4), quote2 = id(5)
  await db.exec('begin')
  try {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1::uuid,$2,clock_timestamp())', [owner, `owner-${tag}@fixture.example.invalid`])
    await db.query(`insert into public.business_settings(user_id,company_name,owner_name,email_primary,business_type,timezone)
      values($1::uuid,'Fictional concurrency business','Fixture owner',$2,'general',${noon})`, [owner, `owner-${tag}@fixture.example.invalid`])
    for (const [cid, qid, n] of [[customer, quote, 1], [customer2, quote2, 2]] as const) {
      await db.query(`insert into public.customers(id,user_id,name,email,email_opt_in,message_prefs)
        values($1::uuid,$2::uuid,'Fixture concurrency customer',$3,true,'{"estimates":true}')`, [cid, owner, `customer-${tag}-${n}@fixture.example.invalid`])
      await db.query(`insert into public.quotes(id,user_id,customer_id,quote_number,customer_name,address,service_type,initial_price,status,sent_at,issued_date,valid_until)
        values($1::uuid,$2::uuid,$3::uuid,$4,'Fixture customer','Fictional address','General visit',100,'sent',clock_timestamp()-interval '7 days',current_date-7,current_date+30)`,
      [qid, owner, cid, `RACE-${tag}-${n}`])
    }
    await db.exec('set local role service_role')
    const connection = await rpc(db, 'select public.pilot_email_create_connection($1::uuid,$2,$3,$4,$5,$6) as value',
      [owner, `race-account-${tag}`, `sender-${tag}@fixture.example.invalid`, `race-${tag}.example.invalid`, `PILOT_RACE_${tag}`, 'v1'])
    assert.equal(connection.code, 'created')
    const cid = connection.connection_id
    for (const state of ['verified', 'active']) assert.equal((await rpc(db, 'select public.pilot_email_set_connection_state($1::uuid,$2) as value', [cid, state])).code, 'updated')
    const dates = (await db.query<{ first: string; second: string }>(`select (clock_timestamp()-interval '2 days')::text as first,(clock_timestamp()-interval '1 day')::text as second`)).rows[0]
    const steps = [{ subject: 'Approved fixture', text: 'Approved first step', due_at: dates.first }]
    if (twoSteps) steps.push({ subject: 'Approved second', text: 'Approved second step', due_at: dates.second })
    const approve = (customerId: string, quoteId: string) => rpc(db,
      'select public.pilot_email_approve_workflow($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::uuid) as value', [cid, customerId, quoteId, JSON.stringify(steps), owner])
    const w1 = await approve(customer, quote), w2 = await approve(customer2, quote2)
    assert.equal(w1.code, 'approved'); assert.equal(w2.code, 'approved')
    await db.exec('commit')
    return { owner, customer, quote, cid, w1: w1.workflow_id, w2: w2.workflow_id }
  } catch (error) { await db.exec('rollback'); throw error }
}

const claim = (db: Database, workflow: unknown, step = 1) => rpc(db, 'select public.pilot_email_claim($1::uuid,$2::int) as value', [workflow, step])
const start = (db: Database, a: Verdict) => rpc(db, 'select public.pilot_email_start($1::uuid,$2::bigint) as value', [a.attempt_id, a.fence])
async function asService<T>(db: Database, work: () => Promise<T>) {
  await db.exec('begin; set local role service_role')
  try { const result = await work(); await db.exec('commit'); return result }
  catch (error) { await db.exec('rollback'); throw error }
}

export async function runConcurrencyCases(observer: Database) {
  const results: TestResult[] = []
  const barriers: unknown[] = []
  const left = await DisposableSession.open('concurrency-left')
  let right: DisposableSession
  try { right = await DisposableSession.open('concurrency-right') }
  catch (error) { await left.close(); throw error }
  assert.notEqual(left.pid, right.pid)
  const test = async (name: string, work: () => Promise<void>) => {
    try { await work(); results.push({ name, pass: true }) }
    catch (error) { results.push({ name, pass: false, error: error instanceof Error ? error.message : 'Concurrency assertion failed' }) }
    finally { await Promise.allSettled([left.exec('rollback'), right.exec('rollback')]) }
  }
  try {
    await test('separate workers: one same-step claim wins and the blocked worker observes busy', async () => {
      const f = await seed(observer, 1)
      await left.exec('begin; set local role service_role')
      const first = await claim(left, f.w1); assert.equal(first.code, 'claimed')
      await right.exec('begin; set local role service_role')
      const second = claim(right, f.w1)
      void second.catch(() => undefined)
      barriers.push(await lockBarrier(observer, right.pid, left.pid))
      await left.exec('commit')
      assert.equal((await second).code, 'busy')
      await right.exec('commit')
      assert.equal(Number(await scalar(observer, 'select fence as value from public.pilot_email_send_attempts where id=$1::uuid', [first.attempt_id])), 1)
    })
    await test('distinct customers/workflows compete for exactly one remaining owner daily slot', async () => {
      const f = await seed(observer, 2)
      await observer.query(`insert into public.notification_log(user_id,channel,template,status)
        select $1::uuid,'email','custom','sent' from generate_series(1,499)`, [f.owner])
      const a = await asService(observer, () => claim(observer, f.w1))
      const b = await asService(observer, () => claim(observer, f.w2))
      assert.equal(a.code, 'claimed'); assert.equal(b.code, 'claimed')
      await left.exec('begin; set local role service_role')
      assert.equal((await start(left, a)).code, 'started')
      await right.exec('begin; set local role service_role')
      const next = start(right, b)
      void next.catch(() => undefined)
      barriers.push(await lockBarrier(observer, right.pid, left.pid))
      await left.exec('commit')
      assert.equal((await next).code, 'daily_cap')
      await right.exec('commit')
      assert.equal(Number(await scalar(observer, 'select count(*) as value from public.pilot_email_send_attempts where user_id=$1::uuid and first_started_at is not null', [f.owner])), 1)
    })

    for (const receiptFirst of [true, false]) {
      await test(receiptFirst ? 'routed reply hold commits before waiting start: no second provider authorization'
        : 'start commits before waiting reply: held workflow still records already-authorized provider receipt', async () => {
        const f = await seed(observer, receiptFirst ? 3 : 4, true)
        const first = await asService(observer, () => claim(observer, f.w1))
        const firstStart = await asService(observer, () => start(observer, first)); assert.equal(firstStart.code, 'started')
        await asService(observer, async () => {
          assert.equal((await rpc(observer, 'select public.pilot_email_confirm($1::uuid,$2::bigint,$3) as value', [first.attempt_id, first.fence, `first-${receiptFirst}`])).code, 'confirmed')
          assert.equal((await rpc(observer, 'select public.pilot_email_finalize($1::uuid,$2::bigint) as value', [first.attempt_id, first.fence])).code, 'finalized')
        })
        const second = await asService(observer, () => claim(observer, f.w1, 2)); assert.equal(second.code, 'claimed')
        const payload = firstStart.payload as { reply_to: string }
        const received = (db: Database) => rpc(db, 'select public.pilot_email_claim_event($1::uuid,$2,$3,$4,$5) as value',
          [f.cid, `race-event-${receiptFirst}`, 'email.received', `received-${receiptFirst}`, payload.reply_to.split('@')[0]])
        await left.exec('begin; set local role service_role')
        assert.equal((await (receiptFirst ? received(left) : start(left, second))).code, receiptFirst ? 'claimed' : 'started')
        await right.exec('begin; set local role service_role')
        const waiting = receiptFirst ? start(right, second) : received(right)
        void waiting.catch(() => undefined)
        barriers.push(await lockBarrier(observer, right.pid, left.pid))
        await left.exec('commit')
        assert.equal((await waiting).code, receiptFirst ? 'held' : 'claimed')
        await right.exec('commit')
        if (receiptFirst) assert.equal(await scalar(observer, 'select first_started_at as value from public.pilot_email_send_attempts where id=$1::uuid', [second.attempt_id]), null)
        else {
          await asService(observer, async () => {
            assert.equal((await rpc(observer, 'select public.pilot_email_confirm($1::uuid,$2::bigint,$3) as value', [second.attempt_id, second.fence, 'already-committed-second'])).code, 'confirmed')
            assert.equal((await rpc(observer, 'select public.pilot_email_finalize($1::uuid,$2::bigint) as value', [second.attempt_id, second.fence])).code, 'finalized')
          })
          assert.equal(Number(await scalar(observer, 'select count(*) as value from public.notification_log where user_id=$1::uuid', [f.owner])), 2)
        }
      })
    }
  } finally { await Promise.allSettled([left.close(), right.close()]) }
  return { tests: results, barriers, sessions: [left.pid, right.pid] }
}
