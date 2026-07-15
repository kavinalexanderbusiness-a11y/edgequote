'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { formatCurrency, localTodayISO } from '@/lib/utils'
import { needsFollowUp } from '@/lib/followup'
import { invoiceBalance } from '@/lib/payments/ledger'
import { computeReactivation, type RQuote, type RJob, type RRecurrence } from '@/lib/reactivation'
import { loadLeadsNeedingResponse, type LeadResponseReport } from '@/lib/leadResponse'
import { settingsToSeasons } from '@/lib/seasons'
import type { Quote } from '@/types'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import {
  ListChecks, CheckCircle2, ArrowRight,
  DollarSign, FileText, Bell, CalendarPlus, AlertTriangle, MessageSquare, Repeat, UserPlus, HeartPulse,
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

      const [qRes, iRes, jRes, rRes, cRes, sRes, custRes, leads] = await Promise.all([
        // Quotes drive follow-ups + accepted-not-scheduled (reuse those exact signals).
        supabase.from('quotes').select('*').eq('user_id', user.id),
        supabase.from('invoices').select('amount, status, amount_paid, discount_type, discount_value').eq('user_id', user.id),
        // service_type is required by the reactivation engine's season gate.
        supabase.from('jobs').select('quote_id, customer_id, status, scheduled_date, recurrence_id, price, service_type').eq('user_id', user.id),
        supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', user.id),
        // Unread conversations — same source as the Messages inbox.
        supabase.from('conversations').select('unread').eq('user_id', user.id).is('archived_at', null).gt('unread', 0),
        // GST — so the owed figure below agrees with the Invoices page and the
        // Outstanding stat (both are ledger-derived, GST-inclusive). service_seasons
        // feeds the reactivation engine's off-season suppression.
        supabase.from('business_settings').select('gst_percent, service_seasons').eq('user_id', user.id).maybeSingle(),
        // Ids only — the reactivation engine is generic, and this row needs counts,
        // not customer records. Archived customers are never re-engagement targets.
        supabase.from('customers').select('id').eq('user_id', user.id).is('archived_at', null),
        loadLeadsNeedingResponse(supabase),
      ])

      const quotes = (qRes.data as Quote[]) || []
      const invoices = (iRes.data as InvoiceLite[]) || []
      const jobs = (jRes.data as RJob[]) || []
      const recById: Record<string, RRecurrence> = {}
      for (const r of (rRes.data as RRecurrence[]) || []) recById[r.id] = r
      const conversations = (cRes.data as { unread: number }[]) || []
      const settingsRow = sRes.data as { gst_percent: number | null; service_seasons: unknown } | null
      const feeSettings = settingsRow
      const seasons = settingsToSeasons(settingsRow?.service_seasons)
      const customers = (custRes.data as { id: string }[]) || []

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
      const followups = quotes.filter(needsFollowUp)
      const followupTotal = followups.reduce((s, q) => s + Number(q.total || 0), 0)
      if (followups.length > 0) {
        next.push({
          key: 'followups', icon: Bell, tone: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
          label: 'Follow up on quotes', detail: `${followups.length} · ${formatCurrency(followupTotal)}`,
          href: '/dashboard/quotes', score: 50_000 + followupTotal,
        })
      }

      // 6) Recurring series ran out — via THE reactivation engine (lib/reactivation),
      //    the same one the Reactivation page renders, so this row's count can never
      //    disagree with the page it links to. (It used to re-derive "ran out" here
      //    with no season gate and no cadence window, which quietly overcounted.)
      //    The pure core is fed the rows already loaded above — no second fetch.
      const react = computeReactivation({
        customers, jobs, quotes: quotes as unknown as RQuote[], recById, seasons, today,
      })
      const ranOutValue = react.ranOuts.reduce((s, r) => s + r.perVisit, 0)
      if (react.ranOuts.length > 0) {
        next.push({
          key: 'reactivation', icon: Repeat, tone: 'text-accent-text bg-accent/10 border-accent/20',
          label: 'Re-book recurring customers', detail: ranOutValue > 0 ? `${react.ranOuts.length} · ${formatCurrency(ranOutValue)}/visit` : `${react.ranOuts.length} customer${react.ranOuts.length !== 1 ? 's' : ''}`,
          href: '/dashboard/reactivation', score: 40_000 + ranOutValue,
        })
      }

      // 6b) Lapsed customers — the slower half of the same engine. Only surfaces
      //     when there's no urgent re-book queue competing for the same click.
      if (react.risks.length > 0 && react.ranOuts.length === 0) {
        const recover = react.risks.reduce((s, r) => s + r.potentialRecovery, 0)
        next.push({
          key: 'lapsed', icon: HeartPulse, tone: 'text-violet-400 bg-violet-500/10 border-violet-500/20',
          label: 'Win back lapsed customers', detail: `${react.risks.length} · ${formatCurrency(recover)} recoverable`,
          href: '/dashboard/reactivation', score: 20_000 + recover,
        })
      }

      // 7) Leads waiting on a reply — a new customer is the most perishable thing
      //    on this list: website form, an unanswered inbound, or an online booking
      //    (which creates NO lead record, only a draft quote — invisible until now).
      if (leads.total > 0) {
        const parts = [
          leads.bySource.website ? `${leads.bySource.website} website` : null,
          leads.bySource.booking ? `${leads.bySource.booking} booking` : null,
          leads.bySource.reply ? `${leads.bySource.reply} awaiting reply` : null,
        ].filter(Boolean).join(' · ')
        const stale = leads.oldestHours != null && leads.oldestHours >= 24
        next.push({
          key: 'leads', icon: UserPlus,
          tone: stale ? 'text-red-400 bg-red-500/10 border-red-500/20' : 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
          label: leads.total === 1 ? 'Respond to a new lead' : 'Respond to new leads',
          detail: leads.oldestHours != null && leads.oldestHours >= 1
            ? `${parts} · oldest ${leads.oldestHours >= 48 ? `${Math.floor(leads.oldestHours / 24)}d` : `${leads.oldestHours}h`}`
            : parts,
          href: leads.items[0]?.href || '/dashboard/messages',
          // Above follow-ups: an unworked lead goes cold fastest. Ages up as it waits.
          score: 90_000 + Math.min(leads.oldestHours ?? 0, 72) * 100,
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
