import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildPilotQuoteSavePlan, parsePilotQuoteSaveIntent, PilotQuoteSavePlanError,
  PILOT_QUOTE_SAVE_INTERNAL_BYTES, PILOT_QUOTE_SAVE_REQUEST_BYTES,
  type PilotQuoteSaveIntent, type PilotQuoteSavePlan, type PilotQuoteSaveTargetRequest,
} from './pilotQuoteSavePlan'
import {
  copyPilotQuoteSaveJson, parsePilotQuoteSaveReceipt,
  type PendingQuoteSave, type PilotQuoteSaveCommittedReceipt,
} from './pilotQuoteSaveReceipt'

// Dormant SERVER adapter only: no route, credentials, live client or loader is
// created here. A future mount must supply verified getUser auth and a separate
// service client. The only write is the one complete transaction below.
type Row = Record<string, unknown>
export interface PilotQuoteSaveAuth {
  getUser(): Promise<{ data: { user: { id: string } | null }; error?: unknown }>
}
export interface PilotQuoteSaveStore {
  snapshot(owner: string, quote: string, signal: AbortSignal): Promise<unknown>
  targets(selection: PilotQuoteSaveTargetRequest, signal: AbortSignal): Promise<unknown>
  commit(owner: string, quote: string, plan: PilotQuoteSavePlan, signal: AbortSignal): Promise<unknown>
}
export interface PilotQuoteSaveRequestOptions {
  /** Trusted deployment configuration; never copy Host, Origin or request.url. */
  trustedOrigin: string
  bodyTimeoutMs?: number
  operationTimeoutMs?: number
}
const row = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v)
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v)
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]))
  return row(a) && row(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && same(a[k], b[k]))
}
class Refusal extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}
const reply = (body: Row | PilotQuoteSaveCommittedReceipt, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
})
const unavailable = () => new Error('quote_save_unavailable')

/** Exact Supabase signatures. Never forward SDK error details or create a
 * preparation write; aborting this transport does not establish DB rollback. */
export function createPilotQuoteSaveStore(sb: SupabaseClient): PilotQuoteSaveStore {
  const rpc = async (name: 'pilot_quote_save_snapshot' | 'pilot_quote_save_targets' | 'pilot_quote_save', args: Row, signal: AbortSignal) => {
    if (signal.aborted) throw unavailable()
    const safeArgs = copyPilotQuoteSaveJson(args, PILOT_QUOTE_SAVE_INTERNAL_BYTES + 1024)
    if (!safeArgs) throw unavailable()
    try {
      const result = await sb.rpc(name, safeArgs).abortSignal(signal)
      if (result.error) throw unavailable()
      const data = copyPilotQuoteSaveJson(result.data, PILOT_QUOTE_SAVE_INTERNAL_BYTES)
      if (!row(data)) throw unavailable()
      return data
    } catch { throw unavailable() }
  }
  return {
    snapshot: (owner, quote, signal) => rpc('pilot_quote_save_snapshot', { p_owner: owner, p_quote: quote }, signal),
    targets: (s, signal) => rpc('pilot_quote_save_targets', { p_owner: s.owner, p_quote: s.quote_id,
      p_expected_revision: s.expected_editor_revision, p_identity: s.identity,
      p_template_ids: s.template_ids, p_provenance_mode: s.provenance_mode }, signal),
    commit: (owner, quote, plan, signal) => rpc('pilot_quote_save', { p_owner: owner, p_quote: quote, p_plan: plan }, signal),
  }
}

// Bounded waits include injected transports that ignore cancellation. Their
// late result is consumed and never becomes an acknowledgement or a retry.
async function bounded<T>(task: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, ms: number): Promise<T> {
  if (parent.aborted) throw unavailable()
  const controller = new AbortController()
  let rejectAbort: (reason: Error) => void = () => {}
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject })
  const abort = () => { controller.abort(); rejectAbort(unavailable()) }
  parent.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, ms)
  try { return await Promise.race([Promise.resolve().then(() => {
    if (controller.signal.aborted) throw unavailable()
    return task(controller.signal)
  }), cancelled]) }
  finally { clearTimeout(timer); parent.removeEventListener('abort', abort) }
}
function duration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > 60_000) throw unavailable()
  return value
}
function validateRequest(request: Request, trustedOrigin: string): void {
  let configured: URL
  try { configured = new URL(trustedOrigin) } catch { throw unavailable() }
  if (!['https:', 'http:'].includes(configured.protocol) || configured.origin !== trustedOrigin) throw unavailable()
  if (request.method !== 'POST') throw new Refusal('method_not_allowed', 405)
  if (new URL(request.url).origin !== trustedOrigin || request.headers.get('origin') !== trustedOrigin
    || ![null, 'same-origin'].includes(request.headers.get('sec-fetch-site'))) throw new Refusal('forbidden_origin', 403)
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
    || ![null, 'identity'].includes(request.headers.get('content-encoding'))) throw new Refusal('invalid_request', 415)
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))) throw new Refusal('invalid_request', 400)
    if (Number(declared) > PILOT_QUOTE_SAVE_REQUEST_BYTES) throw new Refusal('request_too_large', 413)
  }
}
async function readIntent(request: Request, ms: number): Promise<PilotQuoteSaveIntent> {
  if (!request.body) throw new Refusal('invalid_request', 400)
  return bounded(async signal => {
    const reader = request.body!.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    let bytes = 0, body = '', complete = false
    try {
      while (true) {
        if (signal.aborted) throw unavailable()
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > PILOT_QUOTE_SAVE_REQUEST_BYTES) throw new Refusal('request_too_large', 413)
        body += decoder.decode(chunk.value, { stream: true })
      }
      body += decoder.decode()
      if (signal.aborted) throw unavailable()
      const declared = request.headers.get('content-length')
      if (declared !== null && Number(declared) !== bytes) throw new Refusal('invalid_request', 400)
      const intent = parsePilotQuoteSaveIntent(body)
      complete = true
      return intent
    } catch (error) {
      if (error instanceof Refusal || error instanceof PilotQuoteSavePlanError) throw error
      if (signal.aborted) throw unavailable()
      throw new Refusal('invalid_request', 400)
    } finally { signal.removeEventListener('abort', cancel); if (!complete) cancel(); reader.releaseLock() }
  }, request.signal, ms)
}

// These are exact pre-DML return objects in the pinned transaction. An SDK
// error (including SQL errors), unexpected keys or any unknown code is NOT
// proof of refusal after dispatch and stays unknown.
const refusalStatus: Record<string, number> = { not_found: 404, stale_editor: 409, stale_targets: 409,
  retained_customer_binding: 409, pricing_settings_unavailable: 409, invalid_plan: 409,
  unsupported_isolation: 503, snapshot_too_large: 503 }
function knownRefusal(value: unknown): Refusal | null {
  if (!row(value) || Object.keys(value).length !== 1 || typeof value.code !== 'string' || !Object.hasOwn(refusalStatus, value.code)) return null
  return new Refusal(value.code, refusalStatus[value.code])
}
function bindSnapshot(input: unknown, owner: string, intent: PilotQuoteSaveIntent): unknown {
  const v = copyPilotQuoteSaveJson(input, PILOT_QUOTE_SAVE_INTERNAL_BYTES)
  const refusal = knownRefusal(v)
  if (refusal) throw refusal
  if (!row(v) || !row(v.quote) || !row(v.quote.row) || !row(v.identity) || !row(v.identity.quote)
    || v.quote.row.id !== intent.quoteId || v.identity.quote.id !== intent.quoteId
    || v.quote.row.user_id !== owner || v.identity.quote.user_id !== owner) throw unavailable()
  return v
}

// Only these native columns coerce JSON decimal inputs to numeric(p,2). The
// disposable catalog proof pins their typmods. All other planned numbers bind
// exactly; in particular quote_services monetary/quantity columns are numeric
// WITHOUT a scale. This checks SQL storage representation, never quote pricing.
const quoteScaleTwo: Record<string, number> = { hours: 6, rate: 8, travel_fee: 8, overgrowth_multiplier: 4,
  initial_price: 10, weekly_price: 10, biweekly_price: 10, monthly_price: 10, deposit_value: 10 }
const zero = BigInt(0), one = BigInt(1), two = BigInt(2), ten = BigInt(10)
function decimalUnits(value: number, round: boolean): bigint | null {
  if (!Number.isFinite(value)) return null
  const [mantissa, exponent = '0'] = Math.abs(value).toString().split('e')
  const fraction = mantissa.split('.')[1]?.length ?? 0
  const coefficient = BigInt(mantissa.replace('.', ''))
  const shift = Number(exponent) - fraction + 2
  let units: bigint
  if (shift >= 0) units = coefficient * ten ** BigInt(shift)
  else {
    const divisor = ten ** BigInt(-shift), remainder = coefficient % divisor
    if (!round && remainder !== zero) return null
    units = coefficient / divisor + (round && remainder * two >= divisor ? one : zero)
  }
  return value < 0 ? -units : units
}
function storedValue(actual: unknown, expected: unknown, precision?: number): boolean {
  if (typeof expected !== 'number' || precision === undefined) return same(actual, expected)
  if (typeof actual !== 'number') return false
  const expectedUnits = decimalUnits(expected, true), actualUnits = decimalUnits(actual, false)
  return expectedUnits !== null && actualUnits !== null && expectedUnits === actualUnits
    && actualUnits < ten ** BigInt(precision) && actualUnits > -(ten ** BigInt(precision))
}
function sameMeasuredInstant(actual: unknown, expected: unknown): boolean {
  // JS Date stores milliseconds; do not truncate a different PG microsecond
  // instant into an apparently matching acknowledgement.
  const millis = (v: unknown): number | null => {
    if (typeof v !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(v)) return null
    const fractional = /\.(\d+)(?:Z|[+-]\d\d:\d\d)$/.exec(v)?.[1] ?? ''
    if (/[1-9]/.test(fractional.slice(3))) return null
    const instant = Date.parse(v)
    return Number.isFinite(instant) ? instant : null
  }
  const a = millis(actual), b = millis(expected)
  return a !== null && b !== null && a === b
}

/** The shared parser handles shape/correlation. This binds every planned
 * field to the acknowledgement, allowing only the pinned SQL type coercions.
 * Native generated total/subtotal/man_hours are not recalculated here. */
function receiptMatchesPlan(r: PilotQuoteSaveCommittedReceipt, plan: PilotQuoteSavePlan): boolean {
  const q = r.quote, before = plan.expected.editor.quote.row
  if (!Object.entries(plan.parent_patch).every(([k, v]) => storedValue(q[k], v, quoteScaleTwo[k]))) return false
  if (!Number.isInteger(q.crew_size) || !(q.nearby_count === null || Number.isInteger(q.nearby_count))) return false
  if (!['quote_number', 'status', 'selected_option_id', 'accepted_price'].every(k => same(q[k], before[k]))) return false
  const identity = plan.identity.resolved
  if (!Object.entries(identity).filter(([k]) => k !== 'address').every(([k, v]) => same(r.identity[k], v))) return false
  if (plan.provenance.mode === 'preserve') {
    if (!['price_source', 'pricing_config_version_id', 'value_grade', 'nearby_count'].every(k => same(q[k], before[k]))) return false
  } else if (q.price_source !== 'engine' || !uuid(q.pricing_config_version_id)) return false
  const childrenMatch = (actual: Row[], expected: Row[], typmods: Record<string, number> = {}) => actual.length === expected.length && expected.every((v, i) =>
    Object.entries(v).every(([k, value]) => storedValue(actual[i][k], value, typmods[k])))
  // The native primary line's omitted nullable attributes become explicit null.
  if (!childrenMatch(r.services, plan.services.map(v => ({ discount_type: null, discount_value: null, notes: null, ...v })))) return false
  if (plan.options.mode === 'preserve') {
    const original = plan.expected.editor.options.map(o => o.row)
    if (r.options.length !== original.length || r.options.some((o, i) => !Object.keys(o).every(k => same(o[k], original[i][k])))) return false
  } else if (!childrenMatch(r.options, plan.options.rows, { price: 10 })) return false
  if (plan.measurement === null) return r.measurement === null
  return r.measurement !== null && Object.entries(plan.measurement.payload).every(([k, v]) => k === 'measured_at'
    ? sameMeasuredInstant(r.measurement![k], v) : storedValue(r.measurement![k], v, k === 'value' ? 12 : undefined))
}

export async function savePilotQuoteSaveRequest(store: PilotQuoteSaveStore, auth: PilotQuoteSaveAuth, request: Request,
  options: PilotQuoteSaveRequestOptions): Promise<Response> {
  let dispatched = false
  try {
    validateRequest(request, options.trustedOrigin)
    const bodyMs = duration(options.bodyTimeoutMs, 10_000), operationMs = duration(options.operationTimeoutMs, 15_000)
    const intent = await readIntent(request, bodyMs)
    const session = await bounded(() => auth.getUser(), request.signal, operationMs)
    if (session.error || !session.data?.user || !uuid(session.data.user.id)) throw new Refusal('unauthenticated', 401)
    const owner = session.data.user.id
    const snapshot = bindSnapshot(await bounded(signal => store.snapshot(owner, intent.quoteId, signal), request.signal, operationMs), owner, intent)
    const plan = await buildPilotQuoteSavePlan(snapshot, intent, async selection => {
      if (selection.owner !== owner || selection.quote_id !== intent.quoteId || selection.expected_editor_revision !== intent.expectedEditorRevision) throw unavailable()
      const targets = await bounded(signal => store.targets(selection, signal), request.signal, operationMs)
      const refusal = knownRefusal(targets)
      if (refusal) throw refusal
      return targets
    })
    if (request.signal.aborted) throw unavailable()
    const pending: PendingQuoteSave = { version: 1, owner, quoteId: intent.quoteId, clientOperationId: intent.clientOperationId,
      editorGeneration: intent.editorGeneration, originalEditorRevision: intent.expectedEditorRevision,
      submittedValues: intent.values, submittedSerialization: JSON.stringify(intent.values), stagedAt: Date.now(), state: 'pending' }
    dispatched = true
    const outcome = await bounded(signal => store.commit(owner, intent.quoteId, plan, signal), request.signal, operationMs)
    const safeOutcome = copyPilotQuoteSaveJson(outcome, PILOT_QUOTE_SAVE_INTERNAL_BYTES)
    const refusal = knownRefusal(safeOutcome)
    if (refusal) return reply({ code: refusal.code }, refusal.status)
    const receipt = parsePilotQuoteSaveReceipt(safeOutcome, pending)
    if (!receipt || !receiptMatchesPlan(receipt, plan)) return reply({ code: 'unknown' }, 503)
    return reply(receipt)
  } catch (error) {
    if (dispatched) return reply({ code: 'unknown' }, 503)
    if (error instanceof Refusal) return reply({ code: error.code }, error.status)
    if (error instanceof PilotQuoteSavePlanError) {
      if (error.code === 'request_too_large') return reply({ code: error.code }, 413)
      if (['invalid_intent', 'invalid_options', 'invalid_deposit'].includes(error.code)) return reply({ code: 'invalid_request' }, 400)
      if (['stale_editor', 'stale_targets', 'pricing_settings_unavailable'].includes(error.code)) return reply({ code: error.code }, 409)
    }
    return reply({ code: 'unavailable' }, 503)
  }
}
