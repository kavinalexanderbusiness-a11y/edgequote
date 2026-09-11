import assert from 'node:assert/strict'
import { DisposableSession, type Database, type TestResult } from './database'
import { buildPilotQuoteIdentityPlan, createPilotQuoteIdentityStore } from '../../src/lib/quotes/pilotQuoteIdentity'
import { approveIdentityFixture, identityRows, identityRpc, identitySupabase, identityValue, seedQuoteIdentity, type IdentityFixture } from './quote-identity-fixtures'
import type { EnsureInput } from '../../src/lib/customers'

async function transaction<T>(db: Database, work: () => Promise<T>) {
  await db.exec('begin isolation level read committed')
  try { const result = await work(); await db.exec('commit'); return result }
  catch (error) { await db.exec('rollback'); throw error }
}
async function barrier(observer: Database, waiter: number, holder: number, kind: 'advisory' | 'row') {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const found = (await observer.query<{ blocked: boolean; locks: string[] }>(`select
      $2::int=any(pg_blocking_pids($1::int)) as blocked,
      array(select locktype from pg_locks where pid=$1::int and not granted
        and (($3='advisory' and locktype='advisory') or ($3='row' and locktype in ('transactionid','tuple')))
        order by locktype) as locks`, [waiter, holder, kind])).rows[0]
    if (found.blocked && found.locks.length) return { waiter, holder, kind, locks: found.locks, evidence: 'pg_blocking_pids + observed ungranted lock' }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Expected ${kind} dependency between the two identity sessions was not observed`)
}

export async function runQuoteIdentityConcurrency(observer: Database) {
  const tests: TestResult[] = [], barriers: unknown[] = []
  const left = await DisposableSession.open('identity-left')
  let right: DisposableSession
  try { right = await DisposableSession.open('identity-right') } catch (error) { await left.close(); throw error }
  assert.notEqual(left.pid, right.pid)
  const test = async (name: string, work: () => Promise<void>) => {
    try { await work(); tests.push({ name, pass: true }) }
    catch (error) { tests.push({ name, pass: false, error: error instanceof Error ? error.message.slice(0, 1800) : 'Identity concurrency failed' }) }
    finally { await Promise.allSettled([left.exec('rollback'), right.exec('rollback'), observer.exec('rollback')]) }
  }
  const seed = (tag: number) => transaction(observer, () => seedQuoteIdentity(observer, tag))
  const input = (f: IdentityFixture): EnsureInput => ({ customerId: f.target, name: 'Target Customer', address: '200 Existing Road' })
  const prepare = (f: IdentityFixture, value = input(f)) => transaction(observer, async () =>
    buildPilotQuoteIdentityPlan(await createPilotQuoteIdentityStore(identitySupabase(observer)).snapshot(f.owner, f.quote), value))
  const save = (db: Database, f: IdentityFixture, p: Awaited<ReturnType<typeof buildPilotQuoteIdentityPlan>>) =>
    identityRpc(db, 'pilot_quote_identity_save', { p_owner: f.owner, p_quote: f.quote, p_plan: p })
  try {
    for (const approvalFirst of [true, false]) {
      await test(approvalFirst ? 'identity race: approval owns serialization first; waiting save leaves no customer/property residue'
        : 'identity race: save owns serialization first; waiting old-customer approval cannot attach retained history', async () => {
        const f = await seed(approvalFirst ? 201 : 202), p = await prepare(f)
        await left.exec('begin isolation level read committed')
        const first = approvalFirst ? await approveIdentityFixture(left, f) : await save(left, f, p)
        assert.equal(first.code, approvalFirst ? 'approved' : 'saved')
        await right.exec('begin isolation level read committed')
        const waiting = approvalFirst ? save(right, f, p) : approveIdentityFixture(right, f)
        void waiting.catch(() => undefined)
        barriers.push(await barrier(observer, right.pid, left.pid, 'advisory'))
        await left.exec('commit')
        const beforeWaitingCommit = await identityRows(observer, f.owner)
        assert.equal((await waiting).code, approvalFirst ? 'retained_customer_binding' : 'quote_unavailable')
        await right.exec('commit')
        assert.deepEqual(await identityRows(observer, f.owner), beforeWaitingCommit)
        assert.equal(await identityValue(observer, 'select customer_id as value from public.quotes where id=$1::uuid', [f.quote]), approvalFirst ? f.customer : f.target)
        assert.equal(beforeWaitingCommit.pilot_quote_followup_workflows.length, approvalFirst ? 1 : 0)
      })
    }
    for (const kind of ['customer', 'property'] as const) {
      await test(`identity race: independently committed new ${kind} match after planning is rejected without mutation`, async () => {
        const f = await seed(kind === 'customer' ? 203 : 204)
        const value: EnsureInput = kind === 'customer'
          ? { customerId: '__manual', name: 'New automatic target', email: 'new-match@fixture.example.invalid', address: '500 Fresh Road' }
          : { ...input(f), address: '500 Fresh Road' }
        const p = await prepare(f, value)
        await transaction(right, async () => {
          if (kind === 'customer') await right.query('insert into public.customers(user_id,name,email) values($1::uuid,$2,$3)', [f.owner, 'Committed matching target', value.email])
          else await right.query('insert into public.properties(user_id,customer_id,address,is_primary) values($1::uuid,$2::uuid,$3,false)', [f.owner, f.target, value.address])
        })
        const before = await identityRows(observer, f.owner)
        assert.equal((await transaction(left, () => save(left, f, p))).code, 'stale_resolution')
        assert.deepEqual(await identityRows(observer, f.owner), before)
      })
    }
    await test('identity race: selected customer lock makes a concurrent property INSERT wait until save commits', async () => {
      const f = await seed(205), p = await prepare(f)
      await left.exec('begin isolation level read committed')
      assert.equal((await save(left, f, p)).code, 'saved')
      await right.exec('begin isolation level read committed')
      const waiting = right.query('insert into public.properties(user_id,customer_id,address,is_primary) values($1::uuid,$2::uuid,$3,false) returning id', [f.owner, f.target, 'Post-save address'])
      void waiting.catch(() => undefined)
      barriers.push(await barrier(observer, right.pid, left.pid, 'row'))
      await left.exec('commit'); assert.equal((await waiting).rows.length, 1); await right.exec('commit')
      assert.equal(await identityValue(observer, 'select property_id as value from public.quotes where id=$1::uuid', [f.quote]), f.targetProperty)
      assert.equal(Number(await identityValue(observer, 'select count(*) as value from public.properties where user_id=$1::uuid', [f.owner])), 3)
    })
    await test('identity race: selected property DELETE wins first; waiting save refuses current missing property without partial rows', async () => {
      const f = await seed(206), p = await prepare(f)
      await left.exec('begin isolation level read committed')
      await left.query('delete from public.properties where id=$1::uuid', [f.targetProperty])
      await right.exec('begin isolation level read committed')
      const waiting = save(right, f, p); void waiting.catch(() => undefined)
      barriers.push(await barrier(observer, right.pid, left.pid, 'row'))
      await left.exec('commit'); const before = await identityRows(observer, f.owner)
      assert.equal((await waiting).code, 'stale_resolution'); await right.exec('commit')
      assert.deepEqual(await identityRows(observer, f.owner), before)
    })
    await test('identity race: quote content writer wins first; waiting identity save refuses the new full revision', async () => {
      const f = await seed(207), p = await prepare(f)
      await left.exec('begin isolation level read committed')
      await left.query('update public.quotes set internal_notes=$2 where id=$1::uuid', [f.quote, 'Concurrent quote note'])
      await right.exec('begin isolation level read committed')
      const waiting = save(right, f, p); void waiting.catch(() => undefined)
      barriers.push(await barrier(observer, right.pid, left.pid, 'row'))
      await left.exec('commit'); const before = await identityRows(observer, f.owner)
      assert.equal((await waiting).code, 'stale_quote'); await right.exec('commit')
      assert.deepEqual(await identityRows(observer, f.owner), before)
    })
  } finally {
    const closed = await Promise.allSettled([left.close(), right.close()])
    if (closed.some(result => result.status === 'rejected')) throw new Error('Identity concurrency session cleanup could not be confirmed')
  }
  return { tests, barriers, sessions: [left.pid, right.pid] }
}
