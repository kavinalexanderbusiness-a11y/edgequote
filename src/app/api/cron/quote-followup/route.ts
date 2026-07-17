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
// Each chase costs up to two sequential provider round-trips, so the platform
// default (10–15s) would kill the run mid-batch and leave the tally a lie.
export const maxDuration = 300

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

// Blast-radius guard on the scan, not on who gets chased. Truncating is SAFE here:
// claim-before-send means a quote this run never reached keeps its follow_up_count
// and is simply picked up by the next run — nothing is skipped, only deferred. Do
// not "fix" this by removing the cap; an unbounded scan is what makes a run time
// out mid-batch.
const MAX_PER_RUN = 500

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
  // Oldest first, so a truncated scan still holds the stalest money (the in-memory
  // compareFollowUp then applies the engine's exact priority). One row over the cap
  // is how truncation is detected without paying for a count query.
  const sel = 'id, user_id, customer_id, quote_number, total, status, sent_at, valid_until, last_followed_up_at, follow_up_count, customers(name, phone, email, sms_opt_in, email_opt_in, message_prefs)'
  const { data: rows, error } = await supabase.from('quotes').select(sel).eq('status', 'sent')
    .order('sent_at', { ascending: true })
    .limit(MAX_PER_RUN + 1)
  if (error) {
    // A failed read is NOT a quiet day — say so, or an outage looks like "nothing
    // to chase" forever.
    console.error('[cron/quote-followup] quote query failed:', error.message)
    return NextResponse.json({ ok: false, error: error.message, note: 'Could not read quotes — nothing was chased this run.' }, { status: 500 })
  }
  const fetched = (rows as unknown as FollowUpQuote[]) || []
  const truncated = fetched.length > MAX_PER_RUN
  const quotes = fetched.slice(0, MAX_PER_RUN).filter(q => q.customer_id && q.customers)
  if (truncated) console.warn(`[cron/quote-followup] hit MAX_PER_RUN=${MAX_PER_RUN}; the rest are chased on the next run.`)
  if (quotes.length === 0) return NextResponse.json({ ok: true, chased: 0, sent: 0, skipped: 0, failed: 0, truncated })

  // Invoiced → the quote has already turned into money owed; stop chasing it even
  // if its status never moved off 'sent'.
  // A failed read here would empty the stop list and chase quotes that already
  // turned into money owed — so it aborts the run rather than guessing.
  const { data: invRows, error: invErr } = await supabase.from('invoices').select('quote_id').in('quote_id', quotes.map(q => q.id))
  if (invErr) {
    console.error('[cron/quote-followup] invoice lookup failed:', invErr.message)
    return NextResponse.json({ ok: false, error: invErr.message, note: 'Could not read invoices — nothing was chased this run.' }, { status: 500 })
  }
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
    // Hand the attempt back when the send never happened for a reason that could
    // resolve itself (Twilio/Resend down, timing out, rate-limiting) — otherwise two
    // outage days silently retire a live quote at FOLLOW_UP_MAX having sent nothing.
    // Guarded on seen + 1 — the value the claim wrote — so if a concurrent run has
    // already re-claimed this quote, this matches nothing and leaves its attempt alone.
    // last_followed_up_at deliberately STAYS moved: it's the backoff that stops a
    // broken provider being retried on every run.
    refund: async q => {
      const seen = q.follow_up_count ?? 0
      await supabase.from('quotes')
        .update({ follow_up_count: seen })
        .eq('id', q.id).eq('follow_up_count', seen + 1)
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

  const summary = { ok: true, ...tally, truncated }
  // Log only when there was something to do, so quiet runs stay quiet in the logs.
  if (tally.chased > 0) console.log('[cron/quote-followup] run:', JSON.stringify(summary))
  if (tally.failed > 0) console.error(`[cron/quote-followup] ${tally.failed} follow-up(s) sent nothing and had their attempt REFUNDED (provider down/timeout/429/5xx, or a throw) — they are chased again next run. See notification_log rows with status 'error'.`)
  return NextResponse.json(summary)
}
