import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { renderTemplate, CommTemplate } from '@/lib/comms/templates'
import { sendSms, sendEmail, commsEnabled } from '@/lib/comms/send'
import { ensurePortalToken, portalUrl } from '@/lib/portal'

// Manual send — fired by an owner action (e.g. the "On my way" button). Uses the
// owner's session, respects per-customer opt-in, and logs every attempt. Returns
// gracefully with { enabled:false } while credentials are absent (nothing sends).
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const customerId = String(body.customerId || '')
  const template = String(body.template || '') as CommTemplate
  const channels: string[] = Array.isArray(body.channels) ? body.channels : ['sms', 'email']
  const jobId: string | null = body.jobId ?? null
  if (!customerId || !['reminder', 'on_my_way', 'job_complete', 'review_request'].includes(template)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }

  const { data: cust } = await supabase.from('customers')
    .select('id, name, phone, email, sms_opt_in, email_opt_in').eq('id', customerId).eq('user_id', user.id).maybeSingle()
  if (!cust) return NextResponse.json({ error: 'customer not found' }, { status: 404 })
  const c = cust as { id: string; name: string; phone: string | null; email: string | null; sms_opt_in: boolean; email_opt_in: boolean }

  const { data: bizRow } = await supabase.from('business_settings').select('company_name').eq('user_id', user.id).maybeSingle()
  const businessName = (bizRow as { company_name: string | null } | null)?.company_name || 'Edge Property Services'

  const token = await ensurePortalToken(supabase, user.id, customerId)
  const msg = renderTemplate(template, { customerName: c.name, businessName, portalUrl: token ? portalUrl(token) : undefined })

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

  return NextResponse.json({ enabled, results })
}
