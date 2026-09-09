// Dormant disposable PostgreSQL proof of the CURRENT handler's partial save.
// Expected residue is evidence of the defect, not candidate acceptance.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import type { Customer, Quote, QuoteFormValues } from '../../src/types'
import { ensureCustomerAndProperty } from '../../src/lib/customers'
import { applyOvergrowth } from '../../src/lib/utils'
import { sumServiceLines } from '../../src/lib/quoteServices'
import { headlineOptionPrice, optionRowsFor } from '../../src/lib/quoteOptions'
import { depositRuleFromForm } from '../../src/lib/payments/depositGate'
import { ensureCurrentPricingConfigVersion } from '../../src/lib/pricingConfig'
import { servicePricingKind } from '../../src/lib/servicePricing'
import { saveManual } from '../../src/lib/measure/data'
import { DisposableSession, type Database, type TestResult } from './database'
import { baselineOwnerSnapshot, baselineSqlSupabase, type BaselineRequest, type BaselineRow } from './quote-identity-db'

type Snapshot = Record<string, BaselineRow[]>
type CaseKind = 'manual-new' | 'confident-enrichment' | 'selected-existing'
type Fixture = { owner: string; customerA: string; customerB: string; propertyA: string; quote: string; kind: CaseKind; index: number }
export const quoteIdentityBaselineEvidence: Record<string, unknown>[] = []

// Extract only the actual AST node inside the actual page component. All business
// helpers below are real imports. Only closure data, auth/SQL transport and UI
// callbacks are fixture-provided; neither resolution nor save branches are copied.
function actualHandleUpdate() {
  const path = resolve(__dirname, '../../src/app/dashboard/quotes/[id]/page.tsx')
  const source = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const page = file.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'QuoteDetailPage')
  assert.ok(page?.body, 'Actual QuoteDetailPage AST node is required')
  const handlers = page.body.statements.filter((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'handleUpdate')
  assert.equal(handlers.length, 1, 'Exactly one actual handleUpdate AST node is required')
  const handler = handlers[0].getText(file)
  const transpiled = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true })
  assert.equal(transpiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
  return {
    javascript: transpiled.outputText,
    source: { path: 'src/app/dashboard/quotes/[id]/page.tsx',
      pageSha256: createHash('sha256').update(source).digest('hex'),
      handlerSha256: createHash('sha256').update(handler).digest('hex'),
      startLine: file.getLineAndCharacterOfPosition(handlers[0].getStart(file)).line + 1,
      endLine: file.getLineAndCharacterOfPosition(handlers[0].getEnd()).line + 1 },
  }
}

function invokeActualHandler(db: Database, fixture: Fixture, quote: Quote, customers: Customer[], values: QuoteFormValues, trace: BaselineRequest[]) {
  const extracted = actualHandleUpdate()
  const ui: { errors: string[]; callbacks: string[] } = { errors: [], callbacks: [] }
  const bindings = {
    supabase: baselineSqlSupabase(db, fixture.owner, trace), quote, customers, id: fixture.quote, templates: [],
    ensureCustomerAndProperty, applyOvergrowth, sumServiceLines, headlineOptionPrice, optionRowsFor,
    depositRuleFromForm, ensureCurrentPricingConfigVersion, servicePricingKind, saveManual,
    toast: { error: (message: string) => ui.errors.push(message), undo: () => ui.callbacks.push('toast.undo') },
    setQuote: () => ui.callbacks.push('setQuote'), setEditing: () => ui.callbacks.push('setEditing'),
    setOptions: () => ui.callbacks.push('setOptions'), setServices: () => ui.callbacks.push('setServices'),
  }
  const handler = new Function(...Object.keys(bindings), extracted.javascript + '\nreturn handleUpdate;')(...Object.values(bindings)) as (input: QuoteFormValues) => Promise<boolean>
  return { run: () => handler(values), ui, source: extracted.source }
}

const fixtureFor = (index: number, kind: CaseKind): Fixture => {
  const id = (prefix: number) => `${prefix}000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  return { owner: id(31), customerA: id(32), customerB: id(33), propertyA: id(34), quote: id(35), kind, index }
}
const customerNameA = (f: Fixture) => `Fictional Retained Customer A ${f.index}`
const customerNameB = (f: Fixture) => `Fictional Reassignment Customer B ${f.index}`
const addressA = (f: Fixture) => `${100 + f.index} Imaginary Baseline Lane`
const addressB = (f: Fixture) => `${200 + f.index} Imaginary Baseline Ridge`

async function seedRetainedFixture(db: Database, f: Fixture) {
  // Provisioning is committed before the handler starts. No trigger, policy,
  // constraint, provider registration or capability switch is changed.
  await db.exec('begin')
  try {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1::uuid,$2,now())',
      [f.owner, `identity-baseline-owner-${f.index}@business.example.invalid`])
    await db.exec("set local role service_role; select set_config('request.jwt.claim.sub','',true); select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)")
    await db.query(`insert into public.business_settings(user_id,company_name,owner_name,email_primary,business_type,timezone,terms_text)
      values($1::uuid,$2,$3,$4,'general','America/Edmonton',null)`,
    [f.owner, `Fictional Identity Baseline ${f.index}`, 'Fictional Owner', `identity-baseline-owner-${f.index}@business.example.invalid`])
    await db.query(`insert into public.customers(id,user_id,name,email,address,email_opt_in,sms_opt_in,message_prefs,preferred_channel)
      values($1::uuid,$2::uuid,$3,$4,$5,true,false,'{"estimates":true}'::jsonb,'email')`,
    [f.customerA, f.owner, customerNameA(f), `identity-baseline-a-${f.index}@customer.example.invalid`, addressA(f)])
    await db.query(`insert into public.customers(id,user_id,name,address,phone,email,acquisition_source)
      values($1::uuid,$2::uuid,$3,$4,null,null,null)`, [f.customerB, f.owner, customerNameB(f), addressB(f)])
    await db.query(`insert into public.properties(id,user_id,customer_id,address,is_primary)
      values($1::uuid,$2::uuid,$3::uuid,$4,true)`, [f.propertyA, f.owner, f.customerA, addressA(f)])
    await db.query(`insert into public.quotes(id,user_id,customer_id,property_id,quote_number,customer_name,address,service_type,
      initial_price,travel_fee,hours,crew_size,rate,overgrowth_multiplier,status,sent_at,issued_date,valid_until)
      values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,'General service visit',100,0,1,1,100,1,'sent',
      now()-interval '7 days',current_date-7,current_date+30)`,
    [f.quote, f.owner, f.customerA, f.propertyA, `IDENTITY-BASELINE-${f.index}`, customerNameA(f), addressA(f)])
    const rpc = async (sql: string, params: unknown[]) => {
      const value = (await db.query<{ value: BaselineRow }>(sql, params)).rows[0].value
      assert.equal(typeof value.code, 'string'); return value
    }
    const created = await rpc('select public.pilot_email_create_connection($1::uuid,$2,$3,$4,$5,$6) as value',
      [f.owner, `synthetic-identity-baseline-${f.index}`, `quotes@identity-baseline-${f.index}.example.invalid`,
        `reply.identity-baseline-${f.index}.example.invalid`, `PILOT_IDENTITY_BASELINE_${f.index}`, 'version-1'])
    assert.equal(created.code, 'created')
    await rpc('select public.pilot_email_set_connection_state($1::uuid,$2) as value', [created.connection_id, 'verified'])
    await rpc('select public.pilot_email_set_connection_state($1::uuid,$2) as value', [created.connection_id, 'active'])
    const due = (await db.query<{ value: string }>("select (clock_timestamp()-interval '1 second')::text as value")).rows[0].value
    const approved = await rpc('select public.pilot_email_approve_workflow($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::uuid) as value',
      [created.connection_id, f.customerA, f.quote, JSON.stringify([{ subject: 'Your fictional requested estimate',
        text: 'Please review this fictional disposable-test estimate.', due_at: due }]), f.owner])
    assert.equal(approved.code, 'approved'); assert.equal(typeof approved.workflow_id, 'string')
    await db.exec('commit')
    return { connectionId: created.connection_id, workflowId: approved.workflow_id }
  } catch (error) { await db.exec('rollback'); throw error }
}

function formValues(f: Fixture, q: Quote): QuoteFormValues {
  return {
    customer_id: f.kind === 'selected-existing' ? f.customerB : '__manual',
    customer_name: f.kind === 'manual-new' ? `Fictional Newly Prepared Customer ${f.index}` : customerNameB(f),
    address: f.kind === 'manual-new' ? `${300 + f.index} Imaginary Baseline Crescent` : addressB(f),
    customer_phone: `780-555-01${40 + f.index}`,
    customer_email: `identity-baseline-new-${f.index}@customer.example.invalid`,
    acquisition_source: 'Referral', service_type: q.service_type, service_template_id: '',
    initial_price: Number(q.initial_price), weekly_price: 0, biweekly_price: 0, monthly_price: 0,
    overgrowth_multiplier: 1, hours: 1, crew_size: 1, rate: 100, travel_fee: 0, distance_km: 0, status: q.status,
    custom_travel_required: false, show_travel_separately: false, notes: '', internal_notes: '',
    measured_sqft: 0, measurement_snapshot: null, suggested_price: 0, value_grade: null, nearby_count: null,
    has_options: false, options: [], services: [], deposit_type: '', deposit_value: 0,
  }
}

const addedRows = (before: BaselineRow[], after: BaselineRow[]) => after.filter(row => !before.some(prior => prior.id === row.id))
const withoutUpdatedAt = (row: BaselineRow) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'updated_at'))

function assertResidue(f: Fixture, before: Snapshot, after: Snapshot, trace: BaselineRequest[], values: QuoteFormValues) {
  const customerAdds = addedRows(before.customers, after.customers)
  const propertyAdds = addedRows(before.properties, after.properties)
  assert.equal(customerAdds.length, f.kind === 'manual-new' ? 1 : 0)
  assert.equal(propertyAdds.length, 1)
  const target = f.kind === 'manual-new' ? customerAdds[0] : after.customers.find(c => c.id === f.customerB)!
  assert.ok(target); assert.equal(target.user_id, f.owner)
  assert.notEqual(target.id, f.customerA)
  assert.deepEqual<BaselineRow>(propertyAdds[0], { ...propertyAdds[0], user_id: f.owner, customer_id: target.id,
    address: values.address, is_primary: true })
  for (const property of before.properties) assert.deepEqual(after.properties.find(p => p.id === property.id), property)
  for (const customer of before.customers) {
    const current = after.customers.find(c => c.id === customer.id)!
    if (f.kind === 'confident-enrichment' && customer.id === f.customerB) {
      assert.deepEqual(withoutUpdatedAt(current), { ...withoutUpdatedAt(customer), phone: values.customer_phone,
        email: values.customer_email, acquisition_source: 'Referral' })
      assert.notEqual(current.updated_at, customer.updated_at)
    } else assert.deepEqual(current, customer)
  }
  if (f.kind === 'manual-new') {
    assert.equal(target.name, values.customer_name); assert.equal(target.address, values.address)
    assert.equal(target.phone, values.customer_phone); assert.equal(target.email, values.customer_email)
    assert.equal(target.acquisition_source, 'Referral')
    const inserted = trace.find(r => r.table === 'customers' && r.operation === 'insert')!
    assert.deepEqual(inserted.rows, [target], 'The real committed customer INSERT result remains visible to another backend')
  }
  const finalRequest = trace.at(-1)!
  assert.equal(finalRequest.payload!.customer_id, target.id)
  assert.equal(finalRequest.payload!.property_id, propertyAdds[0].id)
  assert.equal(finalRequest.payload!.customer_name, target.name)
  for (const table of ['quotes', 'pilot_email_connections', 'pilot_quote_followup_workflows', 'pilot_email_send_attempts', 'webhook_deliveries']) {
    assert.deepEqual(after[table], before[table], 'Refused request must preserve whole ' + table + ' rows')
  }
  for (const table of ['audit_events', 'integration_events']) {
    for (const row of before[table]) assert.deepEqual(after[table].find(r => r.id === row.id), row)
  }
  const audits = addedRows(before.audit_events, after.audit_events)
  const integrations = addedRows(before.integration_events, after.integration_events)
  assert.equal(audits.length, f.kind === 'selected-existing' ? 0 : 1)
  if (audits.length) {
    assert.equal(audits[0].entity_id, target.id)
    assert.equal(audits[0].action, f.kind === 'manual-new' ? 'customer_added' : 'customer_contact_updated')
    assert.equal(audits[0].actor_type, 'owner'); assert.equal(audits[0].actor_id, f.owner)
    assert.equal(String(audits[0].txid), trace[0].transaction, 'Committed native audit identifies the preparatory request transaction')
  }
  // Native capture_integration_event is gated on an active webhook/API key.
  // These synthetic owners have neither; do not activate one to manufacture work.
  assert.equal(integrations.length, 0)
}

export async function runQuoteIdentityBaseline(db: Database): Promise<TestResult[]> {
  const results: TestResult[] = []
  quoteIdentityBaselineEvidence.length = 0
  for (const [offset, kind] of (['manual-new', 'confident-enrichment', 'selected-existing'] as const).entries()) {
    const f = fixtureFor(offset + 1, kind)
    let writer: DisposableSession | undefined, observer: DisposableSession | undefined
    const evidence: Record<string, unknown> = { kind, owner: f.owner, quoteId: f.quote, expectedDefect: 'committed preparation survives retained-quote FK refusal' }
    quoteIdentityBaselineEvidence.push(evidence)
    try {
      const retained = await seedRetainedFixture(db, f)
      writer = await DisposableSession.open('identity-baseline-writer-' + f.index)
      observer = await DisposableSession.open('identity-baseline-observer-' + f.index)
      assert.notEqual(writer.pid, observer.pid)
      const before = await baselineOwnerSnapshot(observer, f.owner)
      assert.equal(before.quotes.length, 1); assert.equal(before.customers.length, 2); assert.equal(before.properties.length, 1)
      assert.equal(before.pilot_quote_followup_workflows.length, 1); assert.equal(before.pilot_email_send_attempts.length, 1)
      assert.equal(before.pilot_quote_followup_workflows[0].id, retained.workflowId)
      const q = before.quotes[0] as unknown as Quote
      assert.equal(q.initial_price, 100); assert.equal(q.selected_option_id, null)
      const values = formValues(f, q), trace: BaselineRequest[] = []
      const invocation = invokeActualHandler(writer, f, q, before.customers as unknown as Customer[], values, trace)
      Object.assign(evidence, { source: invocation.source, writerPid: writer.pid, observerPid: observer.pid, retained, before, trace })
      const outcome = await invocation.run()
      const after = await baselineOwnerSnapshot(observer, f.owner)
      Object.assign(evidence, { outcome, ui: invocation.ui, after })
      assert.equal(outcome, false)
      assert.deepEqual(invocation.ui.callbacks, [], 'False save must not close the editor or update successful-save state')
      assert.equal(invocation.ui.errors.length, 1); assert.match(invocation.ui.errors[0], /^Could not update quote: PostgreSQL 23503:/)
      const expectedOperations = kind === 'manual-new' ? ['customers.insert', 'properties.select', 'properties.insert', 'quotes.update']
        : kind === 'confident-enrichment' ? ['customers.update', 'properties.select', 'properties.insert', 'quotes.update']
          : ['properties.select', 'properties.insert', 'quotes.update']
      assert.deepEqual(trace.map(r => r.table + '.' + r.operation), expectedOperations)
      assert.equal(new Set(trace.map(r => r.transaction)).size, trace.length, 'Each REST-equivalent request must use a distinct native transaction')
      assert.ok(trace.every(r => r.backend === writer!.pid && r.role === 'authenticated' && r.owner === f.owner))
      assert.ok(trace.slice(0, -1).every(r => r.outcome === 'committed'))
      const failure = trace.at(-1)!
      assert.equal(failure.outcome, 'rolled_back'); assert.equal(failure.sqlstate, '23503')
      assert.match(failure.detail!, /pilot_quote_followup_workflows/)
      assertResidue(f, before, after, trace, values)
      results.push({ name: `baseline actual handler: ${kind} leaves committed preparation after native retained FK refusal`, pass: true })
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1600) : 'Baseline assertion failed'
      evidence.error = message
      results.push({ name: `baseline actual handler: ${kind} leaves committed preparation after native retained FK refusal`, pass: false, error: message })
    } finally {
      const sessions = [writer, observer].filter((session): session is DisposableSession => !!session)
      const closure = await Promise.allSettled(sessions.map(session => session.close()))
      evidence.sessionsClosed = closure.every(result => result.status === 'fulfilled')
      if (closure.some(result => result.status === 'rejected')) {
        results.push({ name: `baseline ${kind}: disposable session cleanup`, pass: false, error: 'A disposable psql session did not confirm exit' })
      }
    }
  }
  return results
}
