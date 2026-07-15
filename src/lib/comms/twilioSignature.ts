import crypto from 'crypto'

// ── Twilio webhook authenticity ───────────────────────────────────────────────
// Twilio signs every webhook: HMAC-SHA1 over (full public URL + the POST params
// concatenated in key order), keyed with the account auth token. ONE
// implementation, shared by the inbound SMS webhook and the delivery status
// callback — the check is security-critical and must not drift between them.
//
// The URL must be byte-identical to what Twilio was configured to call, which is
// why callers pass it explicitly rather than reading it off the request (a proxy
// can rewrite host/proto).
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | null,
): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!token || !signature) return false
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('')
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    return false // length mismatch — timingSafeEqual throws rather than returning false
  }
}
