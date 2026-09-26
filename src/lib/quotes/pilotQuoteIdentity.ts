import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Customer } from '@/types'
import { ensureCustomerAndProperty, type EnsureInput } from '../customers'

// Dormant server primitive. No route mounts this identity-only transaction.
// In particular it must not become a preparatory step in the current multi-write
// quote editor: its content/options/services need a separately reviewed boundary.
type Row = Record<string, unknown>
export type PilotQuoteCustomer = {
  id: string; user_id: string; updated_at: string; archived_at: string | null
  name: string; phone: string | null; email: string | null; address: string | null; acquisition_source: string | null
}
export type PilotQuoteProperty = {
  id: string; user_id: string; customer_id: string; updated_at: string; address: string; is_primary: boolean
}
export type PilotQuoteSnapshot = {
  code: 'snapshot'; complete: true; quote_revision: string
  quote: { id: string; user_id: string; updated_at: string; customer_id: string | null; customer_name: string; property_id: string | null; address: string }
  customers: PilotQuoteCustomer[]; old_customer: PilotQuoteCustomer | null; properties: PilotQuoteProperty[]
}
export type PilotQuoteIdentityPlan = {
  version: 1; preserve: boolean; automatic: boolean
  expected_quote: PilotQuoteSnapshot['quote']; expected_quote_revision: string
  expected_old_customer: PilotQuoteCustomer | null; expected_customer: PilotQuoteCustomer | null
  expected_customers: PilotQuoteCustomer[] | null; expected_properties: PilotQuoteProperty[]; expected_old_property: PilotQuoteProperty | null
  customer_insert: Row | null; customer_patch: Row | null; property_insert: Row | null
  resolved: { customer_id: string | null; customer_name: string; property_id: string | null; address: string; created_customer: boolean; created_property: boolean; matched_by: string | null }
}
export interface PilotQuoteIdentityStore {
  snapshot(owner: string, quote: string): Promise<Row>
  save(owner: string, quote: string, plan: PilotQuoteIdentityPlan): Promise<Row>
}
export interface PilotQuoteIdentityAuth {
  getUser(): Promise<{ data: { user: { id: string } | null }; error?: unknown }>
}

const row = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const nullableId = (value: unknown) => value === null || id(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 10_000 && !value.includes('\0')
const nullableText = (value: unknown) => value === null || text(value)
const stamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 80 && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))
const revision = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
const exact = (value: Row, keys: string[]) => Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k))
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
function insist(condition: unknown): asserts condition { if (!condition) throw new Error('invalid_quote_identity') }

function customer(value: unknown, owner: string): value is PilotQuoteCustomer {
  return row(value) && exact(value, ['id', 'user_id', 'updated_at', 'archived_at', 'name', 'phone', 'email', 'address', 'acquisition_source'])
    && id(value.id) && value.user_id === owner && stamp(value.updated_at) && (value.archived_at === null || stamp(value.archived_at))
    && text(value.name) && ['phone', 'email', 'address', 'acquisition_source'].every(k => nullableText(value[k]))
}
function validateSnapshot(value: unknown): PilotQuoteSnapshot {
  insist(row(value) && exact(value, ['code', 'complete', 'quote', 'quote_revision', 'customers', 'old_customer', 'properties'])
    && value.code === 'snapshot' && value.complete === true && revision(value.quote_revision))
  const q = value.quote
  insist(row(q) && exact(q, ['id', 'user_id', 'updated_at', 'customer_id', 'customer_name', 'property_id', 'address'])
    && id(q.id) && id(q.user_id) && stamp(q.updated_at) && nullableId(q.customer_id) && nullableId(q.property_id) && text(q.customer_name) && text(q.address))
  insist(Array.isArray(value.customers) && value.customers.length <= 10_000 && value.customers.every(c => customer(c, q.user_id as string) && c.archived_at === null))
  const customers = value.customers as PilotQuoteCustomer[]
  insist(new Set(customers.map(c => c.id)).size === customers.length)
  insist(q.customer_id === null ? value.old_customer === null : customer(value.old_customer, q.user_id) && value.old_customer.id === q.customer_id)
  const old = value.old_customer as PilotQuoteCustomer | null
  if (old?.archived_at === null) {
    const active = customers.find(c => c.id === old.id)
    insist(active && Object.keys(old).every(k => active[k as keyof PilotQuoteCustomer] === old[k as keyof PilotQuoteCustomer]))
  } else if (old) insist(!customers.some(c => c.id === old.id))
  insist(Array.isArray(value.properties) && value.properties.length <= 10_000)
  const properties = value.properties
  insist(properties.every(p => row(p) && exact(p, ['id', 'user_id', 'customer_id', 'updated_at', 'address', 'is_primary'])
    && id(p.id) && p.user_id === q.user_id && id(p.customer_id) && stamp(p.updated_at) && text(p.address) && typeof p.is_primary === 'boolean'))
  insist(new Set(properties.map(p => p.id)).size === properties.length)
  if (q.property_id !== null) insist(properties.some(p => p.id === q.property_id && p.customer_id === q.customer_id))
  // All owner properties may include other archived customers. SQL validates
  // those bindings; only active customers participate in automatic matching.
  return value as PilotQuoteSnapshot
}
function validateInput(value: unknown): asserts value is EnsureInput {
  const fields = ['customerId', 'name', 'address', 'phone', 'email', 'city', 'province', 'postal_code', 'source']
  insist(row(value) && Object.keys(value).every(k => fields.includes(k)) && text(value.name) && value.name.trim().length > 0)
  insist(value.customerId === undefined || value.customerId === null || value.customerId === '' || value.customerId === '__manual' || id(value.customerId))
  insist(fields.slice(2).every(k => value[k] === undefined || nullableText(value[k])))
}

export function createPilotQuoteIdentityStore(sb: SupabaseClient): PilotQuoteIdentityStore {
  const rpc = async (name: 'pilot_quote_identity_snapshot' | 'pilot_quote_identity_save', args: Row) => {
    const result = await sb.rpc(name, args)
    if (result.error || !row(result.data) || typeof result.data.code !== 'string') throw new Error('quote_identity_unavailable')
    return result.data
  }
  return {
    snapshot: (owner, quote) => rpc('pilot_quote_identity_snapshot', { p_owner: owner, p_quote: quote }),
    save: (owner, quote, plan) => rpc('pilot_quote_identity_save', { p_owner: owner, p_quote: quote, p_plan: plan }),
  }
}

export async function buildPilotQuoteIdentityPlan(snapshot: unknown, input: EnsureInput): Promise<PilotQuoteIdentityPlan> {
  // Keep snapshots and intent private to this attempt across the resolver awaits.
  validateInput(input)
  const intent: EnsureInput = structuredClone(input)
  const s = validateSnapshot(structuredClone(snapshot)), q = s.quote
  const selected = id(intent.customerId) ? intent.customerId : null
  if (selected) insist(s.customers.some(c => c.id === selected) || s.old_customer?.id === selected)
  const oldProperty = s.properties.find(p => p.id === q.property_id) ?? null
  const preserve = !!selected && selected === q.customer_id && (intent.address || '').trim() === q.address.trim()
  const plan: PilotQuoteIdentityPlan = {
    version: 1, preserve, automatic: !selected, expected_quote: q, expected_quote_revision: s.quote_revision,
    expected_old_customer: s.old_customer, expected_customer: null, expected_customers: selected ? null : s.customers,
    expected_properties: [], expected_old_property: oldProperty, customer_insert: null, customer_patch: null, property_insert: null,
    resolved: { customer_id: q.customer_id, customer_name: q.customer_name, property_id: q.property_id, address: q.address, created_customer: false, created_property: false, matched_by: null },
  }
  if (preserve) {
    plan.expected_customer = s.old_customer
    plan.expected_properties = s.properties.filter(p => p.customer_id === selected)
    return plan
  }

  let readCustomer: string | null = null, patchCustomer: string | null = null
  const known = selected && !s.customers.some(c => c.id === selected) && s.old_customer ? [...s.customers, s.old_customer] : s.customers
  const newId = () => {
    const value = randomUUID()
    insist(![q.id, q.user_id, ...s.customers.map(c => c.id), ...s.properties.map(p => p.id), s.old_customer?.id, plan.customer_insert?.id].includes(value))
    return value
  }
  const customerKeys = ['name', 'email', 'phone', 'address', 'city', 'province', 'postal_code', 'acquisition_source', 'user_id']
  const propertyKeys = ['customer_id', 'user_id', 'address', 'city', 'province', 'postal_code', 'is_primary']
  const facade = {
    from(table: string) {
      insist(table === 'customers' || table === 'properties')
      return {
        update(payload: unknown) {
          insist(table === 'customers' && row(payload) && Object.keys(payload).length > 0 && Object.keys(payload).every(k => ['phone', 'email', 'acquisition_source'].includes(k) && text(payload[k])))
          return { async eq(column: string, value: unknown) {
            insist(column === 'id' && id(value) && !plan.customer_patch && !plan.customer_insert && !readCustomer)
            const target = known.find(c => c.id === value)
            insist(target && Object.keys(payload).every(k => k === 'acquisition_source' ? !target.acquisition_source?.trim() : !target[k as 'phone' | 'email']))
            patchCustomer = value; plan.customer_patch = structuredClone(payload)
            return { data: null, error: null }
          } }
        },
        select(columns: string) {
          insist(table === 'properties' && columns === 'id, address, is_primary')
          return { async eq(column: string, value: unknown) {
            insist(column === 'customer_id' && id(value) && !readCustomer && (known.some(c => c.id === value) || plan.customer_insert?.id === value))
            insist(!selected || value === selected)
            readCustomer = value
            return { data: s.properties.filter(p => p.customer_id === value).map(p => ({ id: p.id, address: p.address, is_primary: p.is_primary })), error: null }
          } }
        },
        insert(payload: unknown) {
          insist(row(payload) && payload.user_id === q.user_id && exact(payload, table === 'customers' ? customerKeys : propertyKeys))
          insist(Object.keys(payload).every(k => k === 'is_primary' ? typeof payload[k] === 'boolean' : nullableText(payload[k])))
          return { select(columns?: string) {
            insist(table === 'customers' ? columns === undefined : columns === 'id')
            return { async single() {
              const inserted = { ...structuredClone(payload), id: newId() }
              if (table === 'customers') {
                insist(!selected && !plan.customer_insert && !plan.customer_patch && !readCustomer && text(payload.name))
                plan.customer_insert = inserted
              } else {
                insist(!plan.property_insert && readCustomer && payload.customer_id === readCustomer && text(payload.address))
                plan.property_insert = inserted
              }
              return { data: inserted, error: null }
            } }
          } }
        },
      }
    },
  }
  // This cast is confined to the strict recording surface above. There is no
  // live client or general-purpose REST operation available to the resolver.
  const result = await ensureCustomerAndProperty(facade as unknown as SupabaseClient, q.user_id, intent, known as unknown as Customer[])
  insist(id(result.customerId) && result.customerId === readCustomer && (!patchCustomer || patchCustomer === result.customerId))
  insist(result.createdCustomer === !!plan.customer_insert && result.createdProperty === !!plan.property_insert && nullableId(result.propertyId))
  insist(result.matchedBy === null || ['phone', 'email', 'address'].includes(result.matchedBy))
  const existing = known.find(c => c.id === result.customerId) ?? null
  insist(existing || plan.customer_insert?.id === result.customerId)
  insist(result.customerName === (existing?.name ?? plan.customer_insert?.name))
  if (result.propertyId !== null) insist(s.properties.some(p => p.id === result.propertyId && p.customer_id === result.customerId) || plan.property_insert?.id === result.propertyId)
  plan.expected_customer = existing
  plan.expected_properties = s.properties.filter(p => p.customer_id === result.customerId)
  // Keep the page's same-customer null fallback without ever transferring an
  // old customer's property to a newly resolved customer.
  const propertyId = result.propertyId ?? (q.customer_id === result.customerId ? q.property_id : null)
  plan.resolved = { customer_id: result.customerId, customer_name: result.customerName, property_id: propertyId,
    address: intent.address || '', created_customer: result.createdCustomer, created_property: result.createdProperty, matched_by: result.matchedBy }
  return plan
}

async function readBody(request: Request): Promise<unknown> {
  if (!request.body) return null
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let length = 0, timer: ReturnType<typeof setTimeout> | undefined
  const read = async () => {
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))) as unknown
        length += next.value.length
        if (length > 200_000) { void reader.cancel().catch(() => {}); return null }
        chunks.push(next.value)
      }
    } catch { return null }
  }
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); resolve(null) }, 10_000) })
  try { return await Promise.race([read(), timeout]) } finally { clearTimeout(timer) }
}
const reply = (status: number, body: Row) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
const refusal = (code: unknown) => typeof code === 'string' && ['not_found', 'stale_quote', 'stale_resolution', 'retained_customer_binding', 'invalid_plan', 'unsupported_isolation'].includes(code)

export async function savePilotQuoteIdentityRequest(store: PilotQuoteIdentityStore, auth: PilotQuoteIdentityAuth, request: Request): Promise<Response> {
  try {
    if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(400, { code: 'invalid_request' })
    if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') return reply(403, { code: 'invalid_origin' })
    const identity = await auth.getUser()
    if (identity.error || !identity.data.user || !id(identity.data.user.id)) return reply(401, { code: 'unauthorized' })
    const body = await readBody(request)
    if (!row(body) || !exact(body, ['quoteId', 'expectedQuoteRevision', 'input']) || !id(body.quoteId) || !revision(body.expectedQuoteRevision)) return reply(400, { code: 'invalid_request' })
    try { validateInput(body.input) } catch { return reply(400, { code: 'invalid_request' }) }
    const input = body.input
    const owner = identity.data.user.id
    const raw = await store.snapshot(owner, body.quoteId)
    if (refusal(raw.code)) return reply(raw.code === 'not_found' ? 404 : 409, { code: raw.code })
    const snapshot = validateSnapshot(raw)
    insist(snapshot.quote.id === body.quoteId && snapshot.quote.user_id === owner)
    if (snapshot.quote_revision !== body.expectedQuoteRevision) return reply(409, { code: 'stale_quote' })
    if (id(input.customerId) && !snapshot.customers.some(c => c.id === input.customerId) && snapshot.old_customer?.id !== input.customerId) return reply(400, { code: 'invalid_request' })
    const plan = await buildPilotQuoteIdentityPlan(snapshot, input)
    const result = await store.save(owner, body.quoteId, plan)
    if (refusal(result.code)) return reply(result.code === 'not_found' ? 404 : 409, { code: result.code })
    const changed = !!(plan.customer_insert || plan.customer_patch || plan.property_insert)
      || !same([plan.resolved.customer_id, plan.resolved.customer_name, plan.resolved.property_id, plan.resolved.address], [snapshot.quote.customer_id, snapshot.quote.customer_name, snapshot.quote.property_id, snapshot.quote.address])
    insist((result.code === 'saved' || result.code === 'unchanged') && exact(result, ['code', 'quote_id', 'customer_id', 'customer_name', 'property_id', 'updated_at', 'created_customer', 'created_property', 'matched_by'])
      && result.code === (changed ? 'saved' : 'unchanged')
      && result.quote_id === body.quoteId && stamp(result.updated_at)
      && result.customer_id === plan.resolved.customer_id && result.customer_name === plan.resolved.customer_name && result.property_id === plan.resolved.property_id
      && result.created_customer === plan.resolved.created_customer && result.created_property === plan.resolved.created_property && result.matched_by === plan.resolved.matched_by)
    if (result.code === 'unchanged') insist(!plan.customer_insert && !plan.customer_patch && !plan.property_insert && result.updated_at === snapshot.quote.updated_at
      && same([plan.resolved.customer_id, plan.resolved.customer_name, plan.resolved.property_id, plan.resolved.address], [snapshot.quote.customer_id, snapshot.quote.customer_name, snapshot.quote.property_id, snapshot.quote.address]))
    return reply(200, result)
  } catch {
    // A lost acknowledgement may already have committed. Never retry this write
    // automatically or fall back to the legacy preparatory REST mutations.
    return reply(503, { code: 'unavailable' })
  }
}
