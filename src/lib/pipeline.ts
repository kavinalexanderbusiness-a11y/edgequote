// ── THE sales pipeline — one deal, one stage, ONE next action ────────────────
//
// WHAT THIS IS
// The answer to "what should I do next?" at the level of a single deal. The
// dashboard's Owner Action queue (lib/dashboard/priorities) already answers it at
// the level of the BUSINESS — "Collect unpaid invoices · 5 · $2,140" — which is
// the right shape for a morning glance and the wrong shape for "…so which one,
// and what do I do about it?". This engine answers that second question, and it
// answers it with the SAME rules: every predicate below is imported from the
// engine that already owns it. Nothing here re-derives staleness, won/lost,
// expiry, a balance, a deposit or a lapse.
//
// NO NEW STATE. There is no `stage` column and no `pipeline_status`. A deal's rung
// is DERIVED on every read from records the app already keeps — exactly the
// posture lib/quoteStatus took with 'expired' and lib/payments/ledger took with
// 'overdue'. A stored stage would be an eighth thing that can disagree with
// quotes.status, and it would be wrong within a week: the customer accepts in the
// portal, a trigger completes the job, an invoice gets paid — none of which would
// ever come back and fix a hand-set stage. See lib/salesStage for the ladder.
//
// WHAT A DEAL IS
// A quote, or an open lead that has no quote yet, or a recurring customer whose
// plan ran dry. One row per deal, never two: a lead whose customer already has a
// quote is represented by the QUOTE (which is what closeOpenLeads encodes when it
// closes leads by customer — "the quote IS the response, whichever door it came
// through"), and a customer already carrying a quote-backed row is never also
// added as a renewal.
//
// WHAT LEAVES THE PIPELINE
// A deal leaves when there is nothing left to do about it. A won quote that is
// booked, invoiced and paid is finished business and drops off; a loss with its
// reason recorded drops off. That is deliberate: this is a working queue, not a
// history. The history already has a home — Grow's Win/Loss panel reads every
// decided quote (lib/winLoss) and this must not become a second, disagreeing copy
// of it. The board says so in words rather than letting the owner infer that a
// short Won column means a bad month.

import { formatCurrency } from '@/lib/utils'
import type { Quote, QuoteStatus } from '@/types'
import { type SalesStage, stageOfQuote } from '@/lib/salesStage'
import { quoteIsQuiet, FOLLOW_UP_DAYS, canChaseCustomer, chaseBlockedReason, daysSince } from '@/lib/followup'
import { describeSkip } from '@/lib/comms/skipReasons'
import type { ReachCustomer } from '@/lib/comms/reach'
import { isQuoteExpired, daysUntilExpiry, sendBlockedReason, type ExpirableQuote } from '@/lib/quoteStatus'
import { invoiceBalance } from '@/lib/payments/ledger'
import { depositState, type DepositInvoice } from '@/lib/payments/deposit'
import { computeReactivation, type RJob, type RQuote, type RRecurrence } from '@/lib/reactivation'
import { computeLeadsNeedingResponse, type LeadConvRow, type LeadQuoteRow, type LeadSource } from '@/lib/leadResponse'
import { scheduledQuoteIds, tierAdder } from '@/lib/dashboard/priorities'
import type { ServiceSeasons } from '@/lib/seasons'
import type { FeeSettings } from '@/lib/invoiceTotals'

export type { SalesStage }

// ── The next action ──────────────────────────────────────────────────────────
// Eleven verbs, and the eleventh is "nothing". `wait` exists because the honest
// answer for a quote sent yesterday is "wait" — inventing a nudge for it is how a
// queue teaches the owner to ignore it. A row with `wait` is still ON the board
// (the deal is live and the money is on the table); it simply asks for nothing
// today, and sorts below everything that does.
export type NextActionKind =
  | 'call_lead'        // an open lead nobody has answered
  | 'prepare_quote'    // we replied; nothing is written down for them yet
  | 'price_quote'      // a draft with no price — it cannot be sent (lib/quoteStatus)
  | 'link_customer'    // a draft with no customer — it cannot be delivered or chased
  | 'send_quote'       // a finished draft the customer has never seen
  | 'follow_up'        // sent, gone quiet on the owner's cadence
  | 'add_contact'      // gone quiet AND unchaseable — find a number, don't write a message
  | 'send_invoice'     // won and worked, invoice still a draft
  | 'collect_deposit'  // won, deposit asked for, money not in
  | 'schedule_work'    // won, nothing on the calendar
  | 'collect_payment'  // won and invoiced, balance outstanding
  | 'renew_service'    // recurring plan ran dry
  | 'log_loss'         // optional — say why it was lost
  | 'wait'             // nothing to do; the ball is theirs

export interface NextAction {
  kind: NextActionKind
  /** The verb, in the owner's words. Never a sentence. */
  label: string
  /** Why now — the fact that justifies the verb. */
  detail: string
  /** One tap does the thing. */
  href: string
  /** Genuinely optional work (only `log_loss`). The UI must not nag for these. */
  optional?: boolean
}

export interface Opportunity {
  /** Stable across reloads: `q-<quoteId>`, `l-<leadKey>` or `c-<customerId>`. */
  key: string
  source: 'quote' | 'lead' | 'customer'
  quoteId: string | null
  customerId: string | null
  name: string
  /** What they asked for, when we know. Empty string when nobody said. */
  service: string
  stage: SalesStage
  /** Money on the table. NULL means unknown — a lead nobody has priced. Never 0. */
  value: number | null
  /** When this deal last moved (ISO). */
  at: string
  /** Whole days since `at`. */
  ageDays: number
  action: NextAction
  /** One tap opens the deal itself. */
  href: string
  score: number
  /** The recorded loss reason key, when there is one (lib/winLoss LOSS_REASONS). */
  lossReason?: string | null
}

export interface PipelineReport {
  items: Opportunity[]
  /** Deals on the board, per rung — counts of `items`, never of history. */
  counts: Record<SalesStage, number>
  /** Money attached to OPEN deals (new_lead → quote_sent). Unpriced deals add nothing. */
  openValue: number
  /** How many rows are asking for something today (everything but `wait`). */
  actionable: number
}

// ── Ranking ──────────────────────────────────────────────────────────────────
// Tiers 10_000 apart, each carrying a clamped value adder — the SAME discipline
// and the SAME clamp (tierAdder) the Owner Action queue uses, imported rather
// than copied so the two orderings cannot invert against each other.
//
// The tier ORDER mirrors that queue's where the concepts match: money already
// owed outranks a perishable lead, which outranks committed work not yet booked,
// which outranks a chase. Two verbs it does not have sit where their urgency puts
// them — a deposit is money owed that is also BLOCKING booked work, so it leads;
// `prepare_quote` is real sales work and sits just above the data-quality chore.
const TIER: Record<NextActionKind, number> = {
  collect_deposit: 12,
  collect_payment: 11,
  call_lead: 10,
  price_quote: 9, link_customer: 9, send_quote: 9,
  schedule_work: 8,
  send_invoice: 7,
  follow_up: 6,
  prepare_quote: 5,
  add_contact: 4,
  renew_service: 3,
  log_loss: 2,
  wait: 1,
}

/** Rank one row. Dollars order WITHIN a tier; age breaks ties for unpriced work. */
function scoreOf(kind: NextActionKind, value: number | null, ageDays: number): number {
  const base = TIER[kind] * 10_000
  const worth = value != null && value > 0 ? value : ageDays * 100
  return base + tierAdder(worth)
}

// ── Inputs ───────────────────────────────────────────────────────────────────
// Deliberately the rows the dashboard loader ALREADY reads. This engine fetches
// nothing; see lib/pipelineData for the one query batch that feeds it.

export interface PQuote {
  id: string
  customer_id: string | null
  customer_name: string
  status: string
  total: number | null
  service_type: string
  created_at: string
  sent_at: string | null
  last_followed_up_at: string | null
  valid_until?: string | null
  lead_meta?: unknown
  /** Reactivation reads these; they ride along in the same select. */
  initial_price?: number | null
  weekly_price?: number | null
  biweekly_price?: number | null
  monthly_price?: number | null
}

export type PJob = RJob & { id: string }

export type PInvoice = DepositInvoice & {
  id: string
  invoice_number: string
  quote_id: string | null
  customer_id: string | null
  status: string
}

export type PCustomer = ReachCustomer & {
  id: string
  name?: string | null
  created_at?: string
  /** Maintained by trigger from outbound messages — THE "have we reached out" fact. */
  last_contacted_at?: string | null
}

export interface PipelineInput {
  quotes: PQuote[]
  jobs: PJob[]
  invoices: PInvoice[]
  customers: PCustomer[]
  conversations: LeadConvRow[]
  /** Recorded loss reasons, so a tagged loss stops asking (lib/winLoss). */
  outcomes: { quote_id: string; reason: string }[]
  recById: Record<string, RRecurrence>
  seasons: ServiceSeasons
  feeSettings: FeeSettings | null
  today: string
  /** Wall clock for staleness. Injected so a test — and a server job — is deterministic. */
  nowMs?: number
  limit?: number
}

const EMPTY_COUNTS = (): Record<SalesStage, number> =>
  ({ new_lead: 0, contacted: 0, quote_draft: 0, quote_sent: 0, won: 0, lost: 0 })

const dayWord = (n: number) => (n === 1 ? '1 day' : `${n} days`)

/** Days between an ISO instant and `nowMs`, floored at 0. Never negative — a row
 *  stamped a few seconds into the future (clock skew) reads as "today", not "-1d". */
function ageOf(at: string, nowMs: number): number {
  const ms = nowMs - new Date(at).getTime()
  return ms > 0 ? Math.floor(ms / 86_400_000) : 0
}

// ═════════════════════════════════════════════════════════════════════════════
// THE engine
// ═════════════════════════════════════════════════════════════════════════════
export function computePipeline(i: PipelineInput): PipelineReport {
  const { quotes, jobs, invoices, customers, conversations, outcomes, recById, seasons, feeSettings, today } = i
  const nowMs = i.nowMs ?? Date.now()

  const custById: Record<string, PCustomer> = {}
  for (const c of customers) custById[c.id] = c
  const reasonByQuote: Record<string, string> = {}
  for (const o of outcomes) reasonByQuote[o.quote_id] = o.reason

  // THE booked-work predicate, shared with the Owner Action queue (a cancelled
  // job is not scheduled work — that trap is held in one place).
  const booked = scheduledQuoteIds(jobs)

  // Invoices reachable from a quote. A quote can carry more than one over its
  // life (a deposit invoice and the balance); the one that still WANTS something
  // is the one worth acting on, so an unsettled invoice always wins over a
  // settled one rather than whichever the database happened to return first.
  const invByQuote: Record<string, PInvoice> = {}
  for (const inv of invoices) {
    if (!inv.quote_id) continue
    const held = invByQuote[inv.quote_id]
    if (!held || (rankInvoice(inv, feeSettings) > rankInvoice(held, feeSettings))) invByQuote[inv.quote_id] = inv
  }

  const items: Opportunity[] = []
  // Every customer already represented on the board — a deal is one row, never two.
  const claimed = new Set<string>()

  // ── 1 · Quote-backed deals ─────────────────────────────────────────────────
  for (const q of quotes) {
    const stage = stageOfQuote(q.status)
    const action = quoteNextAction(q, {
      booked,
      invoice: invByQuote[q.id] ?? null,
      customer: q.customer_id ? custById[q.customer_id] ?? null : null,
      lossReason: reasonByQuote[q.id] ?? null,
      feeSettings, today, nowMs,
    })
    // A finished deal asks for nothing and leaves the board. Only won/lost can
    // reach this: every open rung always produces at least `wait`.
    if (!action) continue

    const value = q.total == null ? null : Number(q.total)
    const at = anchorOf(q)
    const ageDays = ageOf(at, nowMs)
    items.push({
      key: `q-${q.id}`,
      source: 'quote',
      quoteId: q.id,
      customerId: q.customer_id,
      name: q.customer_name || 'Unnamed',
      service: q.service_type || '',
      stage,
      value: value != null && value > 0 ? value : null,
      at, ageDays,
      action,
      href: `/dashboard/quotes/${q.id}`,
      score: scoreOf(action.kind, value, ageDays),
      lossReason: stage === 'lost' ? (reasonByQuote[q.id] ?? null) : null,
    })
    if (q.customer_id) claimed.add(q.customer_id)
  }

  // ── 2 · Leads with no quote ────────────────────────────────────────────────
  // THE lead union (all three doors, already de-duplicated by customer). A lead
  // whose customer has ANY quote is not a second deal — the quote above is it.
  const quotedCustomers = new Set(quotes.map(q => q.customer_id).filter((c): c is string => !!c))
  const leads = computeLeadsNeedingResponse(
    { conversations, quotes: quotes as unknown as LeadQuoteRow[] },
    new Date(nowMs),
  )
  for (const l of leads.items) {
    if (l.customerId && (quotedCustomers.has(l.customerId) || claimed.has(l.customerId))) continue
    const c = l.customerId ? custById[l.customerId] : undefined
    // "Have we reached out?" is customers.last_contacted_at — maintained by the
    // trigger that watches OUTBOUND messages, and the same fact lib/crm/radar
    // asks. Absent = nobody has answered them, which is the whole point of the
    // first rung. A lead with no customer row cannot have been contacted either.
    const contacted = !!c?.last_contacted_at
    const stage: SalesStage = contacted ? 'contacted' : 'new_lead'
    const ageDays = ageOf(l.at, nowMs)
    const action: NextAction = contacted
      ? {
          kind: 'prepare_quote',
          label: 'Prepare quote',
          detail: `contacted ${dayWord(ageDays)} ago · nothing quoted yet`,
          href: l.customerId ? `/dashboard/quotes/new?customer=${l.customerId}` : '/dashboard/quotes/new',
        }
      : {
          kind: 'call_lead',
          label: 'Call lead',
          detail: `${sourceWord(l.source)} · waiting ${waitWord(l.at, nowMs)}`,
          href: l.href,
        }
    items.push({
      key: `l-${l.key}`,
      source: 'lead',
      quoteId: null,
      customerId: l.customerId,
      name: l.name,
      service: '',
      stage,
      // Nobody has priced it. NULL, never 0 — a lead worth an unknown amount must
      // not render as a $0 deal, and must not drag the board's open value down.
      value: null,
      at: l.at, ageDays,
      action,
      href: l.href,
      score: scoreOf(action.kind, null, ageDays),
    })
    if (l.customerId) claimed.add(l.customerId)
  }

  // ── 3 · Recurring plans that ran dry ───────────────────────────────────────
  // THE reactivation engine — the same one the Reactivation page renders, so
  // these can never disagree with the page they link to. Only `ranOuts` (a
  // recurring series with no future visit booked): a definite, nameable renewal.
  // `risks` — the slower "hasn't been seen in months" half — is that page's job
  // and would flood a working queue with maybes.
  const react = computeReactivation({
    customers, jobs, quotes: quotes as unknown as RQuote[], recById, seasons, today,
  })
  for (const r of react.ranOuts) {
    if (claimed.has(r.customer.id)) continue
    const name = (r.customer as { name?: string | null }).name || 'Customer'
    const ageDays = r.daysSince
    const action: NextAction = {
      kind: 'renew_service',
      label: 'Renew service',
      detail: `${r.cadence} plan ran out · last visit ${dayWord(ageDays)} ago`,
      href: `/dashboard/quotes/new?customer=${r.customer.id}`,
    }
    items.push({
      key: `c-${r.customer.id}`,
      source: 'customer',
      quoteId: null,
      customerId: r.customer.id,
      name,
      service: '',
      stage: 'won',
      value: r.perVisit > 0 ? r.perVisit : null,
      at: r.lastServiceDate,
      ageDays,
      action,
      href: `/dashboard/customers/${r.customer.id}`,
      score: scoreOf('renew_service', r.perVisit, ageDays),
    })
    claimed.add(r.customer.id)
  }

  items.sort((a, b) => b.score - a.score || a.at.localeCompare(b.at))

  const counts = EMPTY_COUNTS()
  let openValue = 0
  let actionable = 0
  for (const it of items) {
    counts[it.stage]++
    if (it.stage !== 'won' && it.stage !== 'lost' && it.value) openValue += it.value
    if (it.action.kind !== 'wait') actionable++
  }

  return {
    items: i.limit != null ? items.slice(0, i.limit) : items,
    counts, openValue, actionable,
  }
}

// ── The one action a QUOTE-backed deal is asking for ─────────────────────────
// Returns null ONLY when the deal is finished — won and fully settled, or lost
// and already explained. Every open rung returns something, even if that
// something is `wait`.
//
// EXPORTED because the customer profile asks exactly this question about one
// person's quotes and had grown a third opinion to answer it — a hand-rolled
// "Open items" list whose Schedule rule was `status === 'accepted'` with no
// check for a job, so it told the owner to book work that was already on the
// calendar, forever. One engine, two callers, no drift.
//
// `booked` is THE shared predicate (scheduledQuoteIds) — pass the jobs you
// already hold. `invoice` is the one worth acting on for this quote; `customer`
// answers whether a chase could actually go out. Both optional: absent means
// "unknown", and the engine never invents a blocker it cannot see.
export interface QuoteActionContext {
  booked: Set<string>
  invoice?: PInvoice | null
  customer?: PCustomer | null
  /** A recorded loss reason silences the optional "say why" ask. */
  lossReason?: string | null
  feeSettings: FeeSettings | null
  today: string
  nowMs?: number
}

export function quoteNextAction(q: PQuote, ctx: QuoteActionContext): NextAction | null {
  const stage = stageOfQuote(q.status)
  const { booked, feeSettings, today } = ctx
  const nowMs = ctx.nowMs ?? Date.now()
  const inv = ctx.invoice ?? undefined
  const cust = ctx.customer ?? undefined
  const reasonByQuote: Record<string, string> = ctx.lossReason ? { [q.id]: ctx.lossReason } : {}

  if (stage === 'quote_draft') {
    // Can this even go out? THE shared send gate, so the pipeline names the same
    // blocker the Send button would refuse on — rather than saying "Send quote"
    // about a document that has no price and cannot be sent.
    const blocked = sendBlockedReason({ total: q.total, customer_id: q.customer_id })
    if (blocked === 'no_price') {
      return { kind: 'price_quote', label: 'Add a price', detail: 'this quote has no price yet', href: `/dashboard/quotes/${q.id}` }
    }
    if (blocked === 'no_customer') {
      return { kind: 'link_customer', label: 'Link a customer', detail: 'nobody to send it to', href: `/dashboard/quotes/${q.id}` }
    }
    // A booking arrives as a draft carrying lead_meta — the customer asked for
    // this and is waiting on it, which is a sharper fact than "draft".
    const fromBooking = q.lead_meta != null
    return {
      kind: 'send_quote',
      label: 'Send quote',
      detail: fromBooking
        ? `they booked online ${dayWord(ageOf(q.created_at, nowMs))} ago`
        : `drafted ${dayWord(ageOf(q.created_at, nowMs))} ago · never sent`,
      href: `/dashboard/quotes/${q.id}`,
    }
  }

  if (stage === 'quote_sent') {
    // THE staleness rule (lib/followup), at the manual cadence every owner-facing
    // surface uses. Not quiet yet → the honest answer is "wait".
    if (!quoteIsQuiet(q as unknown as Quote, FOLLOW_UP_DAYS, nowMs)) {
      const sentDays = q.sent_at ? ageOf(q.sent_at, nowMs) : null
      const left = daysUntilExpiry(expirable(q), today)
      return {
        kind: 'wait',
        label: 'Waiting on them',
        detail: [
          sentDays != null ? `sent ${sentDays === 0 ? 'today' : `${dayWord(sentDays)} ago`}` : 'with the customer',
          left != null && left >= 0 ? `expires in ${dayWord(left)}` : null,
        ].filter(Boolean).join(' · '),
        href: `/dashboard/quotes/${q.id}`,
      }
    }
    // Gone quiet — but can a chase actually HAPPEN? Reachability is the reach
    // engine's question, asked separately, and the verb changes with the answer:
    // find a number, versus send a message. Same split the Owner Action queue
    // makes, so the two can never offer a chase the sender would skip.
    if (q.customer_id && cust && !canChaseCustomer(cust)) {
      const why = chaseBlockedReason(cust)
      return {
        kind: 'add_contact',
        label: 'Add a phone number',
        // describeSkip is THE labeller the campaign audience and the message
        // thread already use, so this block reads identically everywhere rather
        // than becoming a fourth hand-written copy.
        detail: why ? describeSkip(why).label : 'no way to reach them',
        href: '/dashboard/data-quality',
      }
    }
    const expired = isQuoteExpired(expirable(q), today)
    const quietDays = daysSince(q.last_followed_up_at || q.sent_at)
    return {
      kind: 'follow_up',
      label: 'Follow up',
      detail: expired
        ? 'this quote has expired — re-send it or extend the date'
        : quietDays != null ? `quiet for ${dayWord(quietDays)}` : 'sent, never timestamped',
      href: `/dashboard/quotes/${q.id}`,
    }
  }

  if (stage === 'won') {
    // Money first, and a deposit before the rest of it: an unpaid deposit is the
    // thing standing between an approved quote and booked work. THE deposit
    // engine, so "how much is still needed" is the invoice panel's number.
    if (inv && inv.status !== 'draft' && inv.status !== 'cancelled') {
      const d = depositState(inv, feeSettings)
      if (d.requested != null && d.outstanding > 0.01) {
        return {
          kind: 'collect_deposit',
          label: 'Collect deposit',
          detail: d.paid > 0
            ? `${formatCurrency(d.paid)} of ${formatCurrency(d.requested)} received`
            : `${formatCurrency(d.outstanding)} up front, not yet paid`,
          href: `/dashboard/invoices?invoice=${encodeURIComponent(inv.invoice_number)}`,
        }
      }
    }
    // Committed revenue with nothing on the calendar.
    if (!booked.has(q.id)) {
      return {
        kind: 'schedule_work',
        label: 'Schedule work',
        detail: `approved ${dayWord(ageOf(anchorOf(q), nowMs))} ago · no date booked`,
        href: `/dashboard/schedule?quote=${q.id}`,
      }
    }
    if (inv) {
      // A draft invoice is money that hasn't been ASKED for yet — a different
      // verb from chasing money that has.
      if (inv.status === 'draft') {
        return {
          kind: 'send_invoice',
          label: 'Send invoice',
          detail: 'the invoice is still a draft',
          href: `/dashboard/invoices?invoice=${encodeURIComponent(inv.invoice_number)}`,
        }
      }
      // ⚠️ A CANCELLED invoice keeps its full balance in the ledger — every money
      // door has to check the status, not just the number.
      if (inv.status !== 'cancelled') {
        const { balance } = invoiceBalance(inv, feeSettings)
        if (balance > 0.01) {
          return {
            kind: 'collect_payment',
            label: 'Collect payment',
            detail: `${formatCurrency(balance)} outstanding`,
            href: `/dashboard/invoices?invoice=${encodeURIComponent(inv.invoice_number)}`,
          }
        }
      }
    }
    // Booked, invoiced, settled — nothing left. It leaves the board.
    return null
  }

  // lost — the reason is OPTIONAL, and asking twice is worse than never asking.
  if (reasonByQuote[q.id]) return null
  return {
    kind: 'log_loss',
    label: 'Say why it was lost',
    detail: 'optional — it teaches your pricing where you lose',
    href: `/dashboard/quotes/${q.id}`,
    optional: true,
  }
}

/** How urgently an invoice still wants something — used only to pick WHICH of a
 *  quote's invoices is the one worth acting on. Higher = more unfinished. */
function rankInvoice(inv: PInvoice, fees: FeeSettings | null): number {
  if (inv.status === 'cancelled') return 0
  if (inv.status === 'draft') return 2
  return invoiceBalance(inv, fees).balance > 0.01 ? 3 : 1
}

/** The instant a quote last MOVED. `sent_at` is the real event when there is one;
 *  `created_at` is the honest fallback for a draft that has never gone anywhere. */
function anchorOf(q: PQuote): string {
  return q.last_followed_up_at || q.sent_at || q.created_at
}

/** The shape THE expiry engine reads. Only ever called from the `quote_sent`
 *  branch, where the status is 'sent' by construction — and 'sent' is the only
 *  status lib/quoteStatus lets expire, so narrowing here asserts nothing the
 *  caller hasn't already established. */
function expirable(q: PQuote): ExpirableQuote {
  return { status: q.status as QuoteStatus, valid_until: q.valid_until ?? null }
}

function sourceWord(s: LeadSource): string {
  return s === 'website' ? 'website form' : s === 'booking' ? 'online booking' : 'they messaged you'
}

/** Hours until it reads badly, then days. A lead waiting 6 hours is a different
 *  emergency from one waiting 6 days, and "0 days" says neither. */
function waitWord(at: string, nowMs: number): string {
  const hrs = Math.max(0, Math.floor((nowMs - new Date(at).getTime()) / 3_600_000))
  if (hrs < 1) return 'under an hour'
  if (hrs < 48) return hrs === 1 ? '1 hour' : `${hrs} hours`
  return dayWord(Math.floor(hrs / 24))
}

// ── One deal's worth of the same engine ──────────────────────────────────────
// The customer profile shows "what's next for THIS person" and must not grow a
// second, disagreeing opinion about it. It runs the whole engine on that
// customer's rows and takes the top-ranked row — same stages, same verbs, same
// order, so the profile and the board can never differ.
export function nextActionForCustomer(i: PipelineInput, customerId: string): Opportunity | null {
  const report = computePipeline(i)
  return report.items.find(o => o.customerId === customerId) ?? null
}

/** Only the rungs that still count as selling. */
export function isOpenOpportunity(o: Opportunity): boolean {
  return o.stage !== 'won' && o.stage !== 'lost'
}
