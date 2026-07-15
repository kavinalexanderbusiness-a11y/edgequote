import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { renderMessage, renderBody, MsgType, MSG_LABELS, type MessagePrefs } from '@/lib/comms/templates'
import { commsEnabled } from '@/lib/comms/send'
import { dispatchToCustomer, sendResultsFromAttempts } from '@/lib/comms/dispatch'
import { loadOwnerContext } from '@/lib/automation/owner'
import { SENT_STATES } from '@/lib/comms/delivery'
import { logSend, logDispatch } from '@/lib/comms/log'
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

  // THE per-owner settings read (lib/automation/owner) — the same one every
  // scheduled sender uses, so a manual message and an automatic one can never sign
  // off as different businesses. Session-scoped client here; RLS narrows it further.
  const biz = await loadOwnerContext(supabase, user.id)

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
    businessName: biz.name,
    eta: vars.eta,
    reviewLink: biz.reviewUrl || undefined,
    portalLink: token ? portalUrl(token, origin) : undefined,
    dateLabel: vars.dateLabel,
    amount: vars.amount,
    timeWindow: vars.timeWindow,
    oldDateLabel: vars.oldDateLabel,
    address: vars.address,
    directPhone: biz.phone || undefined,
    logoUrl: biz.logoUrl || undefined,
    website: biz.website || undefined,
  }
  const rendered = renderMessage(template, biz.templates, msgVars)
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

  // ONE consent gate. dispatchToCustomer owns the category check, per-channel
  // opt-in, the sends, and the threaded bubble — the same path the crons take.
  // This route used to hand-roll all four; it was the last copy.
  //
  // Channel ORDER is load-bearing: the bubble records the FIRST channel that
  // actually sent, and this route has always attempted sms before email no matter
  // what order the caller listed. Dispatch now honours caller order (and at least
  // one caller builds the array dynamically), so normalise here to keep sms-first
  // exactly as before. `push` rides along last so the category gate can skip it
  // like every other requested channel — dispatch ignores it otherwise.
  const dispatchChannels = ['sms', 'email'].filter(ch => channels.includes(ch))
  if (channels.includes('push')) dispatchChannels.push('push')

  const res = await dispatchToCustomer(supabase, {
    userId: user.id,
    customer: {
      id: customerId, phone: c.phone, email: c.email,
      sms_opt_in: c.sms_opt_in, email_opt_in: c.email_opt_in,
      message_prefs: (cust as { message_prefs?: MessagePrefs | null }).message_prefs,
    },
    channels: dispatchChannels,
    smsText: outText,
    emailSubject: rendered.subject,
    emailHtml: outHtml,
    emailText: outText,
    template,
  })

  // Translate the attempt vocabulary back into this route's published per-channel
  // SendResult map — nine callers read it.
  const results = sendResultsFromAttempts(res.attempts)

  // Future channel — wired through, always disabled for now (no provider). Only
  // when the category gate didn't already skip it: an unsubscribed customer's
  // push request reads 'no-optin', exactly as it did when this block was nested
  // inside the consent branch.
  const pushDisabled = channels.includes('push') && !res.attempts.some(a => a.channel === 'push')
  if (pushDisabled) results.push = { sent: false, reason: 'disabled' }

  await logDispatch(supabase, res, { userId: user.id, customerId, jobId, template })
  if (pushDisabled) {
    await logSend(supabase, { userId: user.id, customerId, jobId, channel: 'push', template, status: 'disabled', detail: 'push not configured', messageId: null, provider: null, providerId: null })
  }
  await finalizeSend(supabase, user.id, clientMessageId, res.sentChannels.length ? 'sent' : 'skipped')

  return NextResponse.json({ enabled, results, preview: outText, threaded: !!res.messageId })
}

