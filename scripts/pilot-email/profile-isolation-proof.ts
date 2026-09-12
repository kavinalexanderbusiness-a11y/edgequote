// Focused, cloud-only native proof. No URL, hosted database, real Auth, HTTP,
// browser, provider, production data or broad predecessor-suite entry point.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DisposableSession, SqlStateError, type Database, type TestResult } from './database'
import { splitStatements, substitutePlatformStatements } from '../lib/pg-sql'
import { quoteSaveSnapshot, quoteSaveTargets, quoteSaveWrite } from './quote-save-native-cases'
import { quoteSaveIntentFixture } from './quote-save-plan-cases'
import { identityRpc, seedQuoteIdentity, approveIdentityFixture } from './quote-identity-fixtures'
import { buildPilotQuoteIdentityPlan } from '../../src/lib/quotes/pilotQuoteIdentity'
import { buildPilotQuoteSavePlan, type PilotQuoteSaveEditorSnapshot, type PilotQuoteSaveTargetRequest } from '../../src/lib/quotes/pilotQuoteSavePlan'

type Row = Record<string, unknown>
type Rows = Record<string, Row[]>
type Fixture = { owner: string; customer: string; target: string; property: string; targetProperty: string; quote: string }
type Kind = 'neutral' | 'legacy' | 'save' | 'acceptance' | 'identity'
type Prepared = { save: Awaited<ReturnType<typeof prepareSave>>; expected: Row; identity: Awaited<ReturnType<typeof buildPilotQuoteIdentityPlan>> }
const ROOT = process.cwd(), OUT = resolve('outputs/quote-shared-profile-isolation-20260911')
const EMAIL_CORE_SHA256 = '434048ade9a3625a280707f12877f694281e72efbaa78b29ae141503876540fb'
const EMAIL = ['pilot_email_connections', 'pilot_quote_followup_workflows', 'pilot_email_send_attempts', 'pilot_email_webhook_events']
const TABLES = ['business_settings', 'customers', 'properties', 'quotes', 'quote_services', 'quote_options', 'quote_addons',
  'quote_acceptances', 'service_templates', 'travel_fee_tiers', 'service_pricing_plans', 'measurements', 'property_measurements',
  'property_measurement_events', 'pricing_config_versions', 'messages', 'notification_log', 'notifications', 'audit_events',
  'integration_events', 'webhook_deliveries']
const sha = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim()
const quoted = (name: string) => '"' + name.replace(/"/g, '""') + '"'
const tests: TestResult[] = [], evidence: Row[] = [], sessions: DisposableSession[] = []
const report: Row = { pass: false, startedAt: new Date().toISOString(), tests, evidence, sourcePins: {}, platformSubstitutions: [],
  scope: 'Focused actual disposable PostgreSQL17 schema, native RPC and observed backend locks. Auth/storage/net prelude is synthetic; no real Auth, PostgREST, browser or provider proof.',
  productionCalls: 0, providerCalls: 0, broadPredecessorSuitesRun: 0 }
let db: DisposableSession, emailPresent = false, seedTag = 1800

async function value<T = unknown>(connection: Database, sql: string, params: unknown[] = []): Promise<T> {
  const result = await connection.query<{ value: T }>(sql, params)
  assert.equal(result.rows.length, 1, 'One scalar result required')
  return result.rows[0].value
}
async function transaction<T>(connection: Database, work: () => Promise<T>): Promise<T> {
  await connection.exec('begin isolation level read committed')
  try { const result = await work(); await connection.exec('commit'); return result }
  catch (error) { await connection.exec('rollback'); throw error }
}
async function service<T>(connection: Database, work: () => Promise<T>): Promise<T> {
  await connection.exec('savepoint profile_service; set local role service_role')
  try { const result = await work(); await connection.exec('reset role; release savepoint profile_service'); return result }
  catch (error) { await connection.exec('rollback to savepoint profile_service; reset role; release savepoint profile_service'); throw error }
}
async function open(name: string) { const connection = await DisposableSession.open(name); sessions.push(connection); return connection }
async function test(name: string, work: (entry: Row) => Promise<void>) {
  const entry: Row = { name }; evidence.push(entry)
  try { await work(entry); tests.push({ name, pass: true }); entry.pass = true }
  catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 1600) : 'Focused native assertion failed'
    tests.push({ name, pass: false, error: detail }); entry.pass = false; entry.error = detail
    throw error // Stop dependent phases; never describe unexecuted schedules as passing.
  }
}
async function apply(file: string) {
  const transformed = substitutePlatformStatements(readFileSync(join(ROOT, file), 'utf8'))
  ;(report.platformSubstitutions as string[]).push(...transformed.hits.map(hit => `${file}: ${hit}`))
  for (const [index, statement] of splitStatements(transformed.sql).entries()) {
    try { await db.exec(statement) }
    catch (error) { throw new Error(`SQL application ${file}, statement ${index + 1}: ${error instanceof Error ? error.message : 'failed'}`) }
  }
}
async function rows(f: Fixture, eventTable = 'pilot_email_webhook_events'): Promise<Rows> {
  assert.ok(['pilot_email_webhook_events', 'proof_missing_email_events'].includes(eventTable))
  const tables = [...TABLES, ...(emailPresent ? EMAIL.slice(0, 3) : [])]
  const pairs = tables.map(table => `'${table}',(select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),'[]'::jsonb) from public.${table} r where user_id=$1::uuid)`)
  pairs.push(`'auth_users',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]'::jsonb) from auth.users r where id=$1::uuid)`)
  pairs.push(`'customer_portal_tokens',(select coalesce(jsonb_agg(to_jsonb(r) order by token),'[]'::jsonb) from public.customer_portal_tokens r where user_id=$1::uuid)`)
  if (emailPresent) pairs.push(`'pilot_email_webhook_events',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]'::jsonb) from public.${eventTable} r where connection_id in (select id from public.pilot_email_connections where user_id=$1::uuid))`)
  return value(db, `select jsonb_build_object(${pairs.join(',')}) as value`, [f.owner])
}
// Artifacts contain hashes/counts, never email snapshots, reply tokens, portal
// tokens, credential fields or raw SQL activity. Comparisons use full rows in memory.
function facts(snapshot: Rows) { return { sha256: sha(snapshot), tables: Object.fromEntries(Object.entries(snapshot).map(([k, v]) => [k, { count: v.length, sha256: sha(v) }])) } }
async function seed(): Promise<Fixture> {
  const f = { owner: randomUUID(), customer: randomUUID(), target: randomUUID(), property: randomUUID(), targetProperty: randomUUID(), quote: randomUUID() }
  await transaction(db, async () => {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1::uuid,$2,clock_timestamp())', [f.owner, `profile-${f.owner}@fixture.example.invalid`])
    await db.query(`insert into public.business_settings(user_id,company_name,owner_name,business_type,timezone,default_rate,gst_percent)
      values($1::uuid,'Synthetic profile business','Synthetic owner','general','Etc/UTC',50,0)`, [f.owner])
    for (const [customer, property, name, address] of [[f.customer, f.property, 'Original profile customer', '10 Profile Road'], [f.target, f.targetProperty, 'Target profile customer', '20 Profile Road']]) {
      await db.query('insert into public.customers(id,user_id,name,address) values($1::uuid,$2::uuid,$3,$4)', [customer, f.owner, name, address])
      await db.query('insert into public.properties(id,user_id,customer_id,address,is_primary) values($1::uuid,$2::uuid,$3::uuid,$4,true)', [property, f.owner, customer, address])
    }
    await db.query(`insert into public.quotes(id,user_id,customer_id,property_id,quote_number,customer_name,address,service_type,
      initial_price,travel_fee,status,sent_at,issued_date,valid_until,notes,internal_notes)
      values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'Original profile customer','10 Profile Road','General visit',100,5,'sent',
      clock_timestamp()-interval '1 day',current_date-1,current_date+30,'Original public scope','Synthetic private scope')`,
    [f.quote, f.owner, f.customer, f.property, `PROFILE-${f.quote}`])
  })
  return f
}
async function prepareSave(connection: Database, f: Fixture, changes: Row = {}) {
  const snapshot = await quoteSaveSnapshot(connection, f)
  assert.equal(snapshot.code, 'snapshot')
  const intent = quoteSaveIntentFixture(snapshot as unknown as PilotQuoteSaveEditorSnapshot, { notes: 'Focused shared-lock Save', ...changes })
  let targets: PilotQuoteSaveTargetRequest | undefined
  const plan = await buildPilotQuoteSavePlan(snapshot, intent, request => { targets = request; return quoteSaveTargets(connection, request) })
  assert.ok(targets)
  return { plan, targets, intent }
}
async function prepare(f: Fixture): Promise<Prepared> {
  return transaction(db, async () => {
    const save = await prepareSave(db, f)
    const preview = await service(db, () => value<Row>(db, 'select public.pilot_quote_acceptance_preview($1::uuid,null,$2::uuid,null) as value', [f.owner, f.quote]))
    assert.equal(preview.code, 'preview'); assert.ok(preview.expected)
    const snapshot = await identityRpc(db, 'pilot_quote_identity_snapshot', { p_owner: f.owner, p_quote: f.quote })
    const identity = await buildPilotQuoteIdentityPlan(snapshot, { customerId: f.target, name: 'Ignored typed alias', address: '20 Profile Road' })
    return { save, expected: preview.expected as Row, identity }
  })
}
async function invoke(connection: Database, kind: Kind, f: Fixture, prepared: Prepared): Promise<unknown> {
  if (kind === 'neutral' || kind === 'legacy') return value(connection, `select public.${kind === 'neutral' ? '_pilot_quote_owner_lock' : '_pilot_email_owner_lock'}($1::uuid) as value`, [f.owner])
  if (kind === 'save') return quoteSaveWrite(connection, f, prepared.save.plan)
  if (kind === 'identity') return identityRpc(connection, 'pilot_quote_identity_save', { p_owner: f.owner, p_quote: f.quote, p_plan: prepared.identity })
  return service(connection, () => value(connection, `select public.pilot_quote_acceptance_commit($1::uuid,null,$2::uuid,$3::jsonb,null,
    '{}'::uuid[],'text_message','Synthetic native authority proof',true) as value`, [f.owner, f.quote, JSON.stringify(prepared.expected)]))
}
function tracked<T>(promise: Promise<T>) {
  let unresolved = true
  const result = promise.then(value => ({ value, error: null }), error => ({ value: null, error }))
    .finally(() => { unresolved = false })
  return { result, pending: () => unresolved }
}
async function graph(owner: string, holder: DisposableSession, waiter: DisposableSession, pending: () => boolean) {
  const end = Date.now() + 8000
  do {
    assert.equal(pending(), true, 'Waiting request settled before observed lock contention')
    const observation = await value<Row>(db, `with k as (select hashtextextended('pilot-email:'||$1::text,0) as v),
      key as (select (select oid from pg_database where datname=current_database())::bigint as database,
        ((v>>32)&4294967295::bigint) as classid,(v&4294967295::bigint) as objid,1 as objsubid from k)
      select jsonb_build_object('observed_at',clock_timestamp(),'key',(select to_jsonb(key) from key),'holder',$2::int,'waiter',$3::int,
        'blockers',to_jsonb(pg_blocking_pids($3::int)),
        'holder_locks',(select coalesce(jsonb_agg(jsonb_build_object('database',l.database::bigint,'classid',l.classid::bigint,'objid',l.objid::bigint,'objsubid',l.objsubid,'mode',l.mode,'granted',l.granted)),'[]'::jsonb) from pg_locks l,key k
          where l.pid=$2::int and l.locktype='advisory' and l.database::bigint=k.database and l.classid::bigint=k.classid and l.objid::bigint=k.objid and l.objsubid=k.objsubid),
        'waiter_locks',(select coalesce(jsonb_agg(jsonb_build_object('database',l.database::bigint,'classid',l.classid::bigint,'objid',l.objid::bigint,'objsubid',l.objsubid,'mode',l.mode,'granted',l.granted)),'[]'::jsonb) from pg_locks l,key k
          where l.pid=$3::int and l.locktype='advisory' and l.database::bigint=k.database and l.classid::bigint=k.classid and l.objid::bigint=k.objid and l.objsubid=k.objsubid),
        'wait_event',(select wait_event_type from pg_stat_activity where pid=$3::int)) as value`, [owner, holder.pid, waiter.pid])
    const held = observation.holder_locks as Row[], waiting = observation.waiter_locks as Row[]
    if (JSON.stringify(observation.blockers) === JSON.stringify([holder.pid]) && observation.wait_event === 'Lock'
      && held.length === 1 && waiting.length === 1 && held[0].granted === true && waiting[0].granted === false
      && held[0].mode === 'ExclusiveLock' && waiting[0].mode === 'ExclusiveLock') {
      const { granted: _a, ...left } = held[0], { granted: _b, ...right } = waiting[0]
      assert.deepEqual(left, right); assert.equal(pending(), true)
      return observation
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  } while (Date.now() < end)
  throw new Error('Exact owner advisory contention was not observed within eight seconds')
}
async function closePair(left: DisposableSession, right: DisposableSession, entry: Row) {
  const results = await Promise.allSettled([left.close(), right.close()])
  entry.sessionsClosed = results.every(result => result.status === 'fulfilled')
  assert.equal(entry.sessionsClosed, true, 'Owned SQL backend closure failed')
}
async function lockCase(profile: string, first: Kind, second: Kind) {
  await test(`${profile}: ${first} holds exact owner lock before ${second}`, async entry => {
    const f = await seed(), prepared = await prepare(f), before = await rows(f)
    const left = await open(`profile-${first}-holder`), right = await open(`profile-${second}-waiter`)
    assert.notEqual(left.pid, right.pid); assert.notEqual(left.pid, db.pid); assert.notEqual(right.pid, db.pid)
    let waiting: ReturnType<typeof tracked> | undefined
    try {
      await left.exec('begin isolation level read committed'); const provisional = await invoke(left, first, f, prepared)
      await right.exec('begin isolation level read committed'); waiting = tracked(invoke(right, second, f, prepared))
      entry.graph = await graph(f.owner, left, right, waiting.pending)
      assert.deepEqual(await rows(f), before, 'Uncommitted winner must remain invisible to independent observer')
      entry.before = facts(before); entry.firstReturnBeforeCommitIsProvisional = true
      await left.exec('commit'); entry.firstCommitted = true
      const result = await waiting.result; if (result.error) throw result.error
      const expectedCode = first === 'save' && second === 'acceptance' ? 'quote_changed'
        : first === 'acceptance' && second === 'save' ? 'stale_editor'
          : second === 'save' ? 'committed' : second === 'acceptance' ? 'accepted' : null
      if (expectedCode) assert.equal((result.value as Row).code, expectedCode)
      if (first === 'save') assert.equal((provisional as Row).code, 'committed')
      if (first === 'acceptance') assert.equal((provisional as Row).code, 'accepted')
      await right.exec('commit'); entry.secondCommitted = true
      const after = await rows(f), saved = first === 'save' || (second === 'save' && expectedCode === 'committed')
      const accepted = first === 'acceptance' || (second === 'acceptance' && expectedCode === 'accepted')
      assert.equal(after.quotes[0].notes, saved ? 'Focused shared-lock Save' : before.quotes[0].notes)
      assert.equal(after.quote_acceptances.length, accepted ? 1 : 0)
      for (const table of Object.keys(before)) if (!['quotes', 'quote_acceptances', 'audit_events', 'integration_events', 'webhook_deliveries', 'notifications'].includes(table)) {
        assert.deepEqual(after[table], before[table], `Unexpected ${table} mutation under shared lock`)
      }
      if (saved) {
        const receipt = (first === 'save' ? provisional : result.value) as Row
        for (const [key, expected] of Object.entries(receipt.quote as Row)) assert.deepEqual(after.quotes[0][key], expected, `Committed Save receipt field ${key}`)
        entry.saveReceiptSha256 = sha(receipt)
      }
      if (accepted) {
        const receipt = (first === 'acceptance' ? provisional : result.value) as Row, ledger = after.quote_acceptances[0]
        assert.equal(ledger.id, receipt.acceptance_id); assert.equal(ledger.seq, receipt.acceptance_seq)
        assert.equal(ledger.accepted_amount, receipt.accepted_amount); assert.equal(after.quotes[0].accepted_price, receipt.accepted_amount)
        assert.equal(ledger.document_fingerprint, receipt.document_fingerprint); assert.equal(ledger.terms_fingerprint, receipt.terms_fingerprint)
        assert.equal(await value(db, 'select public.quote_acceptance_is_current($1::uuid) as value', [f.quote]), true)
        entry.acceptanceReceiptSha256 = sha(receipt)
      }
      if (!saved && !accepted) assert.deepEqual(after, before)
      entry.after = facts(after); entry.secondCode = expectedCode; entry.normalCommitReadback = true
    } finally {
      try { entry.beforeCleanup = facts(await rows(f)) } catch { entry.beforeCleanupUnavailable = true }
      await closePair(left, right, entry)
      if (waiting) await waiting.result
      entry.afterCleanup = facts(await rows(f))
      entry.cleanupMeaning = 'Owned connections closed; no inference that cancellation undid a completed COMMIT'
    }
  })
}
async function differentOwner(profile: string) {
  await test(`${profile}: a different owner does not wait on the held owner key`, async entry => {
    const a = await seed(), b = await seed(), prepared = await prepare(b), before = await rows(b)
    const left = await open('profile-different-holder'), right = await open('profile-different-writer')
    try {
      await left.exec('begin'); await value(left, 'select public._pilot_quote_owner_lock($1::uuid) as value', [a.owner])
      await right.exec("begin; set local lock_timeout='1000ms'")
      const result = await invoke(right, 'save', b, prepared); assert.equal((result as Row).code, 'committed')
      assert.deepEqual(await rows(b), before)
      await right.exec('commit')
      assert.equal((await rows(b)).quotes[0].notes, 'Focused shared-lock Save')
      entry.holderStillOpen = await value(db, "select state='idle in transaction' as value from pg_stat_activity where pid=$1::int", [left.pid])
      assert.equal(entry.holderStillOpen, true)
      const locks = (await db.query<Row>(`select pid,database::bigint,classid::bigint,objid::bigint,objsubid,granted from pg_locks
        where pid in ($1::int,$2::int) and locktype='advisory' order by pid,classid,objid`, [left.pid, right.pid])).rows
      const key = await value<Row>(db, `with k as (select hashtextextended('pilot-email:'||$1::text,0) as v)
        select jsonb_build_object('database',(select oid::bigint from pg_database where datname=current_database()),
          'classid',((v>>32)&4294967295::bigint),'objid',(v&4294967295::bigint),'objsubid',1) as value from k`, [a.owner])
      assert.equal(locks.length, 1); assert.equal(locks[0].pid, left.pid); assert.equal(locks[0].granted, true)
      for (const [field, expected] of Object.entries(key)) assert.equal(locks[0][field], expected)
      entry.originalOwnerKey = key
      entry.locksAfterOtherCommit = locks; entry.before = facts(before); entry.after = facts(await rows(b))
      await left.exec('commit')
    } finally { await closePair(left, right, entry) }
  })
}
async function mustRefuse(connection: Database, action: () => Promise<unknown>, expectedCode = '55000') {
  await connection.exec('savepoint profile_expected_refusal')
  let caught: unknown
  try { await action() } catch (error) { caught = error }
  finally { await connection.exec('rollback to savepoint profile_expected_refusal; release savepoint profile_expected_refusal') }
  assert.ok(caught instanceof SqlStateError, 'A native error is required; no empty-history or success fallback')
  assert.equal(caught.code, expectedCode)
  if (expectedCode === '55000') assert.match(caught.detail, /pilot_quote_email_profile_unavailable/)
  return { code: caught.code, message: expectedCode === '55000' ? 'pilot_quote_email_profile_unavailable' : 'native constraint refusal' }
}
async function assertProfile(profile: 'absent' | 'present') {
  const catalogue = await value<Row>(db, 'select public._pilot_quote_email_catalogue() as value')
  const declaration = await value<Row>(db, 'select public._pilot_quote_email_expected_profile() as value')
  const digest = await value<string>(db, "select encode(sha256(convert_to(public._pilot_quote_email_catalogue()::text,'UTF8')),'hex') as value")
  report[`${profile}Catalogue`] = { declaration, observedSha256: digest, counts: Object.fromEntries(Object.entries(catalogue).filter(([k]) => k !== 'version').map(([k, v]) => [k, Array.isArray(v) ? v.length : null])) }
  assert.equal(await value(db, 'select public._pilot_quote_email_profile() as value'), profile)
  assert.equal(declaration.catalogue_sha256, digest, 'Target must match the independently fixed declaration; never learn a new expected digest here')
  if (profile === 'absent') for (const [key, entries] of Object.entries(catalogue)) if (key !== 'version') assert.deepEqual(entries, [], `Absent profile footprint: ${key}`)
  return catalogue
}
async function deletionCase(bulk: boolean) {
  await test(`absent: ${bulk ? 'bulk' : 'single'} quote deletion and same-ID parent Undo remain compatible`, async entry => {
    const f = await seed(), prepared = await prepare(f)
    await transaction(db, async () => { assert.equal(((await invoke(db, 'acceptance', f, prepared)) as Row).code, 'accepted') })
    let second: string | null = null
    if (bulk) {
      second = randomUUID()
      await transaction(db, () => db.query(`insert into public.quotes(id,user_id,customer_id,property_id,quote_number,customer_name,address,service_type,initial_price,status)
        values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'Original profile customer','10 Profile Road','Second visit',90,'draft')`, [second, f.owner, f.customer, f.property, `UNDO-${second}`]))
    }
    const before = await rows(f), ids = before.quotes.map(q => q.id as string)
    assert.equal(before.quote_acceptances.length, 1)
    await transaction(db, async () => {
      const deleted = (await db.query<Row>('delete from public.quotes where user_id=$1::uuid and id=any($2::uuid[]) returning id', [f.owner, '{' + ids.join(',') + '}'])).rows
      assert.equal(deleted.length, bulk ? 2 : 1)
    })
    const deleted = await rows(f)
    assert.equal(deleted.quotes.length, 0); assert.equal(deleted.quote_acceptances.length, 0)
    // Exactly the existing single/bulk UI's parent reinsertion: omit only its
    // three generated columns. No ledger/child reconstruction is added here.
    const undo = before.quotes.map(q => Object.fromEntries(Object.entries(q).filter(([k]) => !['man_hours', 'subtotal', 'total'].includes(k))))
    const keys = Object.keys(undo[0]); keys.forEach(key => assert.match(key, /^[a-z_][a-z0-9_]*$/))
    await transaction(db, () => db.query(`insert into public.quotes(${keys.map(quoted).join(',')})
      select ${keys.map(quoted).join(',')} from jsonb_populate_recordset(null::public.quotes,$1::jsonb) returning id`, [JSON.stringify(undo)]))
    const restored = await rows(f)
    assert.deepEqual(restored.quotes, before.quotes); assert.equal(restored.quote_acceptances.length, 0)
    assert.deepEqual(restored.customers, before.customers); assert.deepEqual(restored.properties, before.properties)
    for (const original of before.audit_events) assert.ok(restored.audit_events.some(row => JSON.stringify(row) === JSON.stringify(original)))
    assert.equal(await value(db, 'select public.quote_acceptance_is_current($1::uuid) as value', [f.quote]), false)
    await assertProfile('absent')
    entry.before = facts(before); entry.deleted = facts(deleted); entry.restored = facts(restored)
    entry.sameIds = ids; entry.acceptanceLedgerRestored = false; entry.scope = 'Native persistence compatibility of current parent-only Undo, not browser or evidence-restoration proof'
  })
}
async function retainedCases() {
  for (const state of ['approved', 'held', 'completed'] as const) await test(`present: ordered ${state} history preserves all-state reassignment/deletion guards`, async entry => {
    const f = await transaction(db, () => seedQuoteIdentity(db, ++seedTag, false))
    await transaction(db, async () => {
      for (let index = 0; index < 2; index++) {
      if (index) await db.query('update public.quotes set notes=$2 where id=$1::uuid', [f.quote, 'Second independently approved scope'])
      const approved = await approveIdentityFixture(db, f); assert.equal(approved.code, 'approved')
      const workflow = approved.workflow_id
      if (state === 'held') assert.equal((await identityRpc(db, 'pilot_email_hold_workflow', { p_workflow: workflow, p_reason: 'owner_paused' })).code, 'held')
      if (state === 'completed') {
        const claim = await identityRpc(db, 'pilot_email_claim', { p_workflow: workflow, p_step: 1 }); assert.equal(claim.code, 'claimed')
        const args = { p_attempt: claim.attempt_id, p_fence: claim.fence }
        assert.equal((await identityRpc(db, 'pilot_email_start', args)).code, 'started')
        assert.equal((await identityRpc(db, 'pilot_email_confirm', { ...args, p_provider_email_id: `synthetic-profile-${seedTag}-${index}` })).code, 'confirmed')
        assert.equal((await identityRpc(db, 'pilot_email_finalize', args)).code, 'finalized')
      }
      }
    })
    const before = await rows(f)
    const retained = await value<Row>(db, 'select public._pilot_quote_email_retained($1::uuid,$2::uuid) as value', [f.owner, f.quote])
    const direct = await value<Row>(db, `select jsonb_build_object('workflows',(select coalesce(jsonb_agg(to_jsonb(w) order by id),'[]'::jsonb) from public.pilot_quote_followup_workflows w where user_id=$1::uuid and quote_id=$2::uuid),
      'attempts',(select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]'::jsonb) from public.pilot_email_send_attempts a where user_id=$1::uuid and quote_id=$2::uuid)) as value`, [f.owner, f.quote])
    assert.deepEqual(retained, direct)
    assert.equal((direct.workflows as Row[]).length, 2); assert.equal((direct.attempts as Row[]).length, 2)
    assert.ok((direct.workflows as Row[]).every(workflow => workflow.state === state))
    await transaction(db, async () => {
      for (const input of [{ customerId: f.target, name: 'Ignored typed alias', address: '200 Existing Road' }, { customerId: '__manual', name: 'Forbidden new person', address: '90 Profile Road' }]) {
        const snapshot = await identityRpc(db, 'pilot_quote_identity_snapshot', { p_owner: f.owner, p_quote: f.quote })
        const plan = await buildPilotQuoteIdentityPlan(snapshot, input)
        assert.equal((await identityRpc(db, 'pilot_quote_identity_save', { p_owner: f.owner, p_quote: f.quote, p_plan: plan })).code, 'retained_customer_binding')
      }
      const save = await prepareSave(db, f, { customer_id: f.target, address: '200 Existing Road' })
      assert.equal((await quoteSaveWrite(db, f, save.plan)).code, 'retained_customer_binding')
      for (const [table, column, id] of [['quotes', 'id', f.quote], ['customers', 'id', f.customer], ['business_settings', 'user_id', f.owner]]) {
        await mustRefuse(db, () => db.query(`delete from public.${table} where ${column}=$1::uuid returning ${column}`, [id]), '23503')
      }
    })
    assert.deepEqual(await rows(f), before)
    await transaction(db, async () => { const same = await prepareSave(db, f, { notes: 'Retained same-customer scope' }); assert.equal((await quoteSaveWrite(db, f, same.plan)).code, 'committed') })
    assert.deepEqual(await value(db, 'select public._pilot_quote_email_retained($1::uuid,$2::uuid) as value', [f.owner, f.quote]), direct)
    entry.before = facts(before); entry.after = facts(await rows(f)); entry.retainedSha256 = sha(direct)
    entry.retainedCounts = { workflows: (direct.workflows as Row[]).length, attempts: (direct.attempts as Row[]).length }
  })
}
const badDeclaration = `create or replace function public._pilot_quote_email_expected_profile() returns jsonb language sql immutable set search_path='' as
  $profile_fault$ select jsonb_build_object('version',1,'profile','present','catalogue_sha256',repeat('0',64)); $profile_fault$`
async function driftCases(profile: 'absent' | 'present') {
  const f = await seed(), prepared = await prepare(f)
  const common: [string, () => Promise<unknown>][] = [
    ['unexpected email table', () => db.exec('create table public.pilot_email_proof_unexpected(id uuid)')],
    ['fixed profile digest mismatch', () => db.exec(badDeclaration)],
    ['malformed fixed declaration', () => db.exec("create or replace function public._pilot_quote_email_expected_profile() returns jsonb language sql immutable set search_path='' as $$select '{}'::jsonb$$")],
    ['missing fixed declaration', () => db.exec('drop function public._pilot_quote_email_expected_profile()')],
  ]
  const drifts: [string, () => Promise<unknown>][] = profile === 'absent' ? common : [
    ['extra column', () => db.exec('alter table public.pilot_email_connections add column proof_extra text')],
    ['column ACL', () => db.exec('grant select(from_address) on public.pilot_email_connections to authenticated')],
    ['table ACL', () => db.exec('grant insert on public.pilot_email_connections to authenticated')],
    ['user trigger disabled', () => db.exec('alter table public.pilot_email_connections disable trigger pilot_connection_immutable')],
    ['INSTEAD rule', () => db.exec('create rule profile_discard_insert as on insert to public.pilot_email_connections do instead nothing')],
    ['nonmatching-named inherited child', () => db.exec('create table public.proof_inherited_payload() inherits(public.pilot_email_connections)')],
    ['internal referenced-parent RI trigger disabled', async () => {
      const target = (await db.query<{ rel: string; name: string }>(`select t.tgrelid::regclass::text rel,t.tgname name from pg_trigger t join pg_constraint c on c.oid=t.tgconstraint
        where t.tgisinternal and c.contype='f' and c.conrelid='public.pilot_quote_followup_workflows'::regclass and t.tgrelid='public.quotes'::regclass order by t.tgname limit 1`)).rows[0]
      assert.ok(target); assert.ok(['quotes', 'public.quotes'].includes(target.rel))
      await db.exec(`alter table public.quotes disable trigger ${quoted(target.name)}`)
    }],
    ['foreign key removed', async () => {
      const name = await value<string>(db, "select conname as value from pg_constraint where conrelid='public.pilot_email_connections'::regclass and contype='f' limit 1")
      await db.exec(`alter table public.pilot_email_connections drop constraint ${quoted(name)}`)
    }],
    ['foreign key not validated', async () => {
      const target = (await db.query<{ name: string; definition: string }>(`select conname name,pg_get_constraintdef(oid,true) definition from pg_constraint where conrelid='public.pilot_email_connections'::regclass and contype='f' limit 1`)).rows[0]
      assert.ok(target)
      await db.exec(`alter table public.pilot_email_connections drop constraint ${quoted(target.name)}; alter table public.pilot_email_connections add constraint ${quoted(target.name)} ${target.definition} not valid`)
    }],
    ['function ACL', () => db.exec('grant execute on function public._pilot_email_owner_lock(uuid) to authenticated')],
    ['compatibility function body', () => db.exec("create or replace function public._pilot_email_owner_lock(p_owner uuid) returns void language sql set search_path='' as $$select pg_advisory_xact_lock(7)$$")],
    ['partial footprint missing table name', () => db.exec('alter table public.pilot_email_webhook_events rename to proof_missing_email_events')],
    ...common,
  ]
  for (const [name, mutate] of drifts) await test(`${profile} drift: ${name} refuses every participating entrance without residual writes`, async entry => {
    await db.exec('begin isolation level read committed')
    const before = await rows(f)
    try {
      await mutate()
      const refusals = []
      for (const [name, action] of [
        ['profile', () => value(db, 'select public._pilot_quote_email_profile() as value')],
        ['retained', () => value(db, 'select public._pilot_quote_email_retained($1::uuid,$2::uuid) as value', [f.owner, f.quote])],
        ['snapshot', () => quoteSaveSnapshot(db, f)],
        ['targets', () => quoteSaveTargets(db, prepared.save.targets)],
        ['Save', () => invoke(db, 'save', f, prepared)],
        ['identity', () => invoke(db, 'identity', f, prepared)],
        ['acceptance', () => invoke(db, 'acceptance', f, prepared)],
      ] as [string, () => Promise<unknown>][]) refusals.push({ entrance: name, ...await mustRefuse(db, action) })
      entry.refusals = refusals
      const afterRefusals = await rows(f, name === 'partial footprint missing table name' ? 'proof_missing_email_events' : 'pilot_email_webhook_events')
      assert.deepEqual(afterRefusals, before)
      entry.afterRefusalsBeforeDriftRollback = facts(afterRefusals)
    } finally { await db.exec('rollback') }
    assert.deepEqual(await rows(f), before); await assertProfile(profile)
    entry.before = facts(before); entry.after = facts(await rows(f)); entry.driftRolledBack = true
  })
}
async function postWait(kind: 'save' | 'identity' | 'acceptance') {
  await test(`post-wait: ${kind} observes a newly invalid fixed profile before DML`, async entry => {
    const f = await seed(), prepared = await prepare(f), before = await rows(f)
    const original = await value<string>(db, "select pg_get_functiondef('public._pilot_quote_email_expected_profile()'::regprocedure) as value")
    const left = await open('profile-postwait-holder'), right = await open('profile-postwait-writer')
    let request: ReturnType<typeof tracked> | undefined, changed = false
    try {
      await left.exec('begin'); await value(left, 'select public._pilot_quote_owner_lock($1::uuid) as value', [f.owner])
      await right.exec('begin isolation level read committed'); request = tracked(invoke(right, kind, f, prepared))
      entry.graph = await graph(f.owner, left, right, request.pending)
      await db.exec(badDeclaration); changed = true
      assert.equal(request.pending(), true); assert.deepEqual(await rows(f), before)
      await left.exec('commit')
      const result = await request.result
      assert.ok(result.error instanceof SqlStateError); assert.equal(result.error.code, '55000'); assert.match(result.error.detail, /pilot_quote_email_profile_unavailable/)
      await right.exec('rollback')
      assert.deepEqual(await rows(f), before)
      entry.before = facts(before); entry.after = facts(await rows(f)); entry.nativeCode = result.error.code
      entry.scope = 'Deliberate profile fault after observed owner-lock wait; not supported live profile switching or arbitrary-DDL protection'
    } finally {
      try { entry.beforeCleanup = facts(await rows(f)) } catch { entry.beforeCleanupUnavailable = true }
      await closePair(left, right, entry)
      if (request) await request.result
      if (changed) await db.exec(original)
      await assertProfile('present'); entry.afterCleanup = facts(await rows(f))
    }
  })
}
async function main() {
  try {
    assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Cloud disposable service only; no heavy local database')
    report.head = git('rev-parse', 'HEAD'); report.tree = git('rev-parse', 'HEAD^{tree}')
    assert.equal(report.head, process.env.GITHUB_SHA); assert.equal(git('status', '--porcelain', '--untracked-files=no'), '')
    const pins = report.sourcePins as Record<string, string>
    for (const file of git('ls-files').split('\n').filter(file => /\.(ts|tsx|sql|json|yml)$/.test(file))) pins[file] = sha(readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n'))
    const core = 'supabase/proposals/pilot-email-core.sql'
    assert.equal(pins[core], EMAIL_CORE_SHA256, 'The reviewed email core must remain unchanged')
    db = await open('profile-observer')
    report.database = (await db.query<Row>('select version() as version,pg_backend_pid() as observer')).rows[0]
    assert.equal(await value<number>(db, "select count(*)::int as value from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m')"), 0)
    await apply('scripts/schema/platform-prelude.sql')
    await db.exec('grant usage on schema auth to authenticated')
    for (const file of readdirSync(join(ROOT, 'supabase/migrations')).filter(file => file.endsWith('.sql')).sort()) await apply('supabase/migrations/' + file)
    await apply('supabase/proposals/pilot-quote-shared-profile.sql')
    await apply('supabase/proposals/pilot-quote-email-absent.sql')
    for (const file of ['pilot-quote-identity.sql', 'pilot-quote-save.sql', 'pilot-quote-versioned-acceptance.sql']) await apply('supabase/proposals/' + file)
    await test('absent: fixed profile has no email footprint and private helpers stay private', async entry => {
      await assertProfile('absent'); const f = await seed()
      assert.deepEqual(await value(db, 'select public._pilot_quote_email_retained($1::uuid,$2::uuid) as value', [f.owner, f.quote]), { workflows: [], attempts: [] })
      assert.equal(await value(db, "select to_regprocedure('public._pilot_email_owner_lock(uuid)')::text as value"), null)
      for (const signature of ['_pilot_quote_owner_lock(uuid)', '_pilot_quote_email_profile()', '_pilot_quote_email_catalogue()', '_pilot_quote_email_retained(uuid,uuid)', '_pilot_quote_email_expected_profile()']) {
        for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await value(db, 'select has_function_privilege($1,$2,\'EXECUTE\') as value', [role, 'public.' + signature]), false)
      }
      entry.catalogue = report.absentCatalogue
    })
    await test('absent: identity reassignment commits without installing email history', async entry => {
      const f = await seed(), p = await prepare(f), before = await rows(f)
      await transaction(db, async () => { assert.equal(((await invoke(db, 'identity', f, p)) as Row).code, 'saved') })
      const after = await rows(f)
      assert.equal(after.quotes[0].customer_id, f.target)
      for (const table of Object.keys(before)) if (table !== 'quotes') assert.deepEqual(after[table], before[table])
      for (const field of ['initial_price', 'travel_fee', 'status', 'notes', 'internal_notes']) assert.equal(after.quotes[0][field], before.quotes[0][field])
      await assertProfile('absent')
      entry.before = facts(before); entry.after = facts(after)
    })
    await deletionCase(false); await deletionCase(true); await driftCases('absent')
    const pairs: [Kind, Kind][] = [['neutral', 'save'], ['neutral', 'acceptance'], ['save', 'acceptance']]
    for (const [first, second] of pairs) { await lockCase('absent', first, second); await lockCase('absent', second, first) }
    await differentOwner('absent')
    // The driver has one fixed disposable database. Every competing backend is
    // closed before this fixture-only quiescent installation transition. This
    // is not an application migration, retention decision or live-switch API.
    assert.equal(await value<number>(db, "select count(*)::int as value from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and application_name like 'pilot-test-%'"), 0)
    await db.exec('drop function public._pilot_quote_email_expected_profile()')
    await apply(core); await apply('supabase/proposals/pilot-quote-email-present.sql'); emailPresent = true
    report.transition = { kind: 'quiescent disposable fixture setup only', competingBackends: 0, targetDerivedExpectedDigest: false }
    await test('present: fixed independently declared catalogue matches PostgreSQL17', async entry => { await assertProfile('present'); entry.catalogue = report.presentCatalogue })
    await retainedCases()
    for (const [first, second] of [...pairs, ['neutral', 'legacy'] as [Kind, Kind]]) { await lockCase('present', first, second); await lockCase('present', second, first) }
    await differentOwner('present'); await driftCases('present')
    for (const kind of ['save', 'identity', 'acceptance'] as const) await postWait(kind)
    report.pass = tests.length > 0 && tests.every(test => test.pass)
  } catch (error) {
    report.pass = false; report.error = error instanceof Error ? error.message.slice(0, 2000) : 'Focused profile proof failed'
    report.remainingCases = 'Not run after first blocking failure'
  } finally {
    const closure = await Promise.allSettled(sessions.map(connection => connection.close()))
    report.allSessionsClosed = closure.every(result => result.status === 'fulfilled')
    if (!report.allSessionsClosed) report.pass = false
    report.sessionCount = sessions.length; report.passed = tests.filter(test => test.pass).length; report.failed = tests.filter(test => !test.pass).length
    report.completedAt = new Date().toISOString()
    mkdirSync(OUT, { recursive: true }); writeFileSync(join(OUT, 'profile-proof.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ pass: report.pass, head: report.head, passed: report.passed, failed: report.failed,
      tests, allSessionsClosed: report.allSessionsClosed, error: report.error, remainingCases: report.remainingCases }))
    if (!report.pass) process.exitCode = 1
  }
}
void main()
