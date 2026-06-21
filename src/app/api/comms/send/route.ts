import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { renderMessage, MsgType, MSG_LABELS } from '@/lib/comms/templates'
import { sendSms, sendEmail, commsEnabled } from '@/lib/comms/send'
import { ensurePortalToken, portalUrl } from '@/lib/portal'

// Manual send — fired by an owner action (Day Ops one-tap buttons, quote/invoice
// send). Uses the owner's session + custom templates, respects per-customer
// opt-in, logs every attempt, and returns gracefully with disabled results while
// credentials are absent (nothing sends).
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const customerId = String(body.customerId || '')
  const template = String(body.template || '') as MsgType
  const channels: string[] = Array.isArray(body.channels) ? body.channels : ['sms', 'email']
  const jobId: string | null = body.jobId ?? null
  const vars: { eta?: string | number; dateLabel?: string; amount?: string } = body.vars || {}
  if (!customerId || !(template in MSG_LABELS)) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  const { data: cust } = await supabase.from('customers')
    .select('id, name, phone, email, sms_opt_in, email_opt_in').eq('id', customerId).eq('user_id', user.id).maybeSingle()
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
  const msg = renderMessage(template, biz?.message_templates, {
    firstName: c.name,
    businessName: biz?.company_name || 'Edge Property Services',
    eta: vars.eta,
    reviewLink: biz?.review_url || undefined,
    portalLink: token ? portalUrl(token) : undefined,
    dateLabel: vars.dateLabel,
    amount: vars.amount,
  })

  const enabled = commsEnabled()
  const results: Record<string, unknown> = {}
  async function log(channel: string, status: string, detail?: string) {
    await supabase.from('notification_log').insert({ user_id: user!.id, customer_id: customerId, job_id: jobId, channel, template, status, detail: detail ?? null })
  }

  if (channels.includes('sms')) {
    if (!c.sms_opt_in) { results.sms = { sent: false, reason: 'no-optin' }; await log('sms', 'skipped', 'no opt-in') }
    else if (!c.phone) { results.sms = { sent: false, reason: 'no-phone' }; await log('sms', 'skipped', 'no phone') }
    else { const r = await sendSms(c.phone, msg.sms); results.sms = r; await log('sms', r.reason, r.error) }
  }
  if (channels.includes('email')) {
    if (!c.email_opt_in) { results.email = { sent: false, reason: 'no-optin' }; await log('email', 'skipped', 'no opt-in') }
    else if (!c.email) { results.email = { sent: false, reason: 'no-email' }; await log('email', 'skipped', 'no email') }
    else { const r = await sendEmail(c.email, msg.subject, msg.html, msg.text); results.email = r; await log('email', r.reason, r.error) }
  }

  return NextResponse.json({ enabled, results, preview: msg.sms })
}
