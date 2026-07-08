import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { renderMessage, MsgType, MSG_LABELS, prefAllows, type MessagePrefs } from '@/lib/comms/templates'
import { sendSms, sendEmail, commsEnabled } from '@/lib/comms/send'
import { getOrCreateConversation } from '@/lib/comms/conversation'
import { SKIP_REASON } from '@/lib/comms/skipReasons'
import { ensurePortalToken, portalUrl } from '@/lib/portal'

// Manual send — fired by an owner action (Day Ops one-tap buttons, the editable
// scheduler composer, Weather Ops notifications, quote/invoice send). Uses the
// owner's session + custom templates, respects per-customer opt-in, logs every
// attempt, records anything actually sent into the customer's message thread, and
// returns gracefully with disabled results while credentials are absent.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const customerId = String(body.customerId || '')
  const template = String(body.template || '') as MsgType
  const channels: string[] = Array.isArray(body.channels) ? body.channels : ['sms', 'email']
  const jobId: string | null = body.jobId ?? null
  // The owner can edit the message before sending (scheduler composer). When a
  // non-empty override is provided it IS the message body; the template is still
  // used for the subject, logging, dedupe and the on-my-way stamp.
  const bodyOverride = typeof body.bodyOverride === 'string' ? body.bodyOverride.trim() : ''
  const vars: { eta?: string | number; dateLabel?: string; amount?: string; timeWindow?: string; oldDateLabel?: string; address?: string } = body.vars || {}
  if (!customerId || !(template in MSG_LABELS)) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  const { data: cust } = await supabase.from('customers')
    .select('id, name, phone, email, sms_opt_in, email_opt_in, message_prefs').eq('id', customerId).eq('user_id', user.id).maybeSingle()
  if (!cust) return NextResponse.json({ error: 'customer not found' }, { status: 404 })
  const c = cust as { id: string; name: string; phone: string | null; email: string | null; sms_opt_in: boolean; email_opt_in: boolean }

  // Automated sends pass dedupe:true so the same template can't fire twice for the
  // same job (e.g. a job completed, undone, completed again).
  if (body.dedupe && jobId) {
    const { data: prior } = await supabase.from('notification_log').select('id').eq('user_id', user.id).eq('job_id', jobId).eq('template', template).eq('status', 'sent').limit(1)
    if (prior && prior.length) return NextResponse.json({ enabled: commsEnabled(), results: {}, skipped: 'duplicate' })
  }

  const { data: bizRow } = await supabase.from('business_settings')
    .select('company_name, review_url, message_templates').eq('user_id', user.id).maybeSingle()
  const biz = bizRow as { company_name: string | null; review_url: string | null; message_templates: Partial<Record<MsgType, string>> | null } | null

  // "On my way" also stamps the job so the customer portal can show a live status.
  if (template === 'on_my_way' && jobId) {
    await supabase.from('jobs').update({ on_my_way_at: new Date().toISOString() }).eq('id', jobId).eq('user_id', user.id)
  }

  const token = await ensurePortalToken(supabase, user.id, customerId)
  // Build portal links off the REQUEST origin so they're always absolute and work
  // in SMS/email (NEXT_PUBLIC_APP_URL may be unset in some deploys).
  const origin = req.nextUrl?.origin || process.env.NEXT_PUBLIC_APP_URL || ''
  const rendered = renderMessage(template, biz?.message_templates, {
    firstName: c.name,
    businessName: biz?.company_name || 'Edge Property Services',
    eta: vars.eta,
    reviewLink: biz?.review_url || undefined,
    portalLink: token ? portalUrl(token, origin) : undefined,
    dateLabel: vars.dateLabel,
    amount: vars.amount,
    timeWindow: vars.timeWindow,
    oldDateLabel: vars.oldDateLabel,
    address: vars.address,
  })
  // The text we actually send: the owner's edit when present, else the rendered
  // template. Email keeps the template subject; its body mirrors the SMS text.
  const outText = bodyOverride || rendered.sms
  const outHtml = bodyOverride
    ? `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1A2333">${escapeHtml(bodyOverride).replace(/\n/g, '<br>')}</div>`
    : rendered.html

  // Caller can preview the fully-rendered text without sending (no I/O side effects).
  if (body.previewOnly) return NextResponse.json({ enabled: commsEnabled(), preview: outText })

  const enabled = commsEnabled()
  const results: Record<string, unknown> = {}
  // Collect every channel attempt; log + thread once at the end so a sent message
  // can be linked to its log rows.
  const attempts: { channel: string; status: string; detail?: string; sent: boolean }[] = []

  // Granular consent — the customer declined this CATEGORY (e.g. marketing) even
  // though a channel is opted in. Same rule the dispatch engine + crons apply.
  if (!prefAllows((cust as { message_prefs?: MessagePrefs | null }).message_prefs, template)) {
    for (const ch of channels) { results[ch] = { sent: false, reason: 'no-optin' }; attempts.push({ channel: ch, status: 'skipped', detail: SKIP_REASON.UNSUBSCRIBED, sent: false }) }
  } else {
  if (channels.includes('sms')) {
    if (!c.sms_opt_in) { results.sms = { sent: false, reason: 'no-optin' }; attempts.push({ channel: 'sms', status: 'skipped', detail: SKIP_REASON.NO_OPT_IN, sent: false }) }
    else if (!c.phone) { results.sms = { sent: false, reason: 'no-phone' }; attempts.push({ channel: 'sms', status: 'skipped', detail: SKIP_REASON.NO_PHONE, sent: false }) }
    else { const r = await sendSms(c.phone, outText); results.sms = r; attempts.push({ channel: 'sms', status: r.reason, detail: r.error, sent: r.sent }) }
  }
  if (channels.includes('email')) {
    if (!c.email_opt_in) { results.email = { sent: false, reason: 'no-optin' }; attempts.push({ channel: 'email', status: 'skipped', detail: SKIP_REASON.NO_OPT_IN, sent: false }) }
    else if (!c.email) { results.email = { sent: false, reason: 'no-email' }; attempts.push({ channel: 'email', status: 'skipped', detail: SKIP_REASON.NO_EMAIL, sent: false }) }
    else { const r = await sendEmail(c.email, rendered.subject, outHtml, outText); results.email = r; attempts.push({ channel: 'email', status: r.reason, detail: r.error, sent: r.sent }) }
  }
  if (channels.includes('push')) {
    // Future channel — wired through, always disabled for now (no provider).
    results.push = { sent: false, reason: 'disabled' }; attempts.push({ channel: 'push', status: 'disabled', detail: 'push not configured', sent: false })
  }
  }

  // Record anything actually delivered into the customer's message thread, so it
  // appears in the message center AND the customer timeline as full text (not just
  // an audit pill). One outbound bubble per send; the per-channel log rows link to
  // it so the thread shows the message, not a duplicate event.
  let messageId: string | null = null
  const sentChannels = attempts.filter(a => a.sent).map(a => a.channel)
  if (sentChannels.length) {
    const convoId = await getOrCreateConversation(supabase, user.id, customerId)
    if (convoId) {
      const { data: m } = await supabase.from('messages')
        .insert({ user_id: user.id, conversation_id: convoId, customer_id: customerId, direction: 'outbound', channel: sentChannels[0], body: outText, status: 'sent', meta: { template } })
        .select('id').single()
      messageId = (m as { id: string } | null)?.id ?? null
    }
  }

  for (const a of attempts) {
    await logSend(supabase, { userId: user.id, customerId, jobId, channel: a.channel, template, status: a.status, detail: a.detail, messageId: a.sent ? messageId : null })
  }

  return NextResponse.json({ enabled, results, preview: outText, threaded: !!messageId })
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Insert a notification_log row. Links to the thread message when one exists; falls
// back to an unlinked insert if the message_id column hasn't been migrated yet, so
// the audit trail is never silently dropped.
async function logSend(
  supabase: Awaited<ReturnType<typeof createClient>>,
  l: { userId: string; customerId: string; jobId: string | null; channel: string; template: string; status: string; detail?: string; messageId: string | null },
): Promise<void> {
  const base = { user_id: l.userId, customer_id: l.customerId, job_id: l.jobId, channel: l.channel, template: l.template, status: l.status, detail: l.detail ?? null }
  if (l.messageId) {
    const { error } = await supabase.from('notification_log').insert({ ...base, message_id: l.messageId })
    if (!error) return
    // Pre-migration fallback: the message_id column may not exist yet.
    await supabase.from('notification_log').insert(base)
    return
  }
  await supabase.from('notification_log').insert(base)
}
