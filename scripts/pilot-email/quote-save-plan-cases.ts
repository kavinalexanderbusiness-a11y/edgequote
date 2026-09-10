import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Customer, Quote, QuoteFormValues, QuoteServiceInput } from '../../src/types'
import { ensureCustomerAndProperty } from '../../src/lib/customers'
import { applyOvergrowth } from '../../src/lib/utils'
import { sumServiceLines } from '../../src/lib/quoteServices'
import { headlineOptionPrice, optionRowsFor } from '../../src/lib/quoteOptions'
import { depositRuleFromForm } from '../../src/lib/payments/depositGate'
import { ensureCurrentPricingConfigVersion } from '../../src/lib/pricingConfig'
import { servicePricingKind } from '../../src/lib/servicePricing'
import { saveManual } from '../../src/lib/measure/data'
import {
  buildPilotQuoteSavePlan, parsePilotQuoteSaveIntent, PilotQuoteSavePlanError,
  PILOT_QUOTE_SAVE_REQUEST_BYTES, PILOT_QUOTE_SAVE_INTERNAL_BYTES,
  type PilotQuoteSaveEditorSnapshot, type PilotQuoteSaveIntent, type PilotQuoteSavePlan,
  type PilotQuoteSaveTargetRequest, type PilotQuoteSaveTargetSnapshot,
} from '../../src/lib/quotes/pilotQuoteSavePlan'
import type { TestResult } from './database'

type Row = Record<string, unknown>
const uuid = (n: number) => `81000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const owner = uuid(1), customer = uuid(2), property = uuid(3), quoteId = uuid(4), configId = uuid(5)
const instant = '2026-09-10T12:00:00.000Z'
const clone = <T>(value: T): T => structuredClone(value)
const frozenSnapshot = {
  v: 2 as const, type: 'area' as const, unit: 'sqft' as const, value: 1200,
  parts: [{ label: 'Original lawn', value: 1200, ring: [{ lat: 51.1, lng: -114.1 }, { lat: 51.101, lng: -114.1 }, { lat: 51.1, lng: -114.101 }] }],
  measuredAt: instant, serviceTemplateId: null, serviceName: 'Original scope', term: 'one_time' as const, basis: 'flat' as const, rate: 100, price: 100,
}
export const quoteSavePlanEvidence: Row[] = []

function fixture(): PilotQuoteSaveEditorSnapshot {
  const c = { id: customer, user_id: owner, updated_at: instant, archived_at: null, name: 'Current customer label', phone: null, email: null, address: '100 Old Street', acquisition_source: null }
  const p = { id: property, user_id: owner, customer_id: customer, updated_at: instant, address: '101 Corrected Street', is_primary: true }
  const identityQuote = { id: quoteId, user_id: owner, updated_at: instant, customer_id: customer, customer_name: 'Old customer label', property_id: property, address: '100 Old Street' }
  return {
    code: 'snapshot', complete: true, editor_revision: 'a'.repeat(32),
    identity: { code: 'snapshot', complete: true, quote_revision: 'b'.repeat(32), quote: identityQuote, customers: [clone(c)], old_customer: clone(c), properties: [p] },
    quote: { xmin: '10', row: { ...identityQuote, initial_price: 100, weekly_price: null, biweekly_price: null, monthly_price: null,
      selected_option_id: null, value_grade: 'B', nearby_count: 3, status: 'sent', measurement_snapshot: frozenSnapshot,
      service_type: 'General service visit', service_template_id: null, travel_fee: 0, hours: 1, crew_size: 1, rate: 100,
      notes: '', internal_notes: '', deposit_type: null, deposit_value: null, measured_sqft: null, suggested_price: null,
      price_source: 'engine', pricing_config_version_id: configId, quote_number: 'SYNTHETIC-PLAN', accepted_price: null, sent_at: instant } },
    services: [], options: [], addons: [], templates: [],
    acceptance: { latest: null, current: false, material_fingerprint: 'c'.repeat(32), terms_fingerprint: 'd'.repeat(32) },
    pricing_inputs: { xmin: '11', row: { user_id: owner, pricing_base_charge: 45, pricing_mow_rate: 2, pricing_recommended_mult: 1.1,
      pricing_premium_mult: 1.2, pricing_travel_rate: 1, crew_cost_per_hour: 30, fee_recovery_percent: 0, payment_fee_strategy: 'absorb' } },
  }
}

/** Synthetic plain-quote form fixture for native cases too. It is NOT the
 * production edit initializer: nonempty line/option cases supply their own
 * explicit fixture values, so no hidden split/default engine is introduced. */
export function quoteSaveIntentFixture(snapshot: PilotQuoteSaveEditorSnapshot, changes: Partial<QuoteFormValues> = {}): PilotQuoteSaveIntent {
  const q = snapshot.quote.row
  const values: QuoteFormValues = {
    customer_id: String(q.customer_id ?? '__manual'), customer_name: String(q.customer_name), address: String(q.address),
    service_type: String(q.service_type), service_template_id: String(q.service_template_id ?? ''),
    initial_price: Number(q.initial_price) || 0, weekly_price: Number(q.weekly_price) || 0,
    biweekly_price: Number(q.biweekly_price) || 0, monthly_price: Number(q.monthly_price) || 0,
    overgrowth_multiplier: 1, hours: Number(q.hours) || 1, crew_size: Number(q.crew_size) || 1,
    rate: Number(q.rate) || 0, travel_fee: Number(q.travel_fee) || 0, distance_km: 0,
    notes: String(q.notes ?? ''), internal_notes: String(q.internal_notes ?? ''),
    custom_travel_required: false, show_travel_separately: false, status: q.status as QuoteFormValues['status'],
    measured_sqft: Number(q.measured_sqft) || 0, measurement_snapshot: clone(q.measurement_snapshot) as QuoteFormValues['measurement_snapshot'],
    suggested_price: Number(q.suggested_price) || 0, value_grade: null, nearby_count: null,
    has_options: false, options: [], services: [], deposit_type: (q.deposit_type ?? '') as QuoteFormValues['deposit_type'],
    deposit_value: Number(q.deposit_value) || 0, ...changes,
  }
  return { version: 1, quoteId: String(q.id), expectedEditorRevision: snapshot.editor_revision,
    clientOperationId: uuid(6), editorGeneration: 'fixture-generation-1', values }
}

function targetFixture(s: PilotQuoteSaveEditorSnapshot, selection: PilotQuoteSaveTargetRequest, lawn = 1000): PilotQuoteSaveTargetSnapshot {
  const r = selection.identity.resolved
  const c = s.identity.customers.find(row => row.id === r.customer_id) ?? s.identity.old_customer
  const p = s.identity.properties.find(row => row.id === r.property_id)
  return { code: 'targets', complete: true, editor_revision: s.editor_revision, target_revision: 'e'.repeat(32),
    customer: selection.identity.customer_insert || !r.customer_id ? null : { row: clone(c!), xmin: '12' },
    property: selection.identity.property_insert || !r.property_id ? null : { row: { ...clone(p!), lawn_sqft: lawn }, xmin: '13' },
    lawn: null, templates: s.templates.filter(t => selection.template_ids.includes(String(t.row.id))).map(clone), pricing_inputs: clone(s.pricing_inputs) }
}

function actualHandler() {
  const path = resolve(__dirname, '../../src/app/dashboard/quotes/[id]/page.tsx')
  const source = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const page = file.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'QuoteDetailPage')
  assert.ok(page?.body)
  const nodes = page.body.statements.filter((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'handleUpdate')
  assert.equal(nodes.length, 1)
  const node = nodes[0].getText(file)
  const js = ts.transpileModule(node, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true })
  assert.equal(js.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
  return { js: js.outputText, pins: { path: 'src/app/dashboard/quotes/[id]/page.tsx',
    pageSha256: createHash('sha256').update(source).digest('hex'), handlerSha256: createHash('sha256').update(node).digest('hex') } }
}

interface Write { table: string; operation: string; payload: unknown }
function recorder(s: PilotQuoteSaveEditorSnapshot, plan: PilotQuoteSavePlan) {
  const writes: Write[] = [], rpcs: Row[] = [], reads: Row[] = []
  const q = s.quote.row, ownerId = s.identity.quote.user_id
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: ownerId } }, error: null }) },
    async rpc(name: string, args: Row) {
      assert.equal(name, 'ensure_pricing_config_version'); assert.deepEqual(args, { p_user: ownerId })
      rpcs.push({ name, args }); return { data: configId, error: null }
    },
    from(table: string) {
      assert.ok(['quotes','customers','properties','quote_options','quote_services','property_measurements','pricing_config_versions'].includes(table))
      let operation = 'select', payload: unknown = null, fields: string | undefined, executed = false
      const filters: Array<[string, unknown]> = []
      const run = async (single: boolean) => {
        assert.equal(executed, false); executed = true
        const response = (data: unknown) => ({ data, error: null })
        if (operation !== 'select') writes.push({ table, operation, payload: clone(payload) })
        else reads.push({ table, fields, filters: clone(filters) })
        if (table === 'quotes') {
          assert.equal(operation, 'update'); assert.equal(fields, '*'); assert.equal(single, true); assert.deepEqual(filters, [['id', q.id]])
          return response({ ...q, ...payload as Row })
        }
        if (table === 'pricing_config_versions') {
          assert.equal(operation, 'select'); assert.equal(fields, '*'); assert.deepEqual(filters, [['id', configId]]); assert.equal(single, true)
          return response({ id: configId, engine_version: 'v1', source: 'recorded', base_charge: 45, mow_rate_per_1000: 2,
            budget_mult: 1, market_mult: 1, recommended_mult: 1.1, premium_mult: 1.2, travel_rate_per_km: 1,
            crew_cost_per_hour: 30, fee_recovery_percent: 0, payment_fee_strategy: 'absorb' })
        }
        if (table === 'quote_options' || table === 'quote_services') {
          if (operation === 'delete') { assert.equal(fields, undefined); assert.deepEqual(filters, [['quote_id', q.id]]); return response(null) }
          assert.equal(operation, 'insert'); assert.equal(fields, '*'); assert.deepEqual(filters, []); assert.ok(Array.isArray(payload)); assert.equal(single, false)
          return response(payload.map((r, i) => ({ ...r, id: uuid(100 + i) })))
        }
        if (table === 'property_measurements') {
          assert.equal(operation, 'upsert'); assert.equal(single, true); assert.deepEqual(filters, [])
          assert.equal(fields, 'id, created_at, updated_at, user_id, property_id, kind, unit, value, shapes, source, confidence, confidence_reason, needs_review, notes, measured_at')
          return response({ ...payload as Row, id: uuid(110), created_at: instant, updated_at: instant })
        }
        if (table === 'customers') {
          if (operation === 'update') { assert.equal(fields, undefined); assert.equal(single, false); assert.deepEqual(filters, [['id', plan.identity.resolved.customer_id]]); return response(null) }
          assert.equal(operation, 'insert'); assert.equal(fields, '*'); assert.equal(single, true); assert.deepEqual(filters, []); assert.ok(plan.identity.customer_insert)
          return response({ ...payload as Row, id: plan.identity.customer_insert.id })
        }
        if (operation === 'select' && fields === 'id, address, is_primary') {
          assert.equal(single, false); assert.deepEqual(filters, [['customer_id', plan.identity.resolved.customer_id]])
          return response(s.identity.properties.filter(p => p.customer_id === filters[0][1]).map(p => ({ id: p.id, address: p.address, is_primary: p.is_primary })))
        }
        if (operation === 'select') {
          assert.equal(fields, 'lawn_sqft'); assert.equal(single, true); assert.deepEqual(filters, [['id', plan.identity.resolved.property_id]])
          return response({ lawn_sqft: plan.expected.targets.property?.row.lawn_sqft ?? null })
        }
        assert.equal(operation, 'insert'); assert.equal(fields, 'id'); assert.equal(single, true); assert.deepEqual(filters, []); assert.ok(plan.identity.property_insert)
        return response({ id: plan.identity.property_insert.id })
      }
      const mutate = (next: string, value: unknown) => { assert.equal(operation, 'select'); assert.equal(fields, undefined); operation = next; payload = clone(value); return builder }
      const builder = {
        insert(value: unknown) { return mutate('insert', value) }, update(value: unknown) { return mutate('update', value) },
        delete() { return mutate('delete', null) },
        upsert(value: unknown, opts: Row) { assert.deepEqual(opts, { onConflict: 'property_id,kind' }); return mutate('upsert', value) },
        select(value = '*') { assert.equal(fields, undefined); fields = value; return builder },
        eq(key: string, value: unknown) { filters.push([key, value]); return builder },
        single() { return run(true) }, maybeSingle() { return run(true) },
        then(onResolve: (value: unknown) => unknown, onReject: (reason: unknown) => unknown) { return run(false).then(onResolve, onReject) },
      }
      return builder
    },
  }
  return { client: client as unknown as SupabaseClient, writes, reads, rpcs }
}

async function parity(s: PilotQuoteSaveEditorSnapshot, intent: PilotQuoteSaveIntent, lawn = 1000) {
  // Test-only clock scope makes the actual saveManual timestamp identical in
  // both invocations. There is no runtime clock/AST override in the planner.
  const RealDate = Date
  class FixedDate extends RealDate { constructor(value?: string | number) { super(value ?? instant) } static now() { return RealDate.parse(instant) } }
  globalThis.Date = FixedDate as DateConstructor
  try {
    let targetCalls = 0
    const originalSnapshot = clone(s), originalIntent = clone(intent)
    const plan = await buildPilotQuoteSavePlan(s, intent, async selection => { targetCalls++; return targetFixture(s, selection, lawn) })
    assert.equal(targetCalls, 1)
    assert.deepEqual(s, originalSnapshot); assert.deepEqual(intent, originalIntent)
    const recorded = recorder(s, plan), extracted = actualHandler(), ui: string[] = []
    const bindings = { supabase: recorded.client, quote: clone(s.quote.row) as unknown as Quote,
      customers: clone(s.identity.customers) as unknown as Customer[], id: intent.quoteId,
      templates: s.templates.map(t => t.row), ensureCustomerAndProperty, applyOvergrowth, sumServiceLines, headlineOptionPrice,
      optionRowsFor, depositRuleFromForm, ensureCurrentPricingConfigVersion, servicePricingKind, saveManual,
      toast: { error: (message: string) => ui.push('error:' + message), undo: () => ui.push('undo') },
      setQuote: () => ui.push('quote'), setEditing: () => ui.push('editing'), setOptions: () => ui.push('options'), setServices: () => ui.push('services') }
    // Actual saved source AST plus actual canonical imports. The fixture
    // supplies only transport, source closure rows, clock and UI callbacks.
    const invoke = new Function(...Object.keys(bindings), extracted.js + '\nreturn handleUpdate;')(...Object.values(bindings)) as (v: QuoteFormValues) => Promise<boolean>
    assert.equal(await invoke(clone(intent.values)), true)
    assert.ok(!ui.some(message => message.startsWith('error:')))
    const parent = recorded.writes.filter(w => w.table === 'quotes')
    assert.equal(parent.length, 1)
    const expectedParent = { ...plan.parent_patch, ...(plan.provenance.mode === 'ensure_current' ? { price_source: 'engine', pricing_config_version_id: configId } : {}) }
    assert.deepEqual(parent[0].payload, expectedParent, 'Every actual parent field, including omissions, matches the private plan')
    assert.equal(recorded.rpcs.length, plan.provenance.mode === 'ensure_current' ? 1 : 0)
    for (const [table, rows] of [['quote_options', plan.options.rows], ['quote_services', plan.services]] as const) {
      const deleted = recorded.writes.filter(w => w.table === table && w.operation === 'delete')
      const inserted = recorded.writes.filter(w => w.table === table && w.operation === 'insert')
      assert.equal(deleted.length, table === 'quote_options' && plan.options.mode === 'preserve' ? 0 : 1)
      assert.equal(inserted.length, rows.length ? 1 : 0)
      if (rows.length) assert.deepEqual(inserted[0].payload, rows, 'Every child payload field and row order matches actual handler: ' + table)
    }
    const measurements = recorded.writes.filter(w => w.table === 'property_measurements')
    assert.equal(measurements.length, plan.measurement ? 1 : 0)
    if (plan.measurement) assert.deepEqual(measurements[0].payload, plan.measurement.payload, 'Actual manual unit, metadata, empty shapes and timestamp match')
    for (const [table, operation, payload] of [
      ['customers','insert',plan.identity.customer_insert], ['customers','update',plan.identity.customer_patch], ['properties','insert',plan.identity.property_insert],
    ] as const) {
      const actual = recorded.writes.filter(w => w.table === table && w.operation === operation)
      assert.equal(actual.length, payload ? 1 : 0)
      if (payload) { const expected = { ...payload }; if (operation === 'insert') delete expected.id; assert.deepEqual(actual[0].payload, expected) }
    }
    assert.equal(Object.hasOwn(plan.parent_patch, 'status'), false)
    assert.equal(Object.hasOwn(plan.parent_patch, 'pricing_config_version_id'), false)
    quoteSavePlanEvidence.push({ kind: 'actual-handler-recording-parity', source: extracted.pins,
      parentKeys: Object.keys(plan.parent_patch).sort(), optionMode: plan.options.mode, optionCount: plan.options.rows.length,
      serviceCount: plan.services.length, provenanceMode: plan.provenance.mode, measurementPlanned: !!plan.measurement,
      identityWrites: recorded.writes.filter(w => ['customers','properties'].includes(w.table)).length,
      nativeDatabaseCalls: 0, liveProviderCalls: 0 })
    return plan
  } finally { globalThis.Date = RealDate }
}

export async function runQuoteSavePlanCases(): Promise<TestResult[]> {
  const results: TestResult[] = []
  quoteSavePlanEvidence.length = 0
  const test = async (name: string, work: () => Promise<void> | void) => {
    try { await work(); results.push({ name, pass: true }) }
    catch (error) { results.push({ name, pass: false, error: error instanceof Error ? error.message.slice(0, 1800) : 'Save plan case failed' }) }
  }
  const service = (patch: Partial<QuoteServiceInput> = {}): QuoteServiceInput => ({ service_type: 'Second service', service_template_id: '', quantity: 2.5,
    unit: 'custom_unit', unit_price: 37.17, est_minutes: 10.6, discount_type: 'percent', discount_value: 7.5, notes: '  Public line note  ', kind: 'service', ...patch })
  const alternatives = [{ name: ' Included ', description: ' No extra ', price: 0, is_recommended: false },
    { name: 'Complete', description: '   ', price: 250.35, is_recommended: true }]
  await test('Save plan matches actual unchanged-price handler and preserves frozen snapshot and separate notes', async () => {
    const s = fixture(), plan = await parity(s, quoteSaveIntentFixture(s, { notes: 'Customer scope', internal_notes: 'Private cost floor' }))
    assert.equal(plan.provenance.mode, 'preserve')
    assert.deepEqual(plan.parent_patch.measurement_snapshot, frozenSnapshot)
    assert.equal(plan.parent_patch.customer_name, 'Current customer label')
    assert.equal(plan.identity.property_insert, null)
    for (const key of ['price_source','pricing_config_version_id','value_grade','nearby_count']) assert.equal(Object.hasOwn(plan.parent_patch, key), false)
  })
  await test('Save plan matches changed four-price provenance, multiplier and carried/fallback grades', async () => {
    for (const patch of [{ initial_price: 123.45 }, { weekly_price: 50 }, { biweekly_price: 75 }, { monthly_price: 95 },
      { initial_price: 150, value_grade: 'A+', nearby_count: 9, overgrowth_multiplier: 1.75, rate: 83.7 }]) {
      const s = fixture(), plan = await parity(s, quoteSaveIntentFixture(s, patch))
      assert.equal(plan.provenance.mode, 'ensure_current'); assert.equal(plan.parent_patch.value_grade, patch.value_grade ?? 'B')
    }
  })
  await test('Save plan matches discounted services/materials, primary omissions and blank-line filtering', async () => {
    const s = fixture()
    await parity(s, quoteSaveIntentFixture(s, { hours: 1.125, services: [service(), service({ service_type: ' Material ', kind: 'material', quantity: 0,
      unit: '', unit_price: 99.99, est_minutes: 0, discount_type: 'amount', discount_value: 5, notes: '' }), service({ service_type: '   ' })] }))
  })
  await test('Save plan uses declared alternatives and preserves hidden off-switch rows', async () => {
    const s = fixture()
    await parity(s, quoteSaveIntentFixture(s, { has_options: true, options: alternatives }))
    const off = await parity(s, quoteSaveIntentFixture(s, { has_options: false, options: alternatives }))
    assert.deepEqual(off.options, { mode: 'replace', rows: [] }); assert.equal(off.parent_patch.initial_price, 100)
  })
  await test('Save plan preserves selected-option rows/price despite hidden altered form alternatives', async () => {
    const s = fixture(); s.quote.row.selected_option_id = uuid(20); s.quote.row.initial_price = 250
    s.options = alternatives.map((o, i) => ({ xmin: String(30 + i), row: { ...o, id: uuid(20 + i), user_id: owner, quote_id: quoteId, sort_order: i } }))
    const plan = await parity(s, quoteSaveIntentFixture(s, { initial_price: 999, has_options: false, options: alternatives }))
    assert.equal(plan.options.mode, 'preserve'); assert.equal(plan.parent_patch.initial_price, 250)
    assert.deepEqual(plan.expected.editor.options, s.options)
  })
  await test('Save plan matches all deposit modes and legal unpriced/weekly-only mapping', async () => {
    for (const patch of [{ deposit_type: '' as const, deposit_value: 0 }, { deposit_type: 'percent' as const, deposit_value: 50 },
      { deposit_type: 'fixed' as const, deposit_value: 30.125 }, { initial_price: 0, weekly_price: 60 }]) {
      const s = fixture(); await parity(s, quoteSaveIntentFixture(s, patch))
    }
  })
  await test('Save plan runs actual identity resolver for manual creation and contact enrichment', async () => {
    const s = fixture()
    const created = await parity(s, quoteSaveIntentFixture(s, { customer_id: '__manual', customer_name: 'New synthetic customer', address: '300 Fictional Avenue', customer_phone: '403-555-0139', customer_email: 'new@fixture.example.invalid', acquisition_source: '  Referral  ' }))
    assert.ok(created.identity.customer_insert); assert.ok(created.identity.property_insert)
    const enriched = await parity(s, quoteSaveIntentFixture(s, { customer_id: '__manual', customer_name: 'Current customer label', address: '100 Old Street', customer_phone: '403-555-0139', acquisition_source: 'Referral' }))
    assert.ok(enriched.identity.customer_patch)
  })
  await test('Save plan uses actual manual lawn metadata only when rounded area differs', async () => {
    const s = fixture()
    const changed = await parity(s, quoteSaveIntentFixture(s, { service_type: 'Lawn mowing', measured_sqft: 1200.125 }))
    assert.equal(changed.measurement?.payload.source, 'manual'); assert.deepEqual(changed.measurement?.payload.shapes, [])
    assert.equal(changed.measurement?.payload.value, 1200.13); assert.equal(changed.measurement?.prior_lawn_value, 1000)
    const sameArea = await parity(s, quoteSaveIntentFixture(s, { service_type: 'Lawn mowing', measured_sqft: 1000.4 }))
    assert.equal(sameArea.measurement, null)
    const newProperty = await parity(s, quoteSaveIntentFixture(s, { address: '400 Fictional Road', service_type: 'Lawn mowing', measured_sqft: 1200 }))
    assert.ok(newProperty.identity.property_insert); assert.equal(newProperty.measurement?.prior_lawn_value, null)
  })
  await test('Save plan respects configured tenant template over service-name lawn classification', async () => {
    const s = fixture(); s.templates = [{ xmin: '40', row: { id: uuid(40), user_id: owner, sort_order: 0, pricing_display_type: 'per_sqft' } }]
    const plan = await parity(s, quoteSaveIntentFixture(s, { service_type: 'Lawn mowing', service_template_id: uuid(40), measured_sqft: 5000 }))
    assert.equal(plan.measurement, null)
  })
  await test('Save intent strictly validates keys, enum/numeric/geometry shape and accepted empty-number sentinels', async () => {
    const s = fixture(), base = quoteSaveIntentFixture(s)
    const blank = clone(base) as unknown as { values: Row }; blank.values.hours = ''; blank.values.measured_sqft = null
    const parsed = parsePilotQuoteSaveIntent(blank); assert.equal(parsed.values.hours, 0); assert.equal(parsed.values.measured_sqft, 0)
    const bad: unknown[] = [{ ...base, owner }, { ...base, plan: {} }, { ...base, values: { ...base.values, status: 'won' } },
      { ...base, values: { ...base.values, accepted_price: 999 } }, { ...base, values: { ...base.values, hours: '12' } },
      { ...base, values: { ...base.values, hours: Infinity } }, { ...base, values: { ...base.values, hours: true } },
      { ...base, values: { ...base.values, value_grade: 'AAA' } }, { ...base, values: { ...base.values, services: [{ ...service(), user_id: owner }] } },
      { ...base, values: { ...base.values, measurement_snapshot: { ...frozenSnapshot, provider_secret: 'never-accepted' } } },
      { ...base, values: { ...base.values, measurement_snapshot: { ...frozenSnapshot, parts: [{ label: null, value: 1, ring: [{ lat: 100, lng: 0 }] }] } } }]
    for (const input of bad) assert.throws(() => parsePilotQuoteSaveIntent(input), PilotQuoteSavePlanError)
    const missing = clone(base) as unknown as { values: Row }; delete missing.values.measurement_snapshot
    assert.throws(() => parsePilotQuoteSaveIntent(missing), PilotQuoteSavePlanError)
  })
  await test('Save intent uses canonical option/deposit gates before any target read', async () => {
    const s = fixture()
    for (const patch of [{ has_options: true, options: alternatives, services: [service({ service_type: '' })] },
      { has_options: true, options: alternatives.slice(0, 1) }, { has_options: true, options: alternatives.map(o => ({ ...o, price: 0 })) },
      { deposit_type: 'percent' as const, deposit_value: 101 }, { deposit_type: 'fixed' as const, deposit_value: 0 }]) {
      let reads = 0
      await assert.rejects(() => buildPilotQuoteSavePlan(s, quoteSaveIntentFixture(s, patch), async () => { reads++; throw new Error('unreachable') }))
      assert.equal(reads, 0)
    }
  })
  await test('Save plan fails closed on incomplete/stale editor, targets, property, template and settings', async () => {
    const s = fixture(), intent = quoteSaveIntentFixture(s)
    await assert.rejects(() => buildPilotQuoteSavePlan({ ...s, complete: false }, intent, async () => null), PilotQuoteSavePlanError)
    await assert.rejects(() => buildPilotQuoteSavePlan(s, { ...intent, expectedEditorRevision: 'f'.repeat(32) }, async () => null), PilotQuoteSavePlanError)
    for (const mutate of [
      (t: PilotQuoteSaveTargetSnapshot) => { t.complete = false as true },
      (t: PilotQuoteSaveTargetSnapshot) => { t.property = null },
      (t: PilotQuoteSaveTargetSnapshot) => { t.property!.row.customer_id = uuid(999) },
      (t: PilotQuoteSaveTargetSnapshot) => { t.property!.row.lawn_sqft = 'unknown' },
      (t: PilotQuoteSaveTargetSnapshot) => { t.pricing_inputs!.xmin = '999' },
      (t: PilotQuoteSaveTargetSnapshot) => { t.editor_revision = 'f'.repeat(32) },
    ]) await assert.rejects(() => buildPilotQuoteSavePlan(s, intent, async selection => { const t = targetFixture(s, selection); mutate(t); return t }), PilotQuoteSavePlanError)
    await assert.rejects(() => buildPilotQuoteSavePlan(s, intent, async () => { throw new Error('required target read failed') }))
    const missingSettings = fixture(); missingSettings.pricing_inputs = null
    await buildPilotQuoteSavePlan(missingSettings, quoteSaveIntentFixture(missingSettings), async selection => targetFixture(missingSettings, selection))
    await assert.rejects(() => buildPilotQuoteSavePlan(missingSettings, quoteSaveIntentFixture(missingSettings, { initial_price: 125 }), async selection => targetFixture(missingSettings, selection)), PilotQuoteSavePlanError)
    await assert.rejects(() => buildPilotQuoteSavePlan(s, quoteSaveIntentFixture(s, { service_template_id: uuid(999) }), async () => null), PilotQuoteSavePlanError)
  })
  await test('Save plan copies intent/snapshot before an awaited target read and rejects arithmetic overflow', async () => {
    const s = fixture(), intent = quoteSaveIntentFixture(s), originalNotes = intent.values.notes
    const plan = await buildPilotQuoteSavePlan(s, intent, async selection => {
      const target = targetFixture(s, selection)
      intent.values.notes = 'Later typing'; s.quote.row.internal_notes = 'Later server read'
      selection.identity.resolved.customer_name = 'Mutated callback argument'
      return target
    })
    assert.equal(plan.parent_patch.notes, originalNotes || null)
    assert.notEqual(plan.identity.resolved.customer_name, 'Mutated callback argument')
    await assert.rejects(() => buildPilotQuoteSavePlan(fixture(), quoteSaveIntentFixture(fixture(), { rate: 1e308, overgrowth_multiplier: 1e308 }), async () => null), PilotQuoteSavePlanError)
  })
  await test('Save request enforces exact UTF-8 bound independently of server-only snapshot cap', async () => {
    const s = fixture(), intent = quoteSaveIntentFixture(s), start = JSON.stringify(intent)
    intent.values.notes = 'x'.repeat(PILOT_QUOTE_SAVE_REQUEST_BYTES - Buffer.byteLength(start, 'utf8'))
    assert.equal(Buffer.byteLength(JSON.stringify(intent), 'utf8'), PILOT_QUOTE_SAVE_REQUEST_BYTES)
    parsePilotQuoteSaveIntent(JSON.stringify(intent))
    intent.values.notes += 'x'; assert.throws(() => parsePilotQuoteSaveIntent(intent), (error: unknown) => error instanceof PilotQuoteSavePlanError && error.code === 'request_too_large')
    const large = fixture(); large.quote.row.internal_notes = 'x'.repeat(210_000)
    await buildPilotQuoteSavePlan(large, quoteSaveIntentFixture(fixture()), async selection => targetFixture(large, selection))
    const tooLarge = fixture(); tooLarge.quote.row.internal_notes = 'x'.repeat(PILOT_QUOTE_SAVE_INTERNAL_BYTES)
    await assert.rejects(() => buildPilotQuoteSavePlan(tooLarge, quoteSaveIntentFixture(fixture()), async () => null), (error: unknown) => error instanceof PilotQuoteSavePlanError && error.code === 'internal_too_large')
  })
  await test('Save private plan accepts its exact16MiB bound and refuses one extra byte before dispatch', async () => {
    const s = fixture(), intent = quoteSaveIntentFixture(s)
    const base = await buildPilotQuoteSavePlan(s, intent, async selection => targetFixture(s, selection))
    s.quote.row.internal_notes = 'x'.repeat(PILOT_QUOTE_SAVE_INTERNAL_BYTES - Buffer.byteLength(JSON.stringify(base), 'utf8'))
    const exact = await buildPilotQuoteSavePlan(s, intent, async selection => targetFixture(s, selection))
    assert.equal(Buffer.byteLength(JSON.stringify(exact), 'utf8'), PILOT_QUOTE_SAVE_INTERNAL_BYTES)
    s.quote.row.internal_notes += 'x'
    await assert.rejects(() => buildPilotQuoteSavePlan(s, intent, async selection => targetFixture(s, selection)), (error: unknown) => error instanceof PilotQuoteSavePlanError && error.code === 'internal_too_large')
  })
  return results
}
