'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { formatCurrency } from '@/lib/utils'
import { needsFollowUp } from '@/lib/followup'
import { jobVisitValue, effectiveFreq } from '@/lib/invoicing'
import type { Quote } from '@/types'
import {
  ListChecks, CheckCircle2, ArrowRight,
  DollarSign, FileText, Bell, CalendarPlus, AlertTriangle, MessageSquare, Repeat,
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

function localTodayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface JobLite { quote_id: string | null; customer_id: string | null; status: string; scheduled_date: string; recurrence_id: string | null; price: number | null }
interface InvoiceLite { amount: number | null; status: string }

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

      const [qRes, iRes, jRes, rRes, cRes] = await Promise.all([
        // Quotes drive follow-ups + accepted-not-scheduled (reuse those exact signals).
        supabase.from('quotes').select('*').eq('user_id', user.id),
        supabase.from('invoices').select('amount, status').eq('user_id', user.id),
        supabase.from('jobs').select('quote_id, customer_id, status, scheduled_date, recurrence_id, price').eq('user_id', user.id),
        supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', user.id),
        // Unread conversations — same source as the Messages inbox.
        supabase.from('conversations').select('unread').eq('user_id', user.id).is('archived_at', null).gt('unread', 0),
      ])

      const quotes = (qRes.data as Quote[]) || []
      const invoices = (iRes.data as InvoiceLite[]) || []
      const jobs = (jRes.data as JobLite[]) || []
      const recById: Record<string, { freq: string | null; interval_unit: string | null; interval_count: number | null }> = {}
      for (const r of (rRes.data as { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null }[]) || []) recById[r.id] = r
      const conversations = (cRes.data as { unread: number }[]) || []

      const next: Priority[] = []

      // 1) Money already owed — invoices sent/unpaid. The single most valuable thing
      //    to chase: work done, just not collected.
      const owed = invoices.filter(i => i.status === 'unpaid' || i.status === 'sent')
      const owedTotal = owed.reduce((s, i) => s + Number(i.amount || 0), 0)
      if (owed.length > 0) {
        next.push({
          key: 'unpaid', icon: DollarSign, tone: 'text-red-400 bg-red-500/10 border-red-500/20',
          label: 'Collect unpaid invoices', detail: `${owed.length} · ${formatCurrency(owedTotal)}`,
          href: '/dashboard/invoices', score: 100_000 + owedTotal,
        })
      }

      // 2) Accepted but not scheduled — committed revenue most at risk of slipping.
      //    Cancelled jobs must NOT count as scheduled (matches UnscheduledAccepted).
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

      // 3) Missed visits — past-date jobs still open. Un-invoiced, customers falling
      //    behind (mirrors MissedJobs).
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
      //    (reuse needsFollowUp so the count matches FollowUpQuotes exactly).
      const followups = quotes.filter(needsFollowUp)
      const followupTotal = followups.reduce((s, q) => s + Number(q.total || 0), 0)
      if (followups.length > 0) {
        next.push({
          key: 'followups', icon: Bell, tone: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
          label: 'Follow up on quotes', detail: `${followups.length} · ${formatCurrency(followupTotal)}`,
          href: '/dashboard/quotes', score: 50_000 + followupTotal,
        })
      }

      // 6) Recurring series ran out — a recurring customer with no upcoming visit
      //    booked. Per-visit value at stake (same valuation engine as Reactivation).
      const futureByCust = new Set(
        jobs.filter(j => j.customer_id && j.scheduled_date >= today && (j.status === 'scheduled' || j.status === 'in_progress'))
          .map(j => j.customer_id),
      )
      const ranOutCusts = new Set<string>()
      let ranOutValue = 0
      for (const j of jobs) {
        if (!j.recurrence_id || !j.customer_id) continue
        if (futureByCust.has(j.customer_id)) continue
        if (j.scheduled_date > today) continue // a future-dated visit means it isn't dry
        if (ranOutCusts.has(j.customer_id)) continue // first (most recent enough) hit per customer
        ranOutCusts.add(j.customer_id)
        const rec = j.recurrence_id ? recById[j.recurrence_id] : null
        const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
        ranOutValue += Math.round(jobVisitValue(j.price, null, freq))
      }
      if (ranOutCusts.size > 0) {
        next.push({
          key: 'reactivation', icon: Repeat, tone: 'text-accent bg-accent/10 border-accent/20',
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

  if (loading) return null // stay quiet until ready — no skeleton noise

  return (
    <div className="rounded-card border border-border bg-bg-secondary overflow-hidden">
      <div className="px-4 sm:px-5 py-3 border-b border-border flex items-center gap-2">
        <ListChecks className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-bold text-ink">Today&rsquo;s Priorities</h2>
        {items.length > 0 && (
          <span className="text-xs font-semibold text-accent bg-accent/10 border border-accent/20 rounded-full px-2 py-0.5">{items.length}</span>
        )}
      </div>

      {items.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <CheckCircle2 className="w-6 h-6 mx-auto mb-2 text-emerald-400" />
          <p className="text-sm font-medium text-ink">You&rsquo;re all caught up</p>
          <p className="text-xs text-ink-muted mt-0.5">No follow-ups, unsent invoices, or unscheduled work right now.</p>
        </div>
      ) : (
        <ol className="divide-y divide-border">
          {items.map((p, i) => (
            <li key={p.key}>
              <Link
                href={p.href}
                className="flex items-center gap-3 px-4 sm:px-5 py-3.5 hover:bg-surface/40 active:bg-surface/60 transition-colors"
              >
                <span className="shrink-0 w-5 text-center text-xs font-bold text-ink-faint tabular-nums">{i + 1}</span>
                <span className={`shrink-0 w-9 h-9 rounded-lg border flex items-center justify-center ${p.tone}`}>
                  <p.icon className="w-4 h-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink truncate">{p.label}</span>
                  <span className="block text-xs text-ink-muted truncate mt-0.5">{p.detail}</span>
                </span>
                <ArrowRight className="w-4 h-4 text-ink-faint shrink-0" />
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
