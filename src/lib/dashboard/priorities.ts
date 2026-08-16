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
//
// ── Every row names ONE record and opens IT ─────────────────────────────────
// A row used to name a CATEGORY and link to an unfiltered list: "Collect unpaid
// invoices · 4 outstanding" → /dashboard/invoices, all 66 of them. The engine had
// already worked out exactly WHICH four and then threw that away, so the owner
// re-derived the set by hand at the other end — the queue named the job but not
// the work.
//
// So each row now leads with its most urgent MEMBER (customer, reference, why)
// and its href is that member's own focused surface — doors that already exist
// (`?invoice=`, `?quote=`, `/quotes/<id>`), never a new route or a second data
// path. `more` says how many others stand behind it, so naming one is never
// mistaken for claiming there is only one; work the top, come back, the row names
// the next. The tier SCORES are untouched — a row still ranks on the whole
// obligation, it just opens on the part you can act on.
//
// Picking "most urgent" uses each domain's existing ordering (compareFollowUp,
// the leads engine's oldest-first sort, the ledger's overdue overlay). No new
// notion of urgency is invented here.
//
// ⛔ THE LINE: a row names a record ONLY where a focused door already exists for
// it. unpaid/drafts have `?invoice=`, unscheduled has `?quote=`, followups have
// `/quotes/<id>`, and each lead carries its own href. reactivation, lapsed,
// missed, messages and followups_blocked stay COUNT rows on purpose — their
// pages take no focus parameter, so naming one customer there would promise a
// specificity the destination cannot honour, which is a worse lie than the
// vague row. If one of those pages ever grows a focused door, this is the
// comment that says it may then be named — do NOT name one before that.

import { formatCurrency } from '@/lib/utils'
import { needsFollowUp, canChaseCustomer, compareFollowUp } from '@/lib/followup'
import type { ReachCustomer } from '@/lib/comms/reach'
import { invoiceBalance, displayInvoiceStatus } from '@/lib/payments/ledger'
// THE scheduling gate — the queue must not urge scheduling a booking the owner
// deliberately gated on a deposit that hasn't arrived. Same engine as the quote
// page and the portal, so all three agree on which bookings are secured.
import { schedulingGate, gateBlocksScheduling, type GateLedgerRow } from '@/lib/payments/depositGate'
import { computeReactivation, type RJob, type RQuote, type RRecurrence } from '@/lib/reactivation'
import type { LeadResponseReport } from '@/lib/leadResponse'
import type { ServiceSeasons } from '@/lib/seasons'
import type { FeeSettings } from '@/lib/invoiceTotals'
import type { InvoiceStatus, Quote } from '@/types'

export type PriorityKind =
  | 'leads' | 'unpaid' | 'unscheduled' | 'missed'
  // followups_blocked = real money that CANNOT be chased (no phone, no email).
  // Separate from `followups` because the verb is different: find a number, not
  // send a message.
  | 'drafts' | 'followups' | 'followups_blocked' | 'reactivation' | 'lapsed' | 'messages'
  // requests = a customer asked for something from their portal and is waiting.
  // Distinct from `messages` because reading it does not answer it.
  | 'requests'
  // quote_drafts = a quote the OWNER started and never sent. Distinct from
  // `drafts` (invoice drafts — money ready to be asked for) because the verb is
  // different: finish pricing vs press send on a bill. Booking-created drafts
  // (lead_meta) are deliberately NOT here — the leads row already owns them and
  // its door already says "build the quote".
  | 'quote_drafts'

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
   * When the row names ONE record (see the header), this is THAT record's
   * figure, not the set's — a row reading "Collect from Sarah Chen" beside the
   * pile every unpaid invoice adds up to would be a number that means something
   * other than what it sits next to. The set totals are already on this screen,
   * one band up, in MoneyBand — so nothing is lost by making this specific.
   */
  value?: number
  /**
   * How many OTHER records of the same kind stand behind the one named. Absent
   * or 0 = this row IS the whole job. Rendered as "+N more", so leading with one
   * customer never reads as a claim that they are the only one.
   */
  more?: number
  /**
   * Engine-owned urgency flag, set ONLY where the domain's own semantics say the
   * situation is broken rather than merely waiting: money past its due date, a
   * visit whose day has already passed. Consumers (the Owner Inbox's sections)
   * read this instead of re-deriving "is it overdue?" from the copy — a second
   * date comparison outside the ledger overlay is the drift this codebase keeps
   * paying for. Absent = the row is work, not an emergency.
   */
  urgency?: 'urgent'
}

// Matches what the ledger's invoiceBalance needs, with the optional fields left
// optional so a caller's narrower select() still satisfies it.
//
// The identity fields are optional for the same reason: they are what lets a row
// name a record and deep-link to it, but a caller that doesn't select them still
// type-checks and simply gets the older count-and-list row (see `pickInvoice`).
export interface PriorityInvoice {
  // The real status vocabulary, not `string`: this row is now handed to the
  // ledger's `displayInvoiceStatus` overlay to find the overdue one, and that
  // engine is typed on the union. Narrower than before and deliberately so — a
  // caller inventing a status should not type-check its way into a money row.
  amount: number; status: InvoiceStatus; amount_paid?: number
  discount_type?: 'amount' | 'percent' | null; discount_value?: number | null
  invoice_number?: string | null; customer_name?: string | null
  due_date?: string | null; viewed_at?: string | null
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
  /**
   * OPEN portal requests only — the caller filters with lib/portalRequests
   * `openRequests`, so this engine never has to re-decide what "open" means and
   * cannot drift from the card that renders them.
   */
  requests: { customer_id: string | null }[]
  leads: LeadResponseReport
  seasons: ServiceSeasons
  feeSettings: FeeSettings | null
  today: string
  /**
   * Quote-linked deposit ledger rows (payments.quote_id), grouped by quote — the
   * scheduling gate's input. Absent/missing entries read as NOTHING COLLECTED,
   * which fails SAFE: a gated quote lands in the waiting row (check the quote)
   * rather than in "schedule now" (act on an unsecured booking).
   */
  quoteDepositRows?: Record<string, GateLedgerRow[]>
  /** Cap the list so the queue stays scannable. */
  limit?: number
}

// Tiers sit 10_000 apart and each carries a dollar/urgency adder on top. The
// adder MUST stay inside the gap: added raw, a $17k pile of unscheduled work
// (80_000 + 17_000) would outrank a three-day-old lead (ceiling 97_200), and any
// $5 unpaid invoice (100_000 floor) would outrank it too — silently inverting
// the order this file documents. Clamping keeps ordering WITHIN a tier by value
// while the tier order stays exactly as written.
export const TIER_GAP = 10_000
/** Clamp a dollar/urgency figure so it can order rows WITHIN a tier but can
 *  never jump one. Exported because lib/pipeline ranks per-deal rows on the same
 *  tier discipline — two copies of this clamp is two ways for the ordering to
 *  silently invert. */
export const tierAdder = (n: number) => Math.min(Math.max(n, 0), TIER_GAP - 1_000)
const adder = tierAdder

// ── Naming the one record a row opens ────────────────────────────────────────

// Whole days between two 'YYYY-MM-DD' days, via local midnight on both sides —
// the same construction isoPlusDays uses in dashboard/data, so neither can drift
// across a UTC boundary and report a day that hasn't happened yet.
function daysBetween(fromISO: string, toISO: string): number {
  const a = new Date(`${fromISO}T00:00:00`).getTime()
  const b = new Date(`${toISO}T00:00:00`).getTime()
  return Math.round((b - a) / 86_400_000)
}

// "Sarah" → "Sarah’s", "Chris" → "Chris’". Curly apostrophe to match the rest of
// the product's copy.
function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}’` : `${name}’s`
}

// A trimmed display name, or null when the row has nothing real to lead with —
// an empty/whitespace customer_name must fall back to the count row rather than
// render "Collect from ’s". customer_name is NOT NULL in the schema, but it is a
// denormalised copy and '' is a value the column accepts.
function displayName(raw: string | null | undefined): string | null {
  const n = (raw ?? '').trim()
  return n.length > 0 ? n : null
}

/**
 * The one invoice a money row should open, plus the copy that explains why it.
 * Returns null when the rows lack the identity fields (a narrower caller) or the
 * winner has no usable name/number — the caller then keeps its count-and-list
 * row, which is always correct, just less specific.
 */
function pickInvoice(
  rows: PriorityInvoice[], settings: FeeSettings | null, today: string,
): { name: string; number: string; balance: number; why: string } | null {
  // due_date is OPTIONAL on PriorityInvoice (a narrower caller may not select it)
  // but REQUIRED-nullable on what the ledger overlay accepts. Absent and null both
  // mean "no due date", so they collapse here — one place, rather than a cast at
  // each of the two call sites below.
  const forLedger = (inv: PriorityInvoice) => ({ ...inv, due_date: inv.due_date ?? null })
  // Longest-overdue first, then the largest balance. There is deliberately NO
  // separate "is it overdue" sort key: among the rows that reach here (owed, so
  // balance > 0 and status unpaid/sent/partial) the ledger calls an invoice
  // overdue exactly when its due date has passed — so due-date order already puts
  // every overdue one ahead of every not-yet-due one, and a second key derived
  // from the same fact could only ever agree with it. An undated invoice sorts
  // last: never overdue, so never the one to chase first.
  let best: PriorityInvoice | null = null
  let bestKey: [string, number] | null = null
  for (const inv of rows) {
    const key: [string, number] = [inv.due_date || '9999-12-31', -invoiceBalance(inv, settings).balance]
    if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      best = inv; bestKey = key
    }
  }
  if (!best) return null
  const name = displayName(best.customer_name)
  const number = (best.invoice_number ?? '').trim()
  if (!name || !number) return null
  const { balance } = invoiceBalance(best, settings)
  // THE ledger's overlay decides whether this says "overdue" — the same call the
  // Invoices page's pill makes, so the two can never disagree about a customer
  // being late.
  //
  // For the rows the unpaid caller passes (owed, so status unpaid/sent/partial)
  // a bare `due_date < today` would agree with it today. It is still asked of the
  // overlay, because "is this invoice overdue?" is a question that already has an
  // owner, and a local date comparison here would be a second answer to it — the
  // failure this codebase keeps paying for. The overlay also knows the cases a
  // date comparison does not: a draft carrying a past due date is not late,
  // because nobody has been asked to pay yet.
  const od = displayInvoiceStatus(forLedger(best), settings, today) === 'overdue' && best.due_date
    ? daysBetween(best.due_date, today) : 0
  return {
    name, number, balance,
    why: od > 0 ? `${number} · ${od} day${od !== 1 ? 's' : ''} overdue` : `${number} · awaiting payment`,
  }
}

// The invoices page's focused detail — the SAME url a click there pushes, keyed
// by invoice_number. No route and no second data path: `?invoice=` IS the detail
// surface (that page's own contract), so this opens the product's real answer
// rather than a dashboard-owned copy of it.
const invoiceHref = (number: string) => `/dashboard/invoices?invoice=${encodeURIComponent(number)}`

// A "missed" visit: a still-open job whose day has passed. The dashboard counts
// these ("Resolve missed jobs · N past due") and the schedule board now surfaces
// and resolves them, so both MUST derive the set the same way — hence one exported
// predicate, not two copies of the date comparison. Plain string-date '<' on
// 'YYYY-MM-DD' (no Date parsing → no UTC-boundary drift); the null guard is inert
// for the NOT-NULL jobs.scheduled_date and only widens the accepted input type.
export function isMissed(job: { scheduled_date: string | null; status: string }, todayISO: string): boolean {
  return job.scheduled_date != null && job.scheduled_date < todayISO
    && (job.status === 'scheduled' || job.status === 'in_progress')
}

// Which quotes already have work on the calendar. A CANCELLED job must not count
// as scheduled — that is the whole trap this predicate exists to hold, and the
// per-deal pipeline asks the identical question ("does this won deal still need
// booking?"). Two copies would let the dashboard queue say "schedule 3 accepted
// quotes" while the pipeline shows 4, off one `!== 'cancelled'`.
export function scheduledQuoteIds(jobs: { quote_id: string | null; status: string }[]): Set<string> {
  const s = new Set<string>()
  for (const j of jobs) if (j.quote_id && j.status !== 'cancelled') s.add(j.quote_id)
  return s
}

export function computePriorities(i: PrioritiesInput): Priority[] {
  const { quotes, invoices, jobs, recById, customers, conversations, requests, leads, seasons, feeSettings, today } = i
  const next: Priority[] = []

  // 1) Money already owed — invoices sent/unpaid. The single most valuable thing
  //    to chase: work done, just not collected. Owed = remaining GST-inclusive
  //    BALANCE via THE ledger engine, so it matches the Invoices page it links to.
  const owed = invoices.filter(inv => inv.status !== 'draft' && inv.status !== 'cancelled' && invoiceBalance(inv, feeSettings).balance > 0.01)
  const owedTotal = owed.reduce((s, inv) => s + invoiceBalance(inv, feeSettings).balance, 0)
  if (owed.length > 0) {
    // Cancelled is excluded above by STATUS, not by balance: cancelling requires
    // nothing paid, so a withdrawn invoice keeps its full balance and would sail
    // through any `balance > 0` test. That trap has already cost this codebase a
    // live Stripe link on a cancelled bill — the filter above is the guard.
    const one = pickInvoice(owed, feeSettings, today)
    // Urgent exactly when at least one owed invoice is past its due date — asked
    // of THE ledger overlay (the same call pickInvoice and the Invoices page
    // make), never a bare date comparison here.
    const anyOverdue = owed.some(inv =>
      displayInvoiceStatus({ ...inv, due_date: inv.due_date ?? null }, feeSettings, today) === 'overdue')
    next.push({
      kind: 'unpaid',
      label: one ? `Collect from ${one.name}` : 'Collect unpaid invoices',
      detail: one ? one.why : `${owed.length} invoice${owed.length !== 1 ? 's' : ''} outstanding`,
      value: one ? one.balance : owedTotal,
      more: one ? owed.length - 1 : 0,
      href: one ? invoiceHref(one.number) : '/dashboard/invoices',
      ...(anyOverdue ? { urgency: 'urgent' as const } : {}),
      // Ranked on the WHOLE pile, opened on one of it — see the header.
      score: 100_000 + adder(owedTotal),
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
    // items[0] IS the longest wait — the leads engine sorts oldest-first and
    // already carries each lead's name and its own door (a filtered inbox for a
    // website lead, the draft quote for a booking). This row was throwing both
    // away and rendering the tally instead.
    const first = leads.items[0]
    const waited = hrs != null && hrs >= 1 ? (hrs >= 48 ? `${Math.floor(hrs / 24)}d` : `${hrs}h`) : null
    const source = first?.source === 'website' ? 'Website lead'
      : first?.source === 'booking' ? 'Online booking' : 'Waiting on a reply'
    const named = displayName(first?.name)
    next.push({
      kind: 'leads',
      label: named ? `Respond to ${named}` : leads.total === 1 ? 'Respond to a new lead' : 'Respond to new leads',
      detail: named
        ? (waited ? `${source} · waiting ${waited}` : source)
        : (waited ? `${parts} · oldest ${waited}` : parts),
      more: named ? leads.total - 1 : 0,
      href: first?.href || '/dashboard/messages',
      score: 90_000 + adder(Math.min(hrs ?? 0, 72) * 100),
    })
  }

  // 3) Accepted but not scheduled — committed revenue most at risk of slipping.
  //    Cancelled jobs must NOT count as scheduled.
  //
  //    Split by the SCHEDULING GATE: a deposit-gated booking whose money hasn't
  //    arrived must not be urged onto the schedule — the owner set that gate on
  //    purpose. Those quotes get their own row ("waiting on the deposit", the
  //    verb is chase/record, the door is the quote page where both live);
  //    everything else keeps the schedule-now row it always had, and once a
  //    gated quote's deposit lands it moves up here labelled as ready.
  const booked = scheduledQuoteIds(jobs)
  const acceptedUnscheduled = quotes.filter(q => q.status === 'accepted' && !booked.has(q.id))
  const gateOf = (q: Quote) => schedulingGate(q, i.quoteDepositRows?.[q.id] ?? [])
  const readyToSchedule = acceptedUnscheduled.filter(q => !gateBlocksScheduling(q, gateOf(q)))
  const waitingOnDeposit = acceptedUnscheduled.filter(q => gateBlocksScheduling(q, gateOf(q)))
  const acceptedTotal = readyToSchedule.reduce((s, q) => s + Number(q.total || 0), 0)
  if (readyToSchedule.length > 0) {
    // Biggest first: within one tier the engine already ranks by money, so the
    // quote it opens is the one whose slipping costs most. `?quote=` opens the
    // schedule's job form already filled from that quote (customer, service,
    // duration, crew, cadence) — the existing door, not a new one.
    const top = [...readyToSchedule].sort((a, b) => Number(b.total || 0) - Number(a.total || 0))[0]
    const named = displayName(top?.customer_name)
    // Name the satisfied gate when there is one — "deposit received" is the
    // whole reason this row can now say "schedule it" about a gated booking.
    const topGate = top ? gateOf(top) : null
    next.push({
      kind: 'unscheduled',
      label: named ? `Schedule ${possessive(named)} job` : 'Schedule accepted jobs',
      detail: named
        ? `${top.service_type || 'Accepted quote'} · ${topGate && topGate.required > 0 && topGate.status === 'satisfied' ? 'deposit received — ready to schedule' : 'accepted, no date yet'}`
        : `${readyToSchedule.length} accepted quote${readyToSchedule.length !== 1 ? 's' : ''} with no date`,
      value: named ? Number(top.total || 0) : acceptedTotal,
      more: named ? readyToSchedule.length - 1 : 0,
      href: named ? `/dashboard/schedule?quote=${encodeURIComponent(top.id)}` : '/dashboard/schedule',
      score: 80_000 + adder(acceptedTotal),
    })
  }
  if (waitingOnDeposit.length > 0) {
    // The blocked half: approved, not yet secured. The figure is the OUTSTANDING
    // deposit (what the row is waiting on), never the quote total — a $4,000 row
    // about a $1,350 wait would rank and read as the wrong obligation. Door =
    // the quote page, which holds both the record-offline-payment door and the
    // explicit schedule-anyway override.
    const withGate = waitingOnDeposit.map(q => ({ q, gate: gateOf(q) }))
    const top = [...withGate].sort((a, b) => b.gate.outstanding - a.gate.outstanding)[0]
    const named = displayName(top.q.customer_name)
    const outstandingTotal = withGate.reduce((s, x) => s + x.gate.outstanding, 0)
    next.push({
      kind: 'unscheduled',
      label: named ? `Waiting on ${possessive(named)} deposit` : 'Bookings waiting on deposits',
      detail: named
        ? `${formatCurrency(top.gate.collected)} of ${formatCurrency(top.gate.required)} received · approved, not yet secured`
        : `${waitingOnDeposit.length} approved booking${waitingOnDeposit.length !== 1 ? 's' : ''} not yet secured`,
      value: named ? top.gate.outstanding : outstandingTotal,
      more: named ? waitingOnDeposit.length - 1 : 0,
      href: named ? `/dashboard/quotes/${encodeURIComponent(top.q.id)}` : '/dashboard/quotes',
      // Below drafts (60k): the next move is usually the customer's, not the
      // owner's — but it stays on the list because a stalled deposit IS the
      // thing standing between approved work and the calendar.
      score: 58_000 + adder(outstandingTotal),
    })
  }

  // 4) Missed visits — past-date jobs still open, customers falling behind.
  //    Always urgent: the day has already passed, so this is never merely waiting.
  const missed = jobs.filter(j => isMissed(j, today))
  if (missed.length > 0) {
    next.push({
      kind: 'missed', label: 'Resolve missed jobs', detail: `${missed.length} past due`,
      href: '/dashboard/schedule', urgency: 'urgent', score: 70_000 + adder(missed.length * 200),
    })
  }

  // 5) Draft invoices to send — the auto-invoiced recurring pipeline that silently
  //    goes unsent (mirrors the Invoices "Drafts to review" card).
  const drafts = invoices.filter(inv => inv.status === 'draft')
  const draftTotal = drafts.reduce((s, inv) => s + Number(inv.amount || 0), 0)
  if (drafts.length > 0) {
    // Largest draft first — the most money not yet asked for. A draft has no due
    // date to be late against, so pickInvoice's overdue/oldest keys are inert
    // here and it falls through to balance, which is what matters for a draft.
    const one = pickInvoice(drafts, feeSettings, today)
    next.push({
      kind: 'drafts',
      label: one ? `Send ${possessive(one.name)} invoice` : 'Send draft invoices',
      detail: one ? `${one.number} · drafted, not sent` : `${drafts.length} draft${drafts.length !== 1 ? 's' : ''} ready to go`,
      value: one ? one.balance : draftTotal,
      more: one ? drafts.length - 1 : 0,
      href: one ? invoiceHref(one.number) : '/dashboard/invoices',
      score: 60_000 + adder(draftTotal),
    })
  }

  // 5b) Quote drafts the owner started and never sent — priced work that never
  //     got asked for. Sits between invoice drafts (money ready to collect) and
  //     follow-ups (money already asked for): a quote that was never sent can
  //     never be accepted, which makes it earlier-stage than both.
  //
  //     Booking-created drafts (lead_meta) are EXCLUDED — the leads engine
  //     already counts each of those as an online-booking lead whose door is the
  //     draft itself, so listing them here would tell the owner to do one thing
  //     twice (the same double-count rule the messages row applies below).
  const quoteDrafts = quotes.filter(q => q.status === 'draft' && !q.lead_meta)
  if (quoteDrafts.length > 0) {
    // Oldest first — the queue's grammar names the most at-risk member, and for
    // an unsent draft that is the one that has sat longest (same posture as the
    // leads engine's oldest-first and compareFollowUp's oldest-anchor).
    const top = [...quoteDrafts].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))[0]
    const named = displayName(top?.customer_name)
    const draftQuoteTotal = quoteDrafts.reduce((s, q) => s + Number(q.total || 0), 0)
    // Whole days since creation, same construction as the followups row's
    // "quiet N days" — a timestamp difference, not a date-string slice (slicing
    // a timestamptz to its UTC date then comparing locally drifts at midnight).
    const age = top?.created_at ? Math.floor((Date.now() - new Date(top.created_at).getTime()) / 86_400_000) : 0
    next.push({
      kind: 'quote_drafts',
      label: named ? `Finish ${possessive(named)} quote` : 'Finish draft quotes',
      detail: named
        ? (age > 0 ? `Draft quote · started ${age} day${age !== 1 ? 's' : ''} ago` : 'Draft quote · not sent yet')
        : `${quoteDrafts.length} draft quote${quoteDrafts.length !== 1 ? 's' : ''} not sent`,
      value: named ? Number(top.total || 0) : draftQuoteTotal,
      more: named ? quoteDrafts.length - 1 : 0,
      href: named ? `/dashboard/quotes/${encodeURIComponent(top.id)}` : '/dashboard/quotes',
      score: 55_000 + adder(draftQuoteTotal),
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
    // compareFollowUp is THE chase order (oldest first, ties to the bigger
    // quote) — the same comparator the Quotes follow-up queue sorts by, so the
    // one this row opens is the one that page would also put at the top.
    const top = [...chaseable].sort(compareFollowUp)[0]
    const named = displayName(top?.customer_name)
    const quiet = top?.sent_at ? Math.floor((Date.now() - new Date(top.last_followed_up_at || top.sent_at).getTime()) / 86_400_000) : null
    next.push({
      kind: 'followups',
      label: named ? `Follow up with ${named}` : 'Follow up on quotes',
      detail: named
        ? (quiet != null && quiet > 0 ? `Quote sent, quiet ${quiet} day${quiet !== 1 ? 's' : ''}` : 'Quote sent, no answer yet')
        : `${chaseable.length} quote${chaseable.length !== 1 ? 's' : ''} gone quiet`,
      value: named ? Number(top.total || 0) : chaseableTotal,
      more: named ? chaseable.length - 1 : 0,
      href: named ? `/dashboard/quotes/${encodeURIComponent(top.id)}` : '/dashboard/quotes',
      score: 50_000 + adder(chaseableTotal),
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

  // 8) Portal requests a customer is still waiting on. Ranked just above unread
  //    messages: a request is an unanswered message that also names something the
  //    customer wants DONE, and unlike a text it does not clear itself by being
  //    read — the owner has to quote it, book it, or say no.
  //
  //    `requests` arrives pre-filtered to open PORTAL rows (lib/portalRequests
  //    isOpenRequest); service_requests is shared with website leads and online
  //    bookings, which close in their own lifecycles and must never appear here.
  const requestCustomerIds = new Set(requests.map(r => r.customer_id).filter(Boolean) as string[])
  if (requests.length > 0) {
    next.push({
      kind: 'requests', label: 'Answer customer requests',
      detail: `${requests.length} request${requests.length !== 1 ? 's' : ''} from your customers`,
      // `?f=` is the inbox's filter param (see leadResponse's website_lead link
      // and the intelligence page). `?filter=` is silently ignored, which would
      // land the owner on All with nothing explaining why.
      href: '/dashboard/messages?f=requests', score: 32_000 + adder(requests.length * 100),
    })
  }

  // 9) Unread messages — time-sensitive but lower raw dollar value, so it sits
  //    below the money rows unless nothing else is up.
  //
  //    An unanswered inbound conversation is ALREADY counted by the leads row
  //    above (leadResponse classifies last_direction='inbound' as a 'reply'
  //    lead). Left alone, the same customers appeared in two rows pointing at the
  //    same inbox — the queue telling the owner to do one thing twice. Anyone the
  //    leads row already owns is excluded here; the higher tier keeps them.
  //
  //    A portal request is the same shape of double count and is excluded the
  //    same way: submitting one writes an inbound portal message, so without this
  //    the queue would say "answer 1 request" AND "reply to 1 message" about one
  //    customer asking for one thing, both linking to the same thread.
  const leadCustomerIds = new Set(
    leads.items.filter(l => l.source === 'reply' && l.customerId).map(l => l.customerId),
  )
  const otherUnread = conversations.filter(c =>
    !(c.customer_id && (leadCustomerIds.has(c.customer_id) || requestCustomerIds.has(c.customer_id))))
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
