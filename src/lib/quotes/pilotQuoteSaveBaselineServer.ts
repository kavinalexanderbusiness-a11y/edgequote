import type { Quote, QuoteOption, QuoteService } from '@/types'
import type { PilotQuoteSaveAuth, PilotQuoteSaveRequestOptions, PilotQuoteSaveStore } from './pilotQuoteSave'
import { parsePilotQuoteSaveEditorSnapshot, PILOT_QUOTE_SAVE_INTERNAL_BYTES, type PilotQuoteSaveEditorSnapshot } from './pilotQuoteSavePlan'
import { pilotQuoteSaveEditorDefaults } from './pilotQuoteSaveEditor'
import { parsePilotQuoteSaveBaseline, type PilotQuoteSaveBaseline } from './pilotQuoteSaveBaseline'
import { quoteSaveJsonCopy, PilotQuoteSavePlanError, validatePilotQuoteSaveDraftValues, PILOT_QUOTE_SAVE_REQUEST_BYTES } from './pilotQuoteSaveValues'
import { PilotQuoteSaveHttpRefusal as Refusal, pilotQuoteSaveReply as reply, boundedQuoteSaveRead as bounded,
  quoteSaveTimeout as duration, validateQuoteSaveRequest, readQuoteSaveBody } from './pilotQuoteSaveHttp'

// Dormant server loader. Only a snapshot capability is accepted: no planner,
// target read, identity preparation, ensure RPC or write can be called here.
type Row = Record<string, unknown>
type Binding = { ownerId: string; quoteId: string }
const row = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v)
const text = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0')
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const nullableNumber = (v: unknown) => v === null || finite(v)
const nullableText = (v: unknown) => v === null || text(v)
const nullableId = (v: unknown) => v === null || uuid(v)
const stamp = (v: unknown) => text(v) && v.length <= 80 && /(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v))
function insist(v: unknown): asserts v { if (!v) throw new Refusal('invalid_baseline', 503) }

/** Validate every native field the initializer consumes BEFORE its || / ?? /
 * Number / boolean defaults. Missing and malformed data never become zeros or
 * an empty replacement set. Unexposed native columns remain private. */
function validateSources(s: PilotQuoteSaveEditorSnapshot): void {
  const q = s.quote.row
  // Native quote_options_shape_guard forbids any stored options together with
  // any quote_services rows, including the primary row (baseline.sql:6642).
  insist(s.options.length === 0 || s.services.length === 0)
  insist(uuid(q.id) && uuid(q.user_id) && stamp(q.updated_at) && text(q.quote_number)
    && ['customer_name','address','service_type'].every(k => text(q[k]))
    && nullableId(q.customer_id) && nullableId(q.property_id) && nullableId(q.service_template_id)
    && ['initial_price','weekly_price','biweekly_price','monthly_price','measured_sqft','suggested_price','deposit_value'].every(k => nullableNumber(q[k]))
    && ['hours','crew_size','rate','travel_fee','overgrowth_multiplier'].every(k => finite(q[k])) && Number.isInteger(q.crew_size)
    && typeof q.custom_travel_required === 'boolean' && typeof q.show_travel_separately === 'boolean'
    && nullableText(q.notes) && nullableText(q.internal_notes)
    && (q.deposit_type === null || ['percent','fixed'].includes(String(q.deposit_type))))
  insist(q.service_template_id === null || s.templates.some(t => t.row.id === q.service_template_id))
  for (const { row: o } of s.options) insist(stamp(o.created_at) && stamp(o.updated_at) && text(o.name)
    && nullableText(o.description) && finite(o.price) && typeof o.is_recommended === 'boolean')
  for (const { row: line } of s.services) insist(stamp(line.created_at) && text(line.service_type) && nullableId(line.service_template_id)
    && (line.service_template_id === null || s.templates.some(t => t.row.id === line.service_template_id))
    && finite(line.quantity) && nullableText(line.unit) && finite(line.unit_price)
    && (line.est_minutes === null || Number.isInteger(line.est_minutes))
    && (line.discount_type === null || ['amount','percent'].includes(String(line.discount_type)))
    && nullableNumber(line.discount_value) && nullableText(line.notes) && ['service','material'].includes(String(line.kind)))
  // These source families affect the bound revision/current standing even
  // though their private content never enters the browser's edit form.
  for (const { row: addon } of s.addons) insist(stamp(addon.created_at) && stamp(addon.updated_at) && text(addon.name)
    && nullableText(addon.description) && finite(addon.price) && typeof addon.is_selected === 'boolean')
}
export function projectPilotQuoteSaveBaseline(input: unknown, binding: Binding): PilotQuoteSaveBaseline {
  const privateCopy = quoteSaveJsonCopy(input, PILOT_QUOTE_SAVE_INTERNAL_BYTES, 'invalid_snapshot', 'internal_too_large')
  const s = parsePilotQuoteSaveEditorSnapshot(privateCopy, binding)
  validateSources(s)
  const q = s.quote.row, selected = q.selected_option_id === null ? null : s.options.find(o => o.row.id === q.selected_option_id)?.row
  insist(q.selected_option_id === null || selected)
  const defaults = { customer_phone: '', customer_email: '', acquisition_source: '', value_grade: null, nearby_count: null,
    ...pilotQuoteSaveEditorDefaults(q as unknown as Quote, s.services.map(v => v.row as unknown as QuoteService), s.options.map(v => v.row as unknown as QuoteOption)) }
  quoteSaveJsonCopy(defaults, PILOT_QUOTE_SAVE_REQUEST_BYTES, 'invalid_snapshot', 'request_too_large')
  const values = validatePilotQuoteSaveDraftValues(defaults)
  insist(values)
  const baseline: PilotQuoteSaveBaseline = { version: 1, code: 'baseline', complete: true, ownerId: binding.ownerId, quoteId: binding.quoteId,
    editorRevision: s.editor_revision, quoteNumber: String(q.quote_number), quoteUpdatedAt: String(q.updated_at),
    selectedOption: selected ? { id: String(selected.id), name: String(selected.name) } : null,
    acceptance: { hasRecord: s.acceptance.latest !== null, current: s.acceptance.current }, values }
  quoteSaveJsonCopy(baseline, PILOT_QUOTE_SAVE_REQUEST_BYTES, 'invalid_snapshot', 'request_too_large')
  quoteSaveJsonCopy({ version: 1, quoteId: binding.quoteId, expectedEditorRevision: s.editor_revision,
    clientOperationId: '00000000-0000-4000-8000-000000000000', editorGeneration: 'g'.repeat(128), values },
  PILOT_QUOTE_SAVE_REQUEST_BYTES, 'invalid_intent', 'request_too_large')
  const parsed = parsePilotQuoteSaveBaseline(baseline, binding)
  insist(parsed)
  return parsed
}

export async function loadPilotQuoteSaveBaselineRequest(store: Pick<PilotQuoteSaveStore, 'snapshot'>, auth: PilotQuoteSaveAuth,
  request: Request, options: PilotQuoteSaveRequestOptions): Promise<Response> {
  try {
    validateQuoteSaveRequest(request, options.trustedOrigin)
    const bodyMs = duration(options.bodyTimeoutMs, 10_000), operationMs = duration(options.operationTimeoutMs, 15_000)
    const input = await readQuoteSaveBody(request, bodyMs, text => JSON.parse(text) as unknown)
    if (!row(input) || Object.keys(input).length !== 2 || input.version !== 1 || !uuid(input.quoteId)) throw new Refusal('invalid_request', 400)
    const session = await bounded(() => auth.getUser(), request.signal, operationMs)
    if (session.error || !session.data?.user || !uuid(session.data.user.id)) throw new Refusal('unauthenticated', 401)
    const binding = { ownerId: session.data.user.id, quoteId: input.quoteId }
    const snapshot = await bounded(signal => store.snapshot(binding.ownerId, binding.quoteId, signal), request.signal, operationMs)
    const safe = quoteSaveJsonCopy(snapshot, PILOT_QUOTE_SAVE_INTERNAL_BYTES, 'invalid_snapshot', 'internal_too_large')
    if (row(safe) && Object.keys(safe).length === 1) {
      if (safe.code === 'not_found') throw new Refusal('not_found', 404)
      if (safe.code === 'snapshot_too_large') throw new Refusal('baseline_too_large', 503)
      if (safe.code === 'unsupported_isolation') throw new Refusal('unavailable', 503)
    }
    if (request.signal.aborted) throw new Refusal('unavailable', 503)
    return reply(projectPilotQuoteSaveBaseline(safe, binding))
  } catch (error) {
    if (error instanceof Refusal) return reply({ code: error.code }, error.status)
    if (error instanceof PilotQuoteSavePlanError) return reply({ code: ['request_too_large','internal_too_large'].includes(error.code) ? 'baseline_too_large' : 'invalid_baseline' }, 503)
    return reply({ code: 'unavailable' }, 503)
  }
}
