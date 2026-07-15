import { NextRequest, NextResponse } from 'next/server'
import { cronSecretOk, serviceClient } from '@/lib/cron/guard'
import { renderMessage, MsgType, type MessagePrefs } from '@/lib/comms/templates'
import { commsEnabled } from '@/lib/comms/send'
import { dispatchToCustomer } from '@/lib/comms/dispatch'
import { logDispatch, logSend } from '@/lib/comms/log'
import { ensurePortalToken, portalUrl } from '@/lib/portal'
import { resolveAutomations, Automations } from '@/lib/comms/automations'
import { dueForAutoFollowUp, compareFollowUp, resolveFollowUpPolicy, type FollowUpPolicy } from '@/lib/followup'
import type { Quote } from '@/types'

export const dynamic = 'force-dynamic'

// ── Automatic quote follow-up (Vercel Cron → see vercel.json) ────────────────
// Chases quotes the customer never answered, using the existing estimate_followup
// template. Same guards as every other scheduled sender:
//   • requires CRON_SECRET,
//   • no-ops when comms credentials are absent,
//   • needs SUPABASE_SERVICE_ROLE_KEY to read across owners,
//   • OFF unless the owner turns it on (automations.quote_followup),
//   • per-customer opt-in + granular consent enforced by dispatchToCustomer,
//   • every send, skip and failure written to notification_log.
//
// It owns no opinion about which quotes are stale — lib/followup is the single
// engine for that, so this cron and the owner's follow-up queue can never drift.
//
// WHEN CHASING STOPS (no separate stop list — all of it falls out of real state):
//   accepted / declined / scheduled / completed / paid → status leaves 'sent',
//     which needsFollowUp already treats as terminal.
//   invoiced  → an invoice row references the quote (checked below).
//   exhausted → follow_up_count reached the owner's maximum.
// NOTE: quotes have no expiry column or 'expired' status in this schema, so
// there is nothing to read for it — the maximum count is what bounds a chase
// (delayDays × maxCount after sending, then silence).

interface FollowUpCustomer {
  name: string; phone: string | null; email: string | null
  sms_opt_in: boolean; email_opt_in: boolean; message_prefs?: MessagePrefs | null
}
type FollowUpQuote = Pick<Quote, 'id' | 'user_id' | 'customer_id' | 'quote_number' | 'total' | 'status' | 'sent_at' | 'last_followed_up_at' | 'follow_up_count'>
  & { customers: FollowUpCustomer | null }

export async function GET(req: NextRequest) {
  if (!cronSecretOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const enabled = commsEnabled()
  if (!enabled.sms && !enabled.email) {
    return NextResponse.json({ ok: true, disabled: true, note: 'Comms disabled — set Twilio/Resend env vars to enable scheduled sends.' })
  }
  const client = serviceClient()
  if (!client) {
    return NextResponse.json({ ok: true, skipped: true, note: 'Set SUPABASE_SERVICE_ROLE_KEY to enable scheduled sends.' })
  }
  const supabase = client

  // Only quotes still awaiting an answer can be chased at all.
  const sel = 'id, user_id, customer_id, quote_number, total, status, sent_at, last_followed_up_at, follow_up_count, customers(name, phone, email, sms_opt_in, email_opt_in, message_prefs)'
  const { data: rows } = await supabase.from('quotes').select(sel).eq('status', 'sent')
  const quotes = ((rows as unknown as FollowUpQuote[]) || []).filter(q => q.customer_id && q.customers)
  if (quotes.length === 0) return NextResponse.json({ ok: true, chased: 0, sent: 0, skipped: 0, failed: 0 })

  // Invoiced → the quote has already turned into money owed; stop chasing it even
  // if its status never moved off 'sent'.
  const { data: invRows } = await supabase.from('invoices').select('quote_id').in('quote_id', quotes.map(q => q.id))
  const invoiced = new Set(((invRows as { quote_id: string | null }[]) || []).map(i => i.quote_id))

  const bizCache: Record<string, { name: string; templates: Partial<Record<MsgType, string>> | null; logoUrl: string | null; website: string | null; phone: string | null; automations: Automations; policy: FollowUpPolicy }> = {}
  async function bizInfo(userId: string) {
    if (bizCache[userId]) return bizCache[userId]
    const { data } = await supabase.from('business_settings').select('company_name, phone, website, logo_url, message_templates, automations').eq('user_id', userId).maybeSingle()
    const d = data as { company_name: string | null; phone: string | null; website: string | null; logo_url: string | null; message_templates: Partial<Record<MsgType, string>> | null; automations: unknown } | null
    return (bizCache[userId] = {
      name: d?.company_name || 'Edge Property Services',
      templates: d?.message_templates ?? null,
      logoUrl: d?.logo_url ?? null,
      website: d?.website ?? null,
      phone: d?.phone ?? null,
      automations: resolveAutomations(d?.automations),
      policy: resolveFollowUpPolicy(d?.automations),
    })
  }

  let sent = 0, skipped = 0, chased = 0, failed = 0
  // Oldest first, biggest ties first — the engine's own priority, so a partial run
  // always chases the stalest money first.
  for (const q of [...quotes].sort((a, b) => compareFollowUp(a as unknown as Quote, b as unknown as Quote))) {
    if (invoiced.has(q.id)) continue
    const info = await bizInfo(q.user_id)
    if (!info.automations.quote_followup) continue                        // owner hasn't switched it on
    if (!dueForAutoFollowUp(q as unknown as Quote, info.policy)) continue  // ONE engine decides staleness + cap

    // ── Claim before sending ──────────────────────────────────────────────────
    // Compare-and-swap on the exact follow_up_count we read, re-checking status in
    // the same statement. Two overlapping cron runs both see the quote as due, but
    // only one UPDATE can match — the loser gets zero rows and moves on, so a quote
    // can never be chased twice. Moving last_followed_up_at also re-anchors
    // needsFollowUp, which is what spaces the next chase by delayDays.
    const seen = q.follow_up_count ?? 0
    const { data: claimed } = await supabase.from('quotes')
      .update({ last_followed_up_at: new Date().toISOString(), follow_up_count: seen + 1 })
      .eq('id', q.id).eq('status', 'sent').eq('follow_up_count', seen)
      .select('id')
    if (!claimed || claimed.length === 0) continue   // another run got it, or it was answered mid-run
    chased++

    // One bad quote must never abort the batch — the rest of the owner's book
    // would go unchased until tomorrow. A throw here is recorded like any other
    // failure so the attempt it consumed is visible rather than silent.
    try {
      const token = await ensurePortalToken(supabase, q.user_id, q.customer_id!)
      const msg = renderMessage('estimate_followup', info.templates, {
        firstName: q.customers!.name,
        businessName: info.name,
        quoteLink: token ? portalUrl(token) : undefined,
        logoUrl: info.logoUrl || undefined,
        website: info.website || undefined,
        directPhone: info.phone || undefined,
      })

      // The shared dispatcher enforces granular consent + per-channel opt-in and
      // threads the message into the customer's conversation — identical to a manual
      // send. It returns one attempt per channel for us to log.
      const res = await dispatchToCustomer(supabase, {
        userId: q.user_id,
        customer: { id: q.customer_id!, ...q.customers! },
        channels: ['sms', 'email'],
        smsText: msg.sms, emailSubject: msg.subject, emailHtml: msg.html, emailText: msg.text,
        template: 'estimate_followup',
        meta: { quote_id: q.id, quote_number: q.quote_number, follow_up_number: seen + 1, automated: true },
      })
      // THE shared writer: carries each attempt's provider id, so a delivery
      // webhook can later move these rows past 'sent' (and only links a bubble to
      // attempts that actually sent).
      await logDispatch(supabase, res, { userId: q.user_id, customerId: q.customer_id, template: 'estimate_followup' })
      if (res.sentChannels.length) sent++; else skipped++
    } catch (e) {
      failed++
      // 'error', not 'failed': the dispatcher threw, so we do NOT know the message
      // reached a provider — that's a send-time failure and must stay retryable.
      // 'failed' is reserved for a provider telling us delivery failed (see
      // lib/comms/delivery SENT_STATES), which would suppress future attempts.
      await logSend(supabase, {
        userId: q.user_id, customerId: q.customer_id, channel: 'sms',
        template: 'estimate_followup', status: 'error',
        detail: e instanceof Error ? e.message.slice(0, 200) : 'follow-up failed',
      })
    }
  }

  return NextResponse.json({ ok: true, chased, sent, skipped, failed })
}
