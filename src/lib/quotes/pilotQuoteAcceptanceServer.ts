import type { SupabaseClient } from '@supabase/supabase-js'
import type { PilotQuoteSaveAuth, PilotQuoteSaveRequestOptions } from './pilotQuoteSave'
import { copyPilotQuoteSaveJson } from './pilotQuoteSaveReceipt'
import { PilotQuoteSaveHttpRefusal, pilotQuoteSaveReply, boundedQuoteSaveRead, quoteSaveTimeout,
  validateQuoteSaveRequest, readQuoteSaveBody } from './pilotQuoteSaveHttp'
import { PILOT_ACCEPTANCE_BYTES, PILOT_ACCEPTANCE_NATIVE_REFUSALS, PilotAcceptanceRequestError,
  parsePilotAcceptancePreviewRequest, parsePilotAcceptanceCommitRequest, parsePilotAcceptancePreview,
  parsePilotAcceptanceCommitReply, type PilotAcceptancePreviewRequest, type PilotAcceptanceCommitRequest,
  type PilotAcceptanceRefusal } from './pilotQuoteAcceptance'

// Dormant server capability only. No routes, credentials, auth client or writes
// are instantiated here. Every public native function is service-only.
type Row = Record<string, unknown>
export type PilotAcceptanceAuthority = { owner: string; portalToken: null } | { owner: null; portalToken: string }
export interface PilotQuoteAcceptanceStore {
  preview(authority: PilotAcceptanceAuthority, request: PilotAcceptancePreviewRequest, signal: AbortSignal): Promise<unknown>
  commit(authority: PilotAcceptanceAuthority, request: PilotAcceptanceCommitRequest, signal: AbortSignal): Promise<unknown>
  reconcile(authority: PilotAcceptanceAuthority, request: PilotAcceptanceCommitRequest, signal: AbortSignal): Promise<unknown>
}
const row = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v)
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v)
const unavailable = () => new Error('acceptance_unavailable')
const internalBytes = 16 * 1024 * 1024
export function createPilotQuoteAcceptanceStore(sb: SupabaseClient): PilotQuoteAcceptanceStore {
  const rpc = async (name: 'pilot_quote_acceptance_preview' | 'pilot_quote_acceptance_commit' | 'pilot_quote_acceptance_reconcile', args: Row, signal: AbortSignal) => {
    if (signal.aborted) throw unavailable()
    const safe = copyPilotQuoteSaveJson(args,internalBytes + 16_384)
    if (!safe) throw unavailable()
    try {
      const response = await sb.rpc(name,safe).abortSignal(signal)
      if (response.error) throw unavailable()
      const value = copyPilotQuoteSaveJson(response.data,internalBytes + 1024)
      if (!row(value)) throw unavailable()
      return value
    } catch { throw unavailable() }
  }
  const base = (a: PilotAcceptanceAuthority, r: PilotAcceptancePreviewRequest) => ({p_owner:a.owner,p_portal_token:a.portalToken,p_quote:r.quoteId,p_option:r.optionId})
  const choice = (a: PilotAcceptanceAuthority, r: PilotAcceptanceCommitRequest) => ({...base(a,r),p_expected:r.expected,
    p_addons:r.addonIds,p_reason:r.reason,p_note:r.note})
  return {
    preview:(a,r,s)=>rpc('pilot_quote_acceptance_preview',base(a,r),s),
    commit:(a,r,s)=>rpc('pilot_quote_acceptance_commit',{...choice(a,r),p_terms_ack:r.termsAck},s),
    reconcile:(a,r,s)=>rpc('pilot_quote_acceptance_reconcile',choice(a,r),s),
  }
}
const refusalStatus: Record<PilotAcceptanceRefusal,number> = { invalid_request:400,unsupported_isolation:503,not_found:404,
  not_eligible:409,invalid_choice:409,quote_changed:409,method_not_allowed:405,forbidden_origin:403,
  request_too_large:413,unauthenticated:401,unavailable:503 }
function knownNative(value: unknown): PilotAcceptanceRefusal | null {
  return row(value) && Object.keys(value).length === 1 && typeof value.code === 'string'
    && (PILOT_ACCEPTANCE_NATIVE_REFUSALS as readonly string[]).includes(value.code) ? value.code as PilotAcceptanceRefusal : null
}
const correlation = (request: PilotAcceptanceCommitRequest) => ({clientOperationId:request.clientOperationId,previewRevision:request.expected.previewRevision})
const unknown = (request: PilotAcceptanceCommitRequest) => pilotQuoteSaveReply({code:'unknown',...correlation(request)},503)
const refused = (reason: PilotAcceptanceRefusal, request?: PilotAcceptanceCommitRequest) =>
  pilotQuoteSaveReply({code:'refused',...(request ? correlation(request) : {}),reason},refusalStatus[reason])
async function authority(auth: PilotQuoteSaveAuth, r: PilotAcceptancePreviewRequest, signal: AbortSignal, ms: number): Promise<PilotAcceptanceAuthority> {
  if (Object.hasOwn(r,'portalToken')) return {owner:null,portalToken:r.portalToken!}
  const user = await boundedQuoteSaveRead(()=>auth.getUser(),signal,ms)
  if (user.error || !user.data?.user || !uuid(user.data.user.id)) throw new PilotQuoteSaveHttpRefusal('unauthenticated',401)
  return {owner:user.data.user.id,portalToken:null}
}
function errorReason(error: unknown): PilotAcceptanceRefusal {
  if (error instanceof PilotAcceptanceRequestError) return error.code
  if (error instanceof PilotQuoteSaveHttpRefusal && Object.hasOwn(refusalStatus,error.code)) return error.code as PilotAcceptanceRefusal
  return 'unavailable'
}
async function handle(mode: 'preview' | 'commit' | 'reconcile', store: PilotQuoteAcceptanceStore, auth: PilotQuoteSaveAuth,
  request: Request, options: PilotQuoteSaveRequestOptions): Promise<Response> {
  let captured: PilotAcceptanceCommitRequest | undefined, invoked = false
  try {
    validateQuoteSaveRequest(request,options.trustedOrigin)
    const bodyMs = quoteSaveTimeout(options.bodyTimeoutMs,10_000), operationMs = quoteSaveTimeout(options.operationTimeoutMs,15_000)
    const r = mode === 'preview' ? await readQuoteSaveBody(request,bodyMs,parsePilotAcceptancePreviewRequest)
      : await readQuoteSaveBody(request,bodyMs,parsePilotAcceptanceCommitRequest)
    if (mode !== 'preview') captured = r as PilotAcceptanceCommitRequest
    const a = await authority(auth,r,request.signal,operationMs)
    if (request.signal.aborted) throw unavailable()
    const result = await boundedQuoteSaveRead(signal=>{
      invoked = true
      return mode === 'preview' ? store.preview(a,r,signal)
        : mode === 'commit' ? store.commit(a,captured!,signal) : store.reconcile(a,captured!,signal)
    },request.signal,operationMs)
    if (mode === 'reconcile') return unknown(captured!) // No positive native reconciliation exists.
    const safe = copyPilotQuoteSaveJson(result,internalBytes + 1024)
    if (!row(safe)) throw unavailable()
    const rejection = knownNative(safe)
    if (rejection) return refused(rejection,captured)
    if (mode === 'preview') {
      if (new TextEncoder().encode(JSON.stringify(safe)).length > PILOT_ACCEPTANCE_BYTES) return refused('request_too_large')
      const parsed = parsePilotAcceptancePreview(safe,r)
      if (!parsed) {
        // A structurally valid native projection can still exceed the future
        // browser request budget. Never truncate or authorize from cached data.
        if (safe.code === 'preview' && row(safe.expected)) {
          const candidate = {...r,expected:safe.expected,addonIds:row(safe.expected.offered) && row(safe.expected.offered.public)
            ? safe.expected.offered.public.included_addon_ids : [], reason:a.owner ? 'text_message' : null,note:null,termsAck:false,
          clientOperationId:'00000000-0000-4000-8000-000000000000'}
          if (new TextEncoder().encode(JSON.stringify(candidate)).length > PILOT_ACCEPTANCE_BYTES) return refused('request_too_large')
        }
        throw unavailable()
      }
      return pilotQuoteSaveReply(parsed)
    }
    const response = {code:'accepted',...correlation(captured!),receipt:safe}
    const parsed = parsePilotAcceptanceCommitReply(response,captured!,a.owner ?? undefined)
    if (!parsed || parsed.code !== 'accepted') return unknown(captured!)
    return pilotQuoteSaveReply(parsed)
  } catch (error) {
    if (captured && (invoked || mode === 'reconcile')) return unknown(captured)
    return refused(errorReason(error),captured)
  }
}
export const previewQuoteAcceptance = (store: PilotQuoteAcceptanceStore, auth: PilotQuoteSaveAuth, request: Request, options: PilotQuoteSaveRequestOptions) =>
  handle('preview',store,auth,request,options)
export const commitQuoteAcceptance = (store: PilotQuoteAcceptanceStore, auth: PilotQuoteSaveAuth, request: Request, options: PilotQuoteSaveRequestOptions) =>
  handle('commit',store,auth,request,options)
export const reconcileQuoteAcceptance = (store: PilotQuoteAcceptanceStore, auth: PilotQuoteSaveAuth, request: Request, options: PilotQuoteSaveRequestOptions) =>
  handle('reconcile',store,auth,request,options)
