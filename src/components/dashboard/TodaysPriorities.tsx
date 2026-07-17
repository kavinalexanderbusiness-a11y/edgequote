'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { formatCurrency, localTodayISO } from '@/lib/utils'
import { needsFollowUp, canChaseCustomer } from '@/lib/followup'
import type { ReachCustomer } from '@/lib/comms/reach'
import { jobVisitValue, effectiveFreq } from '@/lib/invoicing'
import { settingsToSeasons, ServiceSeasons } from '@/lib/seasons'
import { ranOut, cadenceDays, isSeasonallyDormant } from '@/lib/signals'
import { invoiceBalance } from '@/lib/payments/ledger'
import type { Quote } from '@/types'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import {
  ListChecks, CheckCircle2, ArrowRight,
  DollarSign, FileText, Bell, CalendarPlus, AlertTriangle, MessageSquare, Repeat, PhoneOff,
} from 'lucide-react'

// ONE ranked queue of the highest-value things to do right now, distilled from the
// same signals the cards below already surface (follow-ups, accepted-not-scheduled,
// drafts/unpaid invoices, missed visits, unread messages, recurring ran-outs). The
// owner scans one short list instead of many cards. Money already owed and committed
// revenue at risk float to the top; everything is drawn from existing tables only.

interface Priority {
  key: string
  icon: typeof DollarSign
  label: string
  detail: string          // count/$ summary shown on the right
  href: string
  tone: string            // icon + accent colour for this row
  score: number           // urgency × value — higher sorts first
}

// `service_type` is carried so the ran-out signal can season-gate (a snow plan in
// July is dormant, not lost) — see lib/signals/lifecycle.
interface JobLite { quote_id: string | null; customer_id: string | null; status: string; scheduled_date: string; service_type: string | null; recurrence_id: string | null; price: number | null }
interface InvoiceLite { amount: number; status: string; amount_paid?: number; discount_type: 'amount' | 'percent' | null; discount_value: number | null }

export function TodaysPriorities() {
  const supabase = useMemo(() => createClient(), [])
  const [items, setItems] = useState<Priority[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      // getSession() is a local read — no GoTrue round-trip before the data query. The
      // reads below are RLS-scoped, so the session's uid is all we need.
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { setLoading(false); return }
      const today = localTodayISO()

      const [qRes, iRes, jRes, rRes, cRes, sRes, custRes] = await Promise.all([
        // Quotes drive follow-ups + accepted-not-scheduled (reuse those exact signals).
        supabase.from('quotes').select('*').eq('user_id', user.id),
        supabase.from('invoices').select('amount, status, amount_paid, discount_type, discount_value').eq('user_id', user.id),
        supabase.from('jobs').select('quote_id, customer_id, status, scheduled_date, service_type, recurrence_id, price').eq('user_id', user.id),
        supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', user.id),
        // Unread conversations — same source as the Messages inbox.
        supabase.from('conversations').select('unread').eq('user_id', user.id).is('archived_at', null).gt('unread', 0),
        // GST — so the owed figure below agrees with the Invoices page and the
        // Outstanding stat (both are ledger-derived, GST-inclusive). Seasons ride
        // along on the same row: the ran-out signal is season-gated.
        supabase.from('business_settings').select('gst_percent, service_seasons').eq('user_id', user.id).maybeSingle(),
        // Exactly the fields lib/comms/reach needs to answer "would a message to
        // this person actually go out" — so the follow-up row can tell the owner
        // which chases are real. Rides along in the batch that was already going out.
        supabase.from('customers').select('id, phone, email, sms_opt_in, email_opt_in, message_prefs').eq('user_id', user.id),
      ])

      const quotes = (qRes.data as Quote[]) || []
      const invoices = (iRes.data as InvoiceLite[]) || []
      const jobs = (jRes.data as JobLite[]) || []
      const recById: Record<string, { freq: string | null; interval_unit: string | null; interval_count: number | null }> = {}
      for (const r of (rRes.data as { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null }[]) || []) recById[r.id] = r
      // Quotes are already loaded above; index them so a recurring visit can read
      // its cadence price instead of being valued at $0.
      const quotesById: Record<string, Record<string, unknown>> = {}
      for (const q of quotes) quotesById[q.id] = q as unknown as Record<string, unknown>
      const conversations = (cRes.data as { unread: number }[]) || []
      const custById: Record<string, ReachCustomer> = {}
      for (const c of (custRes.data as (ReachCustomer & { id: string })[]) || []) custById[c.id] = c
      const feeSettings = sRes.data as { gst_percent: number | null; service_seasons: unknown } | null
      const seasons: ServiceSeasons = settingsToSeasons(feeSettings?.service_seasons)

      const next: Priority[] = []

      // 1) Money already owed — invoices sent/unpaid. The single most valuable thing
      //    to chase: work done, just not collected.
      // Owed = remaining GST-inclusive BALANCE across issued invoices (partial
      // payments count, cancelled paper doesn't) via THE ledger engine, so this
      // dollar figure matches Outstanding below and the Invoices page it links to.
      const owed = invoices.filter(i => i.status !== 'draft' && i.status !== 'cancelled' && invoiceBalance(i, feeSettings).balance > 0.01)
      const owedTotal = owed.reduce((s, i) => s + invoiceBalance(i, feeSettings).balance, 0)
      if (owed.length > 0) {
        next.push({
          key: 'unpaid', icon: DollarSign, tone: 'text-red-400 bg-red-500/10 border-red-500/20',
          label: 'Collect unpaid invoices', detail: `${owed.length} · ${formatCurrency(owedTotal)}`,
          href: '/dashboard/invoices', score: 100_000 + owedTotal,
        })
      }

      // 2) Accepted but not scheduled — committed revenue most at risk of slipping.
      //    Cancelled jobs must NOT count as scheduled.
      const scheduledQuoteIds = new Set(jobs.filter(j => j.quote_id && j.status !== 'cancelled').map(j => j.quote_id))
      const acceptedUnscheduled = quotes.filter(q => q.status === 'accepted' && !scheduledQuoteIds.has(q.id))
      const acceptedTotal = acceptedUnscheduled.reduce((s, q) => s + Number(q.total || 0), 0)
      if (acceptedUnscheduled.length > 0) {
        next.push({
          key: 'unscheduled', icon: CalendarPlus, tone: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
          label: 'Schedule accepted jobs', detail: `${acceptedUnscheduled.length} · ${formatCurrency(acceptedTotal)}`,
          href: '/dashboard/schedule', score: 80_000 + acceptedTotal,
        })
      }

      // 3) Missed visits — past-date jobs still open, un-invoiced, customers falling behind.
      const missed = jobs.filter(j => j.scheduled_date < today && (j.status === 'scheduled' || j.status === 'in_progress'))
      if (missed.length > 0) {
        next.push({
          key: 'missed', icon: AlertTriangle, tone: 'text-red-400 bg-red-500/10 border-red-500/20',
          label: 'Resolve missed jobs', detail: `${missed.length} past due`,
          href: '/dashboard/schedule', score: 70_000 + missed.length * 200,
        })
      }

      // 4) Draft invoices to send — the auto-invoiced recurring pipeline that silently
      //    goes unsent (mirrors the Invoices "Drafts to review" card).
      const drafts = invoices.filter(i => i.status === 'draft')
      const draftTotal = drafts.reduce((s, i) => s + Number(i.amount || 0), 0)
      if (drafts.length > 0) {
        next.push({
          key: 'drafts', icon: FileText, tone: 'text-sky-400 bg-sky-500/10 border-sky-500/20',
          label: 'Send draft invoices', detail: `${drafts.length} · ${formatCurrency(draftTotal)}`,
          href: '/dashboard/invoices', score: 60_000 + draftTotal,
        })
      }

      // 5) Quotes needing follow-up — gone quiet, most recoverable new revenue
      //    (reuse needsFollowUp so the count matches the Quotes follow-up queue exactly).
      //
      //    Split by whether the chase can actually HAPPEN. This queue used to offer
      //    "9 · $1,246" as one job; on the live book only 3 of those 9 were
      //    chaseable and the other 6 ($445) belonged to customers with no phone and
      //    no email. Both halves are real money, but they need different verbs — one
      //    is "send a message", the other is "find their number" — and a single row
      //    sent the owner to the quote list to discover the difference one dead end
      //    at a time. canChaseCustomer is the same reach engine the sender uses, so
      //    this can't disagree with what a send would actually do.
      const followups = quotes.filter(needsFollowUp)
      const chaseable = followups.filter(q => q.customer_id && canChaseCustomer(custById[q.customer_id]))
      const blocked = followups.filter(q => !q.customer_id || !canChaseCustomer(custById[q.customer_id]))
      const sum = (qs: Quote[]) => qs.reduce((s, q) => s + Number(q.total || 0), 0)
      const chaseableTotal = sum(chaseable)
      const blockedTotal = sum(blocked)
      if (chaseable.length > 0) {
        next.push({
          key: 'followups', icon: Bell, tone: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
          label: 'Follow up on quotes', detail: `${chaseable.length} · ${formatCurrency(chaseableTotal)}`,
          href: '/dashboard/quotes', score: 50_000 + chaseableTotal,
        })
      }
      if (blocked.length > 0) {
        next.push({
          key: 'followups-blocked', icon: PhoneOff, tone: 'text-ink-muted bg-bg-tertiary border-border',
          label: 'Quotes you can’t chase yet', detail: `${blocked.length} · ${formatCurrency(blockedTotal)}`,
          // Data Quality is the surface that already lists customers with no contact
          // on file — the fix for this row is a phone number, not a message.
          href: '/dashboard/data-quality', score: 45_000 + blockedTotal,
        })
      }

      // 6) Recurring series ran out — a recurring customer with no upcoming visit
      //    booked. THE shared ran-out detector, so this count is the same queue the
      //    Reactivation page alarms on: season-gated (an off-season snow customer is
      //    dormant, not adrift), only customers actually serviced, and only while the
      //    series is plausibly still active. Per-visit value at stake.
      const jobsByCust: Record<string, JobLite[]> = {}
      for (const j of jobs) if (j.customer_id) (jobsByCust[j.customer_id] ||= []).push(j)
      const ranOutCusts = new Set<string>()
      let ranOutValue = 0
      // MERGE (main ← guardian-2): both sides fixed a real bug in this loop, and
      // each was missing the other's. Neither version wins wholesale.
      //   · guardian-2: stop re-deriving "ran out" inline — consume the ONE canonical
      //     detector (lib/signals.ranOut). Re-deriving this condition is exactly how
      //     six screens came to disagree about who had churned. It also honours
      //     seasonal dormancy, which the inline rule never did.
      //   · main (1030f52): the QUOTE carries the cadence price. Valuing the visit off
      //     j.price alone made every quote-linked recurring visit (price IS NULL — the
      //     normal case) worth $0, so this tile silently understated its own value.
      // Both sides also independently fixed "DB order can pick a dead series": the
      // sort below is guardian-2's, kept because the signal needs the newest series.
      for (const [custId, cj] of Object.entries(jobsByCust)) {
        // Most RECENT recurring activity — DB order can pick a dead series over the
        // customer's current cadence.
        const recJob = cj.filter(j => j.recurrence_id).sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date))[0]
        const upcoming = cj.some(j => j.scheduled_date >= today && (j.status === 'scheduled' || j.status === 'in_progress'))
        const completed = cj.filter(j => j.status === 'completed').map(j => j.scheduled_date).sort()
        const pastReal = cj.filter(j => j.status !== 'cancelled' && j.scheduled_date <= today).map(j => j.scheduled_date).sort()
        const lastDate = completed.length ? completed[completed.length - 1]
          : (pastReal.length ? pastReal[pastReal.length - 1] : null)
        const rec = recJob?.recurrence_id ? recById[recJob.recurrence_id] : null
        const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
        const signal = ranOut({
          hasRecurring: !!recJob,
          hasUpcoming: upcoming,
          lastServiceDate: lastDate,
          cadenceDays: cadenceDays(freq, rec),
          seasonallyDormant: isSeasonallyDormant(recJob?.service_type ?? null, seasons, today),
          today,
        })
        // Every ran-out series counts here (not just the urgent window) — this row
        // has always tracked the whole re-book backlog.
        if (!signal.isRanOut) continue
        ranOutCusts.add(custId)
        const q = recJob.quote_id ? quotesById[recJob.quote_id] : null
        ranOutValue += Math.round(jobVisitValue(recJob.price, q, freq))
      }
      if (ranOutCusts.size > 0) {
        next.push({
          key: 'reactivation', icon: Repeat, tone: 'text-accent-text bg-accent/10 border-accent/20',
          label: 'Re-book recurring customers', detail: ranOutValue > 0 ? `${ranOutCusts.size} · ${formatCurrency(ranOutValue)}/visit` : `${ranOutCusts.size} customer${ranOutCusts.size !== 1 ? 's' : ''}`,
          href: '/dashboard/reactivation', score: 40_000 + ranOutValue,
        })
      }

      // 7) Unread messages — customers waiting on a reply. Time-sensitive but lower
      //    raw dollar value, so it sits below the money rows unless nothing else is up.
      const unreadTotal = conversations.reduce((s, c) => s + Number(c.unread || 0), 0)
      if (conversations.length > 0) {
        next.push({
          key: 'messages', icon: MessageSquare, tone: 'text-sky-400 bg-sky-500/10 border-sky-500/20',
          label: 'Reply to messages', detail: `${conversations.length} conversation${conversations.length !== 1 ? 's' : ''} · ${unreadTotal} unread`,
          href: '/dashboard/messages', score: 30_000 + unreadTotal * 100,
        })
      }

      next.sort((a, b) => b.score - a.score)
      setItems(next.slice(0, 6))
      setLoading(false)
    }
    load()
  }, [supabase])

  // Reserve the top slot while loading — this card always renders once ready, so
  // returning null here made the whole page jump down when it popped in. The
  // skeleton keeps the hero shell + header so the page anchor never changes
  // identity when the data lands.
  if (loading) {
    return (
      <div className="rounded-card border border-accent/20 hero-aurora overflow-hidden">
        <div className="px-4 sm:px-5 py-3.5 border-b border-border flex items-center gap-2.5">
          <span className="w-7 h-7 rounded-lg bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
            <ListChecks className="w-4 h-4 text-accent-text" />
          </span>
          <h2 className="text-sm font-bold tracking-tight text-ink">Today&rsquo;s Priorities</h2>
        </div>
        <div className="px-4 sm:px-5 py-3">
          <SkeletonRows count={4} />
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-card border border-accent/20 hero-aurora overflow-hidden">
      <div className="px-4 sm:px-5 py-3.5 border-b border-border flex items-center gap-2.5">
        <span className="w-7 h-7 rounded-lg bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
          <ListChecks className="w-4 h-4 text-accent-text" />
        </span>
        <h2 className="text-sm font-bold tracking-tight text-ink">Today&rsquo;s Priorities</h2>
      </div>

      {items.length === 0 ? (
        <EmptyState
          tone="positive"
          icon={CheckCircle2}
          title="You’re all caught up"
          description="No follow-ups, unsent invoices, or unread replies right now."
          className="py-10"
        />
      ) : (
        <ol className="divide-y divide-border">
          {items.map((p, i) => (
            <li key={p.key}>
              <Link
                href={p.href}
                className="group flex items-center gap-3 px-4 sm:px-5 py-3.5 hover:bg-surface/40 active:bg-surface/60 transition-colors"
              >
                <span className={`shrink-0 w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center tabular-nums ${i === 0 ? 'bg-accent/15 text-accent-text' : 'bg-bg-tertiary text-ink-faint'}`}>{i + 1}</span>
                <span className={`shrink-0 w-9 h-9 rounded-lg border flex items-center justify-center ${p.tone}`}>
                  <p.icon className="w-4 h-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold tracking-tight text-ink truncate">{p.label}</span>
                  <span className="block text-xs text-ink-muted truncate mt-0.5 tabular-nums">{p.detail}</span>
                </span>
                <ArrowRight className="w-4 h-4 text-ink-faint shrink-0 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
