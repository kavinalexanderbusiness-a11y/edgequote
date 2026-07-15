import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyTwilioSignature } from '@/lib/comms/twilioSignature'
import { applyDelivery, twilioStatus } from '@/lib/comms/delivery'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ── Twilio delivery status callback ──────────────────────────────────────────
// Twilio POSTs here as a message moves queued → sent → delivered (or fails), but
// ONLY when the send passed a StatusCallback URL — see lib/comms/send.ts. We
// verify the signature, map Twilio's status onto our vocabulary, and advance the
// matching send records.
//
// Never returns 5xx: Twilio retries server errors with backoff, which would turn
// one bad row into a retry storm. Unknown/unmatched events are accepted and
// dropped — a 200 means "received", not "found".

const ok = () => new NextResponse('', { status: 204 })

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const params: Record<string, string> = {}
    form.forEach((v, k) => { params[k] = String(v) })

    const url = `${(process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '')}/api/sms/status`
    if (!verifyTwilioSignature(url, params, req.headers.get('x-twilio-signature'))) {
      return new NextResponse('forbidden', { status: 403 })
    }

    const sid = params.MessageSid || params.SmsSid || ''
    const status = twilioStatus(params.MessageStatus || params.SmsStatus || '')
    if (!sid || !status) return ok() // nothing we can act on

    const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!sbUrl || !svc) return ok()

    // Carry Twilio's own reason onto the row so a failure is explainable
    // (e.g. 30003 "Unreachable destination handset") instead of a bare "Failed".
    const detail = status === 'failed' && params.ErrorCode
      ? `Twilio error ${params.ErrorCode}${params.ErrorMessage ? `: ${params.ErrorMessage}` : ''}`
      : null

    await applyDelivery(createClient(sbUrl, svc), {
      provider: 'twilio', providerMessageId: sid, status, detail,
    })
    return ok()
  } catch (e) {
    // Log the operational error only — never message content or phone numbers.
    console.error('[sms/status] error:', e instanceof Error ? e.message : String(e))
    return ok()
  }
}
