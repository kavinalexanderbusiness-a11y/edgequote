import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from './database'

const A = '00000000-0000-4000-8000-0000000000a1'
const B = '00000000-0000-4000-8000-0000000000b1'
const CA = '00000000-0000-4000-8000-0000000000a2'
const CB = '00000000-0000-4000-8000-0000000000b2'
const QA = '00000000-0000-4000-8000-0000000000a3'
const QB = '00000000-0000-4000-8000-0000000000b3'
type Verdict = { code: string; [key: string]: unknown }

export async function runCases(db: Database) {
  const results: { name: string; pass: boolean; error?: string }[] = []
  await db.exec(readFileSync(join(__dirname, 'native-fixtures.sql'), 'utf8'))
  const scalar = async (sql: string, args: unknown[] = []) => (await db.query<{ value: unknown }>(sql, args)).rows[0]?.value
  const rpc = async (sql: string, args: unknown[] = []): Promise<Verdict> => {
    await db.exec("set local role service_role; select set_config('request.jwt.claim.role', 'service_role', true)")
    const value = await scalar(sql, args)
    await db.exec('reset role')
    assert.ok(value && typeof value === 'object', 'RPC must return a structured outcome')
    return value as Verdict
  }
  const test = async (name: string, work: () => Promise<void>) => {
    await db.exec('begin')
    try {
      // Use the real DB clock while making the tenant's local hour noon. This
      // avoids time-of-day-dependent fixtures without injecting production time.
      await db.exec(`update public.business_settings set timezone = case
        when extract(hour from clock_timestamp() at time zone 'UTC')::int = 12 then 'Etc/UTC'
        when extract(hour from clock_timestamp() at time zone 'UTC')::int > 12
          then 'Etc/GMT+' || (extract(hour from clock_timestamp() at time zone 'UTC')::int - 12)::text
        else 'Etc/GMT' || (extract(hour from clock_timestamp() at time zone 'UTC')::int - 12)::text end`)
      await work()
      results.push({ name, pass: true })
    } catch (error) {
      results.push({ name, pass: false, error: error instanceof Error ? error.message.slice(0, 1200) : 'Assertion failed' })
    } finally { await db.exec('rollback') }
  }
  const refuses = async (sql: string, args: unknown[], allowed: string[], expectedSqlErrors = ['23514', '23503', '22023', '42501']) => {
    await db.exec('savepoint negative_case')
    let value: Verdict | undefined, rejected = false, unexpected: unknown
    try { value = await rpc(sql, args) } catch (error) {
      rejected = true
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (!expectedSqlErrors.includes(code)) unexpected = error
    }
    // A thrown SQL statement needs rollback to restore the test transaction.
    // A returned refusal must keep its effects visible, otherwise this helper
    // would hide a partial native write in the finalization rollback test.
    if (rejected) await db.exec('rollback to savepoint negative_case')
    await db.exec('release savepoint negative_case')
    if (unexpected) throw unexpected
    if (!rejected) assert.ok(value && !allowed.includes(value.code), 'Unsafe operation unexpectedly succeeded')
  }
  const connection = async (owner = A, active = true) => {
    const label = owner === A ? 'a' : 'b'
    const created = await rpc('select public.pilot_email_create_connection($1::uuid,$2,$3,$4,$5,$6) as value',
      [owner, 'synthetic-account-' + label, `quotes@business-${label}.example.invalid`, `reply-${label}.example.invalid`, 'PILOT_TEST_' + label.toUpperCase(), 'version-1'])
    assert.equal(created.code, 'created')
    assert.equal(typeof created.connection_id, 'string')
    if (active) {
      await rpc('select public.pilot_email_set_connection_state($1::uuid,$2) as value', [created.connection_id, 'verified'])
      await rpc('select public.pilot_email_set_connection_state($1::uuid,$2) as value', [created.connection_id, 'active'])
    }
    return created.connection_id as string
  }
  const steps = async (subject = 'Your requested estimate') => [{
    subject, text: 'Hello. Please review the estimate you requested.',
    due_at: await scalar("select (clock_timestamp() - interval '1 second')::text as value"),
  }]
  const workflow = async (cid: string, customer = CA, quote = QA, copy?: unknown, owner = A) => {
    const approved = await rpc('select public.pilot_email_approve_workflow($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::uuid) as value',
      [cid, customer, quote, JSON.stringify(copy ?? await steps()), owner])
    assert.equal(approved.code, 'approved')
    assert.equal(typeof approved.workflow_id, 'string')
    return approved.workflow_id as string
  }
  const claim = async (wid: string) => {
    const value = await rpc('select public.pilot_email_claim($1::uuid,1) as value', [wid])
    assert.equal(value.code, 'claimed')
    assert.equal(typeof value.attempt_id, 'string')
    assert.ok(value.fence != null)
    return value
  }
  const start = (attempt: Verdict) => rpc('select public.pilot_email_start($1::uuid,$2::bigint) as value', [attempt.attempt_id, attempt.fence])
  const confirmed = async () => {
    const cid = await connection(), wid = await workflow(cid), attempt = await claim(wid)
    const started = await start(attempt)
    assert.equal(started.code, 'started')
    const receipt = await rpc('select public.pilot_email_confirm($1::uuid,$2::bigint,$3) as value',
      [attempt.attempt_id, attempt.fence, '00000000-0000-4000-8000-0000000000e1'])
    assert.equal(receipt.code, 'confirmed')
    return { cid, wid, attempt, started }
  }

  await test('proposal creates no active connections or workflows', async () => {
    for (const table of ['pilot_email_connections', 'pilot_quote_followup_workflows', 'pilot_email_send_attempts', 'pilot_email_webhook_events']) {
      assert.equal(Number(await scalar(`select count(*) as value from public.${table}`)), 0)
    }
    assert.equal(Number(await scalar('select count(*) as value from public.platform_capabilities')), 0)
  })
  await test('all pilot tables enforce RLS and deny anonymous and owner table access', async () => {
    const rows = (await db.query<{ name: string; rls: boolean; denied: boolean }>(`select c.relname as name, c.relrowsecurity as rls,
      not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') as denied
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname in ('pilot_email_connections','pilot_quote_followup_workflows','pilot_email_send_attempts','pilot_email_webhook_events')`)).rows
    assert.equal(rows.length, 4)
    assert.ok(rows.every(row => row.rls && row.denied))
  })
  await test('pilot RPCs are not callable by anonymous users or business owners', async () => {
    const leaked = Number(await scalar(`select count(*) as value from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'pilot_email_%'
      and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))`))
    assert.equal(leaked, 0)
  })
  await test('connection creation remains off until explicit verification and activation', async () => {
    const cid = await connection(A, false)
    await refuses('select public.pilot_email_approve_workflow($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::uuid) as value',
      [cid, CA, QA, JSON.stringify(await steps()), A], ['approved'])
  })
  await test('an active connection cannot approve another owner customer or quote', async () => {
    const cid = await connection()
    for (const [customer, quote] of [[CB, QB], [CA, QB], [CB, QA]]) {
      await refuses('select public.pilot_email_approve_workflow($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::uuid) as value',
        [cid, customer, quote, JSON.stringify(await steps()), A], ['approved', 'existing'])
    }
  })
  await test('recipient or From injection in approved steps is rejected', async () => {
    const cid = await connection(), copy = await steps()
    for (const extra of [{ to: 'outside@customer.example.invalid' }, { from: 'wrong@business.example.invalid' }, { reply_to: 'wrong@reply.example.invalid' }]) {
      await refuses('select public.pilot_email_approve_workflow($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::uuid) as value',
        [cid, CA, QA, JSON.stringify([{ ...copy[0], ...extra }]), A], ['approved', 'existing'])
    }
  })
  await test('zero or more than two approved steps cannot create a workflow', async () => {
    const cid = await connection(), copy = await steps()
    for (const invalid of [[], [copy[0], copy[0], copy[0]]]) {
      await refuses('select public.pilot_email_approve_workflow($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::uuid) as value', [cid, CA, QA, JSON.stringify(invalid), A], ['approved'])
    }
  })
  await test('repeating approval preserves the same workflow and attempt budget', async () => {
    const cid = await connection(), copy = await steps(), wid = await workflow(cid, CA, QA, copy)
    const repeated = await rpc('select public.pilot_email_approve_workflow($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::uuid) as value', [cid, CA, QA, JSON.stringify(copy), A])
    assert.equal(repeated.code, 'existing')
    assert.equal(repeated.workflow_id, wid)
    assert.equal(Number(await scalar('select count(*) as value from public.pilot_quote_followup_workflows')), 1)
  })
  await test('an in-flight claim cannot be handed to another worker', async () => {
    const cid = await connection(), wid = await workflow(cid), first = await claim(wid)
    const second = await rpc('select public.pilot_email_claim($1::uuid,1) as value', [wid])
    assert.notEqual(second.code, 'claimed')
    assert.equal(Number(await scalar('select count(*) as value from public.pilot_email_send_attempts')), 1)
    const badFence = Number(first.fence) + 1
    await refuses('select public.pilot_email_start($1::uuid,$2::bigint) as value', [first.attempt_id, badFence], ['started'])
  })
  await test('provider envelope is derived from the exact approved connection and customer', async () => {
    const cid = await connection(), wid = await workflow(cid), attempt = await claim(wid)
    const started = await start(attempt)
    assert.equal(started.code, 'started')
    assert.equal(started.connection_id, cid)
    assert.equal(started.account_scope, 'synthetic-account-a')
    assert.equal(started.credential_version, 'version-1')
    const payload = started.payload as Record<string, unknown>
    assert.equal(payload.from, 'quotes@business-a.example.invalid')
    assert.ok(JSON.stringify(payload.to).includes('shared@customer.example.invalid'))
    assert.match(String(payload.reply_to), /^[^\s@]+@reply-a\.example\.invalid$/)
    assert.ok(started.payload_hash && started.idempotency_key && started.first_started_at && started.retry_until)
  })
  await test('opt-out between claim and provider commitment prevents a start', async () => {
    const cid = await connection(), wid = await workflow(cid), attempt = await claim(wid)
    await db.query('update public.customers set email_opt_in=false where id=$1::uuid', [CA])
    assert.notEqual((await start(attempt)).code, 'started')
  })
  await test('category revocation between claim and provider commitment prevents a start', async () => {
    const cid = await connection(), wid = await workflow(cid), attempt = await claim(wid)
    await db.query(`update public.customers set message_prefs='{"estimates":false}'::jsonb where id=$1::uuid`, [CA])
    assert.notEqual((await start(attempt)).code, 'started')
  })
  await test('recipient changes after approval cannot send the frozen quote to a stale address', async () => {
    const cid = await connection(), wid = await workflow(cid), attempt = await claim(wid)
    await db.query('update public.customers set email=$2 where id=$1::uuid', [CA, 'changed@customer.example.invalid'])
    assert.notEqual((await start(attempt)).code, 'started')
  })
  await test('declining a claimed quote prevents a provider start', async () => {
    const cid = await connection(), wid = await workflow(cid), attempt = await claim(wid)
    await db.query("update public.quotes set status='declined' where id=$1::uuid", [QA])
    assert.notEqual((await start(attempt)).code, 'started')
  })
  await test('changed quote send time invalidates an earlier approval', async () => {
    const cid = await connection(), wid = await workflow(cid), attempt = await claim(wid)
    await db.query("update public.quotes set sent_at=clock_timestamp() where id=$1::uuid", [QA])
    assert.notEqual((await start(attempt)).code, 'started')
  })
  await test('disconnected client identity cannot dispatch an already claimed step', async () => {
    const cid = await connection(), wid = await workflow(cid), attempt = await claim(wid)
    await rpc('select public.pilot_email_set_connection_state($1::uuid,$2) as value', [cid, 'disconnected'])
    assert.notEqual((await start(attempt)).code, 'started')
  })
  await test('confirmation before provider commitment is refused', async () => {
    const cid = await connection(), wid = await workflow(cid), attempt = await claim(wid)
    await refuses('select public.pilot_email_confirm($1::uuid,$2::bigint,$3) as value',
      [attempt.attempt_id, attempt.fence, '00000000-0000-4000-8000-0000000000e1'], ['confirmed', 'finalized'])
  })
  await test('finalization persists one native message and one log, then replays the receipt', async () => {
    const { attempt } = await confirmed()
    const first = await rpc('select public.pilot_email_finalize($1::uuid,$2::bigint) as value', [attempt.attempt_id, attempt.fence])
    const repeat = await rpc('select public.pilot_email_finalize($1::uuid,$2::bigint) as value', [attempt.attempt_id, attempt.fence])
    assert.equal(first.code, 'finalized')
    assert.equal(repeat.message_id, first.message_id)
    assert.equal(repeat.notification_log_id, first.notification_log_id)
    assert.equal(Number(await scalar('select count(*) as value from public.messages')), 1)
    assert.equal(Number(await scalar('select count(*) as value from public.notification_log')), 1)
    assert.equal(Number(await scalar("select count(*) as value from public.messages where channel='email' and direction='outbound' and status='sent'")), 1)
  })
  await test('native log failure rolls back the message and real native trigger side effects', async () => {
    const { attempt } = await confirmed()
    const beforeContact = await scalar('select last_contacted_at::text as value from public.customers where id=$1::uuid', [CA])
    await db.exec(`create function public.pilot_test_refuse_log() returns trigger language plpgsql as $$ begin raise exception 'synthetic_log_failure'; end $$;
      create trigger pilot_test_refuse_log before insert on public.notification_log for each row execute function public.pilot_test_refuse_log()`)
    await refuses('select public.pilot_email_finalize($1::uuid,$2::bigint) as value', [attempt.attempt_id, attempt.fence], ['finalized'], ['P0001'])
    assert.equal(Number(await scalar('select count(*) as value from public.messages')), 0)
    assert.equal(Number(await scalar('select count(*) as value from public.notification_log')), 0)
    assert.equal(await scalar('select last_contacted_at::text as value from public.customers where id=$1::uuid', [CA]), beforeContact)
    await db.exec('drop trigger pilot_test_refuse_log on public.notification_log; drop function public.pilot_test_refuse_log()')
    assert.equal((await rpc('select public.pilot_email_finalize($1::uuid,$2::bigint) as value', [attempt.attempt_id, attempt.fence])).code, 'finalized')
  })
  await test('a confirmed provider receipt still finalizes after a later opt-out', async () => {
    const { attempt } = await confirmed()
    await db.query('update public.customers set email_opt_in=false where id=$1::uuid', [CA])
    const value = await rpc('select public.pilot_email_finalize($1::uuid,$2::bigint) as value', [attempt.attempt_id, attempt.fence])
    assert.equal(value.code, 'finalized')
    assert.equal(Number(await scalar('select count(*) as value from public.messages')), 1)
  })
  return results
}
