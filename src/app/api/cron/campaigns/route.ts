import { NextRequest, NextResponse } from 'next/server'
import { cronSecretOk, serviceClient } from '@/lib/cron/guard'
import { renderMessage, MsgType, type MessagePrefs } from '@/lib/comms/templates'
import { commsEnabled } from '@/lib/comms/send'
import { dispatchToCustomer } from '@/lib/comms/dispatch'
import { logDispatch } from '@/lib/comms/log'
import { loadOwnerContext, type OwnerContext } from '@/lib/automation/owner'
import { ensurePortalToken, portalUrl } from '@/lib/portal'
import {
  CAMPAIGN_KINDS, campaignPeriodKey, campaignFiresToday, type CampaignKind,
} from '@/lib/crm/campaigns'
import { resolveAudience, MAX_AUDIENCE, type AudienceCustomer } from '@/lib/crm/audience'
import type { CampaignAudience, CampaignSchedule } from '@/types'

export const dynamic = 'force-dynamic'
// A campaign's audience is capped at MAX_AUDIENCE (2000) and each recipient costs
// up to two sequential provider round-trips — the platform default (10–15s) could
// not finish one campaign, let alone the day's.
export const maxDuration = 300

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

// Recipients are already bounded per campaign (MAX_AUDIENCE, in lib/crm/audience),
// so what's left unbounded is the NUMBER of campaigns a run will work through.
// This sweep runs across ALL owners, so the cap is platform-wide — set well above
// any realistic day (and below PostgREST's silent 1000-row response cap, which
// would truncate without saying so).
//
// Truncating is safe in the sense that the per-period dedupe (crm_campaign_log)
// means an unreached campaign is picked up by the next run without double-sending.
// But unlike the chasers, a campaign's PERIOD can pass — so the warning below is a
// real signal to raise the cap, not routine noise.
const MAX_CAMPAIGNS_PER_RUN = 200

export async function GET(req: NextRequest) {
  if (!cronSecretOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const enabled = commsEnabled()
  if (!enabled.sms && !enabled.email) {
    return NextResponse.json({ ok: true, disabled: true, note: 'Comms disabled — set Twilio/Resend env vars to enable campaign sends.' })
  }
  const client = serviceClient()
  if (!client) {
    return NextResponse.json({ ok: true, skipped: true, note: 'Set SUPABASE_SERVICE_ROLE_KEY to enable campaign sends.' })
  }
  const supabase = client
  const today = new Date()

  // Oldest-run first, so a truncated run rotates through the book instead of
  // starving the same campaigns every day. One row over the cap is how truncation
  // is detected without paying for a count query.
  const { data: campaignRows, error: campErr } = await supabase.from('crm_campaigns').select('*').eq('enabled', true)
    .order('last_run_at', { ascending: true, nullsFirst: true })
    .limit(MAX_CAMPAIGNS_PER_RUN + 1)
  if (campErr) {
    // A failed read is NOT "no campaigns today" — say so, or an outage is invisible.
    console.error('[cron/campaigns] campaign query failed:', campErr.message)
    return NextResponse.json({ ok: false, error: campErr.message, note: 'Could not read crm_campaigns — nothing was sent this run.' }, { status: 500 })
  }
  const fetched = (campaignRows as CampaignRow[]) || []
  const truncated = fetched.length > MAX_CAMPAIGNS_PER_RUN
  const campaigns = fetched.slice(0, MAX_CAMPAIGNS_PER_RUN)
  if (truncated) console.warn(`[cron/campaigns] hit MAX_CAMPAIGNS_PER_RUN=${MAX_CAMPAIGNS_PER_RUN}; the rest run next time (oldest last_run_at first).`)

  // Per-owner settings (company name, review link, custom templates, email-shell
  // branding) — THE shared read, lib/automation/owner. Cached because this loop
  // asks per campaign: one settings query per owner per run, not one per campaign.
  const bizCache: Record<string, OwnerContext> = {}
  async function bizInfo(userId: string): Promise<OwnerContext> {
    return (bizCache[userId] ??= await loadOwnerContext(supabase, userId))
  }

  // `processed` counts CLAIMS (its long-standing meaning); `sent` counts recipients
  // reached. `skipped`/`failed` are the other two outcomes a claim can have — without
  // them a provider outage and an opted-out book look identical from the response.
  let processed = 0, sent = 0, skipped = 0, failed = 0
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
      // One bad recipient must not abort the campaign — and a throw after the claim
      // would otherwise strand its log row at 'sending' forever (the insert dedupe
      // blocks a retry either way, so the row must be told what happened).
      try {
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
        else if (overall === 'skipped') skipped++
        else {
          // A real send failure, not an opt-out — worth a line in the log.
          failed++
          console.error(`[cron/campaigns] "${camp.name}" (${camp.id}) failed for customer ${c.id}: ${firstDetail || 'no detail'}`)
        }
      } catch (e) {
        failed++
        console.error(`[cron/campaigns] "${camp.name}" (${camp.id}) threw for customer ${c.id}:`, e)
        await supabase.from('crm_campaign_log').update({
          status: 'failed', detail: e instanceof Error ? e.message.slice(0, 200) : 'send threw',
        }).eq('campaign_id', camp.id).eq('customer_id', c.id).eq('period_key', periodKey)
      }
    }

    await supabase.from('crm_campaigns').update({ last_run_at: new Date().toISOString() }).eq('id', camp.id)
  }

  const summary = { ok: true, campaigns: campaigns.length, processed, sent, skipped, failed, truncated, ...(notes.length ? { notes } : {}) }
  // Log only when there was something to do, so quiet runs stay quiet in the logs.
  if (processed > 0) console.log('[cron/campaigns] run:', JSON.stringify(summary))
  return NextResponse.json(summary)
}
