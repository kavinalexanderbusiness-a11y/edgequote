import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { renderMessage, renderBody, MsgType, MSG_LABELS, type MessagePrefs } from '@/lib/comms/templates'
import { sendSms, sendEmail, commsEnabled } from '@/lib/comms/send'
import { reachCheck } from '@/lib/comms/reach'
import { governCheck } from '@/lib/comms/governor'
import { getOrCreateConversation } from '@/lib/comms/conversation'
import { SKIP_REASON } from '@/lib/comms/skipReasons'
import { SENT_STATES } from '@/lib/comms/delivery'
import { logSend } from '@/lib/comms/log'
import { ensurePortalToken, portalUrl } from '@/lib/portal'
import { claimSend, finalizeSend } from '@/lib/comms/idempotency'

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
  // Idempotency key: the client generates this once per logical send and reuses it
  // across retries / concurrent tabs / double-clicks. Optional → legacy callers keep
  // working. See lib/comms/idempotency.
  const clientMessageId = (typeof body.clientMessageId === 'string' && body.clientMessageId) ? body.clientMessageId : null
  if (!customerId || !(template in MSG_LABELS)) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  const { data: cust } = await supabase.from('customers')
    .select('id, name, phone, email, sms_opt_in, email_opt_in, message_prefs').eq('id', customerId).eq('user_id', user.id).maybeSingle()
  if (!cust) return NextResponse.json({ error: 'customer not found' }, { status: 404 })
  const c = cust as { id: string; name: string; phone: string | null; email: string | null; sms_opt_in: boolean; email_opt_in: boolean }

  // Automated sends pass dedupe:true so the same template can't fire twice for the
  // same job (e.g. a job completed, undone, completed again).
  if (body.dedupe && jobId) {
    // SENT_STATES, not status='sent': a delivery webhook may have already moved a
    // prior send to 'delivered', and an equality check would miss it and resend.
    const { data: prior } = await supabase.from('notification_log').select('id').eq('user_id', user.id).eq('job_id', jobId).eq('template', template).in('status', SENT_STATES as unknown as string[]).limit(1)
    if (prior && prior.length) return NextResponse.json({ enabled: commsEnabled(), results: {}, skipped: 'duplicate' })
  }

  // Reserve this send exactly once BEFORE dispatching any SMS/email (skipped for a
  // preview, which never sends). A retry / concurrent tab with the same
  // clientMessageId loses the atomic claim and returns without resending → no
  // duplicate SMS AND no duplicate email.
  if (clientMessageId && !body.previewOnly) {
    const { claimed } = await claimSend(supabase, user.id, clientMessageId, channels.join('+'))
    if (!claimed) return NextResponse.json({ enabled: commsEnabled(), results: {}, deduped: true })
  }

  const { data: bizRow } = await supabase.from('business_settings')
    .select('company_name, phone, website, logo_url, review_url, message_templates').eq('user_id', user.id).maybeSingle()
  const biz = bizRow as { company_name: string | null; phone: string | null; website: string | null; logo_url: string | null; review_url: string | null; message_templates: Partial<Record<MsgType, string>> | null } | null

  // "On my way" also stamps the job so the customer portal can show a live status.
  if (template === 'on_my_way' && jobId) {
    await supabase.from('jobs').update({ on_my_way_at: new Date().toISOString() }).eq('id', jobId).eq('user_id', user.id)
  }

  const token = await ensurePortalToken(supabase, user.id, customerId)
  // Build portal links off the REQUEST origin so they're always absolute and work
  // in SMS/email (NEXT_PUBLIC_APP_URL may be unset in some deploys).
  const origin = req.nextUrl?.origin || process.env.NEXT_PUBLIC_APP_URL || ''
  const msgVars = {
    firstName: c.name,
    // Neutral fallback — never sign messages with a brand the owner didn't set.
    businessName: biz?.company_name || 'your service provider',
    eta: vars.eta,
    reviewLink: biz?.review_url || undefined,
    portalLink: token ? portalUrl(token, origin) : undefined,
    dateLabel: vars.dateLabel,
    amount: vars.amount,
    timeWindow: vars.timeWindow,
    oldDateLabel: vars.oldDateLabel,
    address: vars.address,
    directPhone: biz?.phone || undefined,
    logoUrl: biz?.logo_url || undefined,
    website: biz?.website || undefined,
  }
  const rendered = renderMessage(template, biz?.message_templates, msgVars)
  // The text we actually send: the owner's edit (or a caller-supplied body such
  // as the payment receipt) when present, else the rendered template. An
  // override may still carry {{portal_link}}/{{first_name}}-style tokens — only
  // THIS route knows the real portal token, so they resolve here, through the
  // SAME interpolation engine the templates use. Without this, every
  // single-recipient quote/invoice send went out with a blank where the portal
  // link belonged, and receipts shipped literal {{portal_link}} text.
  const out = bodyOverride ? renderBody(bodyOverride, msgVars, rendered.subject) : rendered
  const outText = out.sms
  const outHtml = out.html

  // Caller can preview the fully-rendered text without sending (no I/O side effects).
  if (body.previewOnly) return NextResponse.json({ enabled: commsEnabled(), preview: outText })

  const enabled = commsEnabled()
  const results: Record<string, unknown> = {}
  // Collect every channel attempt; log + thread once at the end so a sent message
  // can be linked to its log rows.
  // `provider`/`providerId` are the provider's handle on the message (Twilio
  // MessageSid / Resend id) — persisted so the delivery webhooks can later turn
  // 'sent' (provider accepted) into 'delivered'/'bounced'.
  const attempts: { channel: string; status: string; detail?: string; sent: boolean; provider?: string | null; providerId?: string | null }[] = []

  // Consent is decided by THE one predicate (lib/comms/reach) — the same call
  // dispatchToCustomer makes, so a manual send and an automated one can never
  // reach different verdicts about the same customer. This used to be a
  // hand-rolled copy of those rules: it agreed exactly, but nothing kept it
  // agreeing, and reach.ts exists precisely so the next consent rule lands in one
  // place. The route still owns its SEND, because it does things dispatch
  // deliberately doesn't — mint the portal token, honour a bodyOverride, and
  // answer previewOnly without any I/O.
  const gate = reachCheck(c, channels, template)
  const blocked = new Map(gate.map(g => [g.channel, g.blocked]))
  // 'no-optin' vs 'no-phone'/'no-email' is this route's public JSON contract
  // (summarizeSendOutcome + every caller reads it); map the canonical reason onto
  // it rather than changing the shape.
  const reasonFor = (b: string) => b === SKIP_REASON.NO_PHONE ? 'no-phone' : b === SKIP_REASON.NO_EMAIL ? 'no-email' : 'no-optin'
  for (const g of gate) {
    if (!g.blocked) continue
    results[g.channel] = { sent: false, reason: reasonFor(g.blocked) }
    attempts.push({ channel: g.channel, status: 'skipped', detail: g.blocked, sent: false })
  }

  // The governor: WHEN and AGAIN, after consent decides WHETHER — the same
  // brain dispatchToCustomer consults (lib/comms/governor), called here because
  // this route deliberately owns its own send. A manual send and an automated
  // one must never reach different verdicts about timing or frequency. Only
  // consulted when a channel could actually go out.
  if (gate.some(g => !g.blocked)) {
    const gov = await governCheck(supabase, { userId: user.id, customerId, template })
    if (!gov.allowed) {
      for (const g of gate) {
        if (g.blocked) continue
        blocked.set(g.channel, gov.reason!)
        // 'governed' extends the public reason contract; `detail` carries the
        // specific verdict for summarizeSendOutcome's honest one-liner.
        results[g.channel] = { sent: false, reason: 'governed', detail: gov.reason }
        attempts.push({ channel: g.channel, status: 'skipped', detail: gov.reason!, sent: false })
      }
    }
  }

  if (channels.includes('sms') && !blocked.get('sms')) {
    const r = await sendSms(c.phone!, outText); results.sms = r
    attempts.push({ channel: 'sms', status: r.reason, detail: r.error, sent: r.sent, provider: r.sent ? 'twilio' : null, providerId: r.id ?? null })
  }
  if (channels.includes('email') && !blocked.get('email')) {
    const r = await sendEmail(c.email!, rendered.subject, outHtml, outText); results.email = r
    attempts.push({ channel: 'email', status: r.reason, detail: r.error, sent: r.sent, provider: r.sent ? 'resend' : null, providerId: r.id ?? null })
  }
  if (channels.includes('push')) {
    // Future channel — wired through, always disabled for now (no provider).
    results.push = { sent: false, reason: 'disabled' }; attempts.push({ channel: 'push', status: 'disabled', detail: 'push not configured', sent: false })
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
      // The bubble carries the primary channel's provider id, so a delivery
      // webhook for that id can advance THIS row from sent → delivered.
      const primary = attempts.find(a => a.sent && a.channel === sentChannels[0])
      const { data: m } = await supabase.from('messages')
        .insert({
          user_id: user.id, conversation_id: convoId, customer_id: customerId,
          direction: 'outbound', channel: sentChannels[0], body: outText, status: 'sent',
          provider: primary?.provider ?? null, provider_message_id: primary?.providerId ?? null,
          meta: { template },
        })
        .select('id').single()
      messageId = (m as { id: string } | null)?.id ?? null
    }
  }

  for (const a of attempts) {
    await logSend(supabase, { userId: user.id, customerId, jobId, channel: a.channel, template, status: a.status, detail: a.detail, messageId: a.sent ? messageId : null, provider: a.provider ?? null, providerId: a.providerId ?? null })
  }
  await finalizeSend(supabase, user.id, clientMessageId, sentChannels.length ? 'sent' : 'skipped')

  return NextResponse.json({ enabled, results, preview: outText, threaded: !!messageId })
}

