import { PilotQuoteSavePlanError, PILOT_QUOTE_SAVE_REQUEST_BYTES } from './pilotQuoteSaveValues'

// Shared dormant SERVER request policy. No authentication, data access or writes.
type Row = Record<string, unknown>
export class PilotQuoteSaveHttpRefusal extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}
export const pilotQuoteSaveReply = (body: Row, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
})
export const pilotQuoteSaveUnavailable = () => new Error('quote_save_unavailable')

// Bounded waits include injected transports that ignore cancellation. Their
// late result is consumed and never becomes an acknowledgement or a retry.
export async function boundedQuoteSaveRead<T>(task: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, ms: number): Promise<T> {
  if (parent.aborted) throw pilotQuoteSaveUnavailable()
  const controller = new AbortController()
  let rejectAbort: (reason: Error) => void = () => {}
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject })
  const abort = () => { controller.abort(); rejectAbort(pilotQuoteSaveUnavailable()) }
  parent.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, ms)
  try { return await Promise.race([Promise.resolve().then(() => {
    if (controller.signal.aborted) throw pilotQuoteSaveUnavailable()
    return task(controller.signal)
  }), cancelled]) }
  finally { clearTimeout(timer); parent.removeEventListener('abort', abort) }
}
export function quoteSaveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > 60_000) throw pilotQuoteSaveUnavailable()
  return value
}
export function validateQuoteSaveRequest(request: Request, trustedOrigin: string): void {
  let configured: URL
  try { configured = new URL(trustedOrigin) } catch { throw pilotQuoteSaveUnavailable() }
  if (!['https:', 'http:'].includes(configured.protocol) || configured.origin !== trustedOrigin) throw pilotQuoteSaveUnavailable()
  if (request.method !== 'POST') throw new PilotQuoteSaveHttpRefusal('method_not_allowed', 405)
  if (new URL(request.url).origin !== trustedOrigin || request.headers.get('origin') !== trustedOrigin
    || ![null, 'same-origin'].includes(request.headers.get('sec-fetch-site'))) throw new PilotQuoteSaveHttpRefusal('forbidden_origin', 403)
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
    || ![null, 'identity'].includes(request.headers.get('content-encoding'))) throw new PilotQuoteSaveHttpRefusal('invalid_request', 415)
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))) throw new PilotQuoteSaveHttpRefusal('invalid_request', 400)
    if (Number(declared) > PILOT_QUOTE_SAVE_REQUEST_BYTES) throw new PilotQuoteSaveHttpRefusal('request_too_large', 413)
  }
}
export async function readQuoteSaveBody<T>(request: Request, ms: number, parse: (text: string) => T): Promise<T> {
  if (!request.body) throw new PilotQuoteSaveHttpRefusal('invalid_request', 400)
  return boundedQuoteSaveRead(async signal => {
    const reader = request.body!.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    let bytes = 0, body = '', complete = false
    try {
      while (true) {
        if (signal.aborted) throw pilotQuoteSaveUnavailable()
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > PILOT_QUOTE_SAVE_REQUEST_BYTES) throw new PilotQuoteSaveHttpRefusal('request_too_large', 413)
        body += decoder.decode(chunk.value, { stream: true })
      }
      body += decoder.decode()
      if (signal.aborted) throw pilotQuoteSaveUnavailable()
      const declared = request.headers.get('content-length')
      if (declared !== null && Number(declared) !== bytes) throw new PilotQuoteSaveHttpRefusal('invalid_request', 400)
      const intent = parse(body)
      complete = true
      return intent
    } catch (error) {
      if (error instanceof PilotQuoteSaveHttpRefusal || error instanceof PilotQuoteSavePlanError) throw error
      if (signal.aborted) throw pilotQuoteSaveUnavailable()
      throw new PilotQuoteSaveHttpRefusal('invalid_request', 400)
    } finally { signal.removeEventListener('abort', cancel); if (!complete) cancel(); reader.releaseLock() }
  }, request.signal, ms)
}
