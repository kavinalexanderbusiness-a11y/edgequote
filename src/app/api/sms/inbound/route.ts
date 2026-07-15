import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyTwilioSignature } from '@/lib/comms/twilioSignature'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ── Inbound Twilio SMS webhook ───────────────────────────────────────────────
// Configure in Twilio (number or Messaging Service) → "A message comes in" →
// POST to <APP_URL>/api/sms/inbound. We verify Twilio's signature, match the
// sender to a customer, honour STOP/START, and append the reply to that
// customer's thread. Returns empty TwiML (no auto-reply). Wrapped so a thrown
// error can't 500 Twilio into a retry storm; only operational errors are logged
// (never message content / phone numbers).

function twiml(message?: string) {
  const inner = message ? `<Message>${message.replace(/[<&>]/g, '')}</Message>` : ''
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
    status: 200, headers: { 'Content-Type': 'text/xml' },
  })
}

const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']
const START_WORDS = ['START', 'YES', 'UNSTOP']

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const params: Record<string, string> = {}
    form.forEach((v, k) => { params[k] = String(v) })
    const url = `${(process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '')}/api/sms/inbound`
    if (!verifyTwilioSignature(url, params, req.headers.get('x-twilio-signature'))) {
      return new NextResponse('forbidden', { status: 403 })
    }

    const from = params.From || ''
    const rawBody = params.Body || ''
    const body = rawBody.trim()
    const sid = params.MessageSid || ''
    const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!sbUrl || !svc) return twiml()
    const sb = createClient(sbUrl, svc)

    const { data: custJson } = await sb.rpc('find_customer_by_phone', { p_phone: from })
    const c = custJson as { id: string; user_id: string; sms_opt_in: boolean; name: string } | null
    if (!c) return twiml() // unknown number — accept (200) but store nothing

    // STOP/START compliance (Twilio also enforces STOP at the carrier level).
    // Audited to consent_changes, only when the value actually flips.
    const kw = body.toUpperCase()
    if (STOP_WORDS.includes(kw) && c.sms_opt_in) {
      await sb.from('customers').update({ sms_opt_in: false }).eq('id', c.id)
      await sb.from('consent_changes').insert({ user_id: c.user_id, customer_id: c.id, channel: 'sms', old_value: true, new_value: false, source: 'sms', changed_by: 'customer (SMS STOP)' })
    } else if (START_WORDS.includes(kw) && !c.sms_opt_in) {
      await sb.from('customers').update({ sms_opt_in: true }).eq('id', c.id)
      await sb.from('consent_changes').insert({ user_id: c.user_id, customer_id: c.id, channel: 'sms', old_value: false, new_value: true, source: 'sms', changed_by: 'customer (SMS START)' })
    }

    // Get-or-create the conversation atomically. An upsert on the unique key
    // (user_id, customer_id) means two inbound texts racing for a brand-new
    // customer can't both miss a SELECT and drop one message on the floor.
    const { data: convo, error: convoErr } = await sb.from('conversations')
      .upsert({ user_id: c.user_id, customer_id: c.id, last_message_at: new Date().toISOString() }, { onConflict: 'user_id,customer_id' })
      .select('id').single()
    const convoId = (convo as { id: string } | null)?.id ?? null
    if (!convoId) { console.error('[sms/inbound] conversation upsert failed:', convoErr?.message); return twiml() }

    const { error: msgErr } = await sb.from('messages').insert({
      user_id: c.user_id, conversation_id: convoId, customer_id: c.id,
      direction: 'inbound', channel: 'sms', body: rawBody || '(empty)', twilio_sid: sid, status: 'received',
    })
    // 23505 = the messages_twilio_sid_key unique index rejected a re-delivered SID:
    // a Twilio retry of a message we already stored. Silently idempotent (no dup, no
    // double unread); only log genuine failures.
    if (msgErr && msgErr.code !== '23505') console.error('[sms/inbound] message insert failed:', msgErr.message)
    return twiml()
  } catch (e) {
    console.error('[sms/inbound] error:', e instanceof Error ? e.message : String(e))
    return twiml()
  }
}
