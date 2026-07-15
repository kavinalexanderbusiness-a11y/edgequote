import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendSms } from '@/lib/comms/send'
import { getOrCreateConversation } from '@/lib/comms/conversation'
import { claimSend, finalizeSend } from '@/lib/comms/idempotency'

export const dynamic = 'force-dynamic'

// Owner reply in a conversation: send an SMS via the ONE comms sender (logged to
// notification_log), or post an internal note (not sent). Both append to the
// customer's thread.
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

  const { data: cust } = await supabase.from('customers').select('phone').eq('id', customerId).eq('user_id', user.id).maybeSingle()
  const phone = (cust as { phone: string | null } | null)?.phone
  if (!phone) return NextResponse.json({ ok: false, error: 'This customer has no phone number on file.' }, { status: 400 })

  const r = await sendSms(phone, text)
  // Persist Twilio's SID so /api/sms/status can carry these rows from 'sent'
  // (accepted) to 'delivered'/'failed'. Written through a helper that degrades to
  // the pre-migration shape rather than losing the message record.
  const providerCols = r.sent && r.id ? { provider: 'twilio', provider_message_id: r.id } : {}
  const msgBase = { user_id: user.id, conversation_id: convoId, customer_id: customerId, direction: 'outbound', channel: 'sms', body: text, status: r.reason }
  const { error: msgErr } = await supabase.from('messages').insert({ ...msgBase, ...providerCols })
  if (msgErr) await supabase.from('messages').insert(msgBase)
  const logBase = { user_id: user.id, customer_id: customerId, channel: 'sms', template: 'reply', status: r.reason, detail: r.error ?? null }
  const { error: logErr } = await supabase.from('notification_log').insert({ ...logBase, ...providerCols })
  if (logErr) await supabase.from('notification_log').insert(logBase)
  await finalizeSend(supabase, user.id, clientMessageId, r.reason)

  const error = r.reason === 'disabled' ? 'SMS isn’t set up yet (add your Twilio keys).' : r.reason === 'error' ? 'The message could not be sent.' : undefined
  return NextResponse.json({ ok: r.sent, reason: r.reason, error })
}
