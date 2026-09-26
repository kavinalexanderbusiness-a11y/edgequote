// Native baseline reproduction phase, before the proposed full Save fix.
// Execution is restricted to the existing marked disposable cloud PG17 service.
// These tests assert expected defects in UNCHANGED native acceptance functions.
// A pass here is baseline reproduction, never candidate safety or production evidence.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DisposableSession, SqlStateError, type Database, type TestResult } from './database'
import { termsClaimPatch } from '../../src/lib/payments/termsTimingConflict'

type Row = Record<string, unknown>
type Snapshot = Record<string, Row[]>
type Door = 'portal' | 'owner' | 'owner-alias'
type Scenario = 'price-scope' | 'reassignment' | 'withdrawal' | 'deleted'
interface Fixture { owner: string; customer: string; target: string; property: string; targetProperty: string; quote: string; token: string }
interface Context { backend: number; transaction: string; role: string; owner: string; isolation: string }
interface Barrier { waiter: number; holder: number; blocked: boolean; locks: Row[]; evidence: string }
interface NativeDefinition { signature: string; source: string; securityDefiner: boolean; volatility: string; config: string[] | null; acl: string | null }
interface CaseEvidence extends Row { name: string; scope: string; prediction: string; sessionsClosed: boolean }

const nativeFunctions = [
  'portal_accept_quote(text,uuid,uuid,uuid[],boolean)',
  'owner_record_customer_acceptance(uuid,text,uuid,uuid[],text)',
  'owner_select_quote_option(uuid,uuid,uuid[],text,text)',
  'quote_apply_choice(uuid,uuid,uuid[],text)',
  'quote_record_acceptance(uuid,text,text,uuid,text,text,text,boolean)',
  'owner_override_quote_status(uuid,text,text)',
  'quote_acceptances_assign_seq()',
  'quote_acceptances_append_only()',
  'quote_material_fingerprint(uuid)',
  'quote_terms_fingerprint(uuid)',
  'get_portal_data(text)',
] as const
const filesToPin = [
  'supabase/migrations/20260830150001_baseline.sql',
  'src/app/dashboard/quotes/[id]/page.tsx',
  'src/app/portal/[token]/PortalClient.tsx',
  'src/components/quotes/RecordAcceptanceDialog.tsx',
  'src/lib/payments/termsTimingConflict.ts',
  'scripts/pilot-email/database.ts',
  'scripts/pilot-email/acceptance-baseline-cases.ts',
] as const
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

function pinnedSources() {
  const sources: Record<string, string> = {}, pins: Record<string, string> = {}
  for (const path of filesToPin) {
    const text = readFileSync(resolve(__dirname, '../..', path), 'utf8').replace(/\r\n/g, '\n')
    sources[path] = text; pins[path] = sha(text)
  }
  return { sources, pins }
}

// Compare native prosrc with the exact body in the frozen baseline, not with a
// handwritten replica or an already-patched candidate function. ACL and other
// attributes are additionally retained for before/after preservation checks.
async function nativeDefinitions(db: Database, baseline: string): Promise<NativeDefinition[]> {
  const definitions: NativeDefinition[] = []
  for (const signature of nativeFunctions) {
    const name = signature.slice(0, signature.indexOf('('))
    const needle = 'CREATE OR REPLACE FUNCTION public.' + name + '('
    const start = baseline.indexOf(needle)
    assert.ok(start >= 0 && baseline.indexOf(needle, start + needle.length) < 0, 'Exactly one native baseline declaration required: ' + name)
    const tail = baseline.slice(start)
    const delimiter = /\bAS\s+(\$[A-Za-z_0-9]*\$)/.exec(tail)
    assert.ok(delimiter, 'Dollar-quoted native body required: ' + name)
    const bodyStart = delimiter.index + delimiter[0].length
    const bodyEnd = tail.indexOf(delimiter[1], bodyStart)
    assert.ok(bodyEnd > bodyStart)
    const expectedBody = tail.slice(bodyStart, bodyEnd)
    const result = await db.query<NativeDefinition>(`select p.oid::regprocedure::text as signature,
      p.prosrc as source,p.prosecdef as "securityDefiner",p.provolatile::text as volatility,
      p.proconfig as config,p.proacl::text as acl
      from pg_proc p where p.oid=to_regprocedure($1)::oid`, ['public.' + signature])
    assert.equal(result.rows.length, 1, 'Actual native function must exist: ' + signature)
    assert.equal(result.rows[0].source.replace(/\r\n/g, '\n'), expectedBody, 'Native function differs from unpatched baseline: ' + signature)
    definitions.push(result.rows[0])
  }
  return definitions
}

async function schemaDefinitions(db: Database): Promise<unknown> {
  return (await db.query<{ value: unknown }>(`select jsonb_build_object(
    'triggers',(select jsonb_agg(pg_get_triggerdef(t.oid) order by c.relname,t.tgname)
      from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and not t.tgisinternal and c.relname in
      ('quotes','quote_options','quote_services','quote_addons','quote_acceptances','business_settings','customer_portal_tokens','customers','properties','property_measurements','property_measurement_events')),
    'constraints',(select jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,'name',c.conname,'definition',pg_get_constraintdef(c.oid)) order by c.conrelid::regclass::text,c.conname)
      from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public' and c.conrelid in
      ('public.quotes'::regclass,'public.quote_options'::regclass,'public.quote_services'::regclass,'public.quote_addons'::regclass,'public.quote_acceptances'::regclass,'public.customer_portal_tokens'::regclass)),
    'policies',(select jsonb_agg(to_jsonb(p) order by p.tablename,p.policyname) from pg_policies p where schemaname='public' and tablename in
      ('quotes','quote_options','quote_services','quote_addons','quote_acceptances','business_settings','customer_portal_tokens','customers','properties')),
    'publications',(select jsonb_agg(to_jsonb(p) order by p.pubname) from pg_publication p),
    'published_tables',(select jsonb_agg(to_jsonb(p) order by p.pubname,p.schemaname,p.tablename) from pg_publication_tables p)
  ) as value`)).rows[0].value
}

function fixture(tag: number): Fixture {
  assert.ok(Number.isInteger(tag) && tag >= 301 && tag <= 320)
  const id = (prefix: number) => `${prefix}000000-0000-4000-8000-${String(tag).padStart(12, '0')}`
  return { owner: id(71), customer: id(72), target: id(73), property: id(74), targetProperty: id(75), quote: id(76),
    token: `synthetic-acceptance-baseline-${tag}-never-production` }
}

async function begin(db: Database, role: 'authenticated' | 'anon', owner = ''): Promise<Context> {
  await db.exec('begin isolation level read committed; set local role ' + role)
  await db.query(`select set_config('request.jwt.claim.sub',$1,true),
    set_config('request.jwt.claim.role',$2,true),set_config('request.jwt.claims',$3,true)`,
  [owner, role, JSON.stringify(owner ? { sub: owner, role } : { role })])
  const context = (await db.query<Context>(`select pg_backend_pid() as backend,pg_current_xact_id()::text as transaction,
    current_user as role,current_setting('request.jwt.claim.sub',true) as owner,
    current_setting('transaction_isolation') as isolation`)).rows[0]
  assert.equal(context.role, role); assert.equal(context.owner, owner); assert.equal(context.isolation, 'read committed')
  return context
}

async function seed(db: Database, f: Fixture) {
  await db.exec('begin isolation level read committed')
  try {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1::uuid,$2,now())',
      [f.owner, `acceptance-${f.owner.slice(-3)}@business.example.invalid`])
    await db.exec("set local role service_role; select set_config('request.jwt.claim.sub','',true); select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)")
    await db.query(`insert into public.business_settings(user_id,company_name,owner_name,email_primary,business_type,timezone,terms_text)
      values($1::uuid,'Fictional Acceptance Baseline','Fictional Owner',$2,'general','America/Edmonton',null)`,
    [f.owner, `acceptance-${f.owner.slice(-3)}@business.example.invalid`])
    for (const [id, name, address, email] of [
      [f.customer, 'Fictional Customer A', '100 Fictional Baseline Lane', 'a@customer.example.invalid'],
      [f.target, 'Fictional Customer B', '200 Fictional Baseline Lane', 'b@customer.example.invalid'],
    ]) await db.query(`insert into public.customers(id,user_id,name,address,email,email_opt_in,sms_opt_in,message_prefs,preferred_channel)
      values($1::uuid,$2::uuid,$3,$4,$5,true,false,'{"estimates":true}'::jsonb,'email')`, [id, f.owner, name, address, email])
    for (const [id, customer, address] of [
      [f.property, f.customer, '100 Fictional Baseline Lane'], [f.targetProperty, f.target, '200 Fictional Baseline Lane'],
    ]) await db.query('insert into public.properties(id,user_id,customer_id,address,is_primary) values($1::uuid,$2::uuid,$3::uuid,$4,true)', [id, f.owner, customer, address])
    await db.query(`insert into public.quotes(id,user_id,customer_id,property_id,quote_number,customer_name,address,service_type,
      initial_price,travel_fee,hours,crew_size,rate,overgrowth_multiplier,status,notes,sent_at,issued_date,valid_until)
      values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'Fictional Customer A','100 Fictional Baseline Lane','General service visit',
      500,0,1,1,500,1,'sent','old scope',now()-interval '1 day',current_date-1,current_date+30)`,
    [f.quote, f.owner, f.customer, f.property, `ACCEPTANCE-BASELINE-${f.quote.slice(-3)}`])
    await db.query('insert into public.customer_portal_tokens(token,customer_id,user_id,revoked) values($1,$2::uuid,$3::uuid,false)', [f.token, f.customer, f.owner])
    await db.exec('commit')
  } catch (error) { await db.exec('rollback'); throw error }
}

async function snapshot(db: Database, owner: string): Promise<Snapshot> {
  const tables = ['business_settings','customers','properties','quotes','quote_options','quote_services','quote_addons',
    'quote_acceptances','pricing_config_versions','customer_portal_tokens','measurements','property_measurements','property_measurement_events',
    'notifications','audit_events','integration_events','webhook_deliveries','pilot_email_connections','pilot_quote_followup_workflows',
    'pilot_email_send_attempts','pilot_email_webhook_events']
  // All table identifiers are this fixed source allowlist. One SELECT observes
  // full rows consistently; token tables do not have id, so sort complete JSON.
  const parts = tables.map(table => {
    const scope = table === 'pilot_email_webhook_events'
      ? 'exists(select 1 from public.pilot_email_connections c where c.id=r.connection_id and c.user_id=$1::uuid)'
      : 'r.user_id=$1::uuid'
    return `select '${table}' as name,coalesce((select jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)
      from public.${table} r where ${scope}),'[]'::jsonb) as value`
  })
  return (await db.query<{ value: Snapshot }>(`select jsonb_object_agg(s.name,s.value) as value from (${parts.join(' union all ')}) s`, [owner])).rows[0].value
}

async function rowBarrier(observer: Database, waiter: number, holder: number): Promise<Barrier> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const found = (await observer.query<{ blocked: boolean; locks: Row[] }>(`select $2::int=any(pg_blocking_pids($1::int)) as blocked,
      coalesce((select jsonb_agg(jsonb_build_object('locktype',locktype,'mode',mode,'granted',granted,
        'transactionid',transactionid::text,'relation',relation::regclass::text,'page',page,'tuple',tuple) order by locktype,mode)
        from pg_locks where pid=$1::int and not granted and locktype in ('transactionid','tuple')),'[]'::jsonb) as locks`, [waiter, holder])).rows[0]
    if (found.blocked && found.locks.length) return { waiter, holder, ...found, evidence: 'pg_blocking_pids plus observed ungranted native row dependency' }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Expected native quote row dependency was not observed before deadline')
}

async function accept(db: Database, f: Fixture, door: Door): Promise<unknown> {
  if (door === 'portal') return (await db.query<{ value: unknown }>('select public.portal_accept_quote($1,$2::uuid,null,null,false) as value', [f.token, f.quote])).rows[0].value
  if (door === 'owner') return (await db.query<{ value: unknown }>("select public.owner_record_customer_acceptance($1::uuid,'text_message',null,null,null) as value", [f.quote])).rows[0].value
  return (await db.query<{ value: unknown }>("select public.owner_select_quote_option($1::uuid,null,null,'text_message',null) as value", [f.quote])).rows[0].value
}

const predictions: Record<Scenario, string> = {
  'price-scope': 'old 500 price overwrites committed 800 price while new scope enters the acceptance document',
  reassignment: 'old customer A actor records consent against current customer B quote identity',
  withdrawal: 'zero-row quote UPDATE followed by FOUND true permits a ledger row while quote remains declined',
  deleted: 'portal returns true despite absent quote and NULL ledger result; owner returns NULL and alias false',
}

function assertOutcome(scenario: Scenario, door: Door, f: Fixture, before: Snapshot, intermediate: Snapshot, after: Snapshot, result: unknown) {
  assert.equal(before.quotes.length, 1); assert.equal(before.quote_acceptances.length, 0)
  assert.equal(before.quotes[0].status, 'sent'); assert.equal(before.quotes[0].initial_price, 500)
  assert.equal(before.quote_addons.length + before.quote_options.length + before.quote_services.length, 0)
  if (scenario === 'deleted') {
    assert.equal(intermediate.quotes.length, 0); assert.equal(after.quotes.length, 0)
    assert.equal(after.quote_acceptances.length, 0)
    assert.equal(result, door === 'portal' ? true : door === 'owner' ? null : false)
    assert.deepEqual(after, intermediate, 'No ledger or other acceptance effects should exist after deleted-quote outcome')
    return
  }
  if (door === 'owner') assert.match(String(result), /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/)
  else assert.equal(result, true)
  assert.equal(after.quote_acceptances.length, 1)
  const q = after.quotes[0], a = after.quote_acceptances[0]
  if (door === 'owner') assert.equal(a.id, result)
  const document = a.document as Row
  assert.equal(a.quote_id, f.quote); assert.equal(a.user_id, f.owner); assert.equal(a.accepted_amount, 500)
  assert.equal(a.kind, door === 'portal' ? 'customer' : 'owner_on_behalf')
  assert.equal(a.actor_id, door === 'portal' ? f.customer : f.owner)
  assert.equal(a.on_behalf_reason, door === 'portal' ? null : 'text_message')
  assert.equal(a.terms_required, false); assert.equal(a.terms_acknowledged, false)
  if (scenario === 'price-scope') {
    assert.equal(intermediate.quotes[0].initial_price, 800); assert.equal(intermediate.quotes[0].notes, 'new scope')
    assert.equal(q.initial_price, 500); assert.equal(q.accepted_price, 500); assert.equal(q.status, 'accepted')
    assert.equal(q.notes, 'new scope'); assert.equal(document.notes, 'new scope'); assert.equal(document.initial_price, 500)
  } else if (scenario === 'reassignment') {
    assert.equal(q.customer_id, f.target); assert.equal(q.property_id, f.targetProperty)
    assert.equal(q.customer_name, 'Fictional Customer B'); assert.equal(a.customer_id, f.target)
    assert.equal(a.actor_id, f.customer); assert.equal(a.actor_label, 'Fictional Customer A')
    assert.equal(document.customer_name, 'Fictional Customer B'); assert.equal(q.status, 'accepted')
  } else {
    assert.equal(intermediate.quotes[0].status, 'declined'); assert.equal(q.status, 'declined')
    assert.deepEqual(q, intermediate.quotes[0], 'Zero-row acceptance UPDATE must not alter the withdrawn quote')
    assert.deepEqual(after.notifications, intermediate.notifications, 'No accepted-status transition means no native accepted notification')
  }
  for (const table of ['customers','properties','business_settings','customer_portal_tokens','quote_options','quote_services',
    'quote_addons','pricing_config_versions','measurements','property_measurements','property_measurement_events',
    'pilot_email_connections','pilot_quote_followup_workflows','pilot_email_send_attempts','pilot_email_webhook_events']) {
    assert.deepEqual(after[table], intermediate[table], 'Unrelated full rows preserved: ' + table)
  }
}

export async function runAcceptanceBaseline(observer: Database) {
  const tests: TestResult[] = [], evidence: CaseEvidence[] = [], barriers: Barrier[] = []
  const sessions: number[] = []
  let allSessionsClosed = true
  const { sources, pins } = pinnedSources()
  const baseline = sources['supabase/migrations/20260830150001_baseline.sql']
  const nativeBefore = await nativeDefinitions(observer, baseline)
  const schemaBefore = await schemaDefinitions(observer)
  const observerPid = Number((await observer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0].pid)

  const cases: { scenario: Scenario; door: Door }[] = [
    { scenario: 'price-scope', door: 'portal' }, { scenario: 'reassignment', door: 'portal' },
    ...(['portal', 'owner', 'owner-alias'] as const).map(door => ({ scenario: 'withdrawal' as const, door })),
    ...(['portal', 'owner', 'owner-alias'] as const).map(door => ({ scenario: 'deleted' as const, door })),
  ]
  for (const [index, { scenario, door }] of cases.entries()) {
    const f = fixture(301 + index)
    const label = scenario === 'deleted' && door !== 'portal' ? 'baseline native refusal control' : 'baseline native expected defect'
    const name = `${label}: ${scenario} via ${door}`
    const item: CaseEvidence = { name, scope: 'Unchanged native SQL RPC and ordinary native writer; actual React Save/accept caller not invoked',
      prediction: predictions[scenario], sessionsClosed: false, fixture: f, phases: [] }
    evidence.push(item)
    let writer: DisposableSession | undefined, accepter: DisposableSession | undefined
    let waiting: Promise<unknown> | undefined
    const phases = item.phases as string[]
    try {
      await seed(observer, f)
      writer = await DisposableSession.open('accept-baseline-w-' + index)
      accepter = await DisposableSession.open('accept-baseline-a-' + index)
      sessions.push(writer.pid, accepter.pid)
      assert.equal(new Set([observerPid, writer.pid, accepter.pid]).size, 3)
      item.before = await snapshot(observer, f.owner)
      item.writerContext = await begin(writer, 'authenticated', f.owner)
      if (scenario === 'price-scope') await writer.query("update public.quotes set initial_price=800,notes='new scope' where id=$1::uuid returning *", [f.quote])
      else if (scenario === 'reassignment') await writer.query(`update public.quotes set customer_id=$2::uuid,property_id=$3::uuid,
        customer_name='Fictional Customer B',address='200 Fictional Baseline Lane' where id=$1::uuid returning *`, [f.quote, f.target, f.targetProperty])
      else if (scenario === 'withdrawal') {
        const override = (await writer.query<{ value: boolean }>("select public.owner_override_quote_status($1::uuid,'declined','Synthetic concurrency withdrawal') as value", [f.quote])).rows[0].value
        assert.equal(override, true)
      } else {
        const deleted = await writer.query('delete from public.quotes where id=$1::uuid returning id', [f.quote])
        assert.equal(deleted.rows.length, 1)
      }
      phases.push('writer finished native mutation; transaction still open')
      item.accepterContext = await begin(accepter, door === 'portal' ? 'anon' : 'authenticated', door === 'portal' ? '' : f.owner)
      waiting = accept(accepter, f, door)
      void waiting.catch(() => undefined)
      const barrier = await rowBarrier(observer, accepter.pid, writer.pid)
      barriers.push(barrier); item.barrier = barrier
      phases.push('observer confirmed accepter blocked on writer row dependency')
      item.whileBlocked = await snapshot(observer, f.owner)
      assert.deepEqual(item.whileBlocked, item.before, 'Uncommitted writer must be invisible to independent observer')
      await writer.exec('commit'); phases.push('writer committed')
      const result = await waiting
      item.observedRpcResult = result
      phases.push('native acceptance RPC completed; acceptance transaction still open')
      const intermediate = await snapshot(observer, f.owner)
      item.intermediate = intermediate
      await accepter.exec('commit'); phases.push('acceptance transaction committed')
      const after = await snapshot(observer, f.owner); item.after = after
      assertOutcome(scenario, door, f, item.before as Snapshot, intermediate, after, result)
      tests.push({ name, pass: true })
    } catch (error) {
      item.error = error instanceof Error ? error.message.slice(0, 2000) : 'Baseline proof failed'
      if (error instanceof SqlStateError) item.sqlstate = error.code
      tests.push({ name, pass: false, error: String(item.error) })
    } finally {
      // Release the known holder before awaiting a possibly blocked command.
      // Commands queued on accepter cannot roll it back until its RPC completes.
      try { await writer?.exec('rollback') } catch { /* session close below is authoritative */ }
      if (waiting) { try { await waiting } catch { /* original error recorded above */ } }
      try { await accepter?.exec('rollback') } catch { /* session close below is authoritative */ }
      const opened = [writer, accepter].filter((s): s is DisposableSession => !!s)
      const closure = await Promise.allSettled(opened.map(s => s.close()))
      item.sessionsClosed = closure.every(r => r.status === 'fulfilled')
      if (!item.sessionsClosed) {
        allSessionsClosed = false
        tests.push({ name: name + ': confirmed cleanup', pass: false, error: 'Disposable session exit was not confirmed' })
      }
    }
  }

  // A native preview is captured first, then a separate settings transaction
  // changes the terms before native acceptance. This is a serial display/write
  // boundary reproduction, NOT a lock race or an actual React confirmation test.
  {
    const f = fixture(310), name = 'baseline native expected defect: terms change after captured portal preview'
    const item: CaseEvidence = { name, scope: 'Native get_portal_data preview, separate committed terms write, native portal acceptance; no React invocation',
      prediction: 'receipt records new terms Y although captured preview contained X', sessionsClosed: false, fixture: f }
    evidence.push(item)
    let writer: DisposableSession | undefined, accepter: DisposableSession | undefined
    try {
      await seed(observer, f)
      writer = await DisposableSession.open('accept-baseline-terms-w')
      accepter = await DisposableSession.open('accept-baseline-terms-a')
      sessions.push(writer.pid, accepter.pid)
      assert.equal(new Set([observerPid, writer.pid, accepter.pid]).size, 3)
      const x = 'Please provide access to the property.', y = 'Please keep pets indoors during the visit.'
      const writeTerms = async (text: string) => {
        const patch = termsClaimPatch(text)
        assert.equal(patch.terms_payment_claim, 'no_claim')
        const context = await begin(writer!, 'authenticated', f.owner)
        await writer!.query(`update public.business_settings set terms_text=$2,terms_payment_claim=$3,
          terms_payment_claim_fingerprint=$4,terms_payment_claim_version=$5 where user_id=$1::uuid`,
        [f.owner, text, patch.terms_payment_claim, patch.terms_payment_claim_fingerprint, patch.terms_payment_claim_version])
        const fingerprint = (await writer!.query<{ value: string }>('select public.quote_terms_fingerprint($1::uuid) as value', [f.owner])).rows[0].value
        assert.equal(fingerprint, patch.terms_payment_claim_fingerprint)
        await writer!.exec('commit')
        return { context, text, patch, fingerprint }
      }
      item.originalTerms = await writeTerms(x)
      item.previewContext = await begin(accepter, 'anon')
      const preview = (await accepter.query<{ value: { business: Row; quotes: Row[] } }>('select public.get_portal_data($1) as value', [f.token])).rows[0].value
      assert.equal(preview.business.terms_text, x)
      assert.ok(preview.quotes.some(q => q.id === f.quote && q.status === 'sent'))
      item.preview = preview
      await accepter.exec('commit')
      item.changedTerms = await writeTerms(y)
      item.beforeAcceptance = await snapshot(observer, f.owner)
      item.acceptanceContext = await begin(accepter, 'anon')
      const result = (await accepter.query<{ value: boolean }>('select public.portal_accept_quote($1,$2::uuid,null,null,true) as value', [f.token, f.quote])).rows[0].value
      item.observedRpcResult = result
      await accepter.exec('commit')
      const after = await snapshot(observer, f.owner); item.after = after
      assert.equal(result, true); assert.equal(after.quote_acceptances.length, 1)
      assert.equal(after.quote_acceptances[0].terms_text, y)
      assert.equal(after.quote_acceptances[0].terms_fingerprint, (item.changedTerms as { fingerprint: string }).fingerprint)
      assert.equal(after.quote_acceptances[0].terms_required, true)
      assert.equal(after.quote_acceptances[0].terms_acknowledged, true)
      assert.notEqual(after.quote_acceptances[0].terms_text, preview.business.terms_text)
      tests.push({ name, pass: true })
    } catch (error) {
      item.error = error instanceof Error ? error.message.slice(0, 2000) : 'Terms baseline failed'
      if (error instanceof SqlStateError) item.sqlstate = error.code
      tests.push({ name, pass: false, error: String(item.error) })
    } finally {
      await Promise.allSettled([writer?.exec('rollback'), accepter?.exec('rollback')])
      const opened = [writer, accepter].filter((s): s is DisposableSession => !!s)
      const closure = await Promise.allSettled(opened.map(s => s.close()))
      item.sessionsClosed = closure.every(r => r.status === 'fulfilled')
      if (!item.sessionsClosed) {
        allSessionsClosed = false
        tests.push({ name: name + ': confirmed cleanup', pass: false, error: 'Disposable session exit was not confirmed' })
      }
    }
  }

  const nativeAfter = await nativeDefinitions(observer, baseline)
  const schemaAfter = await schemaDefinitions(observer)
  const preserved = JSON.stringify(nativeBefore) === JSON.stringify(nativeAfter) && JSON.stringify(schemaBefore) === JSON.stringify(schemaAfter)
  tests.push({ name: 'baseline native acceptance functions, ACLs, triggers, constraints, RLS and publications remain unchanged', pass: preserved })
  return { tests, evidence, barriers, sessions, observer: observerPid, allSessionsClosed,
    sourcePins: pins, nativeDefinitions: nativeAfter.map(d => ({ ...d, source: undefined, sourceSha256: sha(d.source) })),
    schemaDefinitionSha256: sha(JSON.stringify(schemaAfter)),
    scope: 'Baseline defect reproduction only; no candidate implementation, actual React Save/accept invocation or production activity' }
}
