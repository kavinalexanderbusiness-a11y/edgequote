// Candidate-only phase. The unchanged 193 predecessor/baseline assertions run
// BEFORE the dormant proposals/legacy-door closure are installed by the driver.
// This file has no entry point and cannot choose a database target.
import assert from 'node:assert/strict'
import { DisposableSession, SqlStateError, type Database, type TestResult } from './database'
import { termsClaimPatch } from '../../src/lib/payments/termsTimingConflict'

type Row = Record<string, unknown>
type Verdict = { code: string; expected?: Row; [key: string]: unknown }
type Snapshot = Record<string, Row[]>
interface Fixture { owner: string; customer: string; property: string; quote: string; token: string; option: string; addon: string }
const fixture = (tag: number): Fixture => {
  assert.ok(Number.isInteger(tag) && tag >= 501 && tag <= 650)
  const id = (part: number) => `81000000-0000-4000-8000-${String(tag * 100 + part).padStart(12, '0')}`
  return { owner: id(1), customer: id(2), property: id(3), quote: id(4), option: id(5), addon: id(6), token: `synthetic-versioned-${tag}-not-a-credential` }
}
async function value<T = unknown>(db: Database, sql: string, args: unknown[] = []): Promise<T> {
  return (await db.query<{ value: T }>(sql, args)).rows[0].value
}
async function begin(db: Database, role: 'service_role' | 'authenticated' | 'anon' | 'postgres' = 'service_role', owner = '') {
  await db.exec('begin isolation level read committed; set local role ' + role)
  await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true),set_config('request.jwt.claims',$3,true)",
    [owner, role, JSON.stringify(owner ? { sub: owner, role } : { role })])
  return (await db.query<Row>(`select pg_backend_pid() as backend,pg_current_xact_id()::text as transaction,
    current_user as role,current_setting('transaction_isolation') as isolation`)).rows[0]
}
async function transaction<T>(db: Database, work: () => Promise<T>, role: 'service_role' | 'authenticated' | 'anon' | 'postgres' = 'service_role', owner = '') {
  await begin(db, role, owner)
  try { const result = await work(); await db.exec('commit'); return result }
  catch (error) { await db.exec('rollback'); throw error }
}
async function seed(db: Database, f: Fixture, mode: 'plain' | 'options' | 'services' | 'no-settings' = 'plain') {
  await transaction(db, async () => {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1::uuid,$2,now())', [f.owner, `${f.owner}@versioned.example.invalid`])
    await db.exec('set local role service_role')
    if (mode !== 'no-settings') await db.query(`insert into public.business_settings(user_id,company_name,owner_name,email_primary,business_type,timezone)
      values($1::uuid,'Fictional Versioned Acceptance','Fictional Owner',$2,'general','America/Edmonton')`, [f.owner, `${f.owner}@business.example.invalid`])
    await db.query(`insert into public.customers(id,user_id,name,address,email) values($1::uuid,$2::uuid,'Fictional Customer','100 Fictional Road',$3)`,
      [f.customer, f.owner, `${f.customer}@customer.example.invalid`])
    await db.query(`insert into public.properties(id,user_id,customer_id,address,is_primary) values($1::uuid,$2::uuid,$3::uuid,'100 Fictional Road',true)`,
      [f.property, f.owner, f.customer])
    await db.query(`insert into public.quotes(id,user_id,customer_id,property_id,quote_number,customer_name,address,service_type,
      initial_price,travel_fee,status,sent_at,issued_date,valid_until,notes,internal_notes)
      values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'Fictional Customer','100 Fictional Road','General service',100,5,'sent',
      now()-interval '1 day',current_date-1,current_date+30,'Public scope','PRIVATE_SENTINEL_NOT_FOR_PREVIEW')`,
      [f.quote, f.owner, f.customer, f.property, `VERSIONED-${f.quote.slice(-5)}`])
    await db.query('insert into public.customer_portal_tokens(token,customer_id,user_id,revoked) values($1,$2::uuid,$3::uuid,false)', [f.token, f.customer, f.owner])
    if (mode === 'options') await db.query(`insert into public.quote_options(id,user_id,quote_id,name,description,price,is_recommended)
      values($1::uuid,$2::uuid,$3::uuid,'Explicit selected option','Exact public option description',200,true)`, [f.option, f.owner, f.quote])
    if (mode === 'services') await db.query(`insert into public.quote_services(user_id,quote_id,service_type,quantity,unit,unit_price,est_minutes,kind,notes)
      values($1::uuid,$2::uuid,'Public line',1,'each',100,60,'service','Public service note')`, [f.owner, f.quote])
    if (mode === 'services' || mode === 'options') await db.query(`insert into public.quote_addons(id,user_id,quote_id,name,price,is_selected)
      values($1::uuid,$2::uuid,$3::uuid,'Included extra',17,true)`, [f.addon, f.owner, f.quote])
  }, 'postgres')
}
async function snapshot(db: Database, owner: string): Promise<Snapshot> {
  const tables = ['customers','properties','quotes','quote_options','quote_services','quote_addons','quote_acceptances','business_settings',
    'pricing_config_versions','measurements','property_measurements','property_measurement_events','audit_events','integration_events','webhook_deliveries',
    'notifications','pilot_quote_followup_workflows','pilot_email_send_attempts']
  const branches = tables.map(table => `select '${table}' as name,coalesce((select jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)
    from public.${table} r where r.user_id=$1::uuid),'[]'::jsonb) as rows`)
  branches.push(`select 'customer_portal_tokens',coalesce((select jsonb_agg((to_jsonb(t)-'token')||jsonb_build_object('token_digest',md5(t.token)) order by t.token)
    from public.customer_portal_tokens t where t.user_id=$1::uuid),'[]'::jsonb)`)
  return value(db, `select jsonb_object_agg(name,rows) as value from (${branches.join(' union all ')}) snapshots`, [owner])
}
async function preview(db: Database, f: Fixture, portal = true, option: string | null = null): Promise<Verdict> {
  return value(db, 'select public.pilot_quote_acceptance_preview($1::uuid,$2,$3::uuid,$4::uuid) as value', [portal ? null : f.owner, portal ? f.token : null, f.quote, option])
}
async function commit(db: Database, f: Fixture, expected: Row, portal = true, option: string | null = null, addons: string[] | null = [], termsAck = false): Promise<Verdict> {
  return value(db, `select public.pilot_quote_acceptance_commit($1::uuid,$2,$3::uuid,$4::jsonb,$5::uuid,
    $6::uuid[],$7,$8,$9::boolean) as value`, [portal ? null : f.owner, portal ? f.token : null, f.quote, JSON.stringify(expected), option,
    addons === null ? null : '{' + addons.join(',') + '}', portal ? null : 'text_message', portal ? null : 'Exact owner attestation note', termsAck])
}
async function expected(db: Database, f: Fixture, portal = true, option: string | null = null): Promise<Row> {
  const result = await transaction(db, () => preview(db, f, portal, option))
  assert.equal(result.code, 'preview'); assert.ok(result.expected)
  return result.expected
}
async function barrier(db: Database, waiter: number, holder: number): Promise<Row> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const row = (await db.query<{ blocked: boolean; locks: Row[] }>(`select $2::int=any(pg_blocking_pids($1::int)) as blocked,
      coalesce((select jsonb_agg(jsonb_build_object('locktype',locktype,'mode',mode,'granted',granted,'transactionid',transactionid::text,
        'relation',relation::regclass::text) order by locktype,mode) from pg_locks where pid=$1::int and not granted
        and locktype in ('advisory','transactionid','tuple')),'[]'::jsonb) as locks`, [waiter, holder])).rows[0]
    if (row.blocked && row.locks.length) return { waiter, holder, ...row, evidence: 'pg_blocking_pids plus observed ungranted lock; no timing-only race claim' }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Expected native blocking dependency was not observed')
}

export async function runQuoteVersionedAcceptanceCases(observer: Database) {
  const tests: TestResult[] = [], evidence: Row[] = [], barriers: Row[] = []
  let serial = 500, allSessionsClosed = true
  const sessions: number[] = []
  const test = async (name: string, work: (f: Fixture, item: Row) => Promise<void>) => {
    const item: Row = { name, scope: 'Dormant candidate on fictional marked cloud PG17 fixtures' }
    evidence.push(item)
    try { await work(fixture(++serial), item); tests.push({ name, pass: true }) }
    catch (error) { item.error = error instanceof Error ? error.message.slice(0, 1800) : 'Candidate acceptance failed'; tests.push({ name, pass: false, error: String(item.error) }) }
    finally { await observer.exec('rollback') }
  }
  await test('versioned acceptance: new entrances are service-only and private amount/core helpers are not public RPC doors', async () => {
    const signatures = [
      'pilot_quote_acceptance_preview(uuid,text,uuid,uuid)',
      'pilot_quote_acceptance_commit(uuid,text,uuid,jsonb,uuid,uuid[],text,text,boolean)',
      'pilot_quote_acceptance_reconcile(uuid,text,uuid,jsonb,uuid,uuid[],text,text)',
    ]
    for (const sig of signatures) {
      const data = await value<Row>(observer, `select jsonb_build_object('service',has_function_privilege('service_role',$1,'EXECUTE'),
        'anon',has_function_privilege('anon',$1,'EXECUTE'),'authenticated',has_function_privilege('authenticated',$1,'EXECUTE'),
        'config',(select to_jsonb(proconfig) from pg_proc where oid=$1::regprocedure)) as value`, ['public.' + sig])
      assert.equal(data.service, true); assert.equal(data.anon, false); assert.equal(data.authenticated, false)
      assert.ok(JSON.stringify(data.config).includes('search_path='))
    }
    for (const sig of ['quote_choice_amount(numeric,numeric,numeric)','quote_apply_choice(uuid,uuid,uuid[],text)',
      'quote_record_acceptance(uuid,text,text,uuid,text,text,text,boolean)']) {
      for (const role of ['anon','authenticated','service_role']) assert.equal(await value(observer, 'select has_function_privilege($1,$2,\'EXECUTE\') as value', [role, 'public.' + sig]), false)
    }
  })
  await test('versioned acceptance: shared amount preserves canonical null/zero/option/travel/add-on and numeric typmod results', async () => {
    const cases = [[100,5,17],[null,null,null],[0,0,0],[200,5,17],[100.005,0.004,1.005],[-0.01,0,0]]
    for (const [base, travel, addons] of cases) {
      const result = (await observer.query<{ old: string; next: string }>(`select (coalesce($1::numeric(10,2),0)+coalesce($2::numeric(10,2),0)+coalesce($3::numeric(10,2),0))::numeric(10,2)::text as old,
        public.quote_choice_amount($1::numeric(10,2),$2::numeric(10,2),$3::numeric(10,2))::numeric(10,2)::text as next`, [base, travel, addons])).rows[0]
      assert.equal(result.next, result.old)
    }
    const core = await value<string>(observer, "select prosrc as value from pg_proc where oid='public.quote_apply_choice(uuid,uuid,uuid[],text)'::regprocedure")
    assert.match(core, /where id = p_quote_id and status in \('draft', 'sent'\);\s+GET DIAGNOSTICS v_quote_rows = ROW_COUNT;/)
    assert.match(core, /return v_quote_rows = 1;/); assert.ok(!core.includes('return found;'))
  })
  await test('versioned acceptance: its native preview survives the actual JSON numeric-scale round trip', async (f, item) => {
    await seed(observer, f, 'services')
    const exp = await expected(observer, f), before = await snapshot(observer, f.owner)
    const diagnostic = await transaction(observer, () => value<Row>(observer, `with p as materialized (
      select public.pilot_quote_acceptance_preview(null,$1,$2::uuid,null)->'expected' as v
    ) select jsonb_build_object(
      'raw_shape_valid',public._pilot_qva_expected_valid(v,$2::uuid),
      'transport_shape_valid',public._pilot_qva_expected_valid($3::jsonb,$2::uuid),
      'same_expected_value',v=$3::jsonb,
      'native_preview_revision',v->>'previewRevision',
      'transport_text_hash',md5(($3::jsonb->'offered')::text),
      'native_initial_text',v#>>'{offered,public,initial_price}',
      'transport_initial_text',$3::jsonb#>>'{offered,public,initial_price}') as value from p`,
    [f.token, f.quote, JSON.stringify(exp)]), 'postgres')
    item.transportDiagnostic = diagnostic
    assert.equal(diagnostic.raw_shape_valid, true); assert.equal(diagnostic.transport_shape_valid, true)
    assert.equal(diagnostic.same_expected_value, true)
    assert.equal(diagnostic.native_preview_revision, exp.previewRevision)
    assert.notEqual(diagnostic.native_preview_revision, diagnostic.transport_text_hash,
      'The regression must exercise different SQL numeric text after the real JSON transport')
    assert.equal(diagnostic.native_initial_text, '100.00'); assert.equal(diagnostic.transport_initial_text, '100')
    assert.deepEqual(await snapshot(observer, f.owner), before)
    const receipt = await transaction(observer, () => commit(observer, f, exp, true, null, [f.addon]))
    assert.equal(receipt.code, 'accepted'); assert.equal(receipt.accepted_amount, 122)
  })
  for (const door of ['portal','owner','alias'] as const) {
    await test(`versioned acceptance: retired ${door} entrance refuses before all business/ledger writes`, async f => {
      await seed(observer, f, 'services'); const before = await snapshot(observer, f.owner)
      const sql = door === 'portal' ? 'select public.portal_accept_quote($1,$2::uuid,null,null,false) as value'
        : door === 'owner' ? "select public.owner_record_customer_acceptance($2::uuid,'text_message',null,null,null) as value"
          : "select public.owner_select_quote_option($2::uuid,null,null,'text_message',null) as value"
      await assert.rejects(transaction(observer, () => value(observer, sql, [f.token, f.quote]), door === 'portal' ? 'anon' : 'authenticated', door === 'portal' ? '' : f.owner),
        error => error instanceof SqlStateError && error.code === 'P0001' && error.detail.includes('quote_acceptance_refresh_required'))
      assert.deepEqual(await snapshot(observer, f.owner), before)
    })
  }
  for (const mode of ['services','options'] as const) {
    for (const portal of [true,false]) await test(`versioned acceptance: ${portal ? 'portal' : 'owner'} preserves itemized selected extras and ${mode} amount/ledger`, async (f, item) => {
      await seed(observer, f, mode)
      const before = await snapshot(observer, f.owner), choice = mode === 'options' ? f.option : null
      const exp = await expected(observer, f, portal, choice)
      assert.deepEqual(await snapshot(observer, f.owner), before)
      const offered = (exp.offered as Row).public as Row
      item.expected = exp
      assert.deepEqual(offered.included_addon_ids, [f.addon]); assert.equal(offered.accepted_amount, mode === 'options' ? 222 : 122)
      const serialized = JSON.stringify(exp)
      for (const forbidden of ['PRIVATE_SENTINEL_NOT_FOR_PREVIEW', f.token, f.owner, 'terms_payment_claim', 'no_charge_reason', 'no_charge_by', 'internal_notes']) assert.ok(!serialized.includes(forbidden))
      const receipt = await transaction(observer, () => commit(observer, f, exp, portal, choice, [f.addon]))
      assert.equal(receipt.code, 'accepted'); assert.equal(receipt.accepted_amount, mode === 'options' ? 222 : 122)
      assert.equal(receipt.kind, portal ? 'customer' : 'owner_on_behalf'); assert.deepEqual(receipt.addon_ids, [f.addon])
      const after = await snapshot(observer, f.owner), ledger = after.quote_acceptances[0]
      assert.equal(after.quote_acceptances.length, 1); assert.equal(ledger.id, receipt.acceptance_id)
      assert.equal(ledger.accepted_amount, receipt.accepted_amount); assert.equal(after.quote_addons[0].is_selected, true)
      assert.equal((ledger.document as Row).initial_price, mode === 'options' ? 200 : 100)
      assert.equal(ledger.on_behalf_reason, portal ? null : 'text_message'); assert.equal(ledger.on_behalf_note, portal ? null : 'Exact owner attestation note')
      item.expected = exp; item.receipt = receipt; item.after = after
      const result = await transaction(observer, () => value<Verdict>(observer,
        'select public.pilot_quote_acceptance_reconcile($1::uuid,$2,$3::uuid,$4::jsonb,$5::uuid,$6::uuid[],$7,$8) as value',
        [portal ? null : f.owner, portal ? f.token : null, f.quote, JSON.stringify(exp), choice, '{' + f.addon + '}', portal ? null : 'text_message', portal ? null : 'Exact owner attestation note']))
      assert.equal(result.code, 'unknown'); assert.deepEqual(await snapshot(observer, f.owner), after)
      item.reconciliation = 'Unknown is intentional: complete pre-choice private fence is not recoverable from native ledger history; zero write replay.'
    })
  }
  await test('versioned acceptance: explicitly empty selected set succeeds; missing or duplicate set never defaults to empty', async f => {
    await seed(observer, f); const exp = await expected(observer, f), before = await snapshot(observer, f.owner)
    assert.equal((await transaction(observer, () => commit(observer, f, exp, true, null, null))).code, 'invalid_request')
    assert.equal((await transaction(observer, () => commit(observer, f, exp, true, null, [f.addon,f.addon]))).code, 'invalid_choice')
    assert.deepEqual(await snapshot(observer, f.owner), before)
    assert.equal((await transaction(observer, () => commit(observer, f, exp))).code, 'accepted')
  })
  for (const change of ['scope','terms','selected_addon','customer','token']) {
    await test(`versioned acceptance: changed ${change} after displayed preview leaves zero acceptance residue`, async f => {
      await seed(observer, f, 'services'); const exp = await expected(observer, f)
      await transaction(observer, async () => {
        if (change === 'scope') await observer.query('update public.quotes set notes=$2 where id=$1::uuid', [f.quote, 'Changed public scope'])
        if (change === 'terms') await observer.query('update public.business_settings set terms_text=$2 where user_id=$1::uuid', [f.owner, 'Changed terms'])
        if (change === 'selected_addon') await observer.query('update public.quote_addons set is_selected=false where id=$1::uuid', [f.addon])
        if (change === 'customer') await observer.query('update public.customers set name=$2 where id=$1::uuid', [f.customer, 'Changed actor label'])
        if (change === 'token') await observer.query('update public.customer_portal_tokens set revoked=true where token=$1', [f.token])
      })
      const before = await snapshot(observer, f.owner)
      assert.equal((await transaction(observer, () => commit(observer, f, exp, true, null, [f.addon]))).code, change === 'token' ? 'not_found' : 'quote_changed')
      assert.deepEqual(await snapshot(observer, f.owner), before)
    })
  }
  await test('versioned acceptance: invalid authority, foreign option/add-on and tampered/extra projection fields refuse without writes', async f => {
    await seed(observer, f); const foreign = fixture(649); await seed(observer, foreign, 'options')
    const exp = await expected(observer, f), before = await snapshot(observer, f.owner)
    assert.equal((await transaction(observer, () => value<Verdict>(observer, 'select public.pilot_quote_acceptance_preview($1::uuid,$2,$3::uuid,null) as value', [f.owner, f.token, f.quote]))).code, 'invalid_request')
    assert.equal((await transaction(observer, () => preview(observer, { ...f, owner: foreign.owner }, false))).code, 'not_found')
    assert.equal((await transaction(observer, () => preview(observer, f, true, foreign.option))).code, 'invalid_choice')
    assert.equal((await transaction(observer, () => commit(observer, f, exp, true, null, [foreign.addon]))).code, 'invalid_choice')
    assert.equal((await transaction(observer, () => commit(observer, f, { ...exp, extra: true }))).code, 'invalid_request')
    const tampered = JSON.parse(JSON.stringify(exp)) as Row
    ;(((tampered.offered as Row).public as Row).notes) = 'Forged shown scope'
    assert.equal((await transaction(observer, () => commit(observer, f, tampered))).code, 'quote_changed')
    assert.equal((await transaction(observer, () => commit(observer, f, { ...exp, previewRevision: 'malformed' }))).code, 'invalid_request')
    assert.equal((await transaction(observer, () => commit(observer, f, { ...exp, previewRevision: '0'.repeat(32) }))).code, 'quote_changed')
    assert.deepEqual(await snapshot(observer, f.owner), before)
  })
  await test('versioned acceptance: missing portal terms acknowledgement rolls back preceding native choice and add-on provenance', async f => {
    await seed(observer, f, 'services')
    const text = 'Payment is due upon completion.', patch = termsClaimPatch(text)
    await transaction(observer, () => observer.query(`update public.business_settings set terms_text=$2,terms_payment_claim=$3,
      terms_payment_claim_fingerprint=$4,terms_payment_claim_version=$5 where user_id=$1::uuid`,
      [f.owner,text,patch.terms_payment_claim,patch.terms_payment_claim_fingerprint,patch.terms_payment_claim_version]))
    const exp = await expected(observer, f), before = await snapshot(observer, f.owner)
    await assert.rejects(transaction(observer, () => commit(observer, f, exp, true, null, [f.addon], false)), error => error instanceof SqlStateError && error.code === '23514')
    assert.deepEqual(await snapshot(observer, f.owner), before)
    assert.equal((await transaction(observer, () => commit(observer, f, exp, true, null, [f.addon], true))).code, 'accepted')
  })
  await test('versioned acceptance: zero remains unpriced unless the actual no-charge declaration authorizes it', async f => {
    await seed(observer, f)
    await transaction(observer, () => observer.query('update public.quotes set initial_price=0,travel_fee=0 where id=$1::uuid', [f.quote]))
    const exp = await expected(observer, f), before = await snapshot(observer, f.owner)
    await assert.rejects(transaction(observer, () => commit(observer, f, exp)), error => error instanceof SqlStateError && error.code === '23514')
    assert.deepEqual(await snapshot(observer, f.owner), before)
    await transaction(observer, () => value(observer, "select public.quote_set_no_charge($1::uuid,'PRIVATE_NO_CHARGE_REASON') as value", [f.quote]), 'authenticated', f.owner)
    const free = await expected(observer, f); assert.ok(!JSON.stringify(free).includes('PRIVATE_NO_CHARGE_REASON'))
    assert.equal((await transaction(observer, () => commit(observer, f, free))).accepted_amount, 0)
  })
  await test('versioned acceptance: a null native ledger return rolls back quote, add-on and trigger effects', async f => {
    await seed(observer, f, 'services')
    const exp = await expected(observer, f), before = await snapshot(observer, f.owner)
    // Explicit fault injection, restricted to this synthetic owner. The native
    // ledger function itself is never replaced. Restore the catalog afterwards.
    await transaction(observer, () => observer.exec(`create function public._pilot_qva_fixture_null_ledger() returns trigger
      language plpgsql set search_path='' as $$ begin
        if new.user_id='${f.owner}'::uuid then return null; end if; return new;
      end $$;
      create trigger z_pilot_qva_fixture_null_ledger before insert on public.quote_acceptances
      for each row execute function public._pilot_qva_fixture_null_ledger();`), 'postgres')
    try {
      await assert.rejects(transaction(observer, () => commit(observer, f, exp, true, null, [f.addon])),
        error => error instanceof SqlStateError && error.code === '23514' && error.detail.includes('ledger missing'))
      assert.deepEqual(await snapshot(observer, f.owner), before)
    } finally {
      await transaction(observer, () => observer.exec('drop trigger z_pilot_qva_fixture_null_ledger on public.quote_acceptances; drop function public._pilot_qva_fixture_null_ledger();'), 'postgres')
    }
  })

  // Every race owns disposable sessions, records actual blocking, and awaits
  // process exit even after assertion failure. No psql or URL fallback exists.
  const race = async (name: string, work: (f: Fixture, item: Row, left: DisposableSession, right: DisposableSession, pending: { value?: Promise<unknown> }) => Promise<void>) => {
    await test(name, async (f, item) => {
      const left = await DisposableSession.open('versioned-left-' + serial)
      let right: DisposableSession | undefined
      const pending: { value?: Promise<unknown> } = {}
      try {
        right = await DisposableSession.open('versioned-right-' + serial)
        assert.notEqual(left.pid, right.pid); sessions.push(left.pid, right.pid)
        await work(f, item, left, right, pending)
      } finally {
        await left.exec('rollback').catch(() => undefined)
        await pending.value?.catch(() => undefined)
        await right?.exec('rollback').catch(() => undefined)
        const closed = await Promise.allSettled([left.close(), ...(right ? [right.close()] : [])])
        item.sessionsClosed = closed.every(x => x.status === 'fulfilled')
        if (!item.sessionsClosed) { allSessionsClosed = false; throw new Error('Candidate acceptance sessions did not confirm exit') }
      }
    })
  }
  await race('versioned acceptance race: native quote writer commits first; waiting old displayed version refuses all acceptance writes', async (f,item,left,right,pending) => {
    await seed(observer, f); const exp = await expected(observer, f), before = await snapshot(observer, f.owner)
    item.writer = await begin(left, 'authenticated', f.owner)
    await left.query('update public.quotes set initial_price=800,notes=$2 where id=$1::uuid', [f.quote, 'New scope after displayed preview'])
    item.accepter = await begin(right)
    const waiting = commit(right, f, exp); pending.value = waiting; void waiting.catch(() => undefined)
    const b = await barrier(observer, right.pid, left.pid); barriers.push(b); item.barrier = b
    assert.deepEqual(await snapshot(observer, f.owner), before)
    await left.exec('commit'); const afterWriter = await snapshot(observer, f.owner)
    assert.equal((await waiting).code, 'quote_changed'); await right.exec('commit')
    assert.deepEqual(await snapshot(observer, f.owner), afterWriter); assert.equal(afterWriter.quote_acceptances.length, 0)
    item.before = before; item.after = afterWriter
  })
  await race('versioned acceptance race: first acceptance commits; concurrent same preview cannot create another ledger row', async (f,item,left,right,pending) => {
    await seed(observer, f, 'services'); const exp = await expected(observer, f), before = await snapshot(observer, f.owner)
    item.first = await begin(left)
    const receipt = await commit(left, f, exp, true, null, [f.addon]); assert.equal(receipt.code, 'accepted')
    item.second = await begin(right)
    const waiting = commit(right, f, exp, true, null, [f.addon]); pending.value = waiting; void waiting.catch(() => undefined)
    const b = await barrier(observer, right.pid, left.pid); barriers.push(b); item.barrier = b
    assert.deepEqual(await snapshot(observer, f.owner), before)
    await left.exec('commit'); const afterFirst = await snapshot(observer, f.owner)
    assert.equal((await waiting).code, 'quote_changed'); await right.exec('commit')
    assert.deepEqual(await snapshot(observer, f.owner), afterFirst); assert.equal(afterFirst.quote_acceptances.length, 1)
    item.receipt = receipt; item.after = afterFirst
  })
  await race('versioned acceptance race: token revocation wins; final held-token recheck denies old portal authority', async (f,item,left,right,pending) => {
    await seed(observer, f); const exp = await expected(observer, f)
    item.revoker = await begin(left)
    await left.query('update public.customer_portal_tokens set revoked=true where token=$1', [f.token])
    item.accepter = await begin(right)
    const waiting = commit(right, f, exp); pending.value = waiting; void waiting.catch(() => undefined)
    const b = await barrier(observer, right.pid, left.pid); barriers.push(b); item.barrier = b
    await left.exec('commit'); const afterRevoke = await snapshot(observer, f.owner)
    assert.equal((await waiting).code, 'not_found'); await right.exec('commit')
    assert.deepEqual(await snapshot(observer, f.owner), afterRevoke); item.after = afterRevoke
  })
  await race('versioned acceptance race: absent settings insert waits on native owner FK; later preview is stale', async (f,item,left,right,pending) => {
    await seed(observer, f, 'no-settings')
    const constraint = (await observer.query<Row>(`select conname,condeferrable,convalidated from pg_constraint
      where conname='business_settings_user_id_fkey' and conrelid='public.business_settings'::regclass`)).rows[0]
    assert.equal(constraint.condeferrable, false); assert.equal(constraint.convalidated, true); item.constraint = constraint
    item.previewReader = await begin(left)
    const p = await preview(left, f); assert.equal(p.code, 'preview'); assert.ok(p.expected)
    item.inserter = await begin(right)
    const waiting = right.query("insert into public.business_settings(user_id,company_name) values($1::uuid,'Inserted later') returning user_id", [f.owner])
    pending.value = waiting; void waiting.catch(() => undefined)
    const b = await barrier(observer, right.pid, left.pid); barriers.push(b); item.barrier = b
    assert.equal((await snapshot(observer, f.owner)).business_settings.length, 0)
    await left.exec('commit'); await waiting; await right.exec('commit')
    const afterInsert = await snapshot(observer, f.owner)
    assert.equal((await transaction(observer, () => commit(observer, f, p.expected!))).code, 'quote_changed')
    assert.deepEqual(await snapshot(observer, f.owner), afterInsert); item.after = afterInsert
  })
  await race('versioned core race: zero-row quote UPDATE returns false even after marker cleanup PERFORM statements', async (f,item,left,right,pending) => {
    await seed(observer, f)
    item.writer = await begin(left, 'authenticated', f.owner)
    await left.query("update public.quotes set status='declined' where id=$1::uuid", [f.quote])
    item.privateCoreCaller = await begin(right, 'postgres')
    const waiting = value<boolean>(right, "select public.quote_apply_choice($1::uuid,null,'{}'::uuid[],'portal') as value", [f.quote])
    pending.value = waiting; void waiting.catch(() => undefined)
    const b = await barrier(observer, right.pid, left.pid); barriers.push(b); item.barrier = b
    await left.exec('commit'); const afterWriter = await snapshot(observer, f.owner)
    assert.equal(await waiting, false); await right.exec('rollback')
    assert.deepEqual(await snapshot(observer, f.owner), afterWriter); assert.equal(afterWriter.quote_acceptances.length, 0)
    item.note = 'Privileged synthetic direct-core diagnostic only; app roles cannot call the private core. New public wrapper would refuse earlier under its held baseline locks.'
  })
  return { tests, evidence, barriers, sessions, allSessionsClosed,
    reconciliationCoverage: 'Read-only UNKNOWN for full-fence transitions, including successful acceptance; no request-attribution claim or automatic replay.',
    remainingIntegrationCoverage: 'Actual full-Save versus acceptance race orders, actual portal/owner UI, all child/template/measurement/owner-delete interleavings, exact size-bound cases and complete source preservation belong to root integration/native proof.',
    productionCalls: 0, providerCalls: 0, scope: 'Candidate native functions and synthetic fixtures only; no production or actual Mac/UI verification' }
}
