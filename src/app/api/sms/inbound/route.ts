import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ── Inbound Twilio SMS webhook ───────────────────────────────────────────────
// Configure in Twilio: your number / Messaging Service → "A message comes in" →
// POST to <APP_URL>/api/sms/inbound. We verify Twilio's signature, match the
// sender to a customer, honour STOP/START, and append the reply to that
// customer's thread. Returns empty TwiML (no auto-reply).
//
// TEMP DIAGNOSTICS (2026-06-23): step-by-step logging to the Vercel function
// logs while we chase why inbound SMS never reaches the INSERT. The auth token
// is NEVER logged. Remove the LOG lines (and the signedBase log) once inbound
// SMS is confirmed landing in public.messages.

const LOG = (step: string, detail?: unknown) =>
  console.log(`[sms/inbound] ${step}${detail !== undefined ? ' ' + safe(detail) : ''}`)
function safe(v: unknown): string { try { return JSON.stringify(v) } catch { return String(v) } }

function checkSignature(url: string, params: Record<string, string>, signature: string | null) {
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!token) return { ok: false, reason: 'TWILIO_AUTH_TOKEN missing', expected: '', received: signature, signedBase: '' }
  if (!signature) return { ok: false, reason: 'x-twilio-signature header missing', expected: '', received: null, signedBase: '' }
  const signedBase = url + Object.keys(params).sort().map(k => k + params[k]).join('')
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(signedBase, 'utf-8')).digest('base64')
  let ok = false
  try { ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature)) } catch { ok = false }
  return { ok, reason: ok ? 'match' : 'mismatch', expected, received: signature, signedBase }
}

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
    LOG('1 request received', { url, from: params.From, to: params.To, body: params.Body, sid: params.MessageSid, msgServiceSid: params.MessagingServiceSid, paramKeys: Object.keys(params).sort() })

    const sig = checkSignature(url, params, req.headers.get('x-twilio-signature'))
    // signedBase contains the message text + phone (owner's own data) — logged so
    // it can be diffed against Twilio's Request Inspector. Token is not included.
    LOG('2 signature', { ok: sig.ok, reason: sig.reason, expected: sig.expected, received: sig.received, signedBase: sig.signedBase })
    if (!sig.ok) return new NextResponse('forbidden', { status: 403 })

    const from = params.From || ''
    const rawBody = params.Body || ''
    const body = rawBody.trim()
    const sid = params.MessageSid || ''
    const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!sbUrl || !svc) { LOG('2b supabase env missing', { hasUrl: !!sbUrl, hasServiceKey: !!svc }); return twiml() }
    const sb = createClient(sbUrl, svc)

    const { data: custJson, error: custErr } = await sb.rpc('find_customer_by_phone', { p_phone: from })
    const c = custJson as { id: string; user_id: string; sms_opt_in: boolean; name: string } | null
    LOG('3 find_customer_by_phone', { matched: !!c, customerId: c?.id, error: custErr?.message })
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
    LOG('4 conversation upsert', { convoId, error: convoErr?.message })
    if (!convoId) return twiml()

    const { data: msgRow, error: msgErr } = await sb.from('messages').insert({
      user_id: c.user_id, conversation_id: convoId, customer_id: c.id,
      direction: 'inbound', channel: 'sms', body: rawBody || '(empty)', twilio_sid: sid, status: 'received',
    }).select('id').single()
    LOG('5 messages insert', { messageId: (msgRow as { id: string } | null)?.id, error: msgErr?.message })
    return twiml()
  } catch (e) {
    LOG('EXCEPTION', e instanceof Error ? `${e.name}: ${e.message}` : String(e))
    return twiml()
  }
}
