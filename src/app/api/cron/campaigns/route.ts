import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { renderMessage, isCommercialMessage, MsgType, type MessagePrefs } from '@/lib/comms/templates'
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
// Each customer costs up to ~2 provider calls (10s timeout each) plus ~6 DB
// round-trips, and the audience runs to MAX_AUDIENCE. On the platform default
// (10-15s) the invocation was killed after roughly a dozen recipients — and
// because a broadcast only fires on ONE day per period, the rest were never
// picked up: a 300-customer send silently reached ~4% of its audience, monthly,
// forever. Nothing surfaced it; the kill lands before the response is built.
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

// A claim older than this with no send recorded is treated as abandoned by a
// dead run. Comfortably longer than the worst real send (2 provider calls at a
// 10s timeout each) so a slow-but-live run is never reaped out from under itself.
const STALE_CLAIM_MS = 15 * 60 * 1000

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
  const bizCache: Record<string, { name: string; templates: Partial<Record<MsgType, string>> | null; reviewUrl: string | null; logoUrl: string | null; website: string | null; phone: string | null; mailingAddress: string | null }> = {}
  async function bizInfo(userId: string) {
    if (bizCache[userId]) return bizCache[userId]
    const { data } = await supabase.from('business_settings').select('company_name, phone, website, logo_url, review_url, message_templates, base_address').eq('user_id', userId).maybeSingle()
    const d = data as { company_name: string | null; phone: string | null; website: string | null; logo_url: string | null; review_url: string | null; message_templates: Partial<Record<MsgType, string>> | null; base_address: string | null } | null
    return (bizCache[userId] = { name: d?.company_name || 'Edge Property Services', templates: d?.message_templates ?? null, reviewUrl: d?.review_url ?? null, logoUrl: d?.logo_url ?? null, website: d?.website ?? null, phone: d?.phone ?? null, mailingAddress: d?.base_address ?? null })
  }

  let processed = 0, sent = 0, claimFailures = 0, reaped = 0
  const notes: string[] = []

  // ── Reap stale claims ───────────────────────────────────────────────────────
  // A claim is written 'sending' BEFORE dispatch and finalized after. If a run
  // dies in between (timeout, instance recycled) the row sits at 'sending'
  // forever — and because the dedupe below is status-blind, that customer is
  // skipped for the WHOLE period: a year for a birthday.
  //
  // A stale row is genuinely ambiguous: the send may have gone out and only the
  // finalize failed. Deleting it blindly would double-message. So resolve it
  // against what dispatch actually recorded — it stamps meta.campaign_id on the
  // messages row it threads. Evidence of a send → finalize it. No evidence →
  // release the claim so this run re-sends.
  async function reapStale(camp: CampaignRow, periodKey: string) {
    const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
    const { data: stale } = await supabase.from('crm_campaign_log')
      .select('id, customer_id')
      .eq('campaign_id', camp.id).eq('period_key', periodKey)
      .eq('status', 'sending').lt('created_at', cutoff)
    for (const row of ((stale as { id: string; customer_id: string }[]) || [])) {
      const { data: msg } = await supabase.from('messages')
        .select('id').eq('customer_id', row.customer_id)
        .eq('meta->>campaign_id', camp.id).limit(1)
      if ((msg as unknown[] | null)?.length) {
        // It did send — the finalize is what was lost.
        await supabase.from('crm_campaign_log')
          .update({ status: 'sent', detail: 'recovered: send confirmed, finalize lost' }).eq('id', row.id)
      } else {
        // No trace of a send — release the slot so this run can retry it.
        await supabase.from('crm_campaign_log').delete().eq('id', row.id)
      }
      reaped++
    }
  }

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
    let cands: AudienceCustomer[], capped: boolean
    try {
      const r = await resolveAudience(supabase, {
        userId: camp.user_id, kind: camp.kind, schedule, audience: camp.audience || {}, today,
      })
      cands = r.customers; capped = r.capped
    } catch (e) {
      // resolveAudience now throws rather than resolving to an empty audience.
      // Say so and move to the next campaign — one broken query must not look
      // like "nobody matched", and must not stop the other campaigns.
      notes.push(`Campaign "${camp.name}": could not resolve its audience — ${(e as Error).message}`)
      continue
    }
    if (capped) notes.push(`Campaign "${camp.name}" matched >${MAX_AUDIENCE} customers — only the first ${MAX_AUDIENCE} were processed this run.`)
    if (!cands.length) { await supabase.from('crm_campaigns').update({ last_run_at: new Date().toISOString() }).eq('id', camp.id); continue }

    // Per-period dedupe: pull already-logged customers for this campaign+period.
    // Reap first, so a claim stranded by a crashed run is resolved (or released)
    // BEFORE it gets counted as "already handled" for another whole period.
    const periodKey = campaignPeriodKey(camp.kind, today, leadDays)
    await reapStale(camp, periodKey)
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
    // A commercial message ALWAYS needs the portal link — it's the unsubscribe
    // mechanism its footer is legally required to carry (see renderBody). Minting
    // it only when the body happens to mention {{portal_link}} meant every
    // marketing email shipped with an unsubscribe link it couldn't build.
    const needsPortal = bodyForLinkCheck.includes('{{portal_link}}') || isCommercialMessage(templateKey)

    for (const c of cands) {
      if (done.has(c.id)) continue
      // RESERVE-THEN-SEND: claim the (campaign, customer, period) row BEFORE dispatching.
      // The UNIQUE(campaign_id, customer_id, period_key) makes this atomic — a concurrent
      // cron invocation (Vercel at-least-once) that already claimed this customer/period
      // fails the insert and is skipped here, so the customer is never double-messaged.
      const { error: claimErr } = await supabase.from('crm_campaign_log').insert({
        user_id: camp.user_id, campaign_id: camp.id, customer_id: c.id, period_key: periodKey, status: 'sending',
      })
      if (claimErr) {
        // 23505 = unique violation = another run legitimately owns this customer
        // for this period. That is the ONLY error reserve-then-send absorbs.
        // Anything else (auth, network, constraint) was being swallowed as if it
        // were a dedupe hit, so a run that claimed nothing because it COULDN'T
        // looked identical to a run with nothing to do.
        if (claimErr.code !== '23505') {
          claimFailures++
          notes.push(`Campaign "${camp.name}": could not claim a send for a customer — ${claimErr.message}`)
        }
        continue
      }
      processed++
      // One customer must never take the whole run down with it. Before this, the
      // route had no try/catch at all: a single throw stranded the in-flight claim
      // at 'sending' (permanently skipping that customer for the period) AND
      // killed every campaign later in the loop for that day.
      try {
        const portalLink = needsPortal ? (await ensurePortalToken(supabase, camp.user_id, c.id).then(t => t ? portalUrl(t) : undefined)) : undefined
        // The owner's subject wins when they wrote one; renderMessage falls back to
        // the template's stock subject otherwise (so existing campaigns are
        // untouched, rather than every broadcast emailing "A quick hello").
        const rendered = renderMessage(templateKey, customOverride, {
          firstName: c.name, businessName: biz.name, reviewLink: biz.reviewUrl || undefined, portalLink,
          directPhone: biz.phone || undefined, logoUrl: biz.logoUrl || undefined, website: biz.website || undefined,
          mailingAddress: biz.mailingAddress || undefined,
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
      } catch (e) {
        // Finalize the claim we already own so it can't sit at 'sending' forever.
        // The reaper above only rescues rows a crash left behind; this closes the
        // ones we can still see.
        await supabase.from('crm_campaign_log').update({
          status: 'failed', detail: `run error: ${(e as Error).message}`.slice(0, 300),
        }).eq('campaign_id', camp.id).eq('customer_id', c.id).eq('period_key', periodKey)
        notes.push(`Campaign "${camp.name}": a send failed — ${(e as Error).message}`)
      }
    }

    await supabase.from('crm_campaigns').update({ last_run_at: new Date().toISOString() }).eq('id', camp.id)
  }

  return NextResponse.json({
    ok: true, campaigns: campaigns.length, processed, sent,
    ...(reaped ? { reaped } : {}),
    ...(claimFailures ? { claimFailures } : {}),
    ...(notes.length ? { notes } : {}),
  })
}
