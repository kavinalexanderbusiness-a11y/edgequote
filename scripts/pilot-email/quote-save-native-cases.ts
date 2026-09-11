// Dormant proof exports. Only the existing marked disposable PG17 driver can
// execute these; no connection string, production client or copied save engine.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DisposableSession, SqlStateError, type Database, type TestResult } from './database'
import { identityRows, identityValue, seedQuoteIdentity, type IdentityFixture } from './quote-identity-fixtures'
import { quoteSaveIntentFixture } from './quote-save-plan-cases'
import { buildPilotQuoteSavePlan, type PilotQuoteSaveEditorSnapshot, type PilotQuoteSavePlan, type PilotQuoteSaveTargetRequest } from '../../src/lib/quotes/pilotQuoteSavePlan'
import { parsePilotQuoteSaveReceipt } from '../../src/lib/quotes/pilotQuoteSaveReceipt'
import type { QuoteFormValues, QuoteServiceInput } from '../../src/types'

type Row = Record<string, unknown>
type Verdict = Row & { code: string }
export const quoteSaveNativeEvidence: Row[] = []
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// No JWT impersonation. The service boundary receives the separately verified
// owner; auth.uid() remains NULL in this service transport.
async function transport(db: Database, sql: string, args: unknown[]): Promise<Verdict> {
  await db.exec("savepoint full_save_transport; set local role service_role")
  try {
    // The unchanged fixture intentionally gives service_role no direct USAGE
    // on auth. Diagnose the same claims without weakening that grant boundary.
    const context = await identityValue(db, `select jsonb_build_object('role',current_user,
      'sub',nullif(current_setting('request.jwt.claim.sub',true),''),
      'claims_sub',nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub') as value`)
    assert.deepEqual(context, { role: 'service_role', sub: null, claims_sub: null })
    const value = await identityValue(db, sql, args)
    await db.exec('reset role; release savepoint full_save_transport')
    assert.ok(value && typeof value === 'object' && typeof (value as Row).code === 'string')
    return value as Verdict
  } catch (error) {
    await db.exec('rollback to savepoint full_save_transport; reset role; release savepoint full_save_transport')
    throw error
  }
}
export const quoteSaveSnapshot = (db: Database, f: Pick<IdentityFixture, 'owner' | 'quote'>) => transport(db,
  'select public.pilot_quote_save_snapshot($1::uuid,$2::uuid) as value', [f.owner, f.quote])
export const quoteSaveTargets = (db: Database, r: PilotQuoteSaveTargetRequest) => transport(db,
  `select public.pilot_quote_save_targets($1::uuid,$2::uuid,$3,$4::jsonb,
    array(select jsonb_array_elements_text($5::jsonb))::uuid[],$6) as value`,
  [r.owner, r.quote_id, r.expected_editor_revision, JSON.stringify(r.identity), JSON.stringify(r.template_ids), r.provenance_mode])
export const quoteSaveWrite = (db: Database, f: Pick<IdentityFixture, 'owner' | 'quote'>, plan: unknown) => transport(db,
  'select public.pilot_quote_save($1::uuid,$2::uuid,$3::jsonb) as value', [f.owner, f.quote, JSON.stringify(plan)])
export async function quoteSavePlan(db: Database, f: Pick<IdentityFixture, 'owner' | 'quote'>, changes: Partial<QuoteFormValues> = {}) {
  const snapshot = await quoteSaveSnapshot(db, f)
  assert.equal(snapshot.code, 'snapshot')
  return buildPilotQuoteSavePlan(snapshot, quoteSaveIntentFixture(snapshot as unknown as PilotQuoteSaveEditorSnapshot, changes), selection => quoteSaveTargets(db, selection))
}
// Missing settings is a real supported state. The predecessor identity fixture
// always creates a retained pilot connection whose native FK correctly forbids
// deleting its settings; build a separate minimal native fixture instead.
async function seedQuoteWithoutSettings(db: Database, tag: number) {
  const id = (part: number) => `23000000-0000-4000-8000-${String(tag * 100 + part).padStart(12, '0')}`
  const owner = id(1), customer = id(2), property = id(3), quote = id(4)
  await db.query('insert into auth.users(id,email,email_confirmed_at) values($1::uuid,$2,clock_timestamp())', [owner, `missing-settings-${tag}@fixture.example.invalid`])
  await db.query("insert into public.customers(id,user_id,name,address) values($1::uuid,$2::uuid,'Missing Settings Customer','100 Fixture Road')", [customer, owner])
  await db.query("insert into public.properties(id,user_id,customer_id,address,is_primary) values($1::uuid,$2::uuid,$3::uuid,'100 Fixture Road',true)", [property, owner, customer])
  await db.query(`insert into public.quotes(id,user_id,customer_id,property_id,quote_number,customer_name,address,service_type,initial_price,travel_fee,status)
    values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'Missing Settings Customer','100 Fixture Road','General visit',100,5,'sent')`,
  [quote, owner, customer, property, `NO-SETTINGS-${tag}`])
  assert.equal(Number(await identityValue(db, 'select count(*) as value from public.business_settings where user_id=$1::uuid', [owner])), 0)
  assert.equal(Number(await identityValue(db, 'select count(*) as value from public.pilot_email_connections where user_id=$1::uuid', [owner])), 0)
  return { owner, customer, property, quote }
}
async function allRows(db: Database, owner: string) {
  const out = await identityRows(db, owner)
  for (const table of ['business_settings', 'service_templates', 'measurements', 'property_measurements', 'property_measurement_events', 'pricing_config_versions', 'quote_acceptances', 'notifications']) {
    out[table] = (await db.query<Row>(`select to_jsonb(r) as row from public.${table} r where user_id=$1::uuid order by to_jsonb(r)::text`, [owner])).rows.map(row => row.row as Row)
  }
  out.customer_portal_tokens = (await db.query<{ row: Row }>(`select (to_jsonb(t)-'token')||jsonb_build_object('token_digest',md5(t.token)) as row
    from public.customer_portal_tokens t where user_id=$1::uuid order by token`, [owner])).rows.map(row => row.row)
  return out
}
const line = (changes: Partial<QuoteServiceInput> = {}): QuoteServiceInput => ({ service_type: 'Second fixture service', service_template_id: '', quantity: 2,
  unit: 'each', unit_price: 25, est_minutes: 12, discount_type: 'percent', discount_value: 10, notes: 'Public extra', kind: 'service', ...changes })
const alternatives = [{ name: 'Basic', description: '', price: 100, is_recommended: false },
  { name: 'Complete', description: 'Full scope', price: 250, is_recommended: true }]

export async function runQuoteSaveNativeCases(db: Database): Promise<TestResult[]> {
  const results: TestResult[] = []
  let tag = 500
  const test = async (name: string, work: (tag: number) => Promise<void>) => {
    await db.exec('begin isolation level read committed')
    try { await work(++tag); await db.exec('set constraints all immediate'); results.push({ name, pass: true }) }
    catch (error) { results.push({ name, pass: false, error: error instanceof Error ? error.message.slice(0, 1800) : 'Full Save native assertion failed' }) }
    finally { await db.exec('rollback') }
  }
  await test('full Save native: snapshot and target rebind use real planner with zero writes and immutable original revision', async n => {
    const f = await seedQuoteIdentity(db, n), before = await allRows(db, f.owner)
    const p = await quoteSavePlan(db, f, { customer_id: '__manual', customer_name: 'Brand new fixture', address: '900 New Road' })
    assert.ok(p.identity.customer_insert); assert.ok(p.identity.property_insert)
    assert.equal(p.expected.targets.customer, null); assert.equal(p.expected.targets.property, null)
    assert.equal(p.expected.targets.editor_revision, p.expected.editor.editor_revision)
    assert.equal(p.expected_editor_revision, p.expected.editor.editor_revision)
    assert.deepEqual(await allRows(db, f.owner), before)
    for (const key of ['quote', 'services', 'options', 'addons', 'templates', 'pricing_inputs', 'acceptance', 'identity']) assert.ok(key in p.expected.editor)
    quoteSaveNativeEvidence.push({ kind: 'read-only-plan', owner: f.owner, quote: f.quote, before: digest(before), after: digest(await allRows(db, f.owner)), editorRevision: p.expected_editor_revision })
  })
  await test('full Save native: notes preserve price provenance, protected quote state, retained bindings and add-ons', async n => {
    const f = await seedQuoteIdentity(db, n, true), before = await allRows(db, f.owner)
    const changes = { notes: 'Changed public scope', internal_notes: 'Changed private note' }
    const p = await quoteSavePlan(db, f, changes)
    assert.equal(p.provenance.mode, 'preserve')
    const result = await quoteSaveWrite(db, f, p); assert.equal(result.code, 'committed')
    const after = await allRows(db, f.owner), q = after.quotes[0]
    assert.equal(q.notes, 'Changed public scope'); assert.equal(q.internal_notes, 'Changed private note')
    for (const field of ['status', 'quote_number', 'accepted_price', 'selected_option_id', 'sent_at', 'issued_date', 'valid_until', 'price_source', 'pricing_config_version_id', 'value_grade', 'nearby_count', 'no_charge_at', 'no_charge_reason', 'no_charge_by']) assert.deepEqual(q[field], before.quotes[0][field], field)
    for (const table of ['quote_addons', 'quote_acceptances', 'pilot_quote_followup_workflows', 'pilot_email_send_attempts', 'pricing_config_versions', 'property_measurement_events']) assert.deepEqual(after[table], before[table], table)
    assert.equal(result.client_operation_id, p.client_operation_id); assert.equal(result.editor_generation, p.editor_generation)
    assert.notEqual(result.after_revision, result.before_revision)
    const submitted = quoteSaveIntentFixture(p.expected.editor, changes)
    assert.ok(parsePilotQuoteSaveReceipt(result, { version: 1, owner: f.owner, quoteId: f.quote, clientOperationId: submitted.clientOperationId,
      editorGeneration: submitted.editorGeneration, originalEditorRevision: submitted.expectedEditorRevision,
      submittedValues: submitted.values, submittedSerialization: JSON.stringify(submitted.values), stagedAt: 0, state: 'pending' }))
    assert.equal((result.quote as Row).notes, q.notes)
    assert.equal('portal_token' in (result.quote as Row), false); assert.equal('no_charge_reason' in (result.quote as Row), false)
  })
  for (const raw of [100.001, -1]) {
    await test(`full Save native: canonical provenance honors raw input ${raw} before storage normalization`, async n => {
      const f = await seedQuoteIdentity(db, n)
      const p = await quoteSavePlan(db, f, raw < 0 ? { weekly_price: raw } : { initial_price: raw })
      assert.equal(p.provenance.mode, 'ensure_current')
      assert.equal((await quoteSaveWrite(db, f, p)).code, 'committed')
      const q = (await allRows(db, f.owner)).quotes[0]
      assert.equal(q.price_source, 'engine'); assert.ok(q.pricing_config_version_id)
      assert.equal(q.initial_price, 100); assert.equal(q.weekly_price, null)
    })
  }
  await test('full Save native: new identity, commercial fields, deposit, lines and manual typed lawn commit together', async n => {
    const f = await seedQuoteIdentity(db, n), before = await allRows(db, f.owner)
    const p = await quoteSavePlan(db, f, { customer_id: '__manual', customer_name: 'New full Save fixture', address: '905 New Road',
      service_type: 'Lawn Mowing', measured_sqft: 1500.25, initial_price: 160, weekly_price: 50,
      notes: 'New public scope', internal_notes: 'Private separate scope', deposit_type: 'percent', deposit_value: 50, services: [line()] })
    assert.ok(p.measurement)
    const result = await quoteSaveWrite(db, f, p); assert.equal(result.code, 'committed')
    const after = await allRows(db, f.owner)
    assert.equal(after.customers.length, before.customers.length + 1); assert.equal(after.properties.length, before.properties.length + 1)
    assert.equal(after.quotes[0].customer_id, p.identity.resolved.customer_id); assert.equal(after.quotes[0].property_id, p.identity.resolved.property_id)
    assert.equal(after.quotes[0].initial_price, 205); assert.equal(after.quotes[0].deposit_type, 'percent'); assert.equal(after.quotes[0].deposit_value, 50)
    assert.equal(after.quote_services.length, 2); assert.equal(after.property_measurements.length, 1); assert.equal(after.property_measurement_events.length, 1)
    assert.equal(after.property_measurements[0].value, 1500.25); assert.equal(after.property_measurement_events[0].action, 'measured')
    assert.equal(after.properties.find(row => row.id === p.identity.resolved.property_id)?.lawn_sqft, 1500.25)
    assert.equal((await quoteSaveWrite(db, f, p)).code, 'stale_editor'); assert.deepEqual(await allRows(db, f.owner), after)
  })
  await test('full Save native: alternative replacement and disabling options preserve canonical headline semantics', async n => {
    const f = await seedQuoteIdentity(db, n, false, 'options')
    const p = await quoteSavePlan(db, f, { has_options: true, options: alternatives })
    assert.equal((await quoteSaveWrite(db, f, p)).code, 'committed')
    let after = await allRows(db, f.owner)
    assert.equal(after.quote_options.length, 2); assert.equal(after.quotes[0].initial_price, 250); assert.equal(after.quote_addons.length, 1)
    const disabled = await quoteSavePlan(db, f, { has_options: false, options: alternatives, initial_price: 75 })
    assert.equal((await quoteSaveWrite(db, f, disabled)).code, 'committed')
    after = await allRows(db, f.owner); assert.equal(after.quote_options.length, 0); assert.equal(after.quotes[0].initial_price, 75)
  })
  await test('full Save native: settled option identity and amount stay intact despite form option edits', async n => {
    const f = await seedQuoteIdentity(db, n, false, 'options')
    const oid = await identityValue(db, 'select id as value from public.quote_options where quote_id=$1::uuid', [f.quote])
    assert.equal(await identityValue(db, "select public.quote_apply_choice($1::uuid,$2::uuid,'{}'::uuid[],'owner') as value", [f.quote, oid]), true)
    const before = await allRows(db, f.owner)
    const p = await quoteSavePlan(db, f, { has_options: true, options: alternatives, initial_price: 999, notes: 'Clarification' })
    assert.equal(p.options.mode, 'preserve'); assert.equal(p.parent_patch.initial_price, before.quotes[0].initial_price)
    assert.equal((await quoteSaveWrite(db, f, p)).code, 'committed')
    const after = await allRows(db, f.owner)
    assert.deepEqual(after.quote_options, before.quote_options); assert.equal(after.quotes[0].selected_option_id, oid)
    assert.equal(after.quotes[0].initial_price, before.quotes[0].initial_price)
  })
  await test('full Save native: retained customer rebind refuses before preparation with zero residual writes', async n => {
    const f = await seedQuoteIdentity(db, n, true)
    const p = await quoteSavePlan(db, f, { customer_id: '__manual', customer_name: 'Forbidden retained rebind', address: '909 New Road', initial_price: 400 })
    const before = await allRows(db, f.owner)
    assert.equal((await quoteSaveWrite(db, f, p)).code, 'retained_customer_binding')
    assert.deepEqual(await allRows(db, f.owner), before)
  })
  await test('full Save native: missing pricing settings are an explicit planning refusal with zero writes', async n => {
    const f = await seedQuoteWithoutSettings(db, n)
    const before = await allRows(db, f.owner)
    await assert.rejects(() => quoteSavePlan(db, f, { initial_price: 200 }))
    assert.deepEqual(await allRows(db, f.owner), before)
  })
  for (const change of ['quote', 'services', 'options', 'addons', 'settings', 'target_lawn', 'template'] as const) {
    await test(`full Save native: independently changed ${change} after planning refuses without overwrite`, async n => {
      const f = await seedQuoteIdentity(db, n, false, change === 'options' ? 'options' : 'services')
      if (change === 'template') await db.query("insert into public.service_templates(user_id,name,default_rate) values($1::uuid,'Pinned template',12)", [f.owner])
      const p = await quoteSavePlan(db, f, { notes: 'Stale proposed note' })
      if (change === 'quote') await db.query("update public.quotes set internal_notes='Concurrent note' where id=$1::uuid", [f.quote])
      if (change === 'services') await db.query('update public.quote_services set unit_price=111 where quote_id=$1::uuid', [f.quote])
      if (change === 'options') await db.query('update public.quote_options set price=111 where quote_id=$1::uuid', [f.quote])
      if (change === 'addons') await db.query("update public.quote_addons set name='Concurrent extra' where quote_id=$1::uuid", [f.quote])
      if (change === 'settings') await db.query('update public.business_settings set pricing_base_charge=99 where user_id=$1::uuid', [f.owner])
      if (change === 'target_lawn') await db.query('update public.properties set lawn_sqft=2200 where id=$1::uuid', [f.property])
      if (change === 'template') await db.query('update public.service_templates set default_rate=99 where user_id=$1::uuid', [f.owner])
      const before = await allRows(db, f.owner), result = await quoteSaveWrite(db, f, p)
      assert.ok(['stale_editor', 'stale_targets'].includes(result.code), result.code)
      assert.deepEqual(await allRows(db, f.owner), before)
    })
  }
  for (const defect of ['unexpected_key', 'status_patch', 'missing_property', 'forged_revision', 'wrong_owner', 'incomplete_children'] as const) {
    await test(`full Save native: private malformed plan ${defect} cannot partially save`, async n => {
      const f = await seedQuoteIdentity(db, n, false, 'services'), p = structuredClone(await quoteSavePlan(db, f)) as unknown as Row
      if (defect === 'unexpected_key') p.activation = true
      if (defect === 'status_patch') (p.parent_patch as Row).status = 'approved'
      if (defect === 'missing_property') delete (p.parent_patch as Row).property_id
      if (defect === 'forged_revision') p.expected_editor_revision = '0'.repeat(32)
      if (defect === 'wrong_owner') (p.parent_patch as Row).user_id = f.target
      if (defect === 'incomplete_children') ((p.expected as Row).editor as Row).services = []
      const before = await allRows(db, f.owner)
      const result = await quoteSaveWrite(db, f, p); assert.notEqual(result.code, 'committed')
      assert.deepEqual(await allRows(db, f.owner), before)
    })
  }
  for (const failure of ['parent_suppressed', 'service_suppressed', 'measurement_error', 'history_suppressed'] as const) {
    await test(`full Save native: ${failure} aborts identity, pricing, parent, children and typed measurement together`, async n => {
      const f = await seedQuoteIdentity(db, n), p = await quoteSavePlan(db, f, { customer_id: '__manual', customer_name: 'Must roll back', address: '919 Rollback Road',
        service_type: 'Lawn Mowing', initial_price: 300, measured_sqft: 2001, services: [line()] })
      const table = failure === 'parent_suppressed' ? 'quotes' : failure === 'service_suppressed' ? 'quote_services'
        : failure === 'measurement_error' ? 'property_measurements' : 'property_measurement_events'
      const op = failure === 'parent_suppressed' ? 'update' : 'insert'
      await db.exec(`create function public.pilot_full_save_fault() returns trigger language plpgsql as $$ begin
        ${failure === 'measurement_error' ? "raise exception 'synthetic late measurement fault';" : failure === 'parent_suppressed' ? 'if new.initial_price is distinct from old.initial_price then return null; end if; return new;' : 'return null;'}
        end $$; create trigger pilot_full_save_fault before ${op} on public.${table} for each row execute function public.pilot_full_save_fault()`)
      const before = await allRows(db, f.owner)
      const expectedError = { parent_suppressed: 'pilot_quote_save_parent_missing', service_suppressed: 'pilot_quote_save_service_insert_mismatch',
        measurement_error: 'synthetic late measurement fault', history_suppressed: 'pilot_quote_save_measurement_history_mismatch' }[failure]
      await assert.rejects(() => quoteSaveWrite(db, f, p), error => error instanceof SqlStateError && error.code === 'P0001' && error.detail.includes(expectedError))
      const after = await allRows(db, f.owner); assert.deepEqual(after, before)
      quoteSaveNativeEvidence.push({ kind: 'whole-save-abort', fault: failure, owner: f.owner, before: digest(before), after: digest(after) })
    })
  }
  await test('full Save native: exact SQL jsonb-text 16MiB boundary reaches transaction; one byte over refuses before DML', async n => {
    const f = await seedQuoteIdentity(db, n), p = await quoteSavePlan(db, f)
    p.parent_patch.notes = ''
    const emptyBytes = Number(await identityValue(db, 'select octet_length($1::jsonb::text) as value', [JSON.stringify(p)]))
    p.parent_patch.notes = 'x'.repeat(16 * 1024 * 1024 - emptyBytes)
    assert.equal(Number(await identityValue(db, 'select octet_length($1::jsonb::text) as value', [JSON.stringify(p)])), 16 * 1024 * 1024)
    await db.exec(`create function public.pilot_full_save_bound() returns trigger language plpgsql as $$ begin
      raise exception 'synthetic_exact_boundary_reached_parent'; end $$;
      create trigger pilot_full_save_bound before update on public.quotes for each row execute function public.pilot_full_save_bound()`)
    const before = await allRows(db, f.owner)
    await assert.rejects(() => quoteSaveWrite(db, f, p), /synthetic_exact_boundary_reached_parent/)
    assert.deepEqual(await allRows(db, f.owner), before)
    p.parent_patch.notes += 'x'
    assert.equal((await quoteSaveWrite(db, f, p)).code, 'invalid_plan')
    assert.deepEqual(await allRows(db, f.owner), before)
    quoteSaveNativeEvidence.push({ kind: 'transport-cap-boundary', representation: 'PostgreSQL jsonb::text UTF-8 bytes; independent of compact browser JSON', limit: 16 * 1024 * 1024, exactReachedParent: true, overRefused: true })
  })
  await test('full Save native: complete outward snapshot envelope is bounded at exactly 16MiB and one byte over', async n => {
    const f = await seedQuoteIdentity(db, n)
    await db.query("update public.quotes set notes='' where id=$1::uuid", [f.quote])
    const size = async () => transport(db, `with snapshot as materialized(select public.pilot_quote_save_snapshot($1::uuid,$2::uuid) s)
      select jsonb_build_object('code',s->>'code','bytes',octet_length(s::text)) as value from snapshot`, [f.owner, f.quote])
    const empty = await size(); assert.equal(empty.code, 'snapshot')
    const fill = 16 * 1024 * 1024 - Number(empty.bytes)
    await db.query("update public.quotes set notes=repeat('x',$2::int) where id=$1::uuid", [f.quote, fill])
    const exact = await size(); assert.equal(exact.code, 'snapshot'); assert.equal(exact.bytes, 16 * 1024 * 1024)
    await db.query("update public.quotes set notes=repeat('x',$2::int) where id=$1::uuid", [f.quote, fill + 1])
    assert.equal((await size()).code, 'snapshot_too_large')
    quoteSaveNativeEvidence.push({ kind: 'complete-snapshot-envelope-boundary', exactBytes: exact.bytes, overRefused: true, representation: 'PostgreSQL jsonb::text UTF-8 including code, complete and revision' })
  })
  await test('full Save native: explicit foreign owner claim cannot use service RPC parameters to bypass owner guard', async n => {
    const f = await seedQuoteIdentity(db, n), other = await seedQuoteIdentity(db, n + 10000)
    const p = await quoteSavePlan(db, f), before = await allRows(db, f.owner), otherBefore = await allRows(db, other.owner)
    // Synthetic negative authentication control only. Production RPCs never set
    // or impersonate JWT state; both user IDs exist only in this rollback fixture.
    await db.exec('savepoint foreign_owner_control')
    try {
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [other.owner])
      await db.exec('set local role service_role')
      for (const sql of ['select public.pilot_quote_save_snapshot($1::uuid,$2::uuid) as value',
        'select public.pilot_quote_save($1::uuid,$2::uuid,$3::jsonb) as value']) {
        const result = await identityValue(db, sql, [f.owner, f.quote, JSON.stringify(p)]) as Verdict
        assert.equal(result.code, 'not_found')
      }
    } finally {
      // Recover the subtransaction before RESET ROLE so a genuine RPC failure
      // is not obscured by a secondary "current transaction is aborted" error.
      await db.exec('rollback to savepoint foreign_owner_control; reset role; release savepoint foreign_owner_control')
    }
    assert.deepEqual(await allRows(db, f.owner), before); assert.deepEqual(await allRows(db, other.owner), otherBefore)
  })
  await test('full Save native: privileges and actual nondeferrable owner/parent FK fences are pinned', async () => {
    const standingFunctions = (await db.query<{ signature: string; volatility: string }>(`select oid::regprocedure::text as signature,provolatile::text as volatility
      from pg_proc where oid=any(array['public.quote_acceptance_is_current(uuid)'::regprocedure,'public.quote_material_fingerprint(uuid)'::regprocedure,
        'public.quote_terms_fingerprint(uuid)'::regprocedure]) order by oid::regprocedure::text`)).rows
    assert.equal(standingFunctions.length, 3)
    for (const fn of standingFunctions) assert.equal(fn.volatility, 's', 'Canonical snapshot dependency must remain STABLE: ' + fn.signature)
    const signatures = ['pilot_quote_save_snapshot(uuid,uuid)', 'pilot_quote_save_targets(uuid,uuid,text,jsonb,uuid[],text)', 'pilot_quote_save(uuid,uuid,jsonb)']
    for (const signature of signatures) {
      const value = (await db.query<{ anon: boolean; authenticated: boolean; service: boolean; definer: boolean; config: string[] }>(`select
        has_function_privilege('anon',$1,'execute') anon,has_function_privilege('authenticated',$1,'execute') authenticated,
        has_function_privilege('service_role',$1,'execute') service,p.prosecdef definer,p.proconfig config from pg_proc p where p.oid=$1::regprocedure`, ['public.' + signature])).rows[0]
      assert.equal(value.anon, false); assert.equal(value.authenticated, false); assert.equal(value.service, true); assert.equal(value.definer, true)
      assert.ok(value.config.some(s => s === 'search_path=""'))
    }
    const fk = (await db.query<Row>(`select c.conname,c.conrelid::regclass::text as child,c.confrelid::regclass::text as parent,
      c.condeferrable,c.condeferred,c.convalidated,pg_get_constraintdef(c.oid) as definition from pg_constraint c
      where c.contype='f' and c.conrelid=any(array['public.business_settings'::regclass,'public.customers'::regclass,'public.properties'::regclass,
        'public.service_templates'::regclass,'public.quote_services'::regclass,'public.quote_options'::regclass,'public.quote_addons'::regclass,
        'public.property_measurements'::regclass,'public.quote_acceptances'::regclass]) order by child,c.conname`)).rows
    for (const table of ['business_settings', 'customers', 'properties', 'service_templates', 'quote_services', 'quote_options', 'quote_addons', 'property_measurements', 'quote_acceptances']) {
      const fence = fk.find(r => String(r.child).replace(/^public\./, '') === table && r.parent === 'auth.users' && String(r.definition).includes('FOREIGN KEY (user_id)'))
      assert.ok(fence, 'Missing auth owner FK: ' + table); assert.equal(fence.condeferrable, false); assert.equal(fence.convalidated, true)
    }
    quoteSaveNativeEvidence.push({ kind: 'actual-fk-metadata', constraints: fk, stableCanonicalDependencies: standingFunctions })
  })
  return results
}

async function transaction<T>(db: Database, work: () => Promise<T>) {
  await db.exec('begin isolation level read committed')
  try { const out = await work(); await db.exec('commit'); return out }
  catch (error) { await db.exec('rollback'); throw error }
}
async function waitBarrier(observer: Database, waiter: number, holder: number, kind: 'advisory' | 'row') {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const state = (await observer.query<Row>(`select pg_backend_pid() as observer,$1::int as waiter,$2::int as holder,
      $2::int=any(pg_blocking_pids($1::int)) as blocked,
      (select jsonb_agg(jsonb_build_object('locktype',locktype,'mode',mode,'transactionid',transactionid::text,'granted',granted) order by locktype,mode)
       from pg_locks where pid=$1::int and not granted and (($3='advisory' and locktype='advisory') or ($3='row' and locktype in ('transactionid','tuple')))) as waiting_locks,
      (select jsonb_agg(jsonb_build_object('locktype',locktype,'mode',mode,'transactionid',transactionid::text,'granted',granted) order by locktype,mode)
       from pg_locks where pid=$2::int and granted and locktype in ('transactionid','advisory')) as holder_locks`, [waiter, holder, kind])).rows[0]
    if (state.blocked && Array.isArray(state.waiting_locks) && state.waiting_locks.length) return state
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Native full Save lock barrier was not observed')
}
type AcceptanceFixture = IdentityFixture & { token: string }
const acceptancePreview = (db: Database, f: AcceptanceFixture, portal: boolean) => transport(db,
  'select public.pilot_quote_acceptance_preview($1::uuid,$2,$3::uuid,null) as value', [portal ? null : f.owner, portal ? f.token : null, f.quote])
const acceptanceCommit = (db: Database, f: AcceptanceFixture, portal: boolean, expected: Row) => transport(db,
  `select public.pilot_quote_acceptance_commit($1::uuid,$2,$3::uuid,$4::jsonb,null,
    array(select jsonb_array_elements_text($5::jsonb))::uuid[],$6,$7,true) as value`,
  [portal ? null : f.owner, portal ? f.token : null, f.quote, JSON.stringify(expected),
    JSON.stringify(((expected.offered as Row).public as Row).included_addon_ids), portal ? null : 'text_message', portal ? null : 'Actual displayed version acknowledged'])
async function acceptanceConsistency(db: Database, f: AcceptanceFixture, receipt: Verdict, expected: Row, portal: boolean) {
  const after = await allRows(db, f.owner), ledger = after.quote_acceptances[0], q = after.quotes[0]
  assert.equal(after.quote_acceptances.length, 1); assert.equal(receipt.code, 'accepted')
  assert.equal(ledger.id, receipt.acceptance_id); assert.equal(ledger.seq, receipt.acceptance_seq)
  assert.equal(ledger.kind, portal ? 'customer' : 'owner_on_behalf'); assert.equal(ledger.source, portal ? 'portal' : 'dashboard')
  assert.equal(ledger.customer_id, f.customer); assert.equal(ledger.actor_id, portal ? f.customer : f.owner)
  const offered = (expected.offered as Row).public as Row
  for (const amount of [receipt.accepted_amount, ledger.accepted_amount, q.accepted_price]) assert.equal(amount, offered.accepted_amount)
  const material = await identityValue(db, 'select public.quote_material_fingerprint($1::uuid) as value', [f.quote])
  assert.equal(ledger.document_fingerprint, material); assert.equal(receipt.document_fingerprint, material)
  assert.equal(await identityValue(db, 'select public.quote_acceptance_is_current($1::uuid) as value', [f.quote]), true)
  for (const key of ['initial_price', 'travel_fee', 'customer_name', 'address', 'service_type', 'notes']) assert.equal((ledger.document as Row)[key], q[key], key)
  const selected = after.quote_addons.filter(row => row.is_selected).map(row => row.id).sort()
  assert.deepEqual(selected, receipt.addon_ids); assert.deepEqual(selected, offered.included_addon_ids)
  return after
}
export async function runQuoteSaveNativeConcurrency(observer: Database) {
  const tests: TestResult[] = [], barriers: Row[] = [], evidence: Row[] = []
  const left = await DisposableSession.open('full-save-left')
  let right: DisposableSession
  try { right = await DisposableSession.open('full-save-right') } catch (error) { await left.close(); throw error }
  assert.notEqual(left.pid, right.pid)
  const test = async (name: string, work: () => Promise<void>) => {
    try { await work(); tests.push({ name, pass: true }) }
    catch (error) { tests.push({ name, pass: false, error: error instanceof Error ? error.message.slice(0, 1800) : 'Full Save native schedule failed' }) }
    finally { await Promise.allSettled([left.exec('rollback'), right.exec('rollback'), observer.exec('rollback')]) }
  }
  try {
    await test('full Save race: one Save wins; waiting stale editor cannot overwrite it', async () => {
      const f = await transaction(observer, () => seedQuoteIdentity(observer, 601))
      const p = await transaction(observer, () => quoteSavePlan(observer, f, { notes: 'First atomic Save' }))
      await left.exec('begin isolation level read committed'); assert.equal((await quoteSaveWrite(left, f, p)).code, 'committed')
      await right.exec('begin isolation level read committed'); const waiting = quoteSaveWrite(right, f, p); void waiting.catch(() => undefined)
      barriers.push(await waitBarrier(observer, right.pid, left.pid, 'advisory'))
      const old = await allRows(observer, f.owner); assert.notEqual(old.quotes[0].notes, 'First atomic Save')
      await left.exec('commit'); const before = await allRows(observer, f.owner)
      assert.equal((await waiting).code, 'stale_editor'); await right.exec('commit')
      assert.deepEqual(await allRows(observer, f.owner), before)
      barriers[barriers.length - 1].observer_before_commit = digest(old); barriers[barriers.length - 1].observer_after_commit = digest(before)
    })
    for (const portal of [true, false]) for (const saveFirst of [true, false]) {
      await test(`full Save / ${portal ? 'portal' : 'owner'} acceptance race: ${saveFirst ? 'Save' : 'acceptance'} commits first; stale opposing intent leaves zero partial state`, async () => {
        const tag = 609 + (portal ? 0 : 2) + (saveFirst ? 0 : 1)
        const f = await transaction(observer, async (): Promise<AcceptanceFixture> => {
          const base = await seedQuoteIdentity(observer, tag, false, 'services')
          const token = `synthetic-save-pair-${tag}-not-a-credential`
          await observer.query('insert into public.customer_portal_tokens(token,customer_id,user_id,revoked) values($1,$2::uuid,$3::uuid,false)', [token, base.customer, base.owner])
          await observer.query('update public.quote_addons set is_selected=true where quote_id=$1::uuid', [base.quote])
          return { ...base, token }
        })
        const p = await transaction(observer, () => quoteSavePlan(observer, f, { address: '945 Full Save New Property',
          service_type: 'Lawn Mowing', measured_sqft: 1850, initial_price: 350, services: [line()], notes: 'Entire new public scope', internal_notes: 'Private atomic note' }))
        assert.ok(p.identity.property_insert); assert.ok(p.measurement)
        const preview = await transaction(observer, () => acceptancePreview(observer, f, portal)); assert.equal(preview.code, 'preview')
        const expected = preview.expected as Row, before = await allRows(observer, f.owner)
        await left.exec('begin isolation level read committed')
        const first = saveFirst ? await quoteSaveWrite(left, f, p) : await acceptanceCommit(left, f, portal, expected)
        assert.equal(first.code, saveFirst ? 'committed' : 'accepted')
        await right.exec('begin isolation level read committed')
        const waiting = saveFirst ? acceptanceCommit(right, f, portal, expected) : quoteSaveWrite(right, f, p)
        void waiting.catch(() => undefined)
        const barrier = await waitBarrier(observer, right.pid, left.pid, 'advisory'); barriers.push(barrier)
        assert.deepEqual(await allRows(observer, f.owner), before, 'Independent observer cannot see uncommitted partial rows')
        await left.exec('commit'); const afterFirst = await allRows(observer, f.owner)
        const loser = await waiting; assert.equal(loser.code, saveFirst ? 'quote_changed' : 'stale_editor')
        await right.exec('commit'); const afterLoser = await allRows(observer, f.owner)
        assert.deepEqual(afterLoser, afterFirst, 'Losing RPC must not leave identity, pricing, children, acceptance or trigger writes')
        const item: Row = { kind: 'actual-save-versioned-acceptance-pair', portal, saveFirst, owner: f.owner, quote: f.quote,
          barrier, before, firstReceipt: first, afterFirst, losingVerdict: loser, afterLoser }
        if (saveFirst) {
          assert.equal(afterFirst.quote_acceptances.length, 0); assert.equal(afterFirst.properties.length, before.properties.length + 1)
          assert.equal(afterFirst.property_measurements.length, 1); assert.equal(afterFirst.property_measurement_events.length, 1)
          assert.equal(afterFirst.quote_services.length, 2); assert.equal(afterFirst.quotes[0].initial_price, p.parent_patch.initial_price)
          assert.equal((first.quote as Row).initial_price, afterFirst.quotes[0].initial_price)
          const fresh = await transaction(observer, () => acceptancePreview(observer, f, portal)); assert.equal(fresh.code, 'preview')
          const accepted = await transaction(observer, () => acceptanceCommit(observer, f, portal, fresh.expected as Row))
          item.freshAcceptanceReceipt = accepted
          item.afterFreshAcceptance = await acceptanceConsistency(observer, f, accepted, fresh.expected as Row, portal)
        } else {
          const checked = await acceptanceConsistency(observer, f, first, expected, portal)
          assert.deepEqual(checked.properties, before.properties); assert.deepEqual(checked.pricing_config_versions, before.pricing_config_versions)
          assert.deepEqual(checked.property_measurements, before.property_measurements); assert.deepEqual(checked.property_measurement_events, before.property_measurement_events)
          assert.deepEqual(checked.quote_services, before.quote_services); assert.equal(checked.quotes[0].notes, before.quotes[0].notes)
          assert.equal(checked.quotes[0].property_id, f.property)
        }
        evidence.push(item)
      })
    }
    for (const dependency of ['quote', 'property', 'settings_insert'] as const) {
      await test(`full Save race: ${dependency} commits first; post-wait recheck refuses stale dependencies`, async () => {
        const f = await transaction(observer, async () => {
          return dependency === 'settings_insert' ? seedQuoteWithoutSettings(observer, 604)
            : seedQuoteIdentity(observer, { quote: 602, property: 603 }[dependency])
        })
        const p = await transaction(observer, () => quoteSavePlan(observer, f, { notes: 'Must not overwrite' }))
        await left.exec('begin isolation level read committed')
        if (dependency === 'quote') await left.query("update public.quotes set internal_notes='Concurrent complete note' where id=$1::uuid", [f.quote])
        if (dependency === 'property') await left.query('update public.properties set lawn_sqft=3333 where id=$1::uuid', [f.property])
        if (dependency === 'settings_insert') await left.query('insert into public.business_settings(user_id) values($1::uuid)', [f.owner])
        await right.exec('begin isolation level read committed'); const waiting = quoteSaveWrite(right, f, p); void waiting.catch(() => undefined)
        barriers.push(await waitBarrier(observer, right.pid, left.pid, 'row'))
        await left.exec('commit'); const before = await allRows(observer, f.owner)
        assert.ok(['stale_editor', 'stale_targets'].includes((await waiting).code)); await right.exec('commit')
        assert.deepEqual(await allRows(observer, f.owner), before)
      })
    }
    for (const dependency of ['settings', 'template', 'service', 'measurement'] as const) {
      await test(`full Save race: unseen ${dependency} INSERT waits on the actual owner/parent FK fence`, async () => {
        const f = await transaction(observer, async () => {
          return dependency === 'settings' ? seedQuoteWithoutSettings(observer, 605)
            : seedQuoteIdentity(observer, { template: 606, service: 607, measurement: 608 }[dependency])
        })
        const p = await transaction(observer, () => quoteSavePlan(observer, f, { notes: 'Saved before unseen dependency' }))
        await left.exec('begin isolation level read committed'); assert.equal((await quoteSaveWrite(left, f, p)).code, 'committed')
        await right.exec('begin isolation level read committed')
        const waiting = dependency === 'settings' ? right.query('insert into public.business_settings(user_id) values($1::uuid) returning user_id', [f.owner])
          : dependency === 'template' ? right.query("insert into public.service_templates(user_id,name,default_rate) values($1::uuid,'New future template',45) returning id", [f.owner])
            : dependency === 'service' ? right.query("insert into public.quote_services(user_id,quote_id,service_type) values($1::uuid,$2::uuid,'Future service') returning id", [f.owner, f.quote])
              : right.query(`insert into public.property_measurements(user_id,property_id,kind,unit,value,shapes,source,confidence,confidence_reason,measured_at)
                values($1::uuid,$2::uuid,'lawn','sqft',3000,'[]','manual','high','Synthetic native schedule',clock_timestamp()) returning id`, [f.owner, f.property])
        void waiting.catch(() => undefined)
        barriers.push(await waitBarrier(observer, right.pid, left.pid, 'row'))
        await left.exec('commit'); const beforeOtherCommit = await allRows(observer, f.owner)
        assert.equal(beforeOtherCommit.quotes[0].notes, 'Saved before unseen dependency')
        assert.equal((await waiting).rows.length, 1); await right.exec('commit')
        barriers[barriers.length - 1].dependency = dependency
        barriers[barriers.length - 1].save_committed_observer = digest(beforeOtherCommit)
      })
    }
    for (const inversion of ['measurement', 'addon'] as const) {
      await test(`full Save inversion: native ${inversion}-first writer and Save abort one entire transaction on deadlock`, async () => {
        const f = await transaction(observer, async () => {
          const seed = await seedQuoteIdentity(observer, inversion === 'measurement' ? 613 : 614, false, 'services')
          await observer.query(`insert into public.property_measurements(user_id,property_id,kind,unit,value,source,confidence,confidence_reason,measured_at)
            values($1::uuid,$2::uuid,'lawn','sqft',1000,'manual','high','Original fictional observation',clock_timestamp())`, [seed.owner, seed.property])
          return seed
        })
        const p = await transaction(observer, () => quoteSavePlan(observer, f, { service_type: 'Lawn Mowing', initial_price: 300,
          measured_sqft: 1800, notes: 'Save winner only', services: [line()] }))
        const before = await allRows(observer, f.owner)
        await left.exec('begin isolation level read committed; set local role authenticated')
        await left.query("select set_config('request.jwt.claim.sub',$1,true)", [f.owner])
        if (inversion === 'measurement') await left.query("select id from public.property_measurements where property_id=$1::uuid and kind='lawn' for update", [f.property])
        else await left.query('select id from public.quote_addons where quote_id=$1::uuid for update', [f.quote])
        await right.exec('begin isolation level read committed')
        const save = quoteSaveWrite(right, f, p); void save.catch(() => undefined)
        const barrier = await waitBarrier(observer, right.pid, left.pid, 'row'); barriers.push(barrier)
        assert.deepEqual(await allRows(observer, f.owner), before)
        // The native mirror/add-on-total trigger now needs the earlier property
        // or quote lock held by Save. This is an observed real lock inversion,
        // not a substituted engine, artificial exception or timer-only race.
        const mutation = inversion === 'measurement'
          ? left.query("update public.property_measurements set value=1300 where property_id=$1::uuid and kind='lawn' returning id", [f.property])
          : left.query('update public.quote_addons set price=19,is_selected=true where quote_id=$1::uuid returning id', [f.quote])
        void mutation.catch(() => undefined)
        const [saveResult, mutationResult] = await Promise.allSettled([save, mutation])
        const failures = [saveResult, mutationResult].filter(result => result.status === 'rejected')
        assert.equal(failures.length, 1, 'Exactly one native deadlock victim is required')
        const failure = failures[0] as PromiseRejectedResult
        assert.ok(failure.reason instanceof SqlStateError); assert.equal(failure.reason.code, '40P01')
        if (saveResult.status === 'fulfilled') {
          assert.equal(saveResult.value.code, 'committed'); await right.exec('commit'); await left.exec('rollback')
        } else {
          assert.equal(mutationResult.status, 'fulfilled'); await left.exec('commit'); await right.exec('rollback')
        }
        const after = await allRows(observer, f.owner)
        if (saveResult.status === 'fulfilled') {
          assert.equal(after.quotes[0].notes, 'Save winner only'); assert.equal(after.quotes[0].initial_price, p.parent_patch.initial_price)
          assert.equal(after.property_measurements[0].value, 1800); assert.equal(after.quote_services.length, 2)
          assert.deepEqual(after.quote_addons, before.quote_addons, 'Deadlock victim add-on DML must disappear')
        } else {
          for (const field of ['notes', 'internal_notes', 'initial_price', 'customer_id', 'property_id', 'price_source', 'pricing_config_version_id']) assert.equal(after.quotes[0][field], before.quotes[0][field], field)
          assert.deepEqual(after.customers, before.customers); assert.deepEqual(after.quote_services, before.quote_services)
          assert.deepEqual(after.pricing_config_versions, before.pricing_config_versions)
          assert.equal(after.property_measurements[0].value, inversion === 'measurement' ? 1300 : 1000)
          assert.equal(after.quote_addons[0].price, inversion === 'addon' ? 19 : before.quote_addons[0].price)
        }
        assert.equal(after.quote_acceptances.length, 0)
        evidence.push({ kind: 'native-writer-lock-inversion-whole-abort', inversion, barrier, before, after,
          winner: saveResult.status === 'fulfilled' ? 'full Save' : 'native owner writer', loserSqlstate: failure.reason.code,
          saveReceipt: saveResult.status === 'fulfilled' ? saveResult.value : null })
      })
    }
  } finally {
    const closed = await Promise.allSettled([left.close(), right.close()])
    if (closed.some(result => result.status === 'rejected')) throw new Error('Native full Save sessions did not confirm exit')
  }
  return { tests, barriers, evidence, sessions: [left.pid, right.pid], allSessionsClosed: true,
    closure: 'both disposable psql child exits awaited', acceptanceSafetyClaim: false }
}
