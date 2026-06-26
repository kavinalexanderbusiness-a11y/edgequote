import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { renderMessage, MsgType } from '@/lib/comms/templates'
import { commsEnabled } from '@/lib/comms/send'
import { dispatchToCustomer } from '@/lib/comms/dispatch'
import { ensurePortalToken, portalUrl } from '@/lib/portal'
import {
  CAMPAIGN_KINDS, campaignPeriodKey, dateFieldFiresToday, broadcastFiresToday, type CampaignKind,
} from '@/lib/crm/campaigns'

export const dynamic = 'force-dynamic'

// Daily CRM campaign sends (Vercel Cron → see vercel.json). Resolves each enabled
// crm_campaign's audience + trigger and sends through the SAME comms pipeline the
// rest of the app uses (lib/comms/dispatch → messages + notification_log). Fully
// guarded — same shape as /api/cron/notifications:
//   • requires CRON_SECRET,
//   • no-ops when comms credentials are absent,
//   • needs SUPABASE_SERVICE_ROLE_KEY to read across customers,
//   • honours per-customer opt-in (in dispatch) + a per-period dedupe
//     (crm_campaign_log unique constraint, pre-checked here).
// Date matching uses the SERVER (UTC) day; the cron is scheduled mid-morning
// North-American time so the UTC day lines up with the local day.

const MAX_AUDIENCE = 2000   // safety bound; logged if exceeded (no silent cap)

interface CampaignRow {
  id: string; user_id: string; name: string; kind: CampaignKind; enabled: boolean
  channels: string[]; template_key: string | null; custom_body: string | null
  audience: { recurring_only?: boolean } | null
  schedule: { days?: number; lead_days?: number; day_of_month?: number; every_months?: number } | null
}
interface Cand {
  id: string; name: string; phone: string | null; email: string | null
  sms_opt_in: boolean; email_opt_in: boolean; birthday: string | null; anniversary: string | null
}

export async function GET(req: NextRequest) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '') || new URL(req.url).searchParams.get('secret') || ''
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const enabled = commsEnabled()
  if (!enabled.sms && !enabled.email) {
    return NextResponse.json({ ok: true, disabled: true, note: 'Comms disabled — set Twilio/Resend env vars to enable campaign sends.' })
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !svc) {
    return NextResponse.json({ ok: true, skipped: true, note: 'Set SUPABASE_SERVICE_ROLE_KEY to enable campaign sends.' })
  }
  const supabase = createClient(url, svc)
  const today = new Date()

  const { data: campaignRows } = await supabase.from('crm_campaigns').select('*').eq('enabled', true)
  const campaigns = (campaignRows as CampaignRow[]) || []

  // Per-owner business info cache (company name, review link, custom templates).
  const bizCache: Record<string, { name: string; templates: Partial<Record<MsgType, string>> | null; reviewUrl: string | null }> = {}
  async function bizInfo(userId: string) {
    if (bizCache[userId]) return bizCache[userId]
    const { data } = await supabase.from('business_settings').select('company_name, review_url, message_templates').eq('user_id', userId).maybeSingle()
    const d = data as { company_name: string | null; review_url: string | null; message_templates: Partial<Record<MsgType, string>> | null } | null
    return (bizCache[userId] = { name: d?.company_name || 'Edge Property Services', templates: d?.message_templates ?? null, reviewUrl: d?.review_url ?? null })
  }

  let processed = 0, sent = 0
  const notes: string[] = []

  for (const camp of campaigns) {
    const schedule = camp.schedule || {}
    const leadDays = schedule.lead_days || 0
    // Broadcasts only run on their scheduled day; the others evaluate candidates daily.
    if (camp.kind === 'broadcast' && !broadcastFiresToday(schedule, today)) continue

    // ── Candidate query ──
    let q = supabase.from('customers')
      .select('id, name, phone, email, sms_opt_in, email_opt_in, birthday, anniversary')
      .eq('user_id', camp.user_id).is('archived_at', null).limit(MAX_AUDIENCE + 1)
    if (camp.kind === 'birthday') q = q.not('birthday', 'is', null)
    if (camp.kind === 'anniversary') q = q.not('anniversary', 'is', null)
    if (camp.kind === 'win_back') {
      const cutoff = new Date(today.getTime() - (schedule.days || 45) * 86400000).toISOString()
      // Only customers we used to talk to and have gone quiet on — never blast a
      // brand-new, never-contacted lead.
      q = q.not('last_contacted_at', 'is', null).lt('last_contacted_at', cutoff)
    }
    const { data: candRows } = await q
    let cands = (candRows as Cand[]) || []
    if (cands.length > MAX_AUDIENCE) { notes.push(`Campaign "${camp.name}" matched >${MAX_AUDIENCE} customers — only the first ${MAX_AUDIENCE} were processed this run.`); cands = cands.slice(0, MAX_AUDIENCE) }

    // Day-of matching for date campaigns.
    if (camp.kind === 'birthday') cands = cands.filter(c => dateFieldFiresToday(c.birthday, today, leadDays))
    else if (camp.kind === 'anniversary') cands = cands.filter(c => dateFieldFiresToday(c.anniversary, today, leadDays))

    // Audience filter: recurring customers only.
    if (camp.audience?.recurring_only && cands.length) {
      const { data: recs } = await supabase.from('job_recurrences').select('customer_id').in('customer_id', cands.map(c => c.id))
      const recurringIds = new Set(((recs as { customer_id: string }[]) || []).map(r => r.customer_id))
      cands = cands.filter(c => recurringIds.has(c.id))
    }
    if (!cands.length) { await supabase.from('crm_campaigns').update({ last_run_at: new Date().toISOString() }).eq('id', camp.id); continue }

    // Per-period dedupe: pull already-logged customers for this campaign+period.
    const periodKey = campaignPeriodKey(camp.kind, today, leadDays)
    const { data: doneRows } = await supabase.from('crm_campaign_log').select('customer_id').eq('campaign_id', camp.id).eq('period_key', periodKey)
    const done = new Set(((doneRows as { customer_id: string }[]) || []).map(r => r.customer_id))

    const biz = await bizInfo(camp.user_id)
    const templateKey = (camp.template_key || CAMPAIGN_KINDS[camp.kind].defaultTemplate) as MsgType
    const channels = camp.channels?.length ? camp.channels : CAMPAIGN_KINDS[camp.kind].defaultChannels
    // When the owner wrote custom copy, feed it through renderMessage as the
    // template override (keeps the type's subject + interpolation identical).
    const customOverride = camp.custom_body && camp.custom_body.trim()
      ? { [templateKey]: camp.custom_body } as Partial<Record<MsgType, string>>
      : biz.templates
    const bodyForLinkCheck = (camp.custom_body && camp.custom_body.trim()) || ''
    const needsPortal = bodyForLinkCheck.includes('{{portal_link}}')

    for (const c of cands) {
      if (done.has(c.id)) continue
      processed++
      const portalLink = needsPortal ? (await ensurePortalToken(supabase, camp.user_id, c.id).then(t => t ? portalUrl(t) : undefined)) : undefined
      const rendered = renderMessage(templateKey, customOverride, {
        firstName: c.name, businessName: biz.name, reviewLink: biz.reviewUrl || undefined, portalLink,
      })
      const res = await dispatchToCustomer(supabase, {
        userId: camp.user_id,
        customer: { id: c.id, phone: c.phone, email: c.email, sms_opt_in: c.sms_opt_in, email_opt_in: c.email_opt_in },
        channels, smsText: rendered.sms, emailSubject: rendered.subject, emailHtml: rendered.html, emailText: rendered.text,
        template: templateKey, meta: { campaign_id: camp.id, campaign_kind: camp.kind },
      })

      // Comms audit (per channel) — appears in the customer's message history.
      for (const a of res.attempts) {
        await supabase.from('notification_log').insert({
          user_id: camp.user_id, customer_id: c.id, channel: a.channel, template: templateKey,
          status: a.status, detail: a.detail ?? null, message_id: a.sent ? res.messageId : null,
        })
      }
      // Campaign dedupe + history (one row per customer per period). Recorded even
      // when nothing sent (no consent), so it won't be retried within the period.
      const overall = res.sentChannels.length ? 'sent' : (res.attempts.every(a => a.status === 'skipped') ? 'skipped' : 'failed')
      const firstDetail = res.attempts.find(a => !a.sent)?.detail ?? null
      await supabase.from('crm_campaign_log').insert({
        user_id: camp.user_id, campaign_id: camp.id, customer_id: c.id, period_key: periodKey,
        channel: res.sentChannels[0] ?? null, status: overall, detail: firstDetail, message_id: res.messageId,
      })
      if (res.sentChannels.length) sent++
    }

    await supabase.from('crm_campaigns').update({ last_run_at: new Date().toISOString() }).eq('id', camp.id)
  }

  return NextResponse.json({ ok: true, campaigns: campaigns.length, processed, sent, ...(notes.length ? { notes } : {}) })
}
