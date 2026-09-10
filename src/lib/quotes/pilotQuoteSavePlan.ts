import type { SupabaseClient } from '@supabase/supabase-js'
import type { PricingDisplayType, QuoteFormValues, QuoteServiceInput } from '@/types'
import type { MeasurementSnapshotV2 } from '../measurePricing'
import { applyOvergrowth } from '../utils'
import { sumServiceLines } from '../quoteServices'
import { headlineOptionPrice, optionRowsFor, optionSetProblem, optionsConflictWithLines } from '../quoteOptions'
import { depositRuleFromForm } from '../payments/depositGate'
import { servicePricingKind } from '../servicePricing'
import { saveManual } from '../measure/data'
import { buildPilotQuoteIdentityPlan, type PilotQuoteIdentityPlan, type PilotQuoteSnapshot } from './pilotQuoteIdentity'

// Dormant server planning only. This module has no live Supabase client, write
// transport, route or pricing-config ensure RPC. Its private output is input to
// a separately reviewed atomic transaction, never a browser-supplied write plan.
type Row = Record<string, unknown>
export const PILOT_QUOTE_SAVE_REQUEST_BYTES = 200_000
export const PILOT_QUOTE_SAVE_INTERNAL_BYTES = 16 * 1024 * 1024
export type PilotQuoteSaveVersionedRow = { row: Row; xmin: string }
export type PilotQuoteSaveIntent = {
  version: 1; quoteId: string; expectedEditorRevision: string
  clientOperationId: string; editorGeneration: string; values: QuoteFormValues
}
export type PilotQuoteSaveEditorSnapshot = {
  code: 'snapshot'; complete: true; editor_revision: string
  identity: PilotQuoteSnapshot
  quote: PilotQuoteSaveVersionedRow
  services: PilotQuoteSaveVersionedRow[]; options: PilotQuoteSaveVersionedRow[]; addons: PilotQuoteSaveVersionedRow[]
  acceptance: { latest: PilotQuoteSaveVersionedRow | null; current: boolean; material_fingerprint: string; terms_fingerprint: string }
  // Only the eight safe pricing inputs and user_id, with the native tuple fence.
  pricing_inputs: PilotQuoteSaveVersionedRow | null
  // Complete rows stay server-only. The loader supplies the same ordered
  // template/config observations bound by the original editor revision.
  templates: PilotQuoteSaveVersionedRow[]
}
export type PilotQuoteSaveTargetRequest = {
  owner: string; quote_id: string; expected_editor_revision: string
  identity: PilotQuoteIdentityPlan; template_ids: string[]; provenance_mode: 'preserve' | 'ensure_current'
}
export type PilotQuoteSaveTargetSnapshot = {
  code: 'targets'; complete: true; editor_revision: string; target_revision: string
  customer: PilotQuoteSaveVersionedRow | null; property: PilotQuoteSaveVersionedRow | null
  lawn: PilotQuoteSaveVersionedRow | null; templates: PilotQuoteSaveVersionedRow[]
  pricing_inputs: PilotQuoteSaveVersionedRow | null
}
/** Read-only server loader. It must assemble one complete native snapshot and
 * return explicit null for known absence. Never implement it using helpers
 * that silently turn failed reads into [] or use it to insert planned targets. */
export type PilotQuoteSaveReadTargets = (selection: PilotQuoteSaveTargetRequest) => Promise<unknown>
export type PilotQuoteSavePlan = {
  version: 1; expected_editor_revision: string; expected_target_revision: string
  expected: { editor: PilotQuoteSaveEditorSnapshot; targets: PilotQuoteSaveTargetSnapshot }
  identity: PilotQuoteIdentityPlan; parent_patch: Row
  options: { mode: 'preserve' | 'replace'; rows: ReturnType<typeof optionRowsFor> }
  services: Row[]
  provenance: { mode: 'preserve' } | { mode: 'ensure_current'; value_grade: string | null; nearby_count: number | null }
  measurement: { payload: Row; prior_lawn_value: number | null } | null
  client_operation_id: string; editor_generation: string
}

export class PilotQuoteSavePlanError extends Error {
  constructor(readonly code: 'invalid_intent' | 'request_too_large' | 'invalid_snapshot' | 'internal_too_large' | 'stale_editor' | 'invalid_targets' | 'stale_targets' | 'invalid_options' | 'invalid_deposit' | 'pricing_settings_unavailable') {
    super(code)
  }
}
function requireThat(condition: unknown, code: PilotQuoteSavePlanError['code']): asserts condition {
  if (!condition) throw new PilotQuoteSavePlanError(code)
}
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
const revision = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
const text = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0')
const stamp = (value: unknown): value is string => text(value) && value.length <= 80 && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const nullableNumber = (value: unknown) => value === null || finite(value)
const nullableText = (value: unknown) => value === null || text(value)
const nullableId = (value: unknown) => value === null || id(value)
const exact = (value: Row, keys: readonly string[], optional: readonly string[] = []) =>
  keys.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => keys.includes(k) || optional.includes(k))
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]))
  return object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && same(a[k], b[k]))
}

// Reject non-JSON host objects/getters/functions rather than allowing toJSON to
// turn an injected object into an apparently valid intent. No payload is logged.
function jsonCopy(value: unknown, limit: number, invalid: PilotQuoteSavePlanError['code'], oversize: PilotQuoteSavePlanError['code']): unknown {
  const pending: unknown[] = [value], seen = new Set<object>()
  while (pending.length) {
    const item = pending.pop()
    if (item === null || typeof item === 'boolean' || text(item) || finite(item)) continue
    requireThat(Array.isArray(item) || (object(item) && [Object.prototype, null].includes(Object.getPrototypeOf(item))), invalid)
    // Repeated references are legal JSON trees after serialization. A cycle is
    // rejected by stringify below; skip a revisit here so inspection terminates.
    if (seen.has(item)) continue
    seen.add(item)
    const keys = Object.keys(item)
    if (Array.isArray(item)) requireThat(keys.length === item.length && keys.every((k, i) => k === String(i)), invalid)
    for (const key of keys) {
      requireThat(!['__proto__', 'constructor', 'prototype'].includes(key), invalid)
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      requireThat(descriptor && Object.hasOwn(descriptor, 'value'), invalid)
      pending.push(descriptor.value)
    }
  }
  let serialized: string
  try { serialized = JSON.stringify(value) } catch { throw new PilotQuoteSavePlanError(invalid) }
  requireThat(Buffer.byteLength(serialized, 'utf8') <= limit, oversize)
  return JSON.parse(serialized) as unknown
}

const valueKeys = ['customer_id','customer_name','address','service_type','service_template_id','overgrowth_multiplier',
  'distance_km','hours','crew_size','rate','travel_fee','notes','internal_notes','initial_price','weekly_price','biweekly_price',
  'monthly_price','custom_travel_required','show_travel_separately','status','measured_sqft','measurement_snapshot','suggested_price',
  'value_grade','nearby_count','services','has_options','options','deposit_type','deposit_value'] as const
const numericKeys = ['overgrowth_multiplier','distance_km','hours','crew_size','rate','travel_fee','initial_price',
  'weekly_price','biweekly_price','monthly_price','measured_sqft','suggested_price','deposit_value'] as const
const serviceKeys = ['service_type','service_template_id','quantity','unit','unit_price','est_minutes','discount_type','discount_value','notes','kind'] as const
const statuses = ['draft','sent','accepted','scheduled','completed','paid','declined']
const grades = ['A+','A','B','C','D','F']
const displays = ['starting_from','hourly','per_sqft','per_linear_ft','starting_from_materials','hourly_materials']
const pricingKeys = ['user_id','pricing_base_charge','pricing_mow_rate','pricing_recommended_mult','pricing_premium_mult',
  'pricing_travel_rate','crew_cost_per_hour','fee_recovery_percent','payment_fee_strategy'] as const

function measurementSnapshot(value: unknown): value is MeasurementSnapshotV2 | null {
  if (value === null) return true
  if (!object(value) || !exact(value, ['v','type','unit','value','parts','measuredAt','serviceTemplateId','serviceName','term','basis','rate','price'])) return false
  if (value.v !== 2 || !['area','length','count','none'].includes(String(value.type)) || !['sqft','linear_ft','count'].includes(String(value.unit))
    || !finite(value.value) || value.value < 0 || !stamp(value.measuredAt) || !nullableId(value.serviceTemplateId)
    || !nullableText(value.serviceName) || !(value.term === null || ['one_time','weekly','biweekly','monthly','seasonal'].includes(String(value.term)))
    || !(value.basis === null || ['per_unit','flat'].includes(String(value.basis))) || !nullableNumber(value.rate) || !nullableNumber(value.price) || !Array.isArray(value.parts)) return false
  return value.parts.every(part => object(part) && exact(part, ['label','value'], ['ring']) && nullableText(part.label)
    && finite(part.value) && part.value >= 0 && (!Object.hasOwn(part, 'ring') || (Array.isArray(part.ring) && part.ring.every(point =>
      object(point) && exact(point, ['lat','lng']) && finite(point.lat) && finite(point.lng)
      && point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180))))
}
function formNumber(value: unknown): number {
  // RHF/browser empty-number values can cross JSON as '' or null. Preserve
  // their actual Number(...) == 0 mapping; reject arbitrary numeric strings,
  // booleans/arrays and nonfinite numbers instead of expanding that surface.
  requireThat(finite(value) || value === '' || value === null, 'invalid_intent')
  return Number(value)
}
export function parsePilotQuoteSaveIntent(input: unknown): PilotQuoteSaveIntent {
  let value = input
  if (typeof input === 'string') {
    requireThat(Buffer.byteLength(input, 'utf8') <= PILOT_QUOTE_SAVE_REQUEST_BYTES, 'request_too_large')
    try { value = JSON.parse(input) } catch { throw new PilotQuoteSavePlanError('invalid_intent') }
  }
  value = jsonCopy(value, PILOT_QUOTE_SAVE_REQUEST_BYTES, 'invalid_intent', 'request_too_large')
  requireThat(object(value) && exact(value, ['version','quoteId','expectedEditorRevision','clientOperationId','editorGeneration','values'])
    && value.version === 1 && id(value.quoteId) && revision(value.expectedEditorRevision) && id(value.clientOperationId)
    && text(value.editorGeneration) && /^[A-Za-z0-9_-]{1,128}$/.test(value.editorGeneration), 'invalid_intent')
  const v = value.values
  requireThat(object(v) && exact(v, valueKeys, ['customer_phone','customer_email','acquisition_source']), 'invalid_intent')
  requireThat((v.customer_id === '' || v.customer_id === '__manual' || id(v.customer_id))
    && text(v.customer_name) && v.customer_name.trim().length > 0 && text(v.service_type) && v.service_type.trim().length > 0
    && (v.service_template_id === '' || id(v.service_template_id))
    && ['address','notes','internal_notes'].every(k => text(v[k]))
    && ['customer_phone','customer_email','acquisition_source'].every(k => !Object.hasOwn(v, k) || text(v[k]))
    && ['custom_travel_required','show_travel_separately','has_options'].every(k => typeof v[k] === 'boolean')
    && statuses.includes(String(v.status)) && (v.value_grade === null || grades.includes(String(v.value_grade)))
    && (v.nearby_count === null || (finite(v.nearby_count) && Number.isInteger(v.nearby_count) && v.nearby_count >= 0))
    && ['','percent','fixed'].includes(String(v.deposit_type)) && measurementSnapshot(v.measurement_snapshot), 'invalid_intent')
  for (const key of numericKeys) v[key] = formNumber(v[key])
  requireThat(Array.isArray(v.services) && Array.isArray(v.options), 'invalid_intent')
  for (const s of v.services) {
    requireThat(object(s) && exact(s, serviceKeys) && ['service_type','unit','notes'].every(k => text(s[k]))
      && (s.service_template_id === '' || id(s.service_template_id)) && ['','amount','percent'].includes(String(s.discount_type))
      && ['service','material'].includes(String(s.kind)), 'invalid_intent')
    for (const key of ['quantity','unit_price','est_minutes','discount_value']) s[key] = formNumber(s[key])
  }
  for (const o of v.options) {
    requireThat(object(o) && exact(o, ['name','description','price','is_recommended'], ['id'])
      && text(o.name) && text(o.description) && typeof o.is_recommended === 'boolean'
      && (!Object.hasOwn(o, 'id') || o.id === '' || id(o.id)), 'invalid_intent')
    o.price = formNumber(o.price)
  }
  // These are the actual builder gates, including its unfiltered line count.
  if (v.has_options) requireThat(!optionsConflictWithLines(true, v.services.length)
    && optionSetProblem(v.options as unknown as QuoteFormValues['options']) === null, 'invalid_options')
  return value as unknown as PilotQuoteSaveIntent
}

function versioned(value: unknown, owner: string, quote?: string): value is PilotQuoteSaveVersionedRow {
  return object(value) && exact(value, ['row','xmin']) && text(value.xmin) && /^\d{1,10}$/.test(value.xmin)
    && object(value.row) && value.row.user_id === owner && (quote === undefined || value.row.quote_id === quote)
}
function orderedRows(value: unknown, owner: string, quote?: string): value is PilotQuoteSaveVersionedRow[] {
  if (!Array.isArray(value) || !value.every(r => versioned(r, owner, quote) && id(r.row.id) && finite(r.row.sort_order) && Number.isInteger(r.row.sort_order))) return false
  if (new Set(value.map(r => r.row.id)).size !== value.length) return false
  return value.every((r, i) => i === 0 || Number(value[i - 1].row.sort_order) < Number(r.row.sort_order)
    || (value[i - 1].row.sort_order === r.row.sort_order && String(value[i - 1].row.id) < String(r.row.id)))
}
function pricing(value: unknown, owner: string): value is PilotQuoteSaveVersionedRow | null {
  return value === null || (versioned(value, owner) && exact(value.row, pricingKeys)
    && pricingKeys.slice(1, -1).every(k => nullableNumber(value.row[k])) && nullableText(value.row.payment_fee_strategy))
}
function editorSnapshot(value: unknown, intent: PilotQuoteSaveIntent): PilotQuoteSaveEditorSnapshot {
  const s = jsonCopy(value, PILOT_QUOTE_SAVE_INTERNAL_BYTES, 'invalid_snapshot', 'internal_too_large')
  requireThat(object(s) && exact(s, ['code','complete','editor_revision','identity','quote','services','options','addons','acceptance','pricing_inputs','templates'])
    && s.code === 'snapshot' && s.complete === true && revision(s.editor_revision) && object(s.identity)
    && object(s.identity.quote) && id(s.identity.quote.user_id), 'invalid_snapshot')
  requireThat(s.editor_revision === intent.expectedEditorRevision, 'stale_editor')
  const owner = s.identity.quote.user_id
  requireThat(versioned(s.quote, owner) && s.quote.row.id === intent.quoteId, 'invalid_snapshot')
  const q = s.quote.row
  const identityQuote = s.identity.quote
  requireThat(Object.keys(identityQuote).every(k => same(q[k], identityQuote[k]))
    && ['initial_price','weekly_price','biweekly_price','monthly_price','nearby_count'].every(k => nullableNumber(q[k]))
    && (q.value_grade === null || grades.includes(String(q.value_grade))) && nullableId(q.selected_option_id)
    && statuses.includes(String(q.status)) && measurementSnapshot(q.measurement_snapshot), 'invalid_snapshot')
  requireThat(orderedRows(s.services, owner, intent.quoteId) && orderedRows(s.options, owner, intent.quoteId)
    && orderedRows(s.addons, owner, intent.quoteId) && orderedRows(s.templates, owner)
    && s.templates.every(t => displays.includes(String(t.row.pricing_display_type)))
    && pricing(s.pricing_inputs, owner), 'invalid_snapshot')
  if (q.selected_option_id !== null) requireThat(s.options.some(o => o.row.id === q.selected_option_id), 'invalid_snapshot')
  const a = s.acceptance
  requireThat(object(a) && exact(a, ['latest','current','material_fingerprint','terms_fingerprint']) && typeof a.current === 'boolean'
    && revision(a.material_fingerprint) && revision(a.terms_fingerprint)
    && (a.latest === null || (versioned(a.latest, owner, intent.quoteId) && id(a.latest.row.id) && finite(a.latest.row.seq) && a.latest.row.seq >= 1))
    && (!a.current || a.latest !== null), 'invalid_snapshot')
  return s as unknown as PilotQuoteSaveEditorSnapshot
}

function validateTargets(value: unknown, s: PilotQuoteSaveEditorSnapshot, identity: PilotQuoteIdentityPlan, templateIds: string[], mode: 'preserve' | 'ensure_current'): PilotQuoteSaveTargetSnapshot {
  const t = jsonCopy(value, PILOT_QUOTE_SAVE_INTERNAL_BYTES, 'invalid_targets', 'internal_too_large')
  requireThat(object(t) && exact(t, ['code','complete','editor_revision','target_revision','customer','property','lawn','templates','pricing_inputs'])
    && t.code === 'targets' && t.complete === true && revision(t.target_revision), 'invalid_targets')
  requireThat(t.editor_revision === s.editor_revision, 'stale_editor')
  const owner = s.identity.quote.user_id, resolved = identity.resolved
  if (resolved.customer_id === null || identity.customer_insert) requireThat(t.customer === null, 'invalid_targets')
  else requireThat(versioned(t.customer, owner) && t.customer.row.id === resolved.customer_id && identity.expected_customer
    && Object.keys(identity.expected_customer).every(k => same(t.customer && (t.customer as PilotQuoteSaveVersionedRow).row[k], identity.expected_customer![k as keyof typeof identity.expected_customer])), 'stale_targets')
  if (resolved.property_id === null || identity.property_insert) requireThat(t.property === null && t.lawn === null, 'invalid_targets')
  else {
    const expected = identity.expected_properties.find(p => p.id === resolved.property_id) ?? identity.expected_old_property
    requireThat(versioned(t.property, owner) && t.property.row.id === resolved.property_id && t.property.row.customer_id === resolved.customer_id
      && nullableNumber(t.property.row.lawn_sqft) && expected && expected.id === resolved.property_id
      && Object.keys(expected).every(k => same((t.property as PilotQuoteSaveVersionedRow).row[k], expected[k as keyof typeof expected])), 'stale_targets')
    requireThat(t.lawn === null || (versioned(t.lawn, owner) && id(t.lawn.row.id) && t.lawn.row.property_id === resolved.property_id
      && t.lawn.row.kind === 'lawn' && t.lawn.row.unit === 'sqft' && finite(t.lawn.row.value) && t.lawn.row.value >= 0
      && Array.isArray(t.lawn.row.shapes) && ['manual','traced','auto'].includes(String(t.lawn.row.source))
      && ['low','medium','high'].includes(String(t.lawn.row.confidence)) && text(t.lawn.row.confidence_reason)
      && typeof t.lawn.row.needs_review === 'boolean' && nullableText(t.lawn.row.notes) && stamp(t.lawn.row.measured_at)
      && stamp(t.lawn.row.created_at) && stamp(t.lawn.row.updated_at)), 'invalid_targets')
  }
  requireThat(orderedRows(t.templates, owner) && t.templates.length === templateIds.length
    && t.templates.every(r => templateIds.includes(String(r.row.id))), 'invalid_targets')
  requireThat(t.templates.every(r => same(r, s.templates.find(old => old.row.id === r.row.id))), 'stale_targets')
  requireThat(pricing(t.pricing_inputs, owner), 'invalid_targets')
  requireThat(same(t.pricing_inputs, s.pricing_inputs), 'stale_targets')
  if (mode === 'ensure_current') requireThat(t.pricing_inputs !== null, 'pricing_settings_unavailable')
  return t as unknown as PilotQuoteSaveTargetSnapshot
}

async function manualPayload(owner: string, propertyId: string, value: number): Promise<Row> {
  let captured: Row | null = null
  const facade = {
    from(table: string) {
      requireThat(table === 'property_measurements' && captured === null, 'invalid_targets')
      return { upsert(payload: Row, conflict: Row) {
        requireThat(same(conflict, { onConflict: 'property_id,kind' }) && payload.user_id === owner && payload.property_id === propertyId, 'invalid_targets')
        captured = structuredClone(payload)
        return { select(columns: string) {
          requireThat(columns === 'id, created_at, updated_at, user_id, property_id, kind, unit, value, shapes, source, confidence, confidence_reason, needs_review, notes, measured_at', 'invalid_targets')
          return { async maybeSingle() { return { data: captured, error: null } } }
        } }
      } }
    },
  }
  const result = await saveManual(facade as unknown as SupabaseClient, { userId: owner, propertyId, kind: 'lawn', value })
  requireThat(result.ok && captured !== null, 'invalid_targets')
  return captured
}

export async function buildPilotQuoteSavePlan(snapshot: unknown, incoming: unknown, readTargets: PilotQuoteSaveReadTargets): Promise<PilotQuoteSavePlan> {
  const intent = parsePilotQuoteSaveIntent(incoming), s = editorSnapshot(snapshot, intent)
  const v = intent.values, q = s.quote.row, owner = s.identity.quote.user_id
  const templateIds = [...new Set([v.service_template_id, ...v.services.map(line => line.service_template_id)].filter(Boolean))].sort()
  requireThat(templateIds.every(template => s.templates.some(t => t.row.id === template)), 'invalid_intent')
  const deposit = depositRuleFromForm(v.deposit_type, v.deposit_value)
  requireThat(deposit.ok, 'invalid_deposit')
  const settled = q.selected_option_id !== null, optionsOn = v.has_options && !settled
  const options = optionsOn ? optionRowsFor(v.options, intent.quoteId, owner) : []
  const extras = v.services.filter(line => line.service_type.trim())
  const withExtras = (Number(v.initial_price) > 0 ? Number(v.initial_price) : 0) + sumServiceLines(extras).net
  const initial = optionsOn ? headlineOptionPrice(options) : settled ? q.initial_price : withExtras > 0 ? withExtras : null
  const moved = Number(initial || 0) !== Number(q.initial_price || 0)
    || Number(v.weekly_price || 0) !== Number(q.weekly_price || 0)
    || Number(v.biweekly_price || 0) !== Number(q.biweekly_price || 0)
    || Number(v.monthly_price || 0) !== Number(q.monthly_price || 0)
  const provenance: PilotQuoteSavePlan['provenance'] = moved
    ? { mode: 'ensure_current', value_grade: v.value_grade ?? (q.value_grade as string | null) ?? null, nearby_count: v.nearby_count ?? (q.nearby_count as number | null) ?? null }
    : { mode: 'preserve' }
  const identity = await buildPilotQuoteIdentityPlan(s.identity, {
    customerId: v.customer_id, name: v.customer_name, address: v.address,
    phone: v.customer_phone, email: v.customer_email, source: v.acquisition_source,
  })
  const resolved = identity.resolved
  const name = identity.preserve
    ? s.identity.customers.find(c => c.id === resolved.customer_id)?.name ?? v.customer_name
    : resolved.customer_name
  const mult = Number(v.overgrowth_multiplier) || 1
  const parent: Row = {
    ...deposit.patch, customer_id: resolved.customer_id, customer_name: name, property_id: resolved.property_id,
    address: v.address, service_type: v.service_type, service_template_id: v.service_template_id || null,
    initial_price: initial, weekly_price: Number(v.weekly_price) > 0 ? Number(v.weekly_price) : null,
    biweekly_price: Number(v.biweekly_price) > 0 ? Number(v.biweekly_price) : null,
    monthly_price: Number(v.monthly_price) > 0 ? Number(v.monthly_price) : null,
    overgrowth_multiplier: mult, custom_travel_required: v.custom_travel_required, show_travel_separately: v.show_travel_separately,
    notes: v.notes || null, internal_notes: v.internal_notes || null, hours: Number(v.hours), crew_size: Number(v.crew_size),
    rate: applyOvergrowth(Number(v.rate), mult), travel_fee: Number(v.travel_fee), measured_sqft: Number(v.measured_sqft) || null,
    measurement_snapshot: v.measurement_snapshot, suggested_price: Number(v.suggested_price) || null,
  }
  // Only the transaction adds price_source and a verified canonical config ID.
  // The conditional grade fields below are the actual handler's fallback, not
  // a rerun of recommendations against newly loaded settings.
  if (provenance.mode === 'ensure_current') Object.assign(parent, { value_grade: provenance.value_grade, nearby_count: provenance.nearby_count })
  const serviceRows: Row[] = extras.length ? [{ user_id: owner, quote_id: intent.quoteId, sort_order: 0,
    service_type: v.service_type, service_template_id: v.service_template_id || null, quantity: 1, unit: 'each',
    unit_price: Number(v.initial_price) || 0, est_minutes: Math.round(Number(v.hours) * 60) || null, kind: 'service',
  }, ...extras.map((line: QuoteServiceInput, index) => ({
    user_id: owner, quote_id: intent.quoteId, sort_order: index + 1, service_type: line.service_type.trim(), service_template_id: line.service_template_id || null,
    quantity: Number(line.quantity) > 0 ? Number(line.quantity) : 1, unit: line.unit || 'each', unit_price: Number(line.unit_price) || 0,
    est_minutes: Number(line.est_minutes) > 0 ? Math.round(Number(line.est_minutes)) : null,
    discount_type: line.discount_type || null, discount_value: line.discount_type && Number(line.discount_value) > 0 ? Number(line.discount_value) : null,
    notes: line.notes?.trim() || null, kind: line.kind || 'service',
  }))] : []
  // Values that overflow only during canonical arithmetic are still refused;
  // JSON must not silently change Infinity into null in an apparent valid plan.
  jsonCopy({ parent, serviceRows, options }, PILOT_QUOTE_SAVE_INTERNAL_BYTES, 'invalid_intent', 'internal_too_large')
  const selection: PilotQuoteSaveTargetRequest = { owner, quote_id: intent.quoteId, expected_editor_revision: s.editor_revision,
    identity: structuredClone(identity), template_ids: templateIds, provenance_mode: provenance.mode }
  const targets = validateTargets(await readTargets(structuredClone(selection)), s, identity, templateIds, provenance.mode)
  let measurement: PilotQuoteSavePlan['measurement'] = null
  const template = targets.templates.find(t => t.row.id === v.service_template_id)
  const isLawn = servicePricingKind(v.service_type, template ? { pricing_display_type: template.row.pricing_display_type as PricingDisplayType } : null) === 'lawn_recurring'
  const area = Number(v.measured_sqft) || 0
  if (resolved.property_id && area > 0 && isLawn) {
    const priorValue = targets.property?.row.lawn_sqft as number | null | undefined
    const prior = Number(priorValue) || 0
    if (Math.round(prior) !== Math.round(area)) measurement = {
      payload: await manualPayload(owner, resolved.property_id, area), prior_lawn_value: priorValue ?? null,
    }
  }
  const plan: PilotQuoteSavePlan = { version: 1, expected_editor_revision: s.editor_revision, expected_target_revision: targets.target_revision,
    expected: { editor: s, targets }, identity, parent_patch: parent,
    options: { mode: settled ? 'preserve' : 'replace', rows: options }, services: serviceRows, provenance, measurement,
    client_operation_id: intent.clientOperationId, editor_generation: intent.editorGeneration }
  return jsonCopy(plan, PILOT_QUOTE_SAVE_INTERNAL_BYTES, 'invalid_snapshot', 'internal_too_large') as PilotQuoteSavePlan
}
