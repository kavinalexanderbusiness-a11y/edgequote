// ── THE priority queue engine ────────────────────────────────────────────────
// One ranked list of the highest-value things to do right now, distilled from
// signals the app already computes. Pure and framework-free: it takes rows the
// caller has already loaded and returns data — no fetching, no React, no icons.
// The component maps `kind` → icon/tone, so this stays testable and the same
// queue can be rendered anywhere.
//
// Ranking is urgency × value. Money already owed and committed revenue at risk
// float to the top; a fresh lead outranks a stale follow-up because a new
// customer goes cold fastest.

import { formatCurrency } from '@/lib/utils'
import { needsFollowUp } from '@/lib/followup'
import { invoiceBalance } from '@/lib/payments/ledger'
import { computeReactivation, type RJob, type RQuote, type RRecurrence } from '@/lib/reactivation'
import type { LeadResponseReport } from '@/lib/leadResponse'
import type { ServiceSeasons } from '@/lib/seasons'
import type { FeeSettings } from '@/lib/invoiceTotals'
import type { Quote } from '@/types'

export type PriorityKind =
  | 'leads' | 'unpaid' | 'unscheduled' | 'missed'
  | 'drafts' | 'followups' | 'reactivation' | 'lapsed' | 'messages'

export interface Priority {
  kind: PriorityKind
  label: string
  detail: string
  href: string
  score: number
}

// Matches what the ledger's invoiceBalance needs, with the optional fields left
// optional so a caller's narrower select() still satisfies it.
export interface PriorityInvoice {
  amount: number; status: string; amount_paid?: number
  discount_type?: 'amount' | 'percent' | null; discount_value?: number | null
}

export interface PrioritiesInput {
  quotes: Quote[]
  invoices: PriorityInvoice[]
  jobs: RJob[]
  recById: Record<string, RRecurrence>
  customers: { id: string }[]
  conversations: { unread: number }[]
  leads: LeadResponseReport
  seasons: ServiceSeasons
  feeSettings: FeeSettings | null
  today: string
  /** Cap the list so the queue stays scannable. */
  limit?: number
}

export function computePriorities(i: PrioritiesInput): Priority[] {
  const { quotes, invoices, jobs, recById, customers, conversations, leads, seasons, feeSettings, today } = i
  const next: Priority[] = []

  // 1) Money already owed — invoices sent/unpaid. The single most valuable thing
  //    to chase: work done, just not collected. Owed = remaining GST-inclusive
  //    BALANCE via THE ledger engine, so it matches the Invoices page it links to.
  const owed = invoices.filter(inv => inv.status !== 'draft' && inv.status !== 'cancelled' && invoiceBalance(inv, feeSettings).balance > 0.01)
  const owedTotal = owed.reduce((s, inv) => s + invoiceBalance(inv, feeSettings).balance, 0)
  if (owed.length > 0) {
    next.push({
      kind: 'unpaid', label: 'Collect unpaid invoices',
      detail: `${owed.length} · ${formatCurrency(owedTotal)}`,
      href: '/dashboard/invoices', score: 100_000 + owedTotal,
    })
  }

  // 2) Leads waiting on a reply — the most perishable thing on this list. Ages up
  //    the longer it waits (website form, unanswered inbound, or an online booking).
  if (leads.total > 0) {
    const parts = [
      leads.bySource.website ? `${leads.bySource.website} website` : null,
      leads.bySource.booking ? `${leads.bySource.booking} booking` : null,
      leads.bySource.reply ? `${leads.bySource.reply} awaiting reply` : null,
    ].filter(Boolean).join(' · ')
    const hrs = leads.oldestHours
    next.push({
      kind: 'leads',
      label: leads.total === 1 ? 'Respond to a new lead' : 'Respond to new leads',
      detail: hrs != null && hrs >= 1
        ? `${parts} · oldest ${hrs >= 48 ? `${Math.floor(hrs / 24)}d` : `${hrs}h`}`
        : parts,
      href: leads.items[0]?.href || '/dashboard/messages',
      score: 90_000 + Math.min(hrs ?? 0, 72) * 100,
    })
  }

  // 3) Accepted but not scheduled — committed revenue most at risk of slipping.
  //    Cancelled jobs must NOT count as scheduled.
  const scheduledQuoteIds = new Set(jobs.filter(j => j.quote_id && j.status !== 'cancelled').map(j => j.quote_id))
  const acceptedUnscheduled = quotes.filter(q => q.status === 'accepted' && !scheduledQuoteIds.has(q.id))
  const acceptedTotal = acceptedUnscheduled.reduce((s, q) => s + Number(q.total || 0), 0)
  if (acceptedUnscheduled.length > 0) {
    next.push({
      kind: 'unscheduled', label: 'Schedule accepted jobs',
      detail: `${acceptedUnscheduled.length} · ${formatCurrency(acceptedTotal)}`,
      href: '/dashboard/schedule', score: 80_000 + acceptedTotal,
    })
  }

  // 4) Missed visits — past-date jobs still open, customers falling behind.
  const missed = jobs.filter(j => j.scheduled_date < today && (j.status === 'scheduled' || j.status === 'in_progress'))
  if (missed.length > 0) {
    next.push({
      kind: 'missed', label: 'Resolve missed jobs', detail: `${missed.length} past due`,
      href: '/dashboard/schedule', score: 70_000 + missed.length * 200,
    })
  }

  // 5) Draft invoices to send — the auto-invoiced recurring pipeline that silently
  //    goes unsent (mirrors the Invoices "Drafts to review" card).
  const drafts = invoices.filter(inv => inv.status === 'draft')
  const draftTotal = drafts.reduce((s, inv) => s + Number(inv.amount || 0), 0)
  if (drafts.length > 0) {
    next.push({
      kind: 'drafts', label: 'Send draft invoices',
      detail: `${drafts.length} · ${formatCurrency(draftTotal)}`,
      href: '/dashboard/invoices', score: 60_000 + draftTotal,
    })
  }

  // 6) Quotes needing follow-up — reuse needsFollowUp so the count matches the
  //    Quotes follow-up queue exactly.
  const followups = quotes.filter(needsFollowUp)
  const followupTotal = followups.reduce((s, q) => s + Number(q.total || 0), 0)
  if (followups.length > 0) {
    next.push({
      kind: 'followups', label: 'Follow up on quotes',
      detail: `${followups.length} · ${formatCurrency(followupTotal)}`,
      href: '/dashboard/quotes', score: 50_000 + followupTotal,
    })
  }

  // 7) Recurring ran dry / lapsed — via THE reactivation engine, the same one the
  //    Reactivation page renders, so these counts can never disagree with the page
  //    they link to.
  const react = computeReactivation({ customers, jobs, quotes: quotes as unknown as RQuote[], recById, seasons, today })
  const ranOutValue = react.ranOuts.reduce((s, r) => s + r.perVisit, 0)
  if (react.ranOuts.length > 0) {
    next.push({
      kind: 'reactivation', label: 'Re-book recurring customers',
      detail: ranOutValue > 0 ? `${react.ranOuts.length} · ${formatCurrency(ranOutValue)}/visit` : `${react.ranOuts.length} customer${react.ranOuts.length !== 1 ? 's' : ''}`,
      href: '/dashboard/reactivation', score: 40_000 + ranOutValue,
    })
  }
  // The slower half of the same engine — only when no urgent re-book queue is
  // competing for the same click.
  if (react.risks.length > 0 && react.ranOuts.length === 0) {
    const recover = react.risks.reduce((s, r) => s + r.potentialRecovery, 0)
    next.push({
      kind: 'lapsed', label: 'Win back lapsed customers',
      detail: `${react.risks.length} · ${formatCurrency(recover)} recoverable`,
      href: '/dashboard/reactivation', score: 20_000 + recover,
    })
  }

  // 8) Unread messages — time-sensitive but lower raw dollar value, so it sits
  //    below the money rows unless nothing else is up.
  const unreadTotal = conversations.reduce((s, c) => s + Number(c.unread || 0), 0)
  if (conversations.length > 0) {
    next.push({
      kind: 'messages', label: 'Reply to messages',
      detail: `${conversations.length} conversation${conversations.length !== 1 ? 's' : ''} · ${unreadTotal} unread`,
      href: '/dashboard/messages', score: 30_000 + unreadTotal * 100,
    })
  }

  next.sort((a, b) => b.score - a.score)
  return next.slice(0, i.limit ?? 6)
}
