import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { cacheLease, setCacheOwner } from '../../src/lib/clientCache'
import { loadPilotQuoteAuxiliary, PILOT_QUOTE_AUXILIARY_SELECTS } from '../../src/lib/quotes/pilotQuoteAuxiliaryLoader'
import type { TestResult } from './database'

// TEST ONLY: real Supabase Auth/PostgREST code ends at a synthetic HTTP fetch.
// These independent projections deliberately do not derive from the loader:
// dropping a selected ownership field must fail, not silently enrich fixtures.
export const auxiliaryExpectedSelects = {
  customers: 'id,user_id,name,address,city,province,phone,email,archived_at',
  properties: 'id,user_id,customer_id,address,city,province,is_primary',
  service_templates: 'id,user_id,name,category,default_rate,pricing_display_type,default_description,is_active,is_favorite,sort_order,unit_cost,material_cost,recurrence,measured_by',
  travel_fee_tiers: 'id,user_id,min_km,max_km,fee,is_custom,sort_order',
  business_settings: 'id,user_id,default_rate,base_address,daily_capacity_hours,gst_percent,crew_cost_per_hour,pricing_base_charge,pricing_mow_rate,pricing_recommended_mult,pricing_premium_mult,pricing_travel_rate',
  service_units: 'id,user_id,code,label,abbrev,step,decimals,sort_order,active',
  service_pricing_plans: 'id,created_at,updated_at,user_id,service_template_id,term,basis,rate,is_recommended,sort_order',
} as const
export type AuxiliaryTable = keyof typeof auxiliaryExpectedSelects
export const auxiliaryId = (n: number) => `85000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const auxiliaryStamp = '2026-09-10T12:00:00.000+00:00'
type Row = Record<string, unknown>
export const auxiliaryAssert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw Error(message)
}
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
export function auxiliaryRows(owner = auxiliaryId(1)): Record<AuxiliaryTable, Row[]> {
  const n = Number(owner.slice(-12)), id = (offset: number) => auxiliaryId(n + offset)
  return {
    customers: [{ id: id(2), user_id: owner, name: 'Catalogue changed customer', address: 'Catalogue different address', city: 'Synthetic city', province: 'AB', phone: null, email: null, archived_at: null }],
    properties: [{ id: id(3), user_id: owner, customer_id: id(2), address: 'Catalogue different property', city: 'Synthetic city', province: 'AB', is_primary: true }],
    service_templates: [{ id: id(5), user_id: owner, name: 'Catalogue-only service', category: 'Synthetic', default_rate: 987, pricing_display_type: 'hourly', default_description: 'Catalogue-only scope', is_active: true, is_favorite: false, sort_order: 0, unit_cost: null, material_cost: null, recurrence: 'one_time', measured_by: 'area' }],
    travel_fee_tiers: [{ id: id(7), user_id: owner, min_km: 0, max_km: null, fee: 78, is_custom: false, sort_order: 0 }],
    business_settings: [{ id: id(6), user_id: owner, default_rate: 987, base_address: 'Catalogue office', daily_capacity_hours: 8, gst_percent: 5, crew_cost_per_hour: 30, pricing_base_charge: 999, pricing_mow_rate: 9, pricing_recommended_mult: 3, pricing_premium_mult: 4, pricing_travel_rate: 8 }],
    service_units: [{ id: auxiliaryId(10000), user_id: null, code: 'each', label: 'Each', abbrev: 'ea', step: 1, decimals: 0, sort_order: 0, active: true }],
    service_pricing_plans: [{ id: id(9), created_at: auxiliaryStamp, updated_at: auxiliaryStamp, user_id: owner, service_template_id: id(5), term: 'one_time', basis: 'flat', rate: 456, is_recommended: true, sort_order: 0 }],
  }
}
export type AuxiliaryRequest = { kind: 'auth' | 'role' | 'page'; table?: AuxiliaryTable; occurrence: number; offset?: number; limit?: number; signal: AbortSignal | null }
export type AuxiliaryObservation = Omit<AuxiliaryRequest, 'signal'> & { method: string; aborted: boolean }
export type AuxiliaryHarness = Awaited<ReturnType<typeof createAuxiliaryHarness>>
export const auxiliaryJsonResponse = (data: unknown, status = 200, count?: number) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', ...(count === undefined ? {} : { 'content-range': `${count ? '0-' + (count - 1) : '*'}/${count}` }) },
})

export async function createAuxiliaryHarness(owner = auxiliaryId(1), initialize = true) {
  const state = { owner, data: auxiliaryRows(owner), role: 'owner', authUser: owner as string | null,
    observations: [] as AuxiliaryObservation[], blocked: [] as string[], activeSubscriptions: 0, subscriptions: 0, unsubscribed: 0,
    hook: null as null | ((request: AuxiliaryRequest) => Promise<Response | void> | Response | void), initializedReads: 0, closed: false }
  const counters = new Map<string, number>()
  const refuse = (message: string): never => { state.blocked.push(message); throw Error(message) }
  const syntheticFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url), method = request.method
    if (url.origin !== 'https://quote-auxiliary.invalid') return refuse('Unexpected origin')
    let item: AuxiliaryRequest
    if (url.pathname === '/auth/v1/user' && method === 'GET' && !url.search) item = { kind: 'auth', occurrence: 0, signal: request.signal }
    else if (url.pathname === '/rest/v1/rpc/current_app_role' && method === 'POST' && !url.search) {
      const body = await request.text()
      if (body !== '{}' && body !== '') return refuse('Unexpected role RPC arguments')
      item = { kind: 'role', occurrence: 0, signal: request.signal }
    } else {
      const table = url.pathname.slice('/rest/v1/'.length) as AuxiliaryTable
      if (!url.pathname.startsWith('/rest/v1/') || method !== 'GET' || !(table in auxiliaryExpectedSelects)) return refuse('Unexpected table or mutation')
      const q = url.searchParams, unit = table === 'service_units'
      const expectedKeys = unit ? ['active','limit','offset','or','order','select'] : ['limit','offset','order','select','user_id']
      if (JSON.stringify([...q.keys()].sort()) !== JSON.stringify(expectedKeys)) return refuse('Unexpected page query keys: ' + table)
      if (q.get('select') !== auxiliaryExpectedSelects[table] || q.get('order') !== 'id.asc'
        || q.get('limit') !== '200' || !/^\d+$/.test(q.get('offset') ?? '') || Number(q.get('offset')) % 200 !== 0
        || !(request.headers.get('prefer') ?? '').split(',').includes('count=exact')) return refuse('Unexpected projection/order/range/count: ' + table)
      if (unit ? q.get('or') !== `(user_id.is.null,user_id.eq.${state.owner})` || q.get('active') !== 'eq.true'
        : q.get('user_id') !== `eq.${state.owner}`) return refuse('Unexpected ownership predicate: ' + table)
      item = { kind: 'page', table, occurrence: 0, offset: Number(q.get('offset')), limit: 200, signal: request.signal }
    }
    const key = item.table ?? item.kind
    item.occurrence = (counters.get(key) ?? 0) + 1; counters.set(key, item.occurrence)
    state.observations.push({ kind: item.kind, table: item.table, occurrence: item.occurrence, offset: item.offset, limit: item.limit, method, aborted: item.signal?.aborted ?? false })
    const override = await state.hook?.(item)
    if (override) return override
    if (item.kind === 'auth') return auxiliaryJsonResponse(state.authUser ? { id: state.authUser, aud: 'authenticated', role: 'authenticated', email: 'synthetic@example.invalid', app_metadata: {}, user_metadata: {}, created_at: auxiliaryStamp } : { user: null })
    if (item.kind === 'role') return auxiliaryJsonResponse(state.role)
    const table = item.table!, source = [...state.data[table]].sort((a, b) => String(a.id).localeCompare(String(b.id)))
    const page = source.slice(item.offset, item.offset! + item.limit!)
      .map(value => Object.fromEntries(auxiliaryExpectedSelects[table].split(',').filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])))
    return auxiliaryJsonResponse(page, 200, source.length)
  }
  const client: SupabaseClient = createClient('https://quote-auxiliary.invalid', 'synthetic-anon-key-not-a-credential', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'auxiliary-test-' + crypto.randomUUID() },
    global: { fetch: syntheticFetch },
  })
  // Observe listener ownership without replacing SDK events/results.
  const subscribe = client.auth.onAuthStateChange.bind(client.auth)
  client.auth.onAuthStateChange = callback => {
    const result = subscribe(callback); state.activeSubscriptions++; state.subscriptions++
    const unsubscribe = result.data.subscription.unsubscribe.bind(result.data.subscription); let open = true
    result.data.subscription.unsubscribe = () => { if (open) { open = false; state.activeSubscriptions--; state.unsubscribed++ } unsubscribe() }
    return result
  }
  const setSessionOwner = async (nextOwner: string) => {
    state.owner = nextOwner; state.authUser = nextOwner
    const encode = (v: unknown) => btoa(JSON.stringify(v)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')
    const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: nextOwner, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.synthetic-signature`
    const session = await client.auth.setSession({ access_token: token, refresh_token: 'synthetic-refresh-never-sent' })
    auxiliaryAssert(!session.error && session.data.user?.id === nextOwner, 'Actual SDK synthetic session initialized')
  }
  if (initialize) await setSessionOwner(owner)
  state.initializedReads = state.observations.length
  const close = async () => { await client.auth.stopAutoRefresh(); state.closed = true }
  return { client, state, setSessionOwner, close }
}

export const quoteAuxiliaryLoaderEvidence: Record<string, unknown>[] = []
export async function runQuoteAuxiliaryLoaderCases(): Promise<TestResult[]> {
  const results: TestResult[] = []; quoteAuxiliaryLoaderEvidence.length = 0
  const test = async (name: string, work: (h: AuxiliaryHarness, run: () => ReturnType<typeof loadPilotQuoteAuxiliary>, abort: AbortController) => Promise<void>, initialize = true) => {
    const h = await createAuxiliaryHarness(auxiliaryId(1), initialize), abort = new AbortController(); setCacheOwner(null); setCacheOwner(h.state.owner)
    const lease = cacheLease()!, run = () => loadPilotQuoteAuxiliary(h.client, { quoteId: auxiliaryId(2), lease }, abort.signal)
    try { await work(h, run, abort); auxiliaryAssert(!h.state.blocked.length, h.state.blocked.join('; ')); auxiliaryAssert(h.state.activeSubscriptions === 0, 'Every loader auth listener closed'); results.push({ name: 'Auxiliary SDK: ' + name, pass: true }) }
    catch (error) { results.push({ name: 'Auxiliary SDK: ' + name, pass: false, error: error instanceof Error ? error.message : String(error) }) }
    finally { abort.abort(); await h.close(); setCacheOwner(null); quoteAuxiliaryLoaderEvidence.push({ name, requests: h.state.observations, blocked: h.state.blocked, initializedReads: h.state.initializedReads, subscriptions: h.state.subscriptions, unsubscribed: h.state.unsubscribed, activeSubscriptions: h.state.activeSubscriptions, sdkStopped: h.state.closed }) }
  }
  const refused = async (run: () => ReturnType<typeof loadPilotQuoteAuxiliary>, code = 'unavailable') => {
    auxiliaryAssert(JSON.stringify(await run()) === JSON.stringify({ code }), 'Exact failure only: ' + code)
  }
  await test('complete two-pass projections and fresh auth produce frozen owner-linked data', async (h, run) => {
    auxiliaryAssert(JSON.stringify(PILOT_QUOTE_AUXILIARY_SELECTS) === JSON.stringify(auxiliaryExpectedSelects), 'Independent exact SELECT contract')
    const result = await run(); auxiliaryAssert(result.code === 'ready', 'Ready result')
    auxiliaryAssert(result.source.quoteId === auxiliaryId(2) && result.source.ownerId === h.state.owner && result.source.leaseGeneration === cacheLease()!.gen, 'Exact quote and lease binding')
    auxiliaryAssert(result.customers[0].properties[0].customer_id === result.customers[0].id, 'Property ownership link')
    auxiliaryAssert(Object.isFrozen(result) && Object.isFrozen(result.customers[0].properties[0]), 'Nested immutable output')
    const calls = h.state.observations.slice(h.state.initializedReads)
    auxiliaryAssert(JSON.stringify(calls.map(x => x.table ?? x.kind)) === JSON.stringify(['auth','role',...Object.keys(auxiliaryExpectedSelects),...Object.keys(auxiliaryExpectedSelects),'auth','role']), 'Exactly two whole passes between fresh auth/role checks')
  })
  for (const table of Object.keys(auxiliaryExpectedSelects) as AuxiliaryTable[]) {
    await test(table + ' HTTP denial cannot publish partial catalogues', async (h, run) => { h.state.hook = r => r.table === table ? auxiliaryJsonResponse({ message: 'Synthetic denial', code: '42501' }, 403) : undefined; await refused(run) })
    await test(table + ' omitted selected field cannot become a default', async (h, run) => { delete h.state.data[table][0][table === 'service_units' ? 'active' : 'user_id']; await refused(run) })
  }
  await test('null data, missing count and truncated exact-count pages are refused', async (h, run) => {
    for (const response of [() => auxiliaryJsonResponse(null, 200, 1), () => auxiliaryJsonResponse([]), () => auxiliaryJsonResponse([], 200, 1)]) {
      h.state.hook = r => r.table === 'customers' ? response() : undefined; await refused(run)
    }
  })
  await test('second pass catalogue drift and invalid settings count are refused', async (h, run) => {
    h.state.hook = r => { if (r.table === 'customers' && r.occurrence === 2) h.state.data.customers[0].name = 'Changed during load' }; await refused(run)
    h.state.hook = null; h.state.data.business_settings = []; await refused(run)
  })
  await test('foreign rows and orphan property/plan references are refused', async (h, run) => {
    for (const [table, field] of [['customers','user_id'],['properties','customer_id'],['service_pricing_plans','service_template_id']] as const) {
      h.state.data = auxiliaryRows(); h.state.data[table][0][field] = auxiliaryId(999); await refused(run)
    }
  })
  await test('all owned archived references remain explicit and active custom/system units coexist', async (h, run) => {
    h.state.data.customers[0].archived_at = auxiliaryStamp
    h.state.data.service_units.push({ ...h.state.data.service_units[0], id: auxiliaryId(10001), user_id: h.state.owner })
    const result = await run(); auxiliaryAssert(result.code === 'ready' && result.customers[0].archived_at === auxiliaryStamp && result.units.length === 2, 'No archived reference or native custom unit silently dropped')
  })
  await test('known exact empty catalogues are complete data with required settings retained', async (h, run) => {
    for (const table of ['customers','properties','service_templates','travel_fee_tiers','service_pricing_plans'] as const) h.state.data[table] = []
    const result = await run(); auxiliaryAssert(result.code === 'ready', 'Known complete empty catalogues are ready')
    auxiliaryAssert(result.customers.length === 0 && result.templates.length === 0 && result.tiers.length === 0 && result.plans.length === 0
      && result.settings.gst_percent === 5 && result.units.length === 1, 'Explicit empties retain actual required settings and units')
  })
  await test('pagination reads both exact pages in both passes and refuses overlap', async (h, run) => {
    h.state.data.customers = Array.from({ length: 201 }, (_, i) => ({ ...h.state.data.customers[0], id: i === 0 ? auxiliaryId(3) : auxiliaryId(20000 + i) }))
    auxiliaryAssert((await run()).code === 'ready', 'Complete paginated collection')
    auxiliaryAssert(h.state.observations.filter(r => r.table === 'customers' && r.offset === 200).length === 2, 'Both second pages observed')
    h.state.hook = r => r.table === 'customers' && r.offset === 200 ? auxiliaryJsonResponse([h.state.data.customers[0]], 200, 201) : undefined; await refused(run)
  })
  await test('row and byte caps refuse instead of narrowing results', async (h, run) => {
    h.state.hook = r => r.table === 'customers' ? auxiliaryJsonResponse([], 200, 10001) : undefined; await refused(run)
    h.state.hook = null; h.state.data.customers[0].name = 'x'.repeat(2_000_001); await refused(run)
  })
  await test('required property address and tax percent cannot become null defaults', async (h, run) => {
    h.state.data.properties[0].address = null; await refused(run)
    h.state.data = auxiliaryRows(); h.state.data.business_settings[0].gst_percent = null; await refused(run)
  })
  await test('missing SDK session is unauthenticated without an HTTP request', async (h, run) => {
    await refused(run, 'unauthenticated'); auxiliaryAssert(h.state.observations.length === 0, 'SDK missing-session path is local')
  }, false)
  await test('actual Auth HTTP 401 rejection is unauthenticated without catalogue reads', async (h, run) => {
    h.state.hook = r => r.kind === 'auth' ? auxiliaryJsonResponse({ message: 'Synthetic rejected JWT', code: 'bad_jwt' }, 401) : undefined
    await refused(run, 'unauthenticated'); auxiliaryAssert(!h.state.observations.some(r => r.kind === 'page'), 'Rejected session reads no catalogue')
  })
  await test('auth and role errors differ from authenticated denied/unknown roles', async (h, run) => {
    h.state.hook = r => r.kind === 'auth' ? auxiliaryJsonResponse({ message: 'Synthetic outage' }, 503) : undefined; await refused(run)
    h.state.hook = r => r.kind === 'role' ? auxiliaryJsonResponse({ message: 'Synthetic denied' }, 403) : undefined; await refused(run)
    h.state.hook = null
    for (const role of ['crew','none','unexpected']) { h.state.role = role; await refused(run, role === 'unexpected' ? 'unavailable' : 'forbidden') }
  })
  await test('a fresh verified different user cannot publish for the original lease', async (h, run) => { h.state.authUser = auxiliaryId(81); await refused(run, 'stale') })
  await test('late final role refusal still prevents publication', async (h, run) => { h.state.hook = r => r.kind === 'role' && r.occurrence === 2 ? auxiliaryJsonResponse('crew') : undefined; await refused(run, 'forbidden') })
  await test('same-owner new lease discards a response that ignores abort', async (h, run) => {
    let release!: () => void, arrived!: () => void; const entered = new Promise<void>(r => { arrived = r }), hold = new Promise<void>(r => { release = r })
    h.state.hook = async r => { if (r.table === 'customers') { arrived(); await hold } }
    const pending = run(); await entered; setCacheOwner(null); setCacheOwner(h.state.owner); release(); await refused(() => pending, 'stale')
  })
  await test('caller abort settles before ignored transport response and closes listener', async (h, run, abort) => {
    let release!: () => void, arrived!: () => void; const entered = new Promise<void>(r => { arrived = r }), hold = new Promise<void>(r => { release = r })
    h.state.hook = async r => { if (r.table === 'customers') { arrived(); await hold } }
    const pending = run(); await entered; abort.abort(); await refused(() => pending, 'stale'); release()
  })
  await test('actual SDK same-user SIGNED_IN event invalidates a held read', async (h, run) => {
    let release!: () => void, arrived!: () => void; const entered = new Promise<void>(r => { arrived = r }), hold = new Promise<void>(r => { release = r })
    h.state.hook = async r => { if (r.table === 'customers') { arrived(); await hold } }
    const pending = run(); await entered; await h.setSessionOwner(h.state.owner); await refused(() => pending, 'stale'); release()
  })
  return results
}
