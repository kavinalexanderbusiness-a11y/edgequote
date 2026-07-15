import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { renderMessage, MsgType, type MessagePrefs } from '@/lib/comms/templates'
import { commsEnabled } from '@/lib/comms/send'
import { dispatchToCustomer } from '@/lib/comms/dispatch'
import { logDispatch } from '@/lib/comms/log'
import { ensurePortalToken, portalUrl } from '@/lib/portal'
import {
  CAMPAIGN_KINDS, campaignPeriodKey, campaignFiresToday, type CampaignKind,
} from '@/lib/crm/campaigns'
import { resolveAudience, MAX_AUDIENCE, type AudienceCustomer } from '@/lib/crm/audience'
import type { CampaignAudience, CampaignSchedule } from '@/types'

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

interface CampaignRow {
  id: string; user_id: string; name: string; kind: CampaignKind; enabled: boolean
  channels: string[]; template_key: string | null; custom_body: string | null
  subject: string | null
  audience: CampaignAudience | null
  schedule: CampaignSchedule | null
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

  // Per-owner business info cache (company name, review link, custom templates,
  // email-shell branding).
  const bizCache: Record<string, { name: string; templates: Partial<Record<MsgType, string>> | null; reviewUrl: string | null; logoUrl: string | null; website: string | null; phone: string | null }> = {}
  async function bizInfo(userId: string) {
    if (bizCache[userId]) return bizCache[userId]
    const { data } = await supabase.from('business_settings').select('company_name, phone, website, logo_url, review_url, message_templates').eq('user_id', userId).maybeSingle()
    const d = data as { company_name: string | null; phone: string | null; website: string | null; logo_url: string | null; review_url: string | null; message_templates: Partial<Record<MsgType, string>> | null } | null
    return (bizCache[userId] = { name: d?.company_name || 'Edge Property Services', templates: d?.message_templates ?? null, reviewUrl: d?.review_url ?? null, logoUrl: d?.logo_url ?? null, website: d?.website ?? null, phone: d?.phone ?? null })
  }

  let processed = 0, sent = 0
  const notes: string[] = []

  for (const camp of campaigns) {
    const schedule = camp.schedule || {}
    const leadDays = schedule.lead_days || 0
    // THE campaign-level gate (kind cadence + the optional starts_on/ends_on
    // window), shared with the UI so "when it sends" can never drift from when
    // it actually sends. Birthday/anniversary/win-back evaluate candidates daily.
    if (!campaignFiresToday({ kind: camp.kind, schedule }, today)) continue

    // ── Candidate resolution ──
    // THE shared audience resolver (lib/crm/audience) — the Campaign Manager's
    // preview calls the same code, so what the owner is shown before enabling
    // and who actually receives this can't drift apart.
    const { customers: cands, capped } = await resolveAudience(supabase, {
      userId: camp.user_id, kind: camp.kind, schedule, audience: camp.audience || {}, today,
    })
    if (capped) notes.push(`Campaign "${camp.name}" matched >${MAX_AUDIENCE} customers — only the first ${MAX_AUDIENCE} were processed this run.`)
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
      // RESERVE-THEN-SEND: claim the (campaign, customer, period) row BEFORE dispatching.
      // The UNIQUE(campaign_id, customer_id, period_key) makes this atomic — a concurrent
      // cron invocation (Vercel at-least-once) that already claimed this customer/period
      // fails the insert and is skipped here, so the customer is never double-messaged.
      const { error: claimErr } = await supabase.from('crm_campaign_log').insert({
        user_id: camp.user_id, campaign_id: camp.id, customer_id: c.id, period_key: periodKey, status: 'sending',
      })
      if (claimErr) continue   // another run owns this customer/period → skip (no send)
      processed++
      const portalLink = needsPortal ? (await ensurePortalToken(supabase, camp.user_id, c.id).then(t => t ? portalUrl(t) : undefined)) : undefined
      // The owner's subject wins when they wrote one; renderMessage falls back to
      // the template's stock subject otherwise (so existing campaigns are
      // untouched, rather than every broadcast emailing "A quick hello").
      const rendered = renderMessage(templateKey, customOverride, {
        firstName: c.name, businessName: biz.name, reviewLink: biz.reviewUrl || undefined, portalLink,
        directPhone: biz.phone || undefined, logoUrl: biz.logoUrl || undefined, website: biz.website || undefined,
      }, camp.subject)
      const res = await dispatchToCustomer(supabase, {
        userId: camp.user_id,
        customer: { id: c.id, phone: c.phone, email: c.email, sms_opt_in: c.sms_opt_in, email_opt_in: c.email_opt_in, message_prefs: c.message_prefs },
        channels, smsText: rendered.sms, emailSubject: rendered.subject, emailHtml: rendered.html, emailText: rendered.text,
        template: templateKey, meta: { campaign_id: camp.id, campaign_kind: camp.kind },
      })

      // Comms audit (per channel) — appears in the customer's message history.
      await logDispatch(supabase, res, { userId: camp.user_id, customerId: c.id, template: templateKey })
      // Finalize the claimed row (UPDATE, not a second insert) with the real outcome.
      const overall = res.sentChannels.length ? 'sent' : (res.attempts.every(a => a.status === 'skipped') ? 'skipped' : 'failed')
      const firstDetail = res.attempts.find(a => !a.sent)?.detail ?? null
      await supabase.from('crm_campaign_log').update({
        channel: res.sentChannels[0] ?? null, status: overall, detail: firstDetail, message_id: res.messageId,
      }).eq('campaign_id', camp.id).eq('customer_id', c.id).eq('period_key', periodKey)
      if (res.sentChannels.length) sent++
    }

    await supabase.from('crm_campaigns').update({ last_run_at: new Date().toISOString() }).eq('id', camp.id)
  }

  return NextResponse.json({ ok: true, campaigns: campaigns.length, processed, sent, ...(notes.length ? { notes } : {}) })
}
