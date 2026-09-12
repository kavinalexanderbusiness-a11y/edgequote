import { createHmac, timingSafeEqual } from 'node:crypto'
import { credentialsMatch, type PilotEmailRuntime } from './pilotEmailAttempt'
import { record, uuid } from './pilotEmailStore'
import { retrieveClientEmail } from './pilotEmailTransport'

const MAX_WEBHOOK_BYTES = 128 * 1024
const EVENTS = new Set(['email.received', 'email.sent', 'email.delivered', 'email.delivery_delayed', 'email.opened', 'email.clicked', 'email.bounced', 'email.complained'])

// The event URL only selects a candidate connection. Authorization is the raw
// signature from that exact client's webhook secret, never an owner in JSON.
export function verifyClientEmailSignature(raw: Uint8Array, headers: Headers, secret: string, now = Date.now()): boolean {
  const id = headers.get('svix-id'), timestamp = headers.get('svix-timestamp'), signatures = headers.get('svix-signature')
  if (!(raw instanceof Uint8Array) || raw.byteLength > MAX_WEBHOOK_BYTES || !Number.isFinite(now)
    || !id || !/^[A-Za-z0-9_-]{1,200}$/.test(id) || !timestamp || !/^\d{1,12}$/.test(timestamp)
    || Math.abs(now / 1000 - Number(timestamp)) > 300 || !signatures || signatures.length > 2048
    || typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return false
  const encoded = secret.slice(6), key = Buffer.from(encoded, 'base64')
  if (key.length < 16 || key.length > 128 || key.toString('base64') !== encoded) return false
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(raw).digest()
  return signatures.split(' ').some(part => {
    const match = /^v1,([A-Za-z0-9+/]{43}=)$/.exec(part)
    if (!match) return false
    const actual = Buffer.from(match[1], 'base64')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  })
}

export function emailMailbox(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512 || /[\r\n]/.test(value)) return null
  const trimmed = value.trim()
  const match = /^[^<>]*<([^<>]+)>$/.exec(trimmed)
  const address = (match ? match[1] : trimmed).trim()
  return address.length <= 254 && /^[^\s<>@,;:]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(address)
    ? address.toLowerCase() : null
}

function replyToken(to: unknown, domain: string): string | null {
  if (!Array.isArray(to) || to.length < 1 || to.length > 50) return null
  const tokens = new Set<string>()
  for (const value of to) {
    const address = emailMailbox(value)
    if (!address) return null
    const at = address.lastIndexOf('@'), local = address.slice(0, at)
    if (address.slice(at + 1) === domain.toLowerCase() && /^[a-f0-9]{48}$/.test(local)) tokens.add(local)
  }
  return tokens.size === 1 ? [...tokens][0] : null
}

async function readRaw(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return null
  const length = request.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_WEBHOOK_BYTES)) return null
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let total = 0, timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => { void reader.cancel().catch(() => {}); resolve(null) }, 10_000)
  })
  const read = async () => {
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) return Buffer.concat(chunks, total)
        total += part.value.byteLength
        if (total > MAX_WEBHOOK_BYTES) { await reader.cancel(); return null }
        chunks.push(part.value)
      }
    } catch { return null }
  }
  try { return await Promise.race([read(), timeout]) } finally { clearTimeout(timer) }
}

// Framework-independent actual request handler, deliberately not mounted by an
// app route. Activation and a real recovery/owner-review path require a separate
// approved operational plan. Return retryable failures when work is unfinished.
export async function processPilotEmailWebhook(runtime: PilotEmailRuntime, request: Request, connectionId: string): Promise<{ status: number }> {
  if (request.method !== 'POST') return { status: 405 }
  if (!uuid(connectionId)) return { status: 404 }
  const { store } = runtime
  let eventId: string | null = null, fence: number | null = null
  const release = async (code: 'content_unavailable' | 'metadata_mismatch' | 'store_failed') => {
    if (eventId && fence !== null) {
      try { await store.rpc('pilot_email_fail_event', { p_event: eventId, p_fence: fence, p_code: code }) } catch { /* Lease expiry permits recovery. */ }
    }
  }
  try {
    const connection = await store.connection(connectionId)
    if (!connection || connection.id !== connectionId || connection.state === 'off') return { status: 404 }
    const credentials = await runtime.credentials(connection)
    if (!credentialsMatch(connection, credentials)) return { status: 503 }
    const raw = await readRaw(request)
    if (!raw) return { status: 413 }
    if (!verifyClientEmailSignature(raw, request.headers, credentials.webhookSecret, (runtime.now ?? Date.now)())) return { status: 403 }
    let body
    try { body = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))) } catch { return { status: 400 } }
    if (!body || typeof body.type !== 'string') return { status: 400 }
    if (!EVENTS.has(body.type)) return { status: 204 }
    const data = record(body.data)
    if (!data || !uuid(data.email_id) || typeof body.created_at !== 'string' || !Number.isFinite(Date.parse(body.created_at))) return { status: 400 }
    const token = body.type === 'email.received' ? replyToken(data.to, connection.receiving_domain) : null
    // The durable route hold commits BEFORE retrieving any email content. A
    // temporary provider outage or mismatched sender cannot allow another step.
    const claim = await store.rpc('pilot_email_claim_event', {
      p_connection: connectionId, p_event_id: request.headers.get('svix-id'), p_type: body.type,
      p_provider_email_id: data.email_id, p_route_token: token,
    })
    if (claim.code === 'completed' || claim.code === 'needs_review') return { status: 204 }
    if (claim.code !== 'claimed' || !uuid(claim.event_id) || !Number.isSafeInteger(claim.fence)
      || Number(claim.fence) < 1 || claim.connection_id !== connectionId
      || claim.event_type !== body.type || claim.provider_email_id !== data.email_id) return { status: 503 }
    eventId = claim.event_id; fence = Number(claim.fence)
    let sender: string | null = null, text: string | null = null, rfc: string | null = null, occurred = body.created_at
    if (body.type === 'email.received') {
      const received = await retrieveClientEmail(data.email_id, credentials, { fetch: runtime.http, now: runtime.now })
      if (!received) { await release('content_unavailable'); return { status: 503 } }
      sender = emailMailbox(received.from)
      if (!token || received.id !== data.email_id || !sender || sender !== emailMailbox(data.from)
        || replyToken(received.to, connection.receiving_domain) !== token
        || typeof received.created_at !== 'string' || !Number.isFinite(Date.parse(received.created_at))) {
        await release('metadata_mismatch'); return { status: 503 }
      }
      // HTML-only replies stay held for review. Do not execute/strip arbitrary
      // HTML, fetch attachments, load tracking images or invent a text body.
      if (typeof received.text !== 'string' || received.text.length < 1 || received.text.length > 30_000
        || (received.message_id != null && (typeof received.message_id !== 'string' || received.message_id.length > 998 || /[\r\n]/.test(received.message_id)))) {
        await release('metadata_mismatch'); return { status: 503 }
      }
      text = received.text; rfc = typeof received.message_id === 'string' ? received.message_id : null
      occurred = received.created_at
    }
    const result = await store.rpc('pilot_email_finalize_event', {
      p_event: eventId, p_fence: fence, p_sender: sender, p_body: text,
      p_occurred_at: occurred, p_rfc_message_id: rfc,
    })
    if (result.code === 'completed' || result.code === 'needs_review') return { status: 204 }
    await release('store_failed')
    return { status: 503 }
  } catch {
    await release('store_failed')
    return { status: 503 }
  }
}
