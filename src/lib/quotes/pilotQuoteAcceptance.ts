import { ON_BEHALF_REASONS, type OnBehalfReason } from '../quoteAcceptance'
import { quoteSaveJsonCopy } from './pilotQuoteSaveValues'

// Browser-safe dormant wire. Native SQL remains the pricing/consent authority.
export const PILOT_ACCEPTANCE_BYTES = 200_000
export const PILOT_ACCEPTANCE_TOKEN_BYTES = 10_000
export type PilotAcceptancePreviewRequest = { version: 1; quoteId: string; optionId: string | null; portalToken?: string }
export type PilotAcceptanceOption = { id: string; name: string; description: string | null; price: number; sort_order: number; is_recommended: boolean }
export type PilotAcceptanceService = { id: string; service_type: string; quantity: number; unit: string | null; unit_price: number;
  est_minutes: number | null; discount_type: 'amount' | 'percent' | null; discount_value: number | null; notes: string | null;
  kind: 'service' | 'material'; sort_order: number }
export type PilotAcceptanceAddon = { id: string; name: string; price: number; is_selected: boolean; sort_order: number }
export type PilotAcceptanceDocument = {
  quote_id: string; customer_name: string; quote_number: string; address: string; service_type: string; notes: string | null;
  status: 'draft' | 'sent'; valid_until: string | null; initial_price: number | null; travel_fee: number | null;
  addons_total: number | null; total: number | null; weekly_price: number | null; biweekly_price: number | null; monthly_price: number | null;
  deposit_type: 'percent' | 'fixed' | null; deposit_value: number | null; selected_option_id: string | null;
  options: PilotAcceptanceOption[]; services: PilotAcceptanceService[]; addons: PilotAcceptanceAddon[];
  included_addon_ids: string[]; offered_option_id: string | null; accepted_amount: number;
  terms_text: string | null; gst_percent: number | null; company_name: string | null; no_charge: boolean;
}
export type PilotAcceptanceExpected = { version: 1; quoteId: string; previewRevision: string;
  priorAcceptanceId: string | null; priorAcceptanceSeq: number | null;
  offered: { public: PilotAcceptanceDocument; authorityFence: string } }
export type PilotAcceptanceCommitRequest = PilotAcceptancePreviewRequest & { expected: PilotAcceptanceExpected; addonIds: string[];
  reason: OnBehalfReason | null; note: string | null; termsAck: boolean; clientOperationId: string }
export type PilotAcceptanceReceipt = { code: 'accepted'; quote_id: string; acceptance_id: string; acceptance_seq: number;
  kind: 'customer' | 'owner_on_behalf'; source: 'portal' | 'dashboard'; actor_id: string; customer_id: string | null;
  accepted_amount: number; selected_option_id: string | null; addon_ids: string[]; document_fingerprint: string;
  terms_fingerprint: string | null; previous_acceptance_id: string | null }
export const PILOT_ACCEPTANCE_NATIVE_REFUSALS = ['invalid_request','unsupported_isolation','not_found','not_eligible','invalid_choice','quote_changed','forbidden'] as const
export const PILOT_ACCEPTANCE_HTTP_REFUSALS = ['method_not_allowed','forbidden_origin','invalid_request','request_too_large','unauthenticated','forbidden','unavailable'] as const
export type PilotAcceptanceRefusal = typeof PILOT_ACCEPTANCE_NATIVE_REFUSALS[number] | typeof PILOT_ACCEPTANCE_HTTP_REFUSALS[number]
export type PilotAcceptancePreviewReply = { code: 'preview'; expected: PilotAcceptanceExpected } | { code: 'refused'; reason: PilotAcceptanceRefusal }
type Correlation = { clientOperationId: string; previewRevision: string }
export type PilotAcceptanceCommitReply = Correlation & ({ code: 'accepted'; receipt: PilotAcceptanceReceipt }
  | { code: 'refused'; reason: PilotAcceptanceRefusal } | { code: 'unknown' })
export interface PilotQuoteAcceptanceTransport {
  preview(request: PilotAcceptancePreviewRequest, signal: AbortSignal): Promise<unknown>
  commit(request: PilotAcceptanceCommitRequest, signal: AbortSignal): Promise<unknown>
  reconcile(request: PilotAcceptanceCommitRequest, signal: AbortSignal): Promise<unknown>
}
export class PilotAcceptanceRequestError extends Error {
  constructor(readonly code: 'invalid_request' | 'request_too_large') { super(code) }
}
type Row = Record<string, unknown>
const row = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v)
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v)
const hex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)
const text = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0')
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const integer = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v) && v >= -2147483648 && v <= 2147483647
const nullText = (v: unknown) => v === null || text(v)
const nullNumber = (v: unknown) => v === null || finite(v)
const nullId = (v: unknown) => v === null || uuid(v)
const exact = (v: Row, keys: readonly string[], optional: readonly string[] = []) => keys.every(k => Object.hasOwn(v,k))
  && Object.keys(v).every(k => keys.includes(k) || optional.includes(k))
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id,i) => id === b[i])
const refusal = (v: unknown): v is PilotAcceptanceRefusal => typeof v === 'string'
  && ([...PILOT_ACCEPTANCE_NATIVE_REFUSALS,...PILOT_ACCEPTANCE_HTTP_REFUSALS] as readonly string[]).includes(v)
function requireThat(v: unknown): asserts v { if (!v) throw new PilotAcceptanceRequestError('invalid_request') }
function copy(input: unknown, limit = PILOT_ACCEPTANCE_BYTES): unknown {
  try { return quoteSaveJsonCopy(input,limit,'invalid_intent','request_too_large') }
  catch (error) { throw new PilotAcceptanceRequestError((error as {code?:string}).code === 'request_too_large' ? 'request_too_large' : 'invalid_request') }
}
function inputCopy(input: unknown): unknown {
  if (typeof input !== 'string') return copy(input)
  if (new TextEncoder().encode(input).length > PILOT_ACCEPTANCE_BYTES) throw new PilotAcceptanceRequestError('request_too_large')
  try { return copy(JSON.parse(input)) } catch (error) { if (error instanceof PilotAcceptanceRequestError) throw error; throw new PilotAcceptanceRequestError('invalid_request') }
}
const previewKeys = ['version','quoteId','optionId']
const commitKeys = [...previewKeys,'expected','addonIds','reason','note','termsAck','clientOperationId']
function previewFields(v: Row): void {
  requireThat(v.version === 1 && uuid(v.quoteId) && nullId(v.optionId))
  if (Object.hasOwn(v,'portalToken')) requireThat(text(v.portalToken) && v.portalToken.length > 0
    && new TextEncoder().encode(v.portalToken).length <= PILOT_ACCEPTANCE_TOKEN_BYTES)
}
export function parsePilotAcceptancePreviewRequest(input: unknown): PilotAcceptancePreviewRequest {
  const v = inputCopy(input); requireThat(row(v) && exact(v,previewKeys,['portalToken'])); previewFields(v)
  return v as PilotAcceptancePreviewRequest
}
function ordered(v: unknown, fields: string[], validate: (r: Row) => boolean): v is Row[] {
  if (!Array.isArray(v)) return false
  const ids = new Set<string>(); let prior: Row | undefined
  for (const r of v) {
    if (!row(r) || !exact(r,fields) || !uuid(r.id) || ids.has(r.id) || !integer(r.sort_order) || !validate(r)) return false
    if (prior && (Number(prior.sort_order) > r.sort_order || (prior.sort_order === r.sort_order && String(prior.id) >= r.id))) return false
    ids.add(r.id); prior = r
  }
  return true
}
function expectedFields(v: unknown, request: PilotAcceptancePreviewRequest): v is PilotAcceptanceExpected {
  if (!row(v) || !exact(v,['version','quoteId','previewRevision','priorAcceptanceId','priorAcceptanceSeq','offered'])
    || v.version !== 1 || v.quoteId !== request.quoteId || !hex(v.previewRevision) || !nullId(v.priorAcceptanceId)
    || !(v.priorAcceptanceId === null ? v.priorAcceptanceSeq === null : integer(v.priorAcceptanceSeq) && v.priorAcceptanceSeq > 0)
    || !row(v.offered) || !exact(v.offered,['public','authorityFence']) || !hex(v.offered.authorityFence)) return false
  const p = v.offered.public
  if (!row(p) || !exact(p,['quote_id','customer_name','quote_number','address','service_type','notes','status','valid_until',
    'initial_price','travel_fee','addons_total','total','weekly_price','biweekly_price','monthly_price','deposit_type','deposit_value',
    'selected_option_id','options','services','addons','included_addon_ids','offered_option_id','accepted_amount','terms_text','gst_percent','company_name','no_charge'])
    || p.quote_id !== request.quoteId || !['customer_name','quote_number','address','service_type'].every(k=>text(p[k]))
    || !['notes','terms_text','company_name'].every(k=>nullText(p[k])) || !['draft','sent'].includes(String(p.status))
    || (Object.hasOwn(request,'portalToken') && p.status !== 'sent')
    || !(p.valid_until === null || text(p.valid_until) && /^\d{4}-\d{2}-\d{2}$/.test(p.valid_until) && Number.isFinite(Date.parse(p.valid_until)))
    || !['initial_price','travel_fee','addons_total','total','weekly_price','biweekly_price','monthly_price','deposit_value','gst_percent'].every(k=>nullNumber(p[k]))
    || ![null,'percent','fixed'].includes(p.deposit_type as null|string) || !finite(p.accepted_amount) || typeof p.no_charge !== 'boolean'
    || !nullId(p.selected_option_id) || p.offered_option_id !== request.optionId) return false
  if (!ordered(p.options,['id','name','description','price','sort_order','is_recommended'],o=>text(o.name) && nullText(o.description)
    && finite(o.price) && o.price >= 0 && typeof o.is_recommended === 'boolean')
    || !ordered(p.services,['id','service_type','quantity','unit','unit_price','est_minutes','discount_type','discount_value','notes','kind','sort_order'],s=>text(s.service_type)
      && finite(s.quantity) && finite(s.unit_price) && nullText(s.unit) && nullText(s.notes) && nullNumber(s.discount_value)
      && (s.est_minutes === null || integer(s.est_minutes)) && [null,'amount','percent'].includes(s.discount_type as null|string) && ['service','material'].includes(String(s.kind)))
    || !ordered(p.addons,['id','name','price','is_selected','sort_order'],a=>text(a.name) && finite(a.price) && a.price >= 0 && typeof a.is_selected === 'boolean')) return false
  if (p.options.length > 4 || p.options.length > 0 && p.services.length > 0
    || (p.options.length > 0 ? !p.options.some(o=>o.id === request.optionId) : request.optionId !== null)
    || (p.selected_option_id !== null && !p.options.some(o=>o.id === p.selected_option_id))) return false
  if (!Array.isArray(p.included_addon_ids) || !p.included_addon_ids.every(uuid)) return false
  return sameIds(p.included_addon_ids,p.addons.filter(a=>a.is_selected).map(a=>String(a.id)).sort())
}
export function parsePilotAcceptanceCommitRequest(input: unknown): PilotAcceptanceCommitRequest {
  const v = inputCopy(input); requireThat(row(v) && exact(v,commitKeys,['portalToken'])); previewFields(v)
  requireThat(uuid(v.clientOperationId) && typeof v.termsAck === 'boolean' && nullText(v.note))
  requireThat(Object.hasOwn(v,'portalToken') ? v.reason === null && v.note === null : ON_BEHALF_REASONS.some(r=>r.value === v.reason))
  requireThat(new TextEncoder().encode(String(v.reason ?? '') + String(v.note ?? '')).length <= PILOT_ACCEPTANCE_BYTES)
  requireThat(expectedFields(v.expected,v as PilotAcceptancePreviewRequest) && Array.isArray(v.addonIds) && v.addonIds.every(uuid)
    && sameIds(v.addonIds,v.expected.offered.public.included_addon_ids))
  return v as PilotAcceptanceCommitRequest
}
export function buildPilotAcceptanceCommitRequest(request: PilotAcceptancePreviewRequest, expected: PilotAcceptanceExpected,
  choice: Pick<PilotAcceptanceCommitRequest,'addonIds'|'reason'|'note'|'termsAck'|'clientOperationId'>): PilotAcceptanceCommitRequest {
  const safeRequest = parsePilotAcceptancePreviewRequest(request), safeChoice = copy(choice)
  requireThat(row(safeChoice) && exact(safeChoice,['addonIds','reason','note','termsAck','clientOperationId']))
  const note = typeof safeChoice.note === 'string' ? safeChoice.note.trim() || null : safeChoice.note
  return parsePilotAcceptanceCommitRequest({...safeRequest,expected,...safeChoice,note})
}
export function canFitPilotAcceptanceCommit(request: PilotAcceptancePreviewRequest, expected: PilotAcceptanceExpected): boolean {
  try { const req = parsePilotAcceptancePreviewRequest(request), exp = copy(expected); requireThat(expectedFields(exp,req))
    parsePilotAcceptanceCommitRequest({...req,expected:exp,addonIds:exp.offered.public.included_addon_ids,
    reason:Object.hasOwn(req,'portalToken') ? null : 'text_message',note:null,termsAck:false,
    clientOperationId:'00000000-0000-4000-8000-000000000000'}); return true } catch { return false }
}
export function parsePilotAcceptancePreview(raw: unknown, request: PilotAcceptancePreviewRequest): PilotAcceptancePreviewReply | null {
  try {
    const req = parsePilotAcceptancePreviewRequest(request), v = copy(raw)
    if (row(v) && exact(v,['code','reason']) && v.code === 'refused' && refusal(v.reason)) return v as PilotAcceptancePreviewReply
    if (!row(v) || !exact(v,['code','expected']) || v.code !== 'preview' || !expectedFields(v.expected,req) || !canFitPilotAcceptanceCommit(req,v.expected)) return null
    return v as PilotAcceptancePreviewReply
  } catch { return null }
}
function receiptFields(v: unknown, r: PilotAcceptanceCommitRequest, ownerId?: string): v is PilotAcceptanceReceipt {
  if (!row(v) || !exact(v,['code','quote_id','acceptance_id','acceptance_seq','kind','source','actor_id','customer_id','accepted_amount',
    'selected_option_id','addon_ids','document_fingerprint','terms_fingerprint','previous_acceptance_id']) || v.code !== 'accepted'
    || v.quote_id !== r.quoteId || !uuid(v.acceptance_id) || v.acceptance_id === r.expected.priorAcceptanceId
    || v.acceptance_seq !== (r.expected.priorAcceptanceSeq ?? 0) + 1 || !integer(v.acceptance_seq) || !uuid(v.actor_id) || !nullId(v.customer_id)
    || v.accepted_amount !== r.expected.offered.public.accepted_amount || !finite(v.accepted_amount) || v.accepted_amount < 0
    || v.selected_option_id !== r.optionId || !Array.isArray(v.addon_ids) || !v.addon_ids.every(uuid) || !sameIds(v.addon_ids,r.addonIds)
    || !hex(v.document_fingerprint) || !(v.terms_fingerprint === null || hex(v.terms_fingerprint))
    || v.previous_acceptance_id !== r.expected.priorAcceptanceId) return false
  return Object.hasOwn(r,'portalToken') ? v.kind === 'customer' && v.source === 'portal' && uuid(v.customer_id) && v.actor_id === v.customer_id
    : v.kind === 'owner_on_behalf' && v.source === 'dashboard' && uuid(ownerId) && v.actor_id === ownerId
}
export function parsePilotAcceptanceCommitReply(raw: unknown, request: PilotAcceptanceCommitRequest, ownerId?: string): PilotAcceptanceCommitReply | null {
  try {
    const req = parsePilotAcceptanceCommitRequest(request), v = copy(raw)
    if (!row(v) || v.clientOperationId !== req.clientOperationId || v.previewRevision !== req.expected.previewRevision) return null
    if (v.code === 'unknown' && exact(v,['code','clientOperationId','previewRevision'])) return v as PilotAcceptanceCommitReply
    if (v.code === 'refused' && exact(v,['code','clientOperationId','previewRevision','reason']) && refusal(v.reason)) return v as PilotAcceptanceCommitReply
    if (v.code === 'accepted' && exact(v,['code','clientOperationId','previewRevision','receipt']) && receiptFields(v.receipt,req,ownerId)) return v as PilotAcceptanceCommitReply
    return null
  } catch { return null }
}
export function pilotAcceptanceRefusalMessage(reason: PilotAcceptanceRefusal): string {
  const messages: Record<PilotAcceptanceRefusal,string> = {
    invalid_request:'This confirmation could not be read. Review the quote again.', unsupported_isolation:'Acceptance is temporarily unavailable.',
    not_found:'This quote is no longer available to this account or portal.', not_eligible:'This quote cannot be accepted in its current state.',
    invalid_choice:'That option or included extra has changed. Review the quote again.', quote_changed:'The quote changed. Review the new version before accepting.',
    method_not_allowed:'This confirmation could not be sent.', forbidden_origin:'This confirmation must be sent from the current site.',
    request_too_large:'This confirmation is too large to send. Keep your notes and review the quote.',
    unauthenticated:'Sign in again before recording acceptance.', unavailable:'The confirmation could not be loaded. Try again before accepting.',
    forbidden:'Only a verified business owner can record acceptance on behalf of a customer.',
  }
  return messages[reason]
}
