import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendSms } from '@/lib/comms/send'

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
  if (!customerId || !text) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  // Get-or-create the conversation. Fast path is a SELECT; on a brand-new thread we
  // insert-or-do-nothing on the unique (user_id, customer_id) and re-select if a
  // concurrent request won the race — so this reply can never be dropped on the floor.
  let convoId: string | null = null
  const { data: existing } = await supabase.from('conversations').select('id').eq('user_id', user.id).eq('customer_id', customerId).maybeSingle()
  if (existing) convoId = (existing as { id: string }).id
  else {
    const { data: created } = await supabase.from('conversations')
      .upsert({ user_id: user.id, customer_id: customerId, last_message_at: new Date().toISOString() }, { onConflict: 'user_id,customer_id', ignoreDuplicates: true })
      .select('id').maybeSingle()
    convoId = (created as { id: string } | null)?.id ?? null
    if (!convoId) {
      const { data: ex } = await supabase.from('conversations').select('id').eq('user_id', user.id).eq('customer_id', customerId).maybeSingle()
      convoId = (ex as { id: string } | null)?.id ?? null
    }
  }
  if (!convoId) return NextResponse.json({ error: 'could not open conversation' }, { status: 500 })

  if (internal) {
    await supabase.from('messages').insert({ user_id: user.id, conversation_id: convoId, customer_id: customerId, direction: 'internal', channel: 'internal', body: text, status: 'note' })
    return NextResponse.json({ ok: true, internal: true })
  }

  const { data: cust } = await supabase.from('customers').select('phone').eq('id', customerId).eq('user_id', user.id).maybeSingle()
  const phone = (cust as { phone: string | null } | null)?.phone
  if (!phone) return NextResponse.json({ ok: false, error: 'This customer has no phone number on file.' }, { status: 400 })

  const r = await sendSms(phone, text)
  await supabase.from('messages').insert({ user_id: user.id, conversation_id: convoId, customer_id: customerId, direction: 'outbound', channel: 'sms', body: text, status: r.reason })
  await supabase.from('notification_log').insert({ user_id: user.id, customer_id: customerId, channel: 'sms', template: 'reply', status: r.reason, detail: r.error ?? null })

  const error = r.reason === 'disabled' ? 'SMS isn’t set up yet (add your Twilio keys).' : r.reason === 'error' ? 'The message could not be sent.' : undefined
  return NextResponse.json({ ok: r.sent, reason: r.reason, error })
}
