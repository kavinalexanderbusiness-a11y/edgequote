import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { dispatchToCustomer } from '@/lib/comms/dispatch'
import { logDispatch } from '@/lib/comms/log'
import { describeSkip } from '@/lib/comms/skipReasons'
import { getOrCreateConversation } from '@/lib/comms/conversation'
import { claimSend, finalizeSend } from '@/lib/comms/idempotency'

export const dynamic = 'force-dynamic'

// Owner reply in a conversation: send an SMS through the ONE dispatch pipeline
// (consent-gated, threaded, logged), or post an internal note (not sent).
//
// This route used to select ONLY `phone` and call sendSms directly — no consent
// check of any kind. It was the single authenticated sender with no gate: a
// customer who opted out via the portal, or whom the owner had un-ticked in the
// customer editor, still got texted the moment the owner typed a reply. Only a
// carrier-level STOP caught it, and that safety net doesn't exist for the two
// in-app ways consent is revoked. The UI meanwhile warns the owner that the SMS
// flag is load-bearing.
//
// The template is 'reply', which msgCategory doesn't know, so prefAllows fails
// open — deliberately: an owner's one-off reply isn't a marketing category a
// customer opts out of. What reachCheck DOES enforce here is the channel opt-in
// and a phone on file, which is exactly the gate that was missing.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const customerId = String(body.customerId || '')
  const text = String(body.body || '').trim()
  const internal = !!body.internal
  // Idempotency key: the client generates this once per logical send and reuses it
  // across retries / offline replay / concurrent tabs. Optional → legacy callers are
  // unaffected. See lib/comms/idempotency.
  const clientMessageId = (typeof body.clientMessageId === 'string' && body.clientMessageId) ? body.clientMessageId : null
  if (!customerId || !text) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  // Reserve this send exactly once BEFORE any SMS is dispatched. A duplicate request
  // (retry / offline replay / another tab flushing the same queued op) loses the atomic
  // claim and returns here WITHOUT resending → no duplicate SMS, no duplicate note bubble.
  if (clientMessageId) {
    const { claimed } = await claimSend(supabase, user.id, clientMessageId, internal ? 'internal' : 'sms')
    if (!claimed) return NextResponse.json({ ok: true, deduped: true })
  }

  // Get-or-create the one conversation per customer (shared, race-safe helper).
  const convoId = await getOrCreateConversation(supabase, user.id, customerId)
  if (!convoId) return NextResponse.json({ error: 'could not open conversation' }, { status: 500 })

  if (internal) {
    await supabase.from('messages').insert({ user_id: user.id, conversation_id: convoId, customer_id: customerId, direction: 'internal', channel: 'internal', body: text, status: 'note' })
    await finalizeSend(supabase, user.id, clientMessageId, 'note')
    return NextResponse.json({ ok: true, internal: true })
  }

  const { data: cust } = await supabase.from('customers')
    .select('id, phone, email, sms_opt_in, email_opt_in, message_prefs')
    .eq('id', customerId).eq('user_id', user.id).maybeSingle()
  if (!cust) return NextResponse.json({ ok: false, error: 'Customer not found.' }, { status: 404 })

  // THE send path — the same one every campaign and cron uses. It gates on
  // consent (lib/comms/reach), sends, threads the outbound bubble, and hands back
  // per-channel attempts for the audit log.
  const res = await dispatchToCustomer(supabase, {
    userId: user.id,
    customer: cust as Parameters<typeof dispatchToCustomer>[1]['customer'],
    channels: ['sms'],
    smsText: text, emailSubject: '', emailHtml: '', emailText: text,
    template: 'reply',
  })
  await logDispatch(supabase, res, { userId: user.id, customerId, template: 'reply' })
  const attempt = res.attempts[0]
  await finalizeSend(supabase, user.id, clientMessageId, attempt?.status ?? 'error')

  if (res.sentChannels.length) return NextResponse.json({ ok: true, reason: 'sent' })

  // dispatch only threads a bubble when something actually went out. The owner
  // typed this — it must not vanish from the thread — so record it with the real
  // reason instead, which is also what makes a failed reply visibly retryable.
  await supabase.from('messages').insert({
    user_id: user.id, conversation_id: convoId, customer_id: customerId,
    direction: 'outbound', channel: 'sms', body: text, status: attempt?.status ?? 'error',
  })
  const reason = attempt?.status ?? 'error'
  const error = attempt?.status === 'skipped'
    // Say which consent rule stopped it, in the same words the timeline uses.
    ? `Not sent — ${describeSkip(attempt.detail).label}.`
    : reason === 'disabled' ? 'SMS isn’t set up yet (add your Twilio keys).'
    : 'The message could not be sent.'
  return NextResponse.json({ ok: false, reason, error })
}
