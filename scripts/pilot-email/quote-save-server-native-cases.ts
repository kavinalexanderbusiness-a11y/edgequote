import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, TestResult } from './database'
import { identityRows, identityValue, seedQuoteIdentity, type IdentityFixture } from './quote-identity-fixtures'
import { quoteSaveSnapshot, quoteSaveTargets, quoteSaveWrite } from './quote-save-native-cases'
import { quoteSaveIntentFixture } from './quote-save-plan-cases'
import { createPilotQuoteSaveStore, savePilotQuoteSaveRequest } from '../../src/lib/quotes/pilotQuoteSave'
import { parsePilotQuoteSaveReceipt } from '../../src/lib/quotes/pilotQuoteSaveReceipt'
import type { PilotQuoteSaveEditorSnapshot, PilotQuoteSaveIntent, PilotQuoteSavePlan, PilotQuoteSaveTargetRequest } from '../../src/lib/quotes/pilotQuoteSavePlan'

// Actual adapter + planner + receipt parser + native SECURITY DEFINER RPCs.
// Auth and HTTP are synthetic, not Supabase Auth/PostgREST E2E. Existing native
// service transport proves service_role with NULL JWT subject. Every case runs
// inside an outer ROLLBACK fixture: a lost result after native RPC execution is
// NOT evidence of a durable outer COMMIT. No sessions or live clients are opened.
type Row = Record<string, unknown>
const origin = 'https://adapter-native.fixture.example.invalid'
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const quoteSaveServerNativeEvidence: Row[] = []
const auth = (owner: string) => ({ getUser: async () => ({ data: { user: { id: owner } }, error: null }),
  readOwnerRole: async (expectedOwner: string) => { assert.equal(expectedOwner, owner); return { data: { owner_id: owner, role: 'owner' }, error: null } } })
const request = (intent: PilotQuoteSaveIntent) => new Request(origin + '/dormant-save', { method: 'POST',
  headers: { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(intent) })

async function privateRows(db: Database, owner: string) {
  const rows = await identityRows(db, owner)
  for (const table of ['business_settings', 'pricing_config_versions', 'property_measurements', 'property_measurement_events', 'quote_acceptances']) {
    rows[table] = (await db.query<{ row: Row }>(`select to_jsonb(t) as row from public.${table} t where user_id=$1::uuid order by to_jsonb(t)::text`, [owner])).rows.map(r => r.row)
  }
  return rows
}
function nativeBridge(db: Database, fixture: IdentityFixture, loseWriteResponse = false) {
  const calls: string[] = [], plans: PilotQuoteSavePlan[] = [], writeResults: Row[] = []
  const client = { rpc(name: string, args: Row) {
    assert.ok(['pilot_quote_save_snapshot', 'pilot_quote_save_targets', 'pilot_quote_save'].includes(name))
    return { async abortSignal(signal: AbortSignal) {
      assert.equal(signal.aborted, false)
      assert.equal(args.p_owner, fixture.owner); assert.equal(args.p_quote, fixture.quote)
      calls.push(name)
      if (name === 'pilot_quote_save_snapshot') {
        assert.deepEqual(Object.keys(args).sort(), ['p_owner', 'p_quote'])
        return { data: await quoteSaveSnapshot(db, fixture), error: null }
      }
      if (name === 'pilot_quote_save_targets') {
        assert.deepEqual(Object.keys(args).sort(), ['p_expected_revision', 'p_identity', 'p_owner', 'p_provenance_mode', 'p_quote', 'p_template_ids'])
        const selection: PilotQuoteSaveTargetRequest = { owner: String(args.p_owner), quote_id: String(args.p_quote),
          expected_editor_revision: String(args.p_expected_revision), identity: args.p_identity as PilotQuoteSaveTargetRequest['identity'],
          template_ids: args.p_template_ids as string[], provenance_mode: args.p_provenance_mode as PilotQuoteSaveTargetRequest['provenance_mode'] }
        return { data: await quoteSaveTargets(db, selection), error: null }
      }
      assert.deepEqual(Object.keys(args).sort(), ['p_owner', 'p_plan', 'p_quote'])
      plans.push(structuredClone(args.p_plan as PilotQuoteSavePlan))
      const result = await quoteSaveWrite(db, fixture, args.p_plan)
      writeResults.push(result)
      if (loseWriteResponse) throw new Error('Synthetic response loss after actual native RPC; outer fixture remains uncommitted')
      return { data: result, error: null }
    } }
  } } as unknown as SupabaseClient
  return { store: createPilotQuoteSaveStore(client), calls, plans, writeResults }
}
async function readResponse(response: Response, code: string, status: number): Promise<Row> {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const value = await response.json() as Row
  assert.equal(value.code, code)
  if (code !== 'committed') assert.deepEqual(value, { code })
  assert.equal(Object.hasOwn(value, 'expected'), false); assert.equal(Object.hasOwn(value, 'pricing_inputs'), false)
  return value
}

export async function runQuoteSaveServerNativeCases(db: Database): Promise<TestResult[]> {
  const tests: TestResult[] = []
  quoteSaveServerNativeEvidence.length = 0
  const test = async (name: string, work: () => Promise<void>) => {
    await db.exec('begin isolation level read committed')
    try { await work(); await db.exec('set constraints all immediate'); tests.push({ name: 'full Save server native: ' + name, pass: true }) }
    catch (error) { tests.push({ name: 'full Save server native: ' + name, pass: false,
      error: error instanceof Error ? error.message.slice(0, 1800) : 'Adapter native assertion failed' }) }
    finally { await db.exec('rollback') }
  }
  await test('receipt storage coercions match actual column typmods; unscaled fields remain exact', async () => {
    const expected: Record<string, string> = {
      'quotes.hours': 'numeric(6,2)', 'quotes.crew_size': 'integer', 'quotes.rate': 'numeric(8,2)',
      'quotes.travel_fee': 'numeric(8,2)', 'quotes.overgrowth_multiplier': 'numeric(4,2)',
      'quotes.initial_price': 'numeric(10,2)', 'quotes.weekly_price': 'numeric(10,2)', 'quotes.biweekly_price': 'numeric(10,2)',
      'quotes.monthly_price': 'numeric(10,2)', 'quotes.deposit_value': 'numeric(10,2)', 'quotes.nearby_count': 'integer',
      'quotes.measured_sqft': 'numeric', 'quotes.suggested_price': 'numeric',
      'quote_options.price': 'numeric(10,2)', 'quote_options.sort_order': 'integer',
      'quote_services.quantity': 'numeric', 'quote_services.unit_price': 'numeric', 'quote_services.discount_value': 'numeric',
      'quote_services.est_minutes': 'integer', 'quote_services.sort_order': 'integer',
      'property_measurements.value': 'numeric(12,2)', 'property_measurements.measured_at': 'timestamp with time zone',
    }
    const actual = await identityValue(db, `select jsonb_object_agg(c.relname||'.'||a.attname,format_type(a.atttypid,a.atttypmod)) as value
      from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and a.attnum>0 and not a.attisdropped
      and (c.relname||'.'||a.attname) in (select jsonb_array_elements_text($1::jsonb))`, [JSON.stringify(Object.keys(expected))])
    assert.deepEqual(actual, expected)
    quoteSaveServerNativeEvidence.push({ kind: 'actual-storage-typmods', columns: actual,
      comparison: 'All planned numbers bind; only listed scale-two columns allow native storage coercion. No derived quote pricing is recalculated.' })
  })
  await test('complete HTTP Save matches actual SQL rows, measurement timestamp and one native write', async () => {
    const f = await seedQuoteIdentity(db, 8101), beforeSnapshot = await quoteSaveSnapshot(db, f), before = await privateRows(db, f.owner)
    const intent = quoteSaveIntentFixture(beforeSnapshot as unknown as PilotQuoteSaveEditorSnapshot, {
      customer_id: '__manual', customer_name: 'Adapter synthetic new customer', address: '910 Native Adapter Road',
      service_type: 'Lawn Mowing', measured_sqft: 1500.255, initial_price: 160.125, weekly_price: 50.005,
      hours: 1.125, deposit_type: 'percent', deposit_value: 50.005, notes: 'Native adapter scope', internal_notes: 'Native adapter private note',
      services: [{ service_type: 'Exact decimal extra', service_template_id: '', quantity: 1.25, unit: 'each', unit_price: 12.345,
        est_minutes: 5, discount_type: '', discount_value: 0, notes: 'Native exact line', kind: 'service' }],
    })
    const bridge = nativeBridge(db, f)
    const response = await readResponse(await savePilotQuoteSaveRequest(bridge.store, auth(f.owner), request(intent), { trustedOrigin: origin }), 'committed', 200)
    assert.deepEqual(bridge.calls, ['pilot_quote_save_snapshot', 'pilot_quote_save_targets', 'pilot_quote_save'])
    assert.equal(bridge.plans.length, 1)
    assert.ok(parsePilotQuoteSaveReceipt(response, { version: 1, owner: f.owner, quoteId: f.quote,
      clientOperationId: intent.clientOperationId, editorGeneration: intent.editorGeneration, originalEditorRevision: intent.expectedEditorRevision,
      submittedValues: intent.values, submittedSerialization: JSON.stringify(intent.values), stagedAt: 0, state: 'pending' }))
    const afterSnapshot = await quoteSaveSnapshot(db, f) as unknown as PilotQuoteSaveEditorSnapshot, after = await privateRows(db, f.owner)
    assert.equal(response.after_revision, afterSnapshot.editor_revision)
    assert.deepEqual(response.quote, Object.fromEntries(Object.keys(response.quote as Row).map(k => [k, afterSnapshot.quote.row[k]])))
    assert.deepEqual(response.services, afterSnapshot.services.map(v => v.row)); assert.deepEqual(response.options, afterSnapshot.options.map(v => v.row))
    assert.deepEqual(response.measurement, after.property_measurements[0]); assert.equal(response.acceptance_current, afterSnapshot.acceptance.current)
    assert.equal(after.customers.length, before.customers.length + 1); assert.equal(after.properties.length, before.properties.length + 1)
    assert.equal((response.quote as Row).hours, 1.13); assert.equal((response.quote as Row).weekly_price, 50.01)
    assert.equal((response.quote as Row).deposit_value, 50.01); assert.equal((response.quote as Row).measured_sqft, 1500.255)
    assert.equal((response.services as Row[])[1].unit_price, 12.345); assert.equal((response.services as Row[])[1].quantity, 1.25)
    assert.equal((response.measurement as Row).value, 1500.26)
    assert.notEqual((response.measurement as Row).measured_at, bridge.plans[0].measurement!.payload.measured_at)
    assert.equal(Date.parse(String((response.measurement as Row).measured_at)), Date.parse(String(bridge.plans[0].measurement!.payload.measured_at)))
    assert.equal(after.property_measurement_events.length, before.property_measurement_events.length + 1)
    assert.deepEqual(after.quote_acceptances, before.quote_acceptances)
    quoteSaveServerNativeEvidence.push({ kind: 'actual-adapter-native-save', owner: f.owner, quote: f.quote, calls: bridge.calls,
      rowsBefore: hash(before), rowsAfter: hash(after), snapshotBefore: hash(beforeSnapshot), snapshotAfter: hash(afterSnapshot),
      beforeRevision: beforeSnapshot.editor_revision, afterRevision: afterSnapshot.editor_revision,
      nativeWriteCount: bridge.plans.length, actualTimestampSpellingDiffers: true, outerTransaction: 'rolled back synthetic fixture',
      realSupabaseAuth: false, realPostgrestHttp: false, mountedRoute: false })
  })
  await test('stale original editor stops before target planning or native write with zero row mutation', async () => {
    const f = await seedQuoteIdentity(db, 8102), oldSnapshot = await quoteSaveSnapshot(db, f)
    const intent = quoteSaveIntentFixture(oldSnapshot as unknown as PilotQuoteSaveEditorSnapshot, { notes: 'Stale browser edit' })
    await db.query('update public.quotes set notes=$2 where id=$1::uuid', [f.quote, 'Another completed edit'])
    const before = await privateRows(db, f.owner), beforeSnapshot = await quoteSaveSnapshot(db, f), bridge = nativeBridge(db, f)
    assert.notEqual(beforeSnapshot.editor_revision, oldSnapshot.editor_revision)
    await readResponse(await savePilotQuoteSaveRequest(bridge.store, auth(f.owner), request(intent), { trustedOrigin: origin }), 'stale_editor', 409)
    assert.deepEqual(bridge.calls, ['pilot_quote_save_snapshot']); assert.equal(bridge.plans.length, 0)
    assert.deepEqual(await privateRows(db, f.owner), before); assert.deepEqual(await quoteSaveSnapshot(db, f), beforeSnapshot)
    quoteSaveServerNativeEvidence.push({ kind: 'actual-stale-editor-refusal', owner: f.owner, quote: f.quote, calls: bridge.calls,
      rowsBefore: hash(before), rowsAfter: hash(await privateRows(db, f.owner)), snapshotBefore: hash(beforeSnapshot),
      snapshotAfter: hash(await quoteSaveSnapshot(db, f)), nativeWriteCount: 0, originalRevisionRetained: true })
  })
  await test('option and quote numeric typmods agree with native stored alternative prices', async () => {
    const f = await seedQuoteIdentity(db, 8104, false, 'options'), snapshot = await quoteSaveSnapshot(db, f)
    const intent = quoteSaveIntentFixture(snapshot as unknown as PilotQuoteSaveEditorSnapshot, { has_options: true,
      options: [{ name: 'Base', description: '', price: 100.005, is_recommended: false },
        { name: 'Complete', description: 'Native scale-two alternative', price: 200.005, is_recommended: true }] })
    const bridge = nativeBridge(db, f)
    const response = await readResponse(await savePilotQuoteSaveRequest(bridge.store, auth(f.owner), request(intent), { trustedOrigin: origin }), 'committed', 200)
    const after = await quoteSaveSnapshot(db, f) as unknown as PilotQuoteSaveEditorSnapshot
    assert.equal((response.quote as Row).initial_price, 200.01)
    assert.deepEqual((response.options as Row[]).map(v => v.price), [100.01, 200.01])
    assert.deepEqual(response.options, after.options.map(v => v.row))
    assert.equal(bridge.plans.length, 1); assert.equal(bridge.plans[0].options.rows[0].price, 100.005)
    quoteSaveServerNativeEvidence.push({ kind: 'native-option-storage-coercion', nativeWriteCount: bridge.plans.length,
      submittedPrices: [100.005, 200.005], actualStoredPrices: (response.options as Row[]).map(v => v.price),
      snapshotBefore: hash(snapshot), snapshotAfter: hash(after), outerTransaction: 'rolled back synthetic fixture' })
  })
  await test('lost result after real RPC write is UNKNOWN and never replayed inside rollback fixture', async () => {
    const f = await seedQuoteIdentity(db, 8103), beforeSnapshot = await quoteSaveSnapshot(db, f), before = await privateRows(db, f.owner)
    const intent = quoteSaveIntentFixture(beforeSnapshot as unknown as PilotQuoteSaveEditorSnapshot, { notes: 'Executed native Save with lost response' })
    const bridge = nativeBridge(db, f, true)
    await readResponse(await savePilotQuoteSaveRequest(bridge.store, auth(f.owner), request(intent), { trustedOrigin: origin }), 'unknown', 503)
    assert.deepEqual(bridge.calls, ['pilot_quote_save_snapshot', 'pilot_quote_save_targets', 'pilot_quote_save'])
    assert.equal(bridge.writeResults.length, 1); assert.equal(bridge.writeResults[0].code, 'committed')
    const after = await privateRows(db, f.owner), afterSnapshot = await quoteSaveSnapshot(db, f)
    assert.equal(after.quotes[0].notes, intent.values.notes); assert.notDeepEqual(after, before)
    assert.notEqual(afterSnapshot.editor_revision, beforeSnapshot.editor_revision)
    await Promise.resolve()
    assert.equal(bridge.plans.length, 1); assert.deepEqual(await privateRows(db, f.owner), after)
    quoteSaveServerNativeEvidence.push({ kind: 'native-write-response-loss-in-rollback-fixture', owner: f.owner, quote: f.quote,
      nativeWriteCount: bridge.plans.length, nativeReturned: bridge.writeResults[0].code, httpReturned: 'unknown',
      rowsBefore: hash(before), rowsAfter: hash(after), snapshotBefore: hash(beforeSnapshot), snapshotAfter: hash(afterSnapshot),
      automaticReplay: false, durableOuterCommitProved: false, outerTransaction: 'rolled back synthetic fixture' })
  })
  return tests
}
