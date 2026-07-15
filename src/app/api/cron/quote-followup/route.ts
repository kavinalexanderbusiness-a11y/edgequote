import { NextRequest, NextResponse } from 'next/server'
import { cronSecretOk, serviceClient } from '@/lib/cron/guard'
import { renderMessage, type MessagePrefs } from '@/lib/comms/templates'
import { commsEnabled } from '@/lib/comms/send'
import { runChaseCron } from '@/lib/automation/chase'
import { loadOwnerContext, type OwnerContext } from '@/lib/automation/owner'
import { ensurePortalToken, portalUrl } from '@/lib/portal'
import { dueForAutoFollowUp, compareFollowUp, resolveFollowUpPolicy, type FollowUpPolicy } from '@/lib/followup'
import { isQuoteExpired } from '@/lib/quoteStatus'
import { localTodayISO } from '@/lib/utils'
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
//   expired   → past its valid_until (lib/quoteStatus, the same overlay the list
//               and the detail page show). Chasing a price you will not honour is
//               worse than silence.
//   exhausted → follow_up_count reached the owner's maximum.

interface FollowUpCustomer {
  name: string; phone: string | null; email: string | null
  sms_opt_in: boolean; email_opt_in: boolean; message_prefs?: MessagePrefs | null
}
type FollowUpQuote = Pick<Quote, 'id' | 'user_id' | 'customer_id' | 'quote_number' | 'total' | 'status' | 'sent_at' | 'valid_until' | 'last_followed_up_at' | 'follow_up_count'>
  & { customers: FollowUpCustomer | null }

// The shared per-owner settings (lib/automation/owner) plus the one thing that is
// genuinely this chaser's own: its follow-up cadence.
type QuoteChaseCtx = OwnerContext & { policy: FollowUpPolicy }

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
  const today = localTodayISO()

  // Only quotes still awaiting an answer can be chased at all.
  const sel = 'id, user_id, customer_id, quote_number, total, status, sent_at, valid_until, last_followed_up_at, follow_up_count, customers(name, phone, email, sms_opt_in, email_opt_in, message_prefs)'
  const { data: rows } = await supabase.from('quotes').select(sel).eq('status', 'sent')
  const quotes = ((rows as unknown as FollowUpQuote[]) || []).filter(q => q.customer_id && q.customers)
  if (quotes.length === 0) return NextResponse.json({ ok: true, chased: 0, sent: 0, skipped: 0, failed: 0 })

  // Invoiced → the quote has already turned into money owed; stop chasing it even
  // if its status never moved off 'sent'.
  const { data: invRows } = await supabase.from('invoices').select('quote_id').in('quote_id', quotes.map(q => q.id))
  const invoiced = new Set(((invRows as { quote_id: string | null }[]) || []).map(i => i.quote_id))

  // Per-owner settings. THE shared settings read (lib/automation/owner) plus this
  // chaser's own cadence. runChaseCron caches loadContext per user_id, so this is
  // one query per owner per run — a local cache here would be dead weight.
  async function bizInfo(userId: string): Promise<QuoteChaseCtx> {
    const o = await loadOwnerContext(supabase, userId)
    return { ...o, policy: resolveFollowUpPolicy(o.automationsRaw) }
  }

  // THE shared chase loop (lib/automation/chase) owns the parts that are dangerous
  // to re-type: claim-before-send, 'error' vs 'failed', one bad row never aborting
  // the batch, and what the tally counts. What stays here is only what's this
  // chaser's own.
  const tally = await runChaseCron<FollowUpQuote, QuoteChaseCtx>(supabase, {
    items: quotes,
    template: 'estimate_followup',
    errorLabel: 'follow-up failed',
    // Oldest first, biggest ties first — the engine's own priority, so a partial run
    // always chases the stalest money first.
    sort: (a, b) => compareFollowUp(a as unknown as Quote, b as unknown as Quote),
    // Invoiced → already money owed. Expired → never chase a price we won't honour
    // (ONE expiry engine).
    skip: q => invoiced.has(q.id) || isQuoteExpired(q, today),
    loadContext: bizInfo,
    enabled: ctx => ctx.automations.quote_followup,                          // owner hasn't switched it on
    due: (q, ctx) => dueForAutoFollowUp(q as unknown as Quote, ctx.policy),  // ONE engine decides staleness + cap
    // Compare-and-swap on the exact follow_up_count we read, re-checking status in
    // the same statement. Two overlapping runs both see the quote as due, but only
    // one UPDATE can match. Moving last_followed_up_at also re-anchors
    // needsFollowUp, which is what spaces the next chase by delayDays.
    claim: async q => {
      const seen = q.follow_up_count ?? 0
      const { data } = await supabase.from('quotes')
        .update({ last_followed_up_at: new Date().toISOString(), follow_up_count: seen + 1 })
        .eq('id', q.id).eq('status', 'sent').eq('follow_up_count', seen)
        .select('id')
      return !!data && data.length > 0
    },
    render: async (q, ctx) => {
      const token = await ensurePortalToken(supabase, q.user_id, q.customer_id!)
      const msg = renderMessage('estimate_followup', ctx.templates, {
        firstName: q.customers!.name,
        businessName: ctx.name,
        quoteLink: token ? portalUrl(token) : undefined,
        logoUrl: ctx.logoUrl || undefined,
        website: ctx.website || undefined,
        directPhone: ctx.phone || undefined,
      })
      return {
        smsText: msg.sms, emailSubject: msg.subject, emailHtml: msg.html, emailText: msg.text,
        // follow_up_count is the value READ before the claim — the row object isn't
        // mutated by it — so this is the same number the CAS wrote.
        meta: { quote_id: q.id, quote_number: q.quote_number, follow_up_number: (q.follow_up_count ?? 0) + 1, automated: true },
      }
    },
  })

  return NextResponse.json({ ok: true, ...tally })
}
