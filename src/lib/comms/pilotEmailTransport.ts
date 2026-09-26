import { createHash, timingSafeEqual } from 'node:crypto'

// Dormant server adapter. Credentials must be resolved for this exact connection
// by the caller; deployment/founding-business environment values are never read.
export interface ClientEmailCredentials {
  connectionId: string
  accountScope: string
  credentialVersion: string
  secretRef: string
  apiKey: string
  webhookSecret: string
}

export interface FrozenEmailRequest {
  connectionId: string
  accountScope: string
  credentialVersion: string
  secretRef: string
  payloadJson: string
  payloadHash: string
  idempotencyKey: string
  /** Absolute Unix milliseconds; this adapter never extends the caller's lease. */
  deadline: number
}

type Options = { fetch?: typeof fetch; now?: () => number }
type Result = { code: 'accepted'; providerEmailId: string } | { code: 'unknown' | 'refused' | 'unavailable' }
const API = 'https://api.resend.com'
const MAX_RESPONSE = 128 * 1024
const MAX_PAYLOAD = 1024 * 1024
const TIMEOUT_MS = 10_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BINDINGS = ['connectionId', 'accountScope', 'credentialVersion', 'secretRef'] as const
const HEADER_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const MAILBOX = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !HEADER_CONTROL.test(value)
}

function credentialsValid(value: ClientEmailCredentials): boolean {
  return record(value) && BINDINGS.every(key => boundedString(value[key], 256) && value[key].trim() === value[key])
    && typeof value.apiKey === 'string' && /^re_[A-Za-z0-9_-]{6,256}$/.test(value.apiKey)
    && typeof value.webhookSecret === 'string' && /^[A-Za-z0-9_+/=-]{8,512}$/.test(value.webhookSecret)
}

function mailbox(value: unknown): value is string {
  return boundedString(value, 254) && MAILBOX.test(value)
}

function sender(value: unknown): boolean {
  if (mailbox(value)) return true
  if (!boundedString(value, 500)) return false
  const display = /^([^<>,;]+) <([^<>]+)>$/.exec(value)
  return !!display && !!display[1].trim() && mailbox(display[2])
}

function payloadValid(json: string): boolean {
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD) return false
  let body: unknown
  try { body = JSON.parse(json) } catch { return false }
  if (!record(body)) return false
  const allowed = new Set(['from', 'to', 'reply_to', 'subject', 'text', 'html'])
  if (Object.keys(body).some(key => !allowed.has(key))) return false
  // JSON.parse otherwise silently accepts duplicate envelope keys. Tokenize only
  // after parsing, retaining escaped string contents as one token.
  let depth = 0, keyExpected = false
  const keys = new Set<string>()
  for (const [token] of json.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)) {
    if (token === '{' || token === '[') { depth++; if (depth === 1) keyExpected = true }
    else if (token === '}' || token === ']') depth--
    else if (depth === 1 && token === ',') keyExpected = true
    else if (depth === 1 && keyExpected && token.startsWith('"')) {
      const key: string = JSON.parse(token)
      if (keys.has(key)) return false
      keys.add(key); keyExpected = false
    }
  }
  const to = Array.isArray(body.to) && body.to.length === 1 ? body.to[0] : body.to
  return sender(body.from) && mailbox(to) && mailbox(body.reply_to)
    && boundedString(body.subject, 500) && body.subject.trim().length > 0
    && typeof body.text === 'string' && body.text.trim().length > 0 && body.text.length <= 30_000
    && (body.html === undefined || (typeof body.html === 'string' && body.html.length > 0 && body.html.length <= 100_000))
}

async function readObject(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE)) throw new Error('Response limit')
  if (!response.body) throw new Error('Missing response')
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let bytes = 0, reads = 0
  try {
    while (true) {
      if (signal.aborted || ++reads > 4096) throw new Error('Response limit')
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_RESPONSE) throw new Error('Response limit')
      chunks.push(next.value)
    }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)))
    if (!record(body)) throw new Error('Invalid response')
    return body
  } finally {
    cancel()
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

async function requestObject(url: string, init: RequestInit, options: Options, deadline: number) {
  const now = options.now ?? Date.now
  const remaining = deadline - now()
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('Deadline')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const response = await (options.fetch ?? fetch)(url, {
          ...init, redirect: 'error', cache: 'no-store', signal: controller.signal,
        })
        if (response.redirected || (response.url && response.url !== url)) throw new Error('Unexpected response')
        const data = await readObject(response, controller.signal)
        if (controller.signal.aborted || !Number.isFinite(now()) || now() >= deadline) throw new Error('Deadline')
        return { status: response.status, data }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Deadline')) }, Math.min(TIMEOUT_MS, remaining))
      }),
    ])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/** POST uses the exact hash-checked bytes/key; callers own any retry decision. */
export async function sendClientEmail(request: FrozenEmailRequest, credentials: ClientEmailCredentials, options: Options = {}): Promise<Result> {
  try {
    if (!credentialsValid(credentials) || !record(request)
      || BINDINGS.some(key => request[key] !== credentials[key])) return { code: 'unavailable' }
    if (!Number.isFinite(request.deadline) || request.deadline <= (options.now ?? Date.now)()) return { code: 'unavailable' }
    if (!boundedString(request.idempotencyKey, 256) || !/^[A-Za-z0-9_./:-]+$/.test(request.idempotencyKey)
      || typeof request.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(request.payloadHash)
      || !payloadValid(request.payloadJson)) return { code: 'refused' }
    const hash = createHash('sha256').update(request.payloadJson, 'utf8').digest()
    if (!timingSafeEqual(hash, Buffer.from(request.payloadHash, 'hex'))) return { code: 'refused' }
    const response = await requestObject(`${API}/emails`, {
      method: 'POST', headers: { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': request.idempotencyKey },
      body: request.payloadJson,
    }, options, request.deadline)
    if (response.status >= 200 && response.status < 300 && typeof response.data.id === 'string' && UUID.test(response.data.id)) {
      return { code: 'accepted', providerEmailId: response.data.id }
    }
    // 408/409/429 and server/transport failures may follow provider acceptance.
    // Only a bounded, explicit client refusal is definitive; no retries here.
    if ([400, 401, 403, 404, 405, 413, 415, 422].includes(response.status)) return { code: 'refused' }
    return { code: 'unknown' }
  } catch { return { code: 'unknown' } }
}

/** Fetch only bounded received-email JSON; attachment/raw URLs are inert data. */
export async function retrieveClientEmail(providerEmailId: string, credentials: ClientEmailCredentials, options: Options = {}): Promise<Record<string, unknown> | null> {
  try {
    if (!credentialsValid(credentials) || typeof providerEmailId !== 'string' || !UUID.test(providerEmailId)) return null
    const now = options.now ?? Date.now
    const response = await requestObject(`${API}/emails/receiving/${providerEmailId}?html_format=cid`, {
      method: 'GET', headers: { Authorization: `Bearer ${credentials.apiKey}`, Accept: 'application/json' },
    }, options, now() + TIMEOUT_MS)
    return response.status >= 200 && response.status < 300 && response.data.id === providerEmailId ? response.data : null
  } catch { return null }
}
