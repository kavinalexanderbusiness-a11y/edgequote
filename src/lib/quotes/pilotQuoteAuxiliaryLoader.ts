import type { SupabaseClient } from '@supabase/supabase-js'
import type { BusinessSettings, Customer, ServicePricingPlanRow, ServiceTemplate, TravelFeeTier } from '@/types'
import type { ServiceUnit } from '@/lib/units'
import { isCurrentLease, type CacheLease } from '@/lib/clientCache'
import { classifyAuthError } from '@/lib/authState'
import { copyPilotQuoteSaveJson } from './pilotQuoteSaveReceipt'

export type PilotQuoteAuxiliaryProperty = {
  id: string; user_id: string; customer_id: string; address: string
  city: string | null; province: string | null; is_primary: boolean
}
export type PilotQuoteAuxiliaryCustomer = Pick<Customer,
  'id' | 'user_id' | 'name' | 'address' | 'city' | 'province' | 'phone' | 'email'> & {
    archived_at: string | null; properties: PilotQuoteAuxiliaryProperty[]
  }
export type PilotQuoteAuxiliaryTemplate = Pick<ServiceTemplate,
  'id' | 'user_id' | 'name' | 'category' | 'default_rate' | 'pricing_display_type' | 'default_description'
  | 'is_active' | 'is_favorite' | 'sort_order' | 'unit_cost' | 'material_cost' | 'recurrence' | 'measured_by'>
export type PilotQuoteAuxiliaryTier = Pick<TravelFeeTier,
  'id' | 'user_id' | 'min_km' | 'max_km' | 'fee' | 'is_custom' | 'sort_order'>
export type PilotQuoteAuxiliarySettings = Pick<BusinessSettings,
  'id' | 'user_id' | 'default_rate' | 'base_address' | 'daily_capacity_hours' | 'gst_percent' | 'crew_cost_per_hour'
  | 'pricing_base_charge' | 'pricing_mow_rate' | 'pricing_recommended_mult' | 'pricing_premium_mult' | 'pricing_travel_rate'>
export type PilotQuoteAuxiliaryBinding = { quoteId: string; lease: CacheLease }
export type PilotQuoteAuxiliaryReady = {
  code: 'ready'; complete: true; ownerId: string
  source: { kind: 'verified-owner-auxiliary'; quoteId: string; ownerId: string; leaseGeneration: number }
  /** Includes archived rows so the wrapper can retain the baseline's customer.
   * The picker must offer active rows plus that selected row, not all archives. */
  customers: PilotQuoteAuxiliaryCustomer[]
  templates: PilotQuoteAuxiliaryTemplate[]; tiers: PilotQuoteAuxiliaryTier[]
  settings: PilotQuoteAuxiliarySettings; units: ServiceUnit[]; plans: ServicePricingPlanRow[]
}
type FailureCode = 'unavailable' | 'unauthenticated' | 'forbidden' | 'stale'
export type PilotQuoteAuxiliaryResult = PilotQuoteAuxiliaryReady | { code: FailureCode }

export const PILOT_QUOTE_AUXILIARY_PAGE_SIZE = 200
export const PILOT_QUOTE_AUXILIARY_MAX_ROWS = 10_000
export const PILOT_QUOTE_AUXILIARY_BYTES = 2_000_000
export const PILOT_QUOTE_AUXILIARY_TIMEOUT_MS = 15_000

/** Same tables/column vocabulary as the ordinary editor, with explicit scope,
 * completeness and error handling instead of its optional/fallback loaders.
 * These are read projections, never a client-supplied query or write plan. */
export const PILOT_QUOTE_AUXILIARY_SELECTS = Object.freeze({
  customers: 'id,user_id,name,address,city,province,phone,email,archived_at',
  properties: 'id,user_id,customer_id,address,city,province,is_primary',
  service_templates: 'id,user_id,name,category,default_rate,pricing_display_type,default_description,is_active,is_favorite,sort_order,unit_cost,material_cost,recurrence,measured_by',
  travel_fee_tiers: 'id,user_id,min_km,max_km,fee,is_custom,sort_order',
  business_settings: 'id,user_id,default_rate,base_address,daily_capacity_hours,gst_percent,crew_cost_per_hour,pricing_base_charge,pricing_mow_rate,pricing_recommended_mult,pricing_premium_mult,pricing_travel_rate',
  service_units: 'id,user_id,code,label,abbrev,step,decimals,sort_order,active',
  service_pricing_plans: 'id,created_at,updated_at,user_id,service_template_id,term,basis,rate,is_recommended,sort_order',
})
type Table = keyof typeof PILOT_QUOTE_AUXILIARY_SELECTS
type Row = Record<string, unknown>
type Collections = Record<Table, Row[]>
const tables = Object.keys(PILOT_QUOTE_AUXILIARY_SELECTS) as Table[]
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v)
const row = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0')
const nullableText = (v: unknown) => v === null || text(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const nullableNumber = (v: unknown) => v === null || finite(v)
const integer = (v: unknown): v is number => Number.isSafeInteger(v)
const stamp = (v: unknown) => text(v) && v.length <= 80 && /(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v))
const oneOf = (v: unknown, values: readonly unknown[]) => values.includes(v)
class Refusal extends Error {
  constructor(readonly code: FailureCode) { super(code) }
}
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Refusal('unavailable')
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const child of Object.values(v)) freeze(child)
    Object.freeze(v)
  }
  return v
}
function validateRow(value: unknown, table: Table, owner: string): asserts value is Row {
  requireValue(row(value))
  const keys = PILOT_QUOTE_AUXILIARY_SELECTS[table].split(',')
  requireValue(Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)))
  requireValue(uuid(value.id) && (table === 'service_units'
    ? value.user_id === null || value.user_id === owner : value.user_id === owner))
  switch (table) {
    case 'customers':
      requireValue(text(value.name) && ['address','city','province','phone','email'].every(k => nullableText(value[k]))
        && (value.archived_at === null || stamp(value.archived_at)))
      break
    case 'properties':
      requireValue(uuid(value.customer_id) && text(value.address) && ['city','province'].every(k => nullableText(value[k]))
        && typeof value.is_primary === 'boolean')
      break
    case 'service_templates':
      requireValue(text(value.name) && text(value.category) && finite(value.default_rate)
        && nullableText(value.default_description) && typeof value.is_active === 'boolean'
        && typeof value.is_favorite === 'boolean' && integer(value.sort_order)
        && nullableNumber(value.unit_cost) && nullableNumber(value.material_cost)
        && oneOf(value.pricing_display_type, ['starting_from','hourly','per_sqft','per_linear_ft','starting_from_materials','hourly_materials'])
        && oneOf(value.recurrence, [null,'one_time','recurring_ok','usually_recurring'])
        && oneOf(value.measured_by, [null,'area','length','count']))
      break
    case 'travel_fee_tiers':
      requireValue(finite(value.min_km) && nullableNumber(value.max_km) && nullableNumber(value.fee)
        && typeof value.is_custom === 'boolean' && integer(value.sort_order))
      break
    case 'business_settings':
      requireValue(finite(value.default_rate) && finite(value.gst_percent) && nullableText(value.base_address)
        && ['daily_capacity_hours','crew_cost_per_hour','pricing_base_charge','pricing_mow_rate',
          'pricing_recommended_mult','pricing_premium_mult','pricing_travel_rate'].every(k => nullableNumber(value[k])))
      break
    case 'service_units':
      requireValue(text(value.code) && !!value.code.trim() && text(value.label) && !!value.label.trim()
        && text(value.abbrev) && finite(value.step) && value.step > 0
        && integer(value.decimals) && value.decimals >= 0 && value.decimals <= 20
        && integer(value.sort_order) && value.active === true)
      break
    case 'service_pricing_plans':
      requireValue(stamp(value.created_at) && stamp(value.updated_at) && uuid(value.service_template_id)
        && oneOf(value.term, ['one_time','weekly','biweekly','monthly','seasonal'])
        && oneOf(value.basis, ['per_unit','flat']) && finite(value.rate) && value.rate >= 0
        && typeof value.is_recommended === 'boolean' && integer(value.sort_order))
  }
}

function validateLinks(data: Collections): void {
  const customers = new Set(data.customers.map(c => c.id))
  const templates = new Set(data.service_templates.map(t => t.id))
  requireValue(data.business_settings.length === 1)
  requireValue(data.properties.every(p => customers.has(p.customer_id)))
  requireValue(data.service_pricing_plans.every(p => templates.has(p.service_template_id)))
  // Match the native unique keys, not a made-up global unit-code restriction:
  // system and custom units may legitimately share a code.
  const unitKeys = data.service_units.map(u => JSON.stringify([u.user_id, u.code]))
  const planKeys = data.service_pricing_plans.map(p => JSON.stringify([p.service_template_id, p.term]))
  requireValue(new Set(unitKeys).size === unitKeys.length && new Set(planKeys).size === planKeys.length)
}

/** Dormant browser SDK loader. It does not read a quote document, invoke a Save
 * or identity RPC, create defaults, write records, or contact a provider.
 *
 * Two complete bounded passes detect observable catalogue drift; they are NOT
 * a transaction snapshot or Save revision. The canonical Save rechecks its own
 * dependencies. A wrapper must maintain its own auth/lease listener after this
 * function returns; this ready result is never lasting authentication authority. */
export async function loadPilotQuoteAuxiliary(client: SupabaseClient, binding: PilotQuoteAuxiliaryBinding,
  signal: AbortSignal): Promise<PilotQuoteAuxiliaryResult> {
  if (!binding || !uuid(binding.quoteId) || !binding.lease || !uuid(binding.lease.owner)
    || !integer(binding.lease.gen) || binding.lease.gen < 0) return { code: 'unavailable' }
  const quoteId = binding.quoteId, lease = Object.freeze({ owner: binding.lease.owner, gen: binding.lease.gen })
  if (signal.aborted || !isCurrentLease(lease)) return { code: 'stale' }
  const controller = new AbortController()
  const deadline = Date.now() + PILOT_QUOTE_AUXILIARY_TIMEOUT_MS
  let authChanged = false, timedOut = false
  let subscription: { unsubscribe(): void } | undefined
  let result: PilotQuoteAuxiliaryResult = { code: 'unavailable' }
  const stop = () => controller.abort()
  signal.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(() => { timedOut = true; stop() }, PILOT_QUOTE_AUXILIARY_TIMEOUT_MS)
  const assertActive = () => {
    if (signal.aborted || authChanged || !isCurrentLease(lease)) throw new Refusal('stale')
    if (timedOut || Date.now() >= deadline || controller.signal.aborted) throw new Refusal('unavailable')
  }
  const bounded = async <T>(work: () => PromiseLike<T>): Promise<T> => {
    assertActive()
    let off = () => {}
    const cancelled = new Promise<never>((_, reject) => {
      const abort = () => reject(new Refusal(signal.aborted || authChanged || !isCurrentLease(lease) ? 'stale' : 'unavailable'))
      controller.signal.addEventListener('abort', abort, { once: true })
      off = () => controller.signal.removeEventListener('abort', abort)
    })
    try {
      const response = await Promise.race([Promise.resolve().then(() => { assertActive(); return work() }), cancelled])
      assertActive()
      return response
    } finally { off() }
  }
  const verifyOwner = async () => {
    const identity = await bounded(() => client.auth.getUser())
    if (identity.error) throw new Refusal(identity.data?.user ? 'unavailable'
      : classifyAuthError(identity.error) === 'signed-out' ? 'unauthenticated' : 'unavailable')
    if (!identity.data?.user) throw new Refusal('unauthenticated')
    requireValue(uuid(identity.data.user.id))
    if (identity.data.user.id !== lease.owner) throw new Refusal('stale')
    // resolveAppRole collapses read failures to 'none'; preserve that distinction
    // here, while using exactly its canonical read-only database role RPC.
    const role = await bounded(() => client.rpc('current_app_role').abortSignal(controller.signal))
    if (role.error) throw new Refusal('unavailable')
    if (role.data === 'crew' || role.data === 'none') throw new Refusal('forbidden')
    requireValue(role.data === 'owner')
  }
  const collection = async (table: Table): Promise<Row[]> => {
    const items: Row[] = []
    let expected: number | null = null, lastId = ''
    for (let start = 0; ; start += PILOT_QUOTE_AUXILIARY_PAGE_SIZE) {
      const response = await bounded(() => {
        // The SDK need not expand every literal SELECT permutation: the exact
        // returned projection is validated below before it becomes typed data.
        const columns: string = PILOT_QUOTE_AUXILIARY_SELECTS[table]
        let query = client.from(table).select(columns, { count: 'exact' })
        query = table === 'service_units'
          ? query.or(`user_id.is.null,user_id.eq.${lease.owner}`).eq('active', true)
          : query.eq('user_id', lease.owner)
        return query.order('id', { ascending: true }).range(start, start + PILOT_QUOTE_AUXILIARY_PAGE_SIZE - 1)
          .abortSignal(controller.signal)
      })
      requireValue(!response.error && (response.status === 200 || response.status === 206)
        && integer(response.count) && response.count >= 0 && response.count <= PILOT_QUOTE_AUXILIARY_MAX_ROWS)
      if (expected === null) expected = response.count
      requireValue(response.count === expected)
      const page = copyPilotQuoteSaveJson(response.data, PILOT_QUOTE_AUXILIARY_BYTES)
      requireValue(Array.isArray(page) && page.length === Math.min(PILOT_QUOTE_AUXILIARY_PAGE_SIZE, expected - start))
      for (const value of page) {
        validateRow(value, table, lease.owner)
        // Ordered UUIDs prevent page overlap, duplicates and unstable pagination.
        requireValue(typeof value.id === 'string' && value.id > lastId)
        lastId = value.id
        items.push(value)
      }
      requireValue(copyPilotQuoteSaveJson(items, PILOT_QUOTE_AUXILIARY_BYTES))
      if (items.length === expected) return items
      requireValue(items.length < expected)
    }
  }
  const readAll = async (): Promise<Collections> => {
    // Sequential within one bounded pass: a failed page cannot fan out into
    // unrelated requests. No partial collection is ever published or cached.
    const data = {} as Collections
    for (const table of tables) data[table] = await collection(table)
    requireValue(copyPilotQuoteSaveJson(data, PILOT_QUOTE_AUXILIARY_BYTES))
    validateLinks(data)
    return data
  }
  try {
    const listener = client.auth.onAuthStateChange(event => {
      // SDK subscription bootstrap is not an auth transition. Fresh getUser
      // checks on both ends still bind the actual account, including bootstrap.
      if (event !== 'INITIAL_SESSION') { authChanged = true; stop() }
    })
    subscription = listener.data.subscription
    requireValue(subscription && typeof subscription.unsubscribe === 'function')
    await verifyOwner()
    const first = await readAll(), second = await readAll()
    requireValue(JSON.stringify(first) === JSON.stringify(second))
    await verifyOwner()
    assertActive()
    const byCustomer = new Map<string, PilotQuoteAuxiliaryProperty[]>()
    for (const p of second.properties) {
      const entries = byCustomer.get(String(p.customer_id)) ?? []
      entries.push(p as PilotQuoteAuxiliaryProperty)
      byCustomer.set(String(p.customer_id), entries)
    }
    const sortByOrder = <T extends { sort_order: number; id: string }>(values: T[]) => values.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
    const ready: PilotQuoteAuxiliaryReady = {
      code: 'ready', complete: true, ownerId: lease.owner,
      source: { kind: 'verified-owner-auxiliary', quoteId, ownerId: lease.owner, leaseGeneration: lease.gen },
      customers: second.customers.map(c => ({ ...c, properties: byCustomer.get(String(c.id)) ?? [] })) as PilotQuoteAuxiliaryCustomer[],
      templates: sortByOrder(second.service_templates as PilotQuoteAuxiliaryTemplate[]),
      tiers: sortByOrder(second.travel_fee_tiers as PilotQuoteAuxiliaryTier[]),
      settings: second.business_settings[0] as PilotQuoteAuxiliarySettings,
      units: sortByOrder(second.service_units as unknown as ServiceUnit[]),
      plans: sortByOrder(second.service_pricing_plans as unknown as ServicePricingPlanRow[]),
    }
    const safe = copyPilotQuoteSaveJson(ready, PILOT_QUOTE_AUXILIARY_BYTES)
    requireValue(safe)
    result = freeze(safe)
    assertActive()
  } catch (error) {
    result = { code: error instanceof Refusal ? error.code : 'unavailable' }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
    controller.abort()
    try { subscription?.unsubscribe() } catch { result = { code: 'unavailable' } }
    if (signal.aborted || authChanged || !isCurrentLease(lease)) result = { code: 'stale' }
  }
  return result
}
