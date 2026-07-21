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
import { needsFollowUp, canChaseCustomer } from '@/lib/followup'
import type { ReachCustomer } from '@/lib/comms/reach'
import { invoiceBalance } from '@/lib/payments/ledger'
import { computeReactivation, type RJob, type RQuote, type RRecurrence } from '@/lib/reactivation'
import type { LeadResponseReport } from '@/lib/leadResponse'
import type { ServiceSeasons } from '@/lib/seasons'
import type { FeeSettings } from '@/lib/invoiceTotals'
import type { Quote } from '@/types'

export type PriorityKind =
  | 'leads' | 'unpaid' | 'unscheduled' | 'missed'
  // followups_blocked = real money that CANNOT be chased (no phone, no email).
  // Separate from `followups` because the verb is different: find a number, not
  // send a message.
  | 'drafts' | 'followups' | 'followups_blocked' | 'reactivation' | 'lapsed' | 'messages'

export interface Priority {
  kind: PriorityKind
  label: string
  detail: string
  href: string
  score: number
  /**
   * The row's dollar figure, when the row IS a pile of money (owed, accepted,
   * drafts, chaseable, blocked). Exposed so the component can set it in
   * full-size type instead of burying the number that justified the ranking in
   * a muted detail line. Qualified figures ($/visit, "recoverable") stay in
   * `detail` — a column of unlike numbers would invite summing them.
   * This is the SAME total the score adder already used; nothing new is computed.
   */
  value?: number
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
  // id is all the reactivation engine needs (it's generic over `{id:string}`), but
  // the follow-up split also asks "could a message to this person actually go out",
  // which is the reach engine's question — so the row carries the fields
  // canChaseCustomer reads. They ride along in a query that was already going out.
  customers: (ReachCustomer & { id: string })[]
  conversations: { unread: number; customer_id?: string | null }[]
  leads: LeadResponseReport
  seasons: ServiceSeasons
  feeSettings: FeeSettings | null
  today: string
  /** Cap the list so the queue stays scannable. */
  limit?: number
}

// Tiers sit 10_000 apart and each carries a dollar/urgency adder on top. The
// adder MUST stay inside the gap: added raw, a $17k pile of unscheduled work
// (80_000 + 17_000) would outrank a three-day-old lead (ceiling 97_200), and any
// $5 unpaid invoice (100_000 floor) would outrank it too — silently inverting
// the order this file documents. Clamping keeps ordering WITHIN a tier by value
// while the tier order stays exactly as written.
const TIER_GAP = 10_000
const adder = (n: number) => Math.min(Math.max(n, 0), TIER_GAP - 1_000)

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
      detail: `${owed.length} invoice${owed.length !== 1 ? 's' : ''} outstanding`,
      value: owedTotal,
      href: '/dashboard/invoices', score: 100_000 + adder(owedTotal),
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
      score: 90_000 + adder(Math.min(hrs ?? 0, 72) * 100),
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
      detail: `${acceptedUnscheduled.length} accepted quote${acceptedUnscheduled.length !== 1 ? 's' : ''} with no date`,
      value: acceptedTotal,
      href: '/dashboard/schedule', score: 80_000 + adder(acceptedTotal),
    })
  }

  // 4) Missed visits — past-date jobs still open, customers falling behind.
  const missed = jobs.filter(j => j.scheduled_date < today && (j.status === 'scheduled' || j.status === 'in_progress'))
  if (missed.length > 0) {
    next.push({
      kind: 'missed', label: 'Resolve missed jobs', detail: `${missed.length} past due`,
      href: '/dashboard/schedule', score: 70_000 + adder(missed.length * 200),
    })
  }

  // 5) Draft invoices to send — the auto-invoiced recurring pipeline that silently
  //    goes unsent (mirrors the Invoices "Drafts to review" card).
  const drafts = invoices.filter(inv => inv.status === 'draft')
  const draftTotal = drafts.reduce((s, inv) => s + Number(inv.amount || 0), 0)
  if (drafts.length > 0) {
    next.push({
      kind: 'drafts', label: 'Send draft invoices',
      detail: `${drafts.length} draft${drafts.length !== 1 ? 's' : ''} ready to go`,
      value: draftTotal,
      href: '/dashboard/invoices', score: 60_000 + adder(draftTotal),
    })
  }

  // 6) Quotes needing follow-up — reuse needsFollowUp so the count matches the
  //    Quotes follow-up queue exactly.
  //
  //    Split by whether the chase can actually HAPPEN. This queue used to offer
  //    "9 · $1,246" as one job; on the live book only 3 of those 9 were chaseable
  //    and the other 6 ($445) belonged to customers with no phone and no email.
  //    Both halves are real money, but they need different verbs — one is "send a
  //    message", the other is "find their number" — and a single row sent the owner
  //    to the quote list to discover the difference one dead end at a time.
  //    canChaseCustomer is the same reach engine the sender uses, so this can't
  //    disagree with what a send would actually do.
  const custById: Record<string, ReachCustomer> = {}
  for (const c of customers) custById[c.id] = c
  const followups = quotes.filter(needsFollowUp)
  const sumTotals = (qs: Quote[]) => qs.reduce((s, q) => s + Number(q.total || 0), 0)
  const chaseable = followups.filter(q => q.customer_id && canChaseCustomer(custById[q.customer_id]))
  const blocked = followups.filter(q => !q.customer_id || !canChaseCustomer(custById[q.customer_id]))
  const chaseableTotal = sumTotals(chaseable)
  const blockedTotal = sumTotals(blocked)
  if (chaseable.length > 0) {
    next.push({
      kind: 'followups', label: 'Follow up on quotes',
      detail: `${chaseable.length} quote${chaseable.length !== 1 ? 's' : ''} gone quiet`,
      value: chaseableTotal,
      href: '/dashboard/quotes', score: 50_000 + adder(chaseableTotal),
    })
  }
  if (blocked.length > 0) {
    next.push({
      kind: 'followups_blocked', label: 'Quotes you can’t chase yet',
      detail: `${blocked.length} missing a phone or email`,
      value: blockedTotal,
      // Data-quality, not the quote list: the job here is to find a phone number,
      // not to write a message.
      href: '/dashboard/data-quality', score: 45_000 + adder(blockedTotal),
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
      href: '/dashboard/reactivation', score: 40_000 + adder(ranOutValue),
    })
  }
  // The slower half of the same engine — only when no urgent re-book queue is
  // competing for the same click.
  if (react.risks.length > 0 && react.ranOuts.length === 0) {
    const recover = react.risks.reduce((s, r) => s + r.potentialRecovery, 0)
    next.push({
      kind: 'lapsed', label: 'Win back lapsed customers',
      detail: `${react.risks.length} · ${formatCurrency(recover)} recoverable`,
      href: '/dashboard/reactivation', score: 20_000 + adder(recover),
    })
  }

  // 8) Unread messages — time-sensitive but lower raw dollar value, so it sits
  //    below the money rows unless nothing else is up.
  //
  //    An unanswered inbound conversation is ALREADY counted by the leads row
  //    above (leadResponse classifies last_direction='inbound' as a 'reply'
  //    lead). Left alone, the same customers appeared in two rows pointing at the
  //    same inbox — the queue telling the owner to do one thing twice. Anyone the
  //    leads row already owns is excluded here; the higher tier keeps them.
  const leadCustomerIds = new Set(
    leads.items.filter(l => l.source === 'reply' && l.customerId).map(l => l.customerId),
  )
  const otherUnread = conversations.filter(c => !(c.customer_id && leadCustomerIds.has(c.customer_id)))
  const unreadTotal = otherUnread.reduce((s, c) => s + Number(c.unread || 0), 0)
  if (otherUnread.length > 0) {
    next.push({
      kind: 'messages', label: 'Reply to messages',
      detail: `${otherUnread.length} conversation${otherUnread.length !== 1 ? 's' : ''} · ${unreadTotal} unread`,
      href: '/dashboard/messages', score: 30_000 + adder(unreadTotal * 100),
    })
  }

  next.sort((a, b) => b.score - a.score)
  return next.slice(0, i.limit ?? 6)
}
