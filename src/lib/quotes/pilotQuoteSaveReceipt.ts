import type { QuoteFormValues } from '@/types'

type Row = Record<string, unknown>
export type PendingQuoteSave = {
  version: 1; owner: string; quoteId: string; clientOperationId: string
  editorGeneration: string; originalEditorRevision: string
  submittedValues: QuoteFormValues; submittedSerialization: string
  stagedAt: number; state: 'pending' | 'unknown'
}
export type PilotQuoteSaveCommittedReceipt = {
  code: 'committed'; owner_id: string; quote_id: string; client_operation_id: string
  editor_generation: string; before_revision: string; after_revision: string
  quote: Row; options: Row[]; services: Row[]; measurement: Row | null
  acceptance_current: boolean; identity: Row
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v)
const revision = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)
const row = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Row, keys: string[]) => keys.length === Object.keys(v).length && keys.every(k => Object.hasOwn(v, k))
export const copyPilotQuoteSaveJson = <T>(value: T, bytes: number): T | null => {
  try {
    const visited = new Set<object>(), queue: unknown[] = [value]
    while (queue.length) {
      const v = queue.pop()
      if (v === null || typeof v === 'boolean' || (typeof v === 'string' && !v.includes('\0')) || (typeof v === 'number' && Number.isFinite(v))) continue
      if (!v || typeof v !== 'object' || !(Array.isArray(v)
        ? [Array.prototype, null].includes(Object.getPrototypeOf(v)) : [Object.prototype, null].includes(Object.getPrototypeOf(v)))) return null
      if (visited.has(v)) continue
      visited.add(v)
      if (Object.getOwnPropertySymbols(v).length) return null
      const keys = Object.getOwnPropertyNames(v)
      if (Array.isArray(v) && (keys.length !== v.length + 1 || keys.some((k, i) => i === v.length ? k !== 'length' : k !== String(i)))) return null
      for (const k of keys) {
        if (Array.isArray(v) && k === 'length') continue
        const d = Object.getOwnPropertyDescriptor(v, k)
        if (['__proto__','constructor','prototype','toJSON'].includes(k) || !d || !d.enumerable || !Object.hasOwn(d, 'value')) return null
        queue.push(d.value)
      }
    }
    const serialized = JSON.stringify(value)
    if (new TextEncoder().encode(serialized).length > bytes) return null
    return JSON.parse(serialized) as T
  } catch { return null }
}
const receiptKeys = ['code','owner_id','quote_id','client_operation_id','editor_generation','before_revision','after_revision','quote','options','services','measurement','acceptance_current','identity']
const quoteKeys = ['id','user_id','quote_number','updated_at','customer_id','customer_name','property_id','address','service_type','service_template_id',
  'initial_price','weekly_price','biweekly_price','monthly_price','hours','crew_size','rate','travel_fee','overgrowth_multiplier','custom_travel_required',
  'show_travel_separately','notes','internal_notes','measured_sqft','measurement_snapshot','suggested_price','value_grade','nearby_count','price_source',
  'pricing_config_version_id','deposit_type','deposit_value','status','selected_option_id','accepted_price','total','subtotal','man_hours']
const serviceKeys = ['id','created_at','user_id','quote_id','service_type','service_template_id','quantity','unit','unit_price','est_minutes','discount_type','discount_value','notes','sort_order','kind']
const optionKeys = ['id','created_at','updated_at','quote_id','user_id','name','description','price','sort_order','is_recommended']
const identityKeys = ['code','quote_id','customer_id','customer_name','property_id','updated_at','created_customer','created_property','matched_by']
const measurementKeys = ['id','created_at','updated_at','user_id','property_id','kind','unit','value','shapes','source','confidence','confidence_reason','needs_review','notes','measured_at']
const string = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0')
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const nullableNumber = (v: unknown) => v === null || finite(v)
const nullableString = (v: unknown) => v === null || string(v)
const nullableId = (v: unknown) => v === null || uuid(v)
const timestamp = (v: unknown) => string(v) && /(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v))
function validSnapshot(v: unknown): boolean {
  if (v === null) return true
  if (!row(v) || !exact(v,['v','type','unit','value','parts','measuredAt','serviceTemplateId','serviceName','term','basis','rate','price'])
    || v.v !== 2 || !['area','length','count','none'].includes(String(v.type)) || !['sqft','linear_ft','count'].includes(String(v.unit))
    || !finite(v.value) || v.value < 0 || !timestamp(v.measuredAt) || !nullableId(v.serviceTemplateId) || !nullableString(v.serviceName)
    || !(v.term === null || ['one_time','weekly','biweekly','monthly','seasonal'].includes(String(v.term)))
    || !(v.basis === null || ['per_unit','flat'].includes(String(v.basis))) || !nullableNumber(v.rate) || !nullableNumber(v.price) || !Array.isArray(v.parts)) return false
  return v.parts.every(p => row(p) && (exact(p,['label','value']) || exact(p,['label','value','ring'])) && nullableString(p.label)
    && finite(p.value) && p.value >= 0 && (!Object.hasOwn(p,'ring') || (Array.isArray(p.ring) && p.ring.every(point => row(point)
      && exact(point,['lat','lng']) && finite(point.lat) && finite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180))))
}
/** One schema-and-correlation parser shared by the browser and future adapter.
 * It does no pricing or identity calculation and never accepts current server
 * rows in place of this operation's direct acknowledgement. */
export function parsePilotQuoteSaveReceipt(input: unknown, p: PendingQuoteSave): PilotQuoteSaveCommittedReceipt | null {
  const v = copyPilotQuoteSaveJson(input, 16 * 1024 * 1024)
  if (!row(v) || !exact(v,receiptKeys) || v.code !== 'committed' || v.owner_id !== p.owner || v.quote_id !== p.quoteId
    || v.client_operation_id !== p.clientOperationId || v.editor_generation !== p.editorGeneration
    || v.before_revision !== p.originalEditorRevision || !revision(v.after_revision) || v.after_revision === v.before_revision || typeof v.acceptance_current !== 'boolean') return null
  const q = v.quote, identity = v.identity
  if (!row(q) || !exact(q,quoteKeys) || q.id !== p.quoteId || q.user_id !== p.owner || !timestamp(q.updated_at)
    || !['quote_number','customer_name','address','service_type','status'].every(k => string(q[k]))
    || !['draft','sent','accepted','scheduled','completed','paid','declined'].includes(String(q.status))
    || !['customer_id','property_id','service_template_id','pricing_config_version_id','selected_option_id'].every(k => nullableId(q[k]))
    || !['notes','internal_notes','value_grade','price_source'].every(k => nullableString(q[k]))
    || !['initial_price','weekly_price','biweekly_price','monthly_price','measured_sqft','suggested_price','nearby_count','deposit_value','accepted_price'].every(k => nullableNumber(q[k]))
    || !['hours','crew_size','rate','travel_fee','overgrowth_multiplier','total','subtotal','man_hours'].every(k => finite(q[k]))
    || typeof q.custom_travel_required !== 'boolean' || typeof q.show_travel_separately !== 'boolean'
    || !(q.deposit_type === null || ['percent','fixed'].includes(String(q.deposit_type))) || !validSnapshot(q.measurement_snapshot)) return null
  if (!row(identity) || !exact(identity,identityKeys) || !['saved','unchanged'].includes(String(identity.code))
    || identity.quote_id !== p.quoteId || identity.customer_id !== q.customer_id || identity.property_id !== q.property_id
    || !string(identity.customer_name) || !timestamp(identity.updated_at) || typeof identity.created_customer !== 'boolean'
    || typeof identity.created_property !== 'boolean' || !(identity.matched_by === null || ['phone','email','address'].includes(String(identity.matched_by)))) return null
  const children = (values: unknown, option: boolean): boolean => {
    if (!Array.isArray(values)) return false
    const ids = new Set<string>()
    return values.every(r => {
      if (!row(r) || !exact(r, option ? optionKeys : serviceKeys) || !uuid(r.id) || ids.has(r.id)
        || r.user_id !== p.owner || r.quote_id !== p.quoteId || !timestamp(r.created_at) || !Number.isInteger(r.sort_order)) return false
      ids.add(r.id)
      return option
        ? timestamp(r.updated_at) && string(r.name) && nullableString(r.description) && finite(r.price) && typeof r.is_recommended === 'boolean'
        : string(r.service_type) && nullableId(r.service_template_id) && finite(r.quantity) && nullableString(r.unit) && finite(r.unit_price)
          && nullableNumber(r.est_minutes) && nullableNumber(r.discount_value) && nullableString(r.notes)
          && (r.discount_type === null || ['amount','percent'].includes(String(r.discount_type))) && ['service','material'].includes(String(r.kind))
    })
  }
  if (!children(v.options,true) || !children(v.services,false)) return null
  const m = v.measurement
  if (m !== null && (!row(m) || !exact(m,measurementKeys) || !uuid(m.id) || m.user_id !== p.owner || m.property_id !== q.property_id
    || !timestamp(m.created_at) || !timestamp(m.updated_at) || !timestamp(m.measured_at) || m.kind !== 'lawn' || m.unit !== 'sqft'
    || !finite(m.value) || !Array.isArray(m.shapes) || m.shapes.length !== 0 || m.source !== 'manual' || m.confidence !== 'high'
    || !string(m.confidence_reason) || typeof m.needs_review !== 'boolean' || !nullableString(m.notes))) return null
  return v as unknown as PilotQuoteSaveCommittedReceipt
}
