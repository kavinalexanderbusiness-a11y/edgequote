// Webhook payload signing — ONE implementation for the whole platform.
//
// Scheme (Stripe-style, matching the hand-rolled verifiers this repo already
// trusts in stripe/config.ts and email/status): the header carries a unix
// timestamp and an HMAC-SHA256 of `${timestamp}.${rawBody}` keyed by the
// endpoint's whsec_ secret. Verifiers must use the RAW request body — any
// re-serialisation breaks the signature.
//
// Node-only (crypto), but pure: no env, no I/O — verify:integrations runs it.

import { createHmac, timingSafeEqual } from 'crypto'

export const SIGNATURE_HEADER = 'x-edgequote-signature'
export const EVENT_HEADER = 'x-edgequote-event'
export const DELIVERY_HEADER = 'x-edgequote-delivery'
export const SIGNATURE_TOLERANCE_SECONDS = 300

function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex')
}

/** Length-guarded constant-time string compare (also used for shared secrets). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** Build the signature header value: `t=<unix seconds>,v1=<hmac hex>`. */
export function signPayload(secret: string, rawBody: string, timestampSeconds?: number): string {
  const t = timestampSeconds ?? Math.floor(Date.now() / 1000)
  return `t=${t},v1=${hmacHex(secret, `${t}.${rawBody}`)}`
}

/**
 * Verify a signature header against the raw body. Tolerates multiple v1
 * entries (secret rotation) and rejects timestamps outside the replay window.
 * `nowSeconds` is injectable for tests.
 */
export function verifySignature(
  secret: string,
  header: string | null | undefined,
  rawBody: string,
  nowSeconds?: number,
): boolean {
  if (!header) return false
  let t: number | null = null
  const v1s: string[] = []
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2).map((s) => s?.trim())
    if (k === 't' && v && /^\d+$/.test(v)) t = Number(v)
    else if (k === 'v1' && v) v1s.push(v)
  }
  if (t === null || v1s.length === 0) return false
  const now = nowSeconds ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - t) > SIGNATURE_TOLERANCE_SECONDS) return false
  const expected = hmacHex(secret, `${t}.${rawBody}`)
  return v1s.some((v) => safeEqual(v, expected))
}
