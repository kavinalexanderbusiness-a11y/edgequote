import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { applyDelivery, resendStatus } from '@/lib/comms/delivery'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ── Resend delivery webhook ──────────────────────────────────────────────────
// Resend POSTs here on email.sent/delivered/opened/clicked/bounced/complained.
// Configure it once in the Resend dashboard (Webhooks → add endpoint) — unlike
// Twilio there is no per-send parameter, so the sending pipeline needs nothing.
//
// Resend signs with Svix, so verification needs the RAW body (parsing first would
// change the bytes and every signature would fail).
//
// Never returns 5xx: Svix retries server errors for days.

const ok = () => new NextResponse('', { status: 204 })

// Svix scheme: HMAC-SHA256 over `${id}.${timestamp}.${body}` with the base64 key
// from RESEND_WEBHOOK_SECRET ("whsec_…"). The signature header carries a
// space-separated list of `v1,<sig>` (key rotation), any of which may match.
function verifyResend(raw: string, req: NextRequest): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) return false
  const id = req.headers.get('svix-id')
  const ts = req.headers.get('svix-timestamp')
  const sig = req.headers.get('svix-signature')
  if (!id || !ts || !sig) return false

  // Replay guard — reject anything older than 5 minutes.
  const age = Math.abs(Date.now() / 1000 - Number(ts))
  if (!Number.isFinite(age) || age > 300) return false

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64')
  return sig.split(' ').some(part => {
    const v = part.split(',')[1]
    if (!v) return false
    try { return crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected)) } catch { return false }
  })
}

interface ResendEvent {
  type?: string
  created_at?: string
  data?: { email_id?: string; bounce?: { message?: string; type?: string } }
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text()
    if (!verifyResend(raw, req)) return new NextResponse('forbidden', { status: 403 })

    let evt: ResendEvent
    try { evt = JSON.parse(raw) as ResendEvent } catch { return ok() }

    const status = resendStatus(evt.type || '')
    const id = evt.data?.email_id || ''
    if (!status || !id) return ok() // event type we don't track

    const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!sbUrl || !svc) return ok()

    // Keep the provider's bounce reason so "Bounced" is explainable.
    const b = evt.data?.bounce
    const detail = status === 'bounced' && (b?.message || b?.type)
      ? `Resend bounce${b?.type ? ` (${b.type})` : ''}${b?.message ? `: ${b.message}` : ''}`
      : null

    await applyDelivery(createClient(sbUrl, svc), {
      provider: 'resend', providerMessageId: id, status, detail, at: evt.created_at,
    })
    return ok()
  } catch (e) {
    console.error('[email/status] error:', e instanceof Error ? e.message : String(e))
    return ok()
  }
}
