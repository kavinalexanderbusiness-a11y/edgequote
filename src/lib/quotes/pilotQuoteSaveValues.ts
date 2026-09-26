import type { QuoteFormValues } from '@/types'
import type { MeasurementSnapshotV2 } from '../measurePricing'
import { optionSetProblem, optionsConflictWithLines } from '../quoteOptions'
import { depositRuleFromForm } from '../payments/depositGate'

// Browser-safe shared field schema. Draft validation preserves exact JSON;
// canonical submission parsing alone performs the existing Number coercions.
type Row = Record<string, unknown>
export const PILOT_QUOTE_SAVE_REQUEST_BYTES = 200_000
export type PilotQuoteSaveIntent = {
  version: 1; quoteId: string; expectedEditorRevision: string
  clientOperationId: string; editorGeneration: string; values: QuoteFormValues
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

// Reject non-JSON host objects/getters/functions rather than allowing toJSON to
// turn an injected object into an apparently valid intent. No payload is logged.
export function quoteSaveJsonCopy(value: unknown, limit: number, invalid: PilotQuoteSavePlanError['code'], oversize: PilotQuoteSavePlanError['code']): unknown {
  const pending: unknown[] = [value], seen = new Set<object>()
  while (pending.length) {
    const item = pending.pop()
    if (item === null || typeof item === 'boolean' || text(item) || finite(item)) continue
    requireThat(Array.isArray(item) || object(item), invalid)
    requireThat((Array.isArray(item) ? [Array.prototype, null] : [Object.prototype, null]).includes(Object.getPrototypeOf(item)), invalid)
    // Repeated references are legal JSON trees after serialization. A cycle is
    // rejected by stringify below; skip a revisit here so inspection terminates.
    if (seen.has(item)) continue
    seen.add(item)
    requireThat(Object.getOwnPropertySymbols(item).length === 0, invalid)
    const keys = Object.getOwnPropertyNames(item)
    if (Array.isArray(item)) requireThat(keys.length === item.length + 1
      && keys.every((k, i) => i === item.length ? k === 'length' : k === String(i)), invalid)
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue
      requireThat(!['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key), invalid)
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      requireThat(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'), invalid)
      pending.push(descriptor.value)
    }
  }
  let serialized: string
  try { serialized = JSON.stringify(value) } catch { throw new PilotQuoteSavePlanError(invalid) }
  requireThat(new TextEncoder().encode(serialized).length <= limit, oversize)
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

export function isPilotQuoteSaveMeasurementSnapshot(value: unknown): value is MeasurementSnapshotV2 | null {
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
    requireThat(new TextEncoder().encode(input).length <= PILOT_QUOTE_SAVE_REQUEST_BYTES, 'request_too_large')
    try { value = JSON.parse(input) } catch { throw new PilotQuoteSavePlanError('invalid_intent') }
  }
  value = quoteSaveJsonCopy(value, PILOT_QUOTE_SAVE_REQUEST_BYTES, 'invalid_intent', 'request_too_large')
  requireThat(object(value) && exact(value, ['version','quoteId','expectedEditorRevision','clientOperationId','editorGeneration','values'])
    && value.version === 1 && id(value.quoteId) && revision(value.expectedEditorRevision) && id(value.clientOperationId)
    && text(value.editorGeneration) && /^[A-Za-z0-9_-]{1,128}$/.test(value.editorGeneration), 'invalid_intent')
  validateFields(value.values, true)
  return value as unknown as PilotQuoteSaveIntent
}


function validateFields(v: unknown, submission: boolean): asserts v is Row {
  requireThat(object(v) && exact(v, valueKeys, ['customer_phone','customer_email','acquisition_source']), 'invalid_intent')
  requireThat((v.customer_id === '' || v.customer_id === '__manual' || id(v.customer_id))
    && text(v.customer_name) && (!submission || v.customer_name.trim().length > 0) && text(v.service_type) && (!submission || v.service_type.trim().length > 0)
    && (v.service_template_id === '' || id(v.service_template_id))
    && ['address','notes','internal_notes'].every(k => text(v[k]))
    && ['customer_phone','customer_email','acquisition_source'].every(k => !Object.hasOwn(v, k) || text(v[k]))
    && ['custom_travel_required','show_travel_separately','has_options'].every(k => typeof v[k] === 'boolean')
    && statuses.includes(String(v.status)) && (v.value_grade === null || grades.includes(String(v.value_grade)))
    && (v.nearby_count === null || (finite(v.nearby_count) && Number.isInteger(v.nearby_count) && v.nearby_count >= 0))
    && ['','percent','fixed'].includes(String(v.deposit_type)) && isPilotQuoteSaveMeasurementSnapshot(v.measurement_snapshot), 'invalid_intent')
  for (const key of numericKeys) { const n = formNumber(v[key]); if (submission) v[key] = n }
  requireThat(Array.isArray(v.services) && Array.isArray(v.options), 'invalid_intent')
  for (const s of v.services) {
    requireThat(object(s) && exact(s, serviceKeys) && ['service_type','unit','notes'].every(k => text(s[k]))
      && (s.service_template_id === '' || id(s.service_template_id)) && ['','amount','percent'].includes(String(s.discount_type))
      && ['service','material'].includes(String(s.kind)), 'invalid_intent')
    for (const key of ['quantity','unit_price','est_minutes','discount_value']) { const n = formNumber(s[key]); if (submission) s[key] = n }
  }
  for (const o of v.options) {
    requireThat(object(o) && exact(o, ['name','description','price','is_recommended'], ['id'])
      && text(o.name) && text(o.description) && typeof o.is_recommended === 'boolean'
      && (!Object.hasOwn(o, 'id') || o.id === '' || id(o.id)), 'invalid_intent')
    const n = formNumber(o.price); if (submission) o.price = n
  }
  // These are the actual builder gates, including its unfiltered line count.
  if (submission && v.has_options) requireThat(!optionsConflictWithLines(true, v.services.length)
    && optionSetProblem(v.options as unknown as QuoteFormValues['options']) === null, 'invalid_options')
}

/** Exact structural copy for draft storage, including transient incomplete
 * business fields. Validation never normalizes or drops submitted bytes. */
export function validatePilotQuoteSaveDraftValues(input: unknown): QuoteFormValues | null {
  try {
    const value = quoteSaveJsonCopy(input, PILOT_QUOTE_SAVE_REQUEST_BYTES, 'invalid_intent', 'request_too_large')
    validateFields(value, false)
    return value as unknown as QuoteFormValues
  } catch { return null }
}

export function validatePilotQuoteSaveSubmission(input: unknown): { ok: true } | { ok: false; code: PilotQuoteSavePlanError['code'] } {
  try {
    // This normalized COPY is only inspected. Caller recovery/transport keeps
    // its original immutable raw values and serialization.
    const intent = parsePilotQuoteSaveIntent(input)
    if (!depositRuleFromForm(intent.values.deposit_type, intent.values.deposit_value).ok) throw new PilotQuoteSavePlanError('invalid_deposit')
    return { ok: true }
  } catch (error) { return { ok: false, code: error instanceof PilotQuoteSavePlanError ? error.code : 'invalid_intent' } }
}

export function isPilotQuoteSaveNumericPath(name: string): boolean {
  return (numericKeys as readonly string[]).includes(name)
    || /^services\.(?:0|[1-9]\d*)\.(?:quantity|unit_price|est_minutes|discount_value)$/.test(name)
    || /^options\.(?:0|[1-9]\d*)\.price$/.test(name)
}
/** Opt-in DOM number-input adapter. Preserve recovered blanks/null exactly;
 * malformed values throw instead of being manufactured into valid zeros. */
export function normalizePilotQuoteSaveNumericInput(value: unknown): number | '' | null {
  if (value === '' || value === null) return value
  if (finite(value)) return value
  requireThat(typeof value === 'string' && /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value), 'invalid_intent')
  const number = Number(value)
  requireThat(Number.isFinite(number), 'invalid_intent')
  return number
}
