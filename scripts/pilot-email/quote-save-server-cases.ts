import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { QuoteFormValues } from '../../src/types'
import {
  createPilotQuoteSaveStore, savePilotQuoteSaveRequest,
  type PilotQuoteSaveAuth, type PilotQuoteSaveStore, type PilotQuoteSaveRequestOptions,
} from '../../src/lib/quotes/pilotQuoteSave'
import {
  PILOT_QUOTE_SAVE_REQUEST_BYTES,
  type PilotQuoteSaveEditorSnapshot, type PilotQuoteSaveIntent, type PilotQuoteSavePlan,
  type PilotQuoteSaveTargetRequest, type PilotQuoteSaveTargetSnapshot,
} from '../../src/lib/quotes/pilotQuoteSavePlan'
import type { TestResult } from './database'

// Synthetic HTTP/transport checks only. Actual planner and shared receipt parser;
// no live route, service key, database, network, or substitute pricing engine.
type Row = Record<string, unknown>
const id = (n: number) => `83000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const owner = id(1), quote = id(2), customer = id(3), property = id(4), config = id(5)
const origin = 'https://synthetic.example', stamp = '2026-09-10T12:00:00.000Z', revision = 'a'.repeat(32)
const privateSentinel = 'SYNTHETIC_PRIVATE_MUST_NOT_LEAVE_SERVER'
const clone = <T>(value: T): T => structuredClone(value)
export const quoteSaveServerEvidence: Row[] = []

function fixture() {
  const c = { id: customer, user_id: owner, updated_at: stamp, archived_at: null, name: 'Synthetic customer',
    phone: null, email: null, address: '10 Synthetic Street', acquisition_source: null }
  const p = { id: property, user_id: owner, customer_id: customer, updated_at: stamp, address: c.address, is_primary: true }
  const iq = { id: quote, user_id: owner, updated_at: stamp, customer_id: customer, customer_name: c.name, property_id: property, address: c.address }
  const q: Row = { ...iq, quote_number: 'SYNTHETIC-HTTP', service_type: 'General service visit', service_template_id: null,
    initial_price: 100, weekly_price: null, biweekly_price: null, monthly_price: null, hours: 1, crew_size: 1, rate: 100, travel_fee: 0,
    overgrowth_multiplier: 1, custom_travel_required: false, show_travel_separately: false, notes: 'Before', internal_notes: null,
    measured_sqft: null, measurement_snapshot: null, suggested_price: null, value_grade: 'B', nearby_count: 3,
    price_source: 'engine', pricing_config_version_id: config, deposit_type: null, deposit_value: null,
    status: 'sent', selected_option_id: null, accepted_price: null, total: 100, subtotal: 100, man_hours: 1 }
  const snapshot: PilotQuoteSaveEditorSnapshot = { code: 'snapshot', complete: true, editor_revision: revision,
    identity: { code: 'snapshot', complete: true, quote_revision: 'b'.repeat(32), quote: iq, customers: [c], old_customer: c, properties: [p] },
    quote: { row: { ...q, no_charge_reason: privateSentinel }, xmin: '10' }, services: [], options: [], addons: [], templates: [],
    acceptance: { latest: null, current: false, material_fingerprint: 'c'.repeat(32), terms_fingerprint: 'd'.repeat(32) },
    pricing_inputs: { xmin: '11', row: { user_id: owner, pricing_base_charge: 45, pricing_mow_rate: 2, pricing_recommended_mult: 1.1,
      pricing_premium_mult: 1.2, pricing_travel_rate: 1, crew_cost_per_hour: 30, fee_recovery_percent: 0, payment_fee_strategy: 'absorb' } } }
  const values: QuoteFormValues = { customer_id: customer, customer_name: c.name, address: c.address, service_type: String(q.service_type),
    service_template_id: '', initial_price: 100, weekly_price: 0, biweekly_price: 0, monthly_price: 0,
    hours: 1, crew_size: 1, rate: 100, travel_fee: 0, overgrowth_multiplier: 1, distance_km: 0,
    notes: 'Submitted edit', internal_notes: '', custom_travel_required: false, show_travel_separately: false, status: 'sent',
    measured_sqft: 0, measurement_snapshot: null, suggested_price: 0, value_grade: null, nearby_count: null,
    deposit_type: '', deposit_value: 0, has_options: false, options: [], services: [] }
  const intent: PilotQuoteSaveIntent = { version: 1, quoteId: quote, expectedEditorRevision: revision, clientOperationId: id(6), editorGeneration: 'http-instance-1', values }
  const targets = (s: PilotQuoteSaveTargetRequest): PilotQuoteSaveTargetSnapshot => ({ code: 'targets', complete: true,
    editor_revision: revision, target_revision: 'e'.repeat(32), customer: s.identity.customer_insert ? null : { row: clone(c), xmin: '12' },
    property: s.identity.property_insert ? null : { row: { ...clone(p), lawn_sqft: 0 }, xmin: '13' }, lawn: null,
    templates: [], pricing_inputs: clone(snapshot.pricing_inputs) })
  // A synthetic native acknowledgement with authoritative numbers, not a
  // second money/trigger calculation. Native receipts are proved separately.
  const receipt = (plan: PilotQuoteSavePlan): Row => {
    const { address: _address, ...resolved } = plan.identity.resolved
    return { code: 'committed', owner_id: owner, quote_id: quote, client_operation_id: intent.clientOperationId,
      editor_generation: intent.editorGeneration, before_revision: revision, after_revision: 'f'.repeat(32),
      quote: { ...Object.fromEntries(Object.keys(q).map(k => [k, clone(snapshot.quote.row[k])])), ...clone(plan.parent_patch) },
      options: plan.options.mode === 'preserve' ? plan.expected.editor.options.map(o => clone(o.row))
        : plan.options.rows.map((o, i) => ({ ...o, id: id(100 + i), created_at: stamp, updated_at: stamp })),
      services: plan.services.map((s, i) => ({ discount_type: null, discount_value: null, notes: null, ...s, id: id(200 + i), created_at: stamp })),
      measurement: plan.measurement ? { ...plan.measurement.payload, id: id(300), created_at: stamp, updated_at: stamp } : null,
      acceptance_current: false,
      identity: { code: 'unchanged', quote_id: quote, ...resolved, updated_at: stamp },
    }
  }
  return { snapshot, intent, targets, receipt }
}
function request(value: unknown, init: RequestInit = {}, url = origin + '/dormant-test') {
  return new Request(url, { method: 'POST', body: JSON.stringify(value), headers: { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, ...init })
}
function harness() {
  const f = fixture(), calls: string[] = [], plans: PilotQuoteSavePlan[] = []
  const store: PilotQuoteSaveStore = {
    async snapshot(o, q, signal) { calls.push('snapshot'); assert.equal(o, owner); assert.equal(q, quote); assert.equal(signal.aborted, false); return clone(f.snapshot) },
    async targets(s, signal) { calls.push('targets'); assert.equal(s.owner, owner); assert.equal(s.quote_id, quote);
      assert.equal(s.expected_editor_revision, revision); assert.equal(signal.aborted, false); return f.targets(s) },
    async commit(o, q, plan, signal) { calls.push('commit'); assert.equal(o, owner); assert.equal(q, quote); assert.equal(signal.aborted, false);
      plans.push(clone(plan)); return f.receipt(plan) },
  }
  const auth: PilotQuoteSaveAuth = { async getUser() { calls.push('auth'); return { data: { user: { id: owner } }, error: null } } }
  const run = (r = request(f.intent), options: Partial<PilotQuoteSaveRequestOptions> = {}) => savePilotQuoteSaveRequest(store, auth, r,
    { trustedOrigin: origin, bodyTimeoutMs: 1000, operationTimeoutMs: 1000, ...options })
  return { ...f, calls, plans, store, auth, run }
}
async function responseIs(response: Response, code: string, status: number): Promise<Row> {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.match(response.headers.get('content-type')!, /^application\/json/)
  const text = await response.text()
  assert.equal(text.includes(privateSentinel), false)
  const value = JSON.parse(text) as Row
  assert.equal(value.code, code)
  if (code !== 'committed') assert.deepEqual(value, { code })
  return value
}

export async function runQuoteSaveServerCases(): Promise<TestResult[]> {
  const results: TestResult[] = []
  quoteSaveServerEvidence.length = 0
  const test = async (name: string, run: () => Promise<void>) => {
    try { await run(); results.push({ name: 'full Save HTTP: ' + name, pass: true }) }
    catch (error) { results.push({ name: 'full Save HTTP: ' + name, pass: false, error: error instanceof Error ? error.message.slice(0, 1500) : 'failed' }) }
  }
  await test('verified owner, original baseline, two readonly RPCs and exactly one complete commit', async () => {
    const h = harness(), result = await responseIs(await h.run(), 'committed', 200)
    assert.deepEqual(h.calls, ['auth', 'snapshot', 'targets', 'commit'])
    assert.equal(h.plans.length, 1); assert.equal(h.plans[0].expected_editor_revision, revision)
    assert.equal((result.quote as Row).notes, h.intent.values.notes)
    assert.equal(Object.hasOwn(result, 'expected'), false)
    assert.equal(Object.hasOwn(result, 'pricing_inputs'), false)
    quoteSaveServerEvidence.push({ case: 'one_complete_commit', calls: h.calls, privateSnapshotReturned: false, mountedRoute: false })
  })
  await test('SDK adapter invokes exact three signatures with abort signals and no preparation write', async () => {
    const h = harness(), calls: Array<{ name: string; args: Row }> = [], signals: AbortSignal[] = []
    const client = { rpc(name: string, args: Row) { calls.push({ name, args: clone(args) }); return { abortSignal(signal: AbortSignal) {
      signals.push(signal)
      if (name === 'pilot_quote_save_snapshot') return Promise.resolve({ data: clone(h.snapshot), error: null })
      if (name === 'pilot_quote_save_targets') return Promise.resolve({ data: h.targets({ owner: String(args.p_owner), quote_id: String(args.p_quote),
        expected_editor_revision: String(args.p_expected_revision), identity: args.p_identity as PilotQuoteSaveTargetRequest['identity'],
        template_ids: args.p_template_ids as string[], provenance_mode: args.p_provenance_mode as 'preserve' }), error: null })
      assert.equal(name, 'pilot_quote_save'); return Promise.resolve({ data: h.receipt(args.p_plan as PilotQuoteSavePlan), error: null })
    } } } } as unknown as SupabaseClient
    await responseIs(await savePilotQuoteSaveRequest(createPilotQuoteSaveStore(client), h.auth, request(h.intent), { trustedOrigin: origin }), 'committed', 200)
    assert.deepEqual(calls.map(c => c.name), ['pilot_quote_save_snapshot', 'pilot_quote_save_targets', 'pilot_quote_save'])
    assert.deepEqual(calls[0].args, { p_owner: owner, p_quote: quote })
    assert.deepEqual(Object.keys(calls[1].args).sort(), ['p_owner','p_quote','p_expected_revision','p_identity','p_template_ids','p_provenance_mode'].sort())
    assert.deepEqual(Object.keys(calls[2].args).sort(), ['p_owner','p_quote','p_plan'].sort())
    assert.equal(calls[1].args.p_expected_revision, revision)
    assert.equal((calls[2].args.p_plan as PilotQuoteSavePlan).expected_editor_revision, revision)
    assert.equal(signals.length, 3); assert.equal(signals.every(s => s instanceof AbortSignal), true)
  })
  await test('untrusted origins and fetch metadata rejected before auth or reads', async () => {
    for (const headers of [ { origin: 'https://foreign.example', 'content-type': 'application/json' },
      { 'content-type': 'application/json' }, { origin, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-site' } ] as Record<string, string>[]) {
      const h = harness(); await responseIs(await h.run(request(h.intent, { headers })), 'forbidden_origin', 403); assert.deepEqual(h.calls, [])
    }
    const h = harness()
    await responseIs(await h.run(request(h.intent, { headers: { origin: 'https://foreign.example', host: 'synthetic.example', 'content-type': 'application/json' } }, 'https://foreign.example/save')), 'forbidden_origin', 403)
    assert.deepEqual(h.calls, [])
  })
  await test('missing or noncanonical trusted deployment origin fails closed', async () => {
    for (const trustedOrigin of ['', origin + '/', origin + '/path', 'null', 'https://user:pass@synthetic.example', 'ftp://synthetic.example']) {
      const h = harness(); await responseIs(await h.run(undefined, { trustedOrigin }), 'unavailable', 503); assert.deepEqual(h.calls, [])
    }
  })
  await test('POST JSON required and encoded bodies rejected before auth', async () => {
    const h = harness()
    await responseIs(await h.run(request(h.intent, { method: 'PUT' })), 'method_not_allowed', 405)
    for (const headers of [{ origin, 'content-type': 'text/plain' }, { origin, 'content-type': 'application/json', 'content-encoding': 'gzip' }] as Record<string, string>[]) {
      await responseIs(await h.run(request(h.intent, { headers })), 'invalid_request', 415)
    }
    assert.deepEqual(h.calls, [])
  })
  await test('strict body forbids request owner, extra keys, missing values and invalid JSON', async () => {
    for (const body of [{ ...fixture().intent, owner }, { ...fixture().intent, plan: {} }, { version: 1 }, null]) {
      const h = harness(); await responseIs(await h.run(request(body)), 'invalid_request', 400); assert.deepEqual(h.calls, [])
    }
    const h = harness(); await responseIs(await h.run(request(null, { body: '{not json' })), 'invalid_request', 400); assert.deepEqual(h.calls, [])
  })
  await test('declared bytes are valid, bounded and match streamed bytes', async () => {
    for (const [length, code, status] of [['-1','invalid_request',400], ['invalid','invalid_request',400], ['1','invalid_request',400],
      [String(PILOT_QUOTE_SAVE_REQUEST_BYTES + 1),'request_too_large',413]] as const) {
      const h = harness(); await responseIs(await h.run(request(h.intent, { headers: { origin, 'content-type': 'application/json', 'content-length': length } })), code, status)
      assert.deepEqual(h.calls, [])
    }
  })
  await test('streamed UTF8 cap accepts exact boundary and rejects one byte above', async () => {
    const h = harness(), compact = JSON.stringify(h.intent)
    const remaining = PILOT_QUOTE_SAVE_REQUEST_BYTES - Buffer.byteLength(compact)
    // Legal trailing JSON whitespace makes the actual HTTP bytes exactly cap.
    await responseIs(await h.run(request(null, { body: compact + ' '.repeat(remaining) })), 'committed', 200)
    const over = harness(); await responseIs(await over.run(request(null, { body: compact + ' '.repeat(remaining + 1) })), 'request_too_large', 413)
    assert.deepEqual(over.calls, [])
  })
  await test('byte limit counts multibyte data and fatal decoder rejects malformed UTF8', async () => {
    const h = harness()
    await responseIs(await h.run(request(null, { body: '"' + 'é'.repeat(100_000) + '"' })), 'request_too_large', 413)
    await responseIs(await h.run(request(null, { body: new Uint8Array([0x22, 0xc3, 0x28, 0x22]) })), 'invalid_request', 400)
    assert.deepEqual(h.calls, [])
  })
  await test('slow or aborted body is cancelled before authentication', async () => {
    const h = harness(); let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    const r = request(null, { body: stream, duplex: 'half' } as RequestInit)
    await responseIs(await h.run(r, { bodyTimeoutMs: 5 }), 'unavailable', 503)
    assert.equal(cancelled, true); assert.deepEqual(h.calls, [])
    const abort = new AbortController(); abort.abort()
    await responseIs(await h.run(request(h.intent, { signal: abort.signal })), 'unavailable', 503); assert.deepEqual(h.calls, [])
  })
  await test('verified user required; auth errors never expose service data', async () => {
    for (const result of [{ data: { user: null } }, { data: { user: { id: owner } }, error: { message: privateSentinel } },
      { data: { user: { id: 'invalid-owner' } } }]) {
      const h = harness(); h.auth.getUser = async () => result
      await responseIs(await h.run(), 'unauthenticated', 401); assert.deepEqual(h.calls, [])
    }
    const h = harness(); h.auth.getUser = async () => { throw new Error(privateSentinel) }
    await responseIs(await h.run(), 'unavailable', 503); assert.deepEqual(h.calls, [])
  })
  await test('foreign owner or quote snapshot never reaches target read or commit', async () => {
    for (const change of [(s: PilotQuoteSaveEditorSnapshot) => { s.quote.row.user_id = id(99) },
      (s: PilotQuoteSaveEditorSnapshot) => { s.identity.quote.user_id = id(99) },
      (s: PilotQuoteSaveEditorSnapshot) => { s.quote.row.id = id(99) }]) {
      const h = harness(); change(h.snapshot)
      await responseIs(await h.run(), 'unavailable', 503); assert.deepEqual(h.calls, ['auth', 'snapshot'])
    }
  })
  await test('incomplete, malformed and stale baseline cannot be silently refreshed', async () => {
    for (const [value, code, status] of [
      [{ ...fixture().snapshot, complete: false }, 'unavailable', 503],
      [{ ...fixture().snapshot, services: undefined }, 'unavailable', 503],
      [{ ...fixture().snapshot, editor_revision: '9'.repeat(32) }, 'stale_editor', 409],
      [{ code: 'not_found' }, 'not_found', 404],
    ] as const) {
      const h = harness(); h.store.snapshot = async () => { h.calls.push('snapshot'); return value }
      await responseIs(await h.run(), code, status); assert.deepEqual(h.calls, ['auth', 'snapshot'])
    }
  })
  await test('failed, partial, foreign and stale target reads cause zero commits', async () => {
    for (const kind of ['throw', 'partial', 'foreign', 'stale', 'refusal']) {
      const h = harness(); h.store.targets = async s => { h.calls.push('targets')
        if (kind === 'throw') throw new Error(privateSentinel)
        if (kind === 'partial') return { ...h.targets(s), lawn: undefined }
        if (kind === 'refusal') return { code: 'stale_editor' }
        const t = h.targets(s)
        if (kind === 'foreign') t.customer!.row.user_id = id(99)
        if (kind === 'stale') t.editor_revision = '9'.repeat(32)
        return t
      }
      const code = kind === 'foreign' ? 'stale_targets' : ['stale', 'refusal'].includes(kind) ? 'stale_editor' : 'unavailable'
      await responseIs(await h.run(), code, code === 'unavailable' ? 503 : 409)
      assert.deepEqual(h.calls, ['auth', 'snapshot', 'targets'])
    }
  })
  await test('read timeout and precommit cancellation issue no mutation', async () => {
    const h = harness(); h.store.snapshot = () => { h.calls.push('snapshot'); return new Promise(() => {}) }
    await responseIs(await h.run(undefined, { operationTimeoutMs: 5 }), 'unavailable', 503); assert.deepEqual(h.calls, ['auth', 'snapshot'])
    const a = harness(), abort = new AbortController(); a.store.targets = async s => { a.calls.push('targets'); abort.abort(); return a.targets(s) }
    await responseIs(await a.run(request(a.intent, { signal: abort.signal })), 'unavailable', 503)
    assert.deepEqual(a.calls, ['auth', 'snapshot', 'targets'])
  })
  await test('only exact proven pre-DML refusal object is a definitive conflict', async () => {
    const h = harness(); h.store.commit = async () => { h.calls.push('commit'); return { code: 'stale_editor' } }
    await responseIs(await h.run(), 'stale_editor', 409); assert.deepEqual(h.calls, ['auth', 'snapshot', 'targets', 'commit'])
    const extra = harness(); extra.store.commit = async () => { extra.calls.push('commit'); return { code: 'stale_editor', detail: privateSentinel } }
    await responseIs(await extra.run(), 'unknown', 503); assert.equal(extra.calls.filter(c => c === 'commit').length, 1)
  })
  await test('lost response remains unknown; exactly one dispatch with no automatic retry', async () => {
    const h = harness(); let committed = false
    h.store.commit = async () => { h.calls.push('commit'); committed = true; throw new Error(privateSentinel) }
    await responseIs(await h.run(), 'unknown', 503); assert.equal(committed, true)
    assert.deepEqual(h.calls, ['auth', 'snapshot', 'targets', 'commit'])
    quoteSaveServerEvidence.push({ case: 'response_loss', dispatched: 1, status: 'unknown', retry: false, rollbackClaim: false })
  })
  await test('commit timeout aborts transport; late valid acknowledgement is not returned', async () => {
    const h = harness(); let signal: AbortSignal | undefined, finish: ((v: unknown) => void) | undefined, plan: PilotQuoteSavePlan | undefined
    h.store.commit = (_o, _q, p, s) => { h.calls.push('commit'); plan = p; signal = s; return new Promise(resolve => { finish = resolve }) }
    await responseIs(await h.run(undefined, { operationTimeoutMs: 5 }), 'unknown', 503)
    assert.equal(signal?.aborted, true); finish!(h.receipt(plan!)); await Promise.resolve()
    assert.deepEqual(h.calls, ['auth', 'snapshot', 'targets', 'commit'])
  })
  await test('client disconnect after commit dispatch stays unknown', async () => {
    const h = harness(), abort = new AbortController()
    h.store.commit = async (_o, _q, p) => { h.calls.push('commit'); abort.abort(); return h.receipt(p) }
    await responseIs(await h.run(request(h.intent, { signal: abort.signal })), 'unknown', 503)
    assert.equal(h.calls.filter(c => c === 'commit').length, 1)
  })
  await test('null, extra private fields, malformed and uncorrelated acknowledgements stay unknown', async () => {
    const mutations: Array<(r: Row) => unknown> = [() => null, r => ({ ...r, expected: privateSentinel }), r => ({ ...r, owner_id: id(99) }),
      r => ({ ...r, quote_id: id(99) }), r => ({ ...r, client_operation_id: id(99) }), r => ({ ...r, editor_generation: 'other-editor' }),
      r => ({ ...r, before_revision: '9'.repeat(32) }), r => ({ ...r, after_revision: revision }),
      r => ({ ...r, services: null }), r => ({ ...r, acceptance_current: null }), r => ({ ...r, code: 'saved' })]
    for (const mutate of mutations) {
      const h = harness(); h.store.commit = async (_o, _q, p) => { h.calls.push('commit'); return mutate(h.receipt(p)) }
      await responseIs(await h.run(), 'unknown', 503); assert.equal(h.calls.filter(c => c === 'commit').length, 1)
    }
  })
  await test('shape-valid wrong plan content or protected state cannot acknowledge success', async () => {
    const mutations: Array<(r: Row) => void> = [r => { (r.quote as Row).notes = 'Another operation' },
      r => { (r.quote as Row).status = 'accepted' }, r => { (r.quote as Row).price_source = 'manual' },
      r => { (r.identity as Row).created_customer = true }, r => { (r.identity as Row).customer_name = 'Wrong name' },
      r => { (r.quote as Row).accepted_price = 200 }]
    for (const mutate of mutations) {
      const h = harness(); h.store.commit = async (_o, _q, p) => { h.calls.push('commit'); const r = h.receipt(p); mutate(r); return r }
      await responseIs(await h.run(), 'unknown', 503); assert.equal(h.calls.filter(c => c === 'commit').length, 1)
    }
  })
  await test('ordered children bind count and all content, including unconstrained numeric decimals', async () => {
    const h = harness(); h.intent.values.services = [{ service_type: 'Synthetic extra', service_template_id: '', quantity: 1,
      unit: 'each', unit_price: 12.345, est_minutes: 5, discount_type: '', discount_value: 0, notes: '', kind: 'service' }]
    await responseIs(await h.run(), 'committed', 200)
    for (const mode of ['missing', 'reverse', 'foreign-content', 'rounded-unit-price', 'quantity', 'discount', 'minutes']) {
      const a = harness(); a.intent.values.services = clone(h.intent.values.services)
      a.store.commit = async (_o, _q, p) => { a.calls.push('commit'); const r = a.receipt(p), lines = r.services as Row[]
        if (mode === 'missing') lines.pop()
        if (mode === 'reverse') lines.reverse()
        if (mode === 'foreign-content') lines[1].service_type = 'Other service'
        if (mode === 'rounded-unit-price') lines[1].unit_price = 12.35
        if (mode === 'quantity') lines[1].quantity = 9
        if (mode === 'discount') lines[1].discount_value = 40
        if (mode === 'minutes') lines[1].est_minutes = 99
        return r }
      await responseIs(await a.run(), 'unknown', 503); assert.equal(a.calls.filter(c => c === 'commit').length, 1)
    }
  })
  await test('SDK read and commit errors are generic, with uncertainty only after dispatch', async () => {
    for (const stage of ['pilot_quote_save_snapshot', 'pilot_quote_save']) {
      const h = harness(), calls: string[] = []
      const client = { rpc(name: string, args: Row) { calls.push(name); return { abortSignal() {
        if (name === stage) return Promise.resolve({ data: null, error: { message: privateSentinel, details: 'secret SQL' } })
        if (name === 'pilot_quote_save_snapshot') return Promise.resolve({ data: h.snapshot, error: null })
        return Promise.resolve({ data: h.targets({ owner, quote_id: quote, expected_editor_revision: revision,
          identity: args.p_identity as PilotQuoteSaveTargetRequest['identity'], template_ids: [], provenance_mode: 'preserve' }), error: null })
      } } } } as unknown as SupabaseClient
      await responseIs(await savePilotQuoteSaveRequest(createPilotQuoteSaveStore(client), h.auth, request(h.intent), { trustedOrigin: origin }),
        stage === 'pilot_quote_save' ? 'unknown' : 'unavailable', 503)
      assert.equal(calls.filter(c => c === 'pilot_quote_save').length, stage === 'pilot_quote_save' ? 1 : 0)
    }
  })
  await test('replacement options bind count, order and nonmoney content', async () => {
    for (const mutation of ['none', 'remove', 'rename', 'reverse', 'price']) {
      const h = harness(); h.intent.values.has_options = true
      h.intent.values.options = [{ name: 'Base', description: 'Scope one', price: 100, is_recommended: true },
        { name: 'Plus', description: 'Scope two', price: 200, is_recommended: false }]
      h.store.commit = async (_o, _q, p) => { h.calls.push('commit'); const r = h.receipt(p), rows = r.options as Row[]
        if (mutation === 'remove') rows.pop()
        if (mutation === 'rename') rows[0].name = 'Other scope'
        if (mutation === 'reverse') rows.reverse()
        if (mutation === 'price') rows[0].price = 900
        return r }
      await responseIs(await h.run(), mutation === 'none' ? 'committed' : 'unknown', mutation === 'none' ? 200 : 503)
      assert.equal(h.calls.filter(c => c === 'commit').length, 1)
    }
  })
  await test('settled alternatives retain their exact IDs and stored prices', async () => {
    for (const mutation of [false, true]) {
      const h = harness(); h.snapshot.quote.row.selected_option_id = id(150)
      h.snapshot.options = [{ xmin: '20', row: { id: id(150), created_at: stamp, updated_at: stamp, user_id: owner, quote_id: quote,
        name: 'Chosen', description: 'Recorded scope', price: 100, sort_order: 0, is_recommended: true } }]
      h.store.commit = async (_o, _q, p) => { h.calls.push('commit'); assert.equal(p.options.mode, 'preserve')
        const r = h.receipt(p); if (mutation) (r.options as Row[])[0].price = 101; return r }
      await responseIs(await h.run(), mutation ? 'unknown' : 'committed', mutation ? 503 : 200)
    }
  })
  await test('manual lawn acknowledgement must exist only for the planned measurement', async () => {
    for (const mutation of ['none', 'missing', 'wrong-reason', 'value', 'pg-offset', 'other-instant', 'microsecond']) {
      const h = harness(); h.intent.values.service_type = 'Lawn mowing'; h.intent.values.measured_sqft = 1234.5
      h.store.commit = async (_o, _q, p) => { h.calls.push('commit'); assert.ok(p.measurement)
        const r = h.receipt(p)
        if (mutation === 'missing') r.measurement = null
        if (mutation === 'wrong-reason') (r.measurement as Row).confidence_reason = 'Another measurement'
        if (mutation === 'value') (r.measurement as Row).value = 9999
        if (mutation === 'pg-offset') (r.measurement as Row).measured_at = String((r.measurement as Row).measured_at).replace('Z', '+00:00')
        if (mutation === 'other-instant') (r.measurement as Row).measured_at = new Date(Date.parse(String((r.measurement as Row).measured_at)) + 1).toISOString()
        if (mutation === 'microsecond') (r.measurement as Row).measured_at = String((r.measurement as Row).measured_at).replace('Z', '001+00:00')
        return r }
      const valid = ['none', 'pg-offset'].includes(mutation)
      await responseIs(await h.run(), valid ? 'committed' : 'unknown', valid ? 200 : 503)
      assert.equal(h.calls.filter(c => c === 'commit').length, 1)
    }
  })
  await test('arbitrary or unconstrained parent numeric changes never acknowledge success', async () => {
    for (const field of ['initial_price', 'weekly_price', 'hours', 'rate', 'travel_fee', 'overgrowth_multiplier', 'crew_size', 'measured_sqft', 'suggested_price']) {
      const h = harness(); h.store.commit = async (_o, _q, p) => { h.calls.push('commit'); const r = h.receipt(p); (r.quote as Row)[field] = 987; return r }
      await responseIs(await h.run(), 'unknown', 503)
    }
    const h = harness(); h.intent.values.measured_sqft = 100.005
    h.store.commit = async (_o, _q, p) => { const r = h.receipt(p); (r.quote as Row).measured_sqft = 100.01; return r }
    await responseIs(await h.run(), 'unknown', 503)
  })
  await test('only pinned numeric scale-two storage rounding is accepted, including signed ties and exponents', async () => {
    for (const [input, stored] of [[1.125, 1.13], [-1.125, -1.13], [1.1249, 1.12], [1e-7, 0], [9.999e-3, 0.01], [2.675, 2.68]]) {
      for (const correct of [true, false]) {
        const h = harness(); h.intent.values.hours = input
        h.store.commit = async (_o, _q, p) => { const r = h.receipt(p); (r.quote as Row).hours = correct ? stored : stored + 0.01; return r }
        await responseIs(await h.run(), correct ? 'committed' : 'unknown', correct ? 200 : 503)
      }
    }
    const h = harness(); h.intent.values.hours = 10_000
    await responseIs(await h.run(), 'unknown', 503) // numeric(6,2) overflow cannot be a real receipt.
  })
  return results
}
