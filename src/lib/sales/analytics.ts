// ── THE sales analytics composition ──────────────────────────────────────────
//
// WHAT THIS IS
// The owner's money questions about SELLING, answered from records EdgeQuote
// already keeps: how much did I quote, what is still open, what was won, what
// was lost, what is authorized now, what did I actually invoice, and what did I
// actually collect. Plus which lead sources produced each of those.
//
// WHAT THIS IS NOT
// It is not a second pipeline engine. lib/pipeline answers "what do I do next"
// over a WORKING QUEUE — deals leave that board the moment nothing is left to do
// about them, which is exactly right for a morning queue and exactly wrong for
// "how much did I win this quarter". This module answers the HISTORY question
// over the same records, and it derives no stage of its own: every rung comes
// from lib/salesStage, the one ladder ([[engineering-principles]] §3).
//
// It owns NO money rule either. Every dollar below is produced by the engine
// that already owns it:
//   • invoiced   → invoiceTotals()      (invoices have no `total` column)
//   • balance    → invoiceBalance()     (a CANCELLED invoice keeps its balance)
//   • collected  → cashAmountOf()       (never sum(payments.amount))
//   • authorized → authorizedValue()    (original + APPROVED change orders)
//   • won/lost   → isWon() / isLost()   (lib/salesStage)
//   • quiet      → quoteIsQuiet()       (lib/followup, THE staleness rule)
//   • source     → describeSource()     (lib/attribution, THE normalizer)
//
// ══ THE ANCHOR, AND WHY IT IS THE QUOTE'S CREATION DATE ══════════════════════
// ⚠️⚠️ `quotes` HAS NO `accepted_at` AND NO `declined_at`. The only timestamps on
// the row are created_at, sent_at, last_followed_up_at and updated_at — and
// updated_at moves on ANY edit, so it is not a decision date and must never be
// read as one. lib/timeline already records this fact at its own acceptance
// event; this module is the second place someone will come looking, so it is
// recorded here too.
//
// The consequence is load-bearing and the session brief names it: "do not infer
// historical states that were never recorded". So there is NO "won in the last
// 30 days" here, because that sentence is not answerable from this book. What IS
// answerable is a COHORT:
//
//     of the quotes CREATED in this period, how many were won, and what has
//     happened to their money since.
//
// One anchor for the whole report. Every downstream figure — authorized,
// invoiced, collected — belongs to a quote in the cohort, and is counted in full
// however long after the period the money actually moved. That is a true
// sentence about a real set of deals. Mixing anchors (wins by quote date,
// cash by paid_at) inside one funnel would produce stages that do not describe
// the same deals, which is the standard way a funnel lies.
//
// `cohortNote` carries that sentence to the UI so the screen states its own
// anchor rather than leaving the owner to assume a period means paid-in-period.

import { isWon, isLost, stageOfQuote, type SalesStage } from '@/lib/salesStage'
import { invoiceTotals, type FeeSettings } from '@/lib/invoiceTotals'
import { invoiceBalance } from '@/lib/payments/ledger'
import { cashAmountOf } from '@/lib/payments/analytics'
import { authorizedValue, type ChangeOrderStatus } from '@/lib/changeOrders'
import { quoteIsQuiet, FOLLOW_UP_DAYS } from '@/lib/followup'
import { describeSource, sourceLabel, MIN_SAMPLE_FOR_RATE, type SourceCategory } from '@/lib/attribution'
import type { Quote } from '@/types'

const round2 = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// ── Inputs ───────────────────────────────────────────────────────────────────
// Deliberately narrow row shapes: the loader selects exactly these columns, so a
// column that stops existing breaks the build rather than silently reading NaN.

export interface SAQuote {
  id: string
  quote_number: string
  customer_id: string | null
  customer_name: string
  service_type: string
  status: string
  /** GENERATED = initial_price + travel_fee. THE quote's value everywhere else. */
  total: number | null
  /** The acceptance SNAPSHOT — what the customer actually agreed to. Null on
   *  every quote nobody has accepted, and on wins recorded before the snapshot
   *  columns existed. Never written by app code. */
  accepted_price: number | null
  created_at: string
  sent_at: string | null
  last_followed_up_at: string | null
}

export interface SAJob {
  id: string
  quote_id: string | null
  customer_id: string | null
}

export interface SAInvoice {
  id: string
  invoice_number: string
  quote_id: string | null
  job_id: string | null
  customer_id: string | null
  status: string
  /** The NET subtotal, ex-GST. `invoices` has NO `total` column. */
  amount: number
  amount_paid?: number | null
  discount_type?: 'amount' | 'percent' | null
  discount_value?: number | null
}

export interface SAPayment {
  id: string
  invoice_id: string | null
  /** Set on a deposit taken against a BOOKING, before any invoice exists. */
  quote_id?: string | null
  customer_id: string | null
  kind: string | null
  provider: string | null
  status: string | null
  amount: number | null
}

export interface SAChangeOrder {
  id: string
  job_id: string | null
  status: string
  amount: number | string | null
}

export interface SACustomer {
  id: string
  acquisition_source: string | null
  created_at: string
}

export interface SalesAnalyticsInput {
  /** Quotes CREATED inside the period — the cohort. The loader filters; the
   *  engine trusts, so a guard can drive it with an exact set. */
  quotes: SAQuote[]
  jobs: SAJob[]
  invoices: SAInvoice[]
  payments: SAPayment[]
  changeOrders: SAChangeOrder[]
  /** Every customer behind a cohort quote, PLUS customers created in the period
   *  (so a lead who was never quoted is still counted). */
  customers: SACustomer[]
  feeSettings: FeeSettings | null
  period: Period
  /** Wall clock for the staleness rule. Injected so a guard is deterministic. */
  nowMs?: number
}

// ── Period ───────────────────────────────────────────────────────────────────

export type PeriodKey = '30d' | '90d' | 'year' | 'custom'

export interface Period {
  key: PeriodKey
  /** Inclusive ISO date (YYYY-MM-DD). */
  from: string
  /** Inclusive ISO date (YYYY-MM-DD). */
  to: string
  label: string
}

export const PERIOD_PRESETS: { key: Exclude<PeriodKey, 'custom'>; label: string; days: number }[] = [
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 90 days', days: 90 },
  { key: 'year', label: 'Last 12 months', days: 365 },
]

/**
 * A preset period ending on `todayISO` (inclusive both ends).
 *
 * Date-only arithmetic on purpose: the filter the loader applies is a calendar
 * range on `created_at`, and doing the maths in UTC ms avoids a DST hour turning
 * "30 days" into 29 for half the year.
 */
export function presetPeriod(key: Exclude<PeriodKey, 'custom'>, todayISO: string): Period {
  const preset = PERIOD_PRESETS.find(p => p.key === key) ?? PERIOD_PRESETS[0]
  const end = new Date(`${todayISO}T00:00:00Z`).getTime()
  // `days - 1` because both ends are inclusive: a 30-day period is today plus
  // the 29 days before it, not 31 dates.
  const from = new Date(end - (preset.days - 1) * 86_400_000).toISOString().slice(0, 10)
  return { key, from, to: todayISO, label: preset.label }
}

export function customPeriod(from: string, to: string): Period {
  // Swapped dates are a typo, not an error worth an empty screen.
  const [a, b] = from <= to ? [from, to] : [to, from]
  return { key: 'custom', from: a, to: b, label: `${a} → ${b}` }
}

// ── The snapshot ─────────────────────────────────────────────────────────────
//
// ⚖️ THE FIVE FIGURES STAY FIVE (S52 owner ruling, 2026-08-14, extended by the
// quoted figure this report adds). They are DIFFERENT QUESTIONS and must never
// collapse into one "revenue" number:
//
//   1. quoted     — what you asked for
//   2. won        — what they agreed to (the acceptance snapshot)
//   3. authorized — what the work is worth NOW (won + approved change orders)
//   4. invoiced   — what you actually billed
//   5. collected  — what actually arrived
//
// If a figure reads misleadingly the fix is a clearer label or a secondary
// figure, NEVER collapsing two of them. A change order can legitimately make
// `authorized` exceed `won`; a deposit can make `collected` non-zero while
// `invoiced` is still zero. Both are true, and both are supposed to be visible.

export interface SalesSnapshot {
  // ── 1 · Quoted ─────────────────────────────────────────────────────────────
  /** Value of quotes that actually LEFT THE DESK (status !== 'draft'). */
  quoted: number
  quotedCount: number
  /** Drafts, held apart. A draft is not a quote the customer has ever seen, so
   *  folding it into `quoted` would report work you never asked anyone for. */
  draft: number
  draftCount: number

  // ── 2 · Still open ─────────────────────────────────────────────────────────
  /** Sent, undecided. THE "money on the table" figure. */
  open: number
  openCount: number
  /** …of which the follow-up cadence says have gone quiet (lib/followup). */
  followUpValue: number
  followUpCount: number
  /** …and the rest, still inside the cadence — the ball is genuinely theirs. */
  awaitingValue: number
  awaitingCount: number

  // ── 3 · Decided ────────────────────────────────────────────────────────────
  /** Accepted deal value: `accepted_price` when the snapshot exists, else `total`. */
  won: number
  wonCount: number
  lost: number
  lostCount: number
  /** won / (won + lost) by COUNT, 0..1 — or null below the sample floor.
   *  Unanswered quotes are deliberately outside this denominator; see isWon. */
  winRate: number | null
  /** Deals still undecided — the reason winRate is not won/quoted. */
  undecidedCount: number

  // ── 4 · Authorized ─────────────────────────────────────────────────────────
  /** Current authorized value of work from WON quotes: accepted deal value plus
   *  APPROVED change orders on that deal's visits. Pending changes are the
   *  customer's move and are excluded — reported separately below. */
  authorized: number
  /** authorized − won. Positive = approved scope growth. */
  approvedChanges: number
  /** Asked for, not yet answered by the customer. NOT authorized money. */
  pendingChanges: number
  pendingChangeCount: number

  // ── 5 · Billed and banked ──────────────────────────────────────────────────
  /** invoiceTotals().total over issued, non-cancelled invoices on cohort deals. */
  invoiced: number
  invoicedCount: number
  /** Invoices still sitting in draft — money not yet ASKED for. */
  invoiceDraft: number
  invoiceDraftCount: number
  /** Cancelled invoices, surfaced rather than silently dropped. */
  cancelledCount: number
  /** Cash IN on those deals (cashAmountOf — credits and credit settlements out). */
  collected: number
  /** Cash handed BACK, as a positive number. */
  refunded: number
  /** collected − refunded. What the bank actually kept. */
  netCollected: number
  /** Still owed on issued, non-cancelled invoices (invoiceBalance). */
  outstanding: number
}

// ── The funnel ───────────────────────────────────────────────────────────────
//
// One rung per real record, and NOTHING is inferred backwards. A quote that was
// created and accepted without ever being marked `sent` does NOT retro-fill the
// "sent" rung: `sentCount` counts quotes carrying a `sent_at`, and the honest
// consequence is that a later rung can exceed an earlier one. That is a true
// fact about how the book was kept, not a bug to clamp — clamping it would
// invent send events that never happened.

export interface FunnelStage {
  key: 'leads' | 'quoted' | 'won' | 'authorized' | 'invoiced' | 'collected'
  label: string
  /** Records on this rung. */
  count: number
  /** Money on this rung, or NULL when the rung has no defensible dollar figure
   *  (leads are unpriced — null, never 0). */
  value: number | null
  /** What this rung counts, in the owner's words. */
  meaning: string
}

export interface SalesFunnel {
  stages: FunnelStage[]
  /**
   * Customers created in the period who never received a quote. Counted at the
   * CUSTOMER level — the same unit lib/attribution's funnel uses — because
   * "leads" is not a table in EdgeQuote and a deal has no record before a quote.
   */
  unquotedLeads: number
  /** True when any quote in the cohort has no `sent_at`, so the UI can explain
   *  why the "quoted" rung may under-count rather than looking broken. */
  hasUnstampedSends: boolean
}

// ── Lead sources ─────────────────────────────────────────────────────────────
//
// ⚠️ lib/attribution's `buildAcquisitionFunnel` deliberately carries NO money,
// and that refusal is pinned by its own guard. This is not a reversal of it:
// that engine is a COUNTS funnel over every customer ever, and its stated
// reasons were (a) an invoice total is not revenue, (b) a payment is not
// attributable to acquisition, (c) it would put a second engine on money.
//
// (a) and (c) are answered by construction here — every dollar comes from
// invoiceTotals / invoiceBalance / cashAmountOf, and nothing in this file adds a
// money rule. (b) is answered by LABELLING, and the labels are load-bearing:
// these figures are "collected FROM customers acquired via X", never "revenue
// caused by X". EdgeQuote cannot support a causal claim and does not make one.
//
// ⭐ The CATEGORY is still derived in lib/attribution and nowhere else. This
// module calls describeSource and stores the answer; it contains no mapping of
// its own, because a second copy is a second attribution engine.

export interface SourceRow {
  category: SourceCategory
  label: string
  /** Raw strings behind this category, so `other` is never a black box. */
  details: string[]
  /** Customers in this cohort's source bucket — the denominator. */
  customers: number
  /** …who were sent at least one non-draft quote in this period. */
  quoted: number
  /** …who won at least one. Counted per CUSTOMER: five won quotes is still one. */
  won: number
  /** won / customers, 0..1 — NULL below the sample floor. */
  wonRate: number | null
  /** Accepted deal value from this bucket's won quotes. */
  wonValue: number
  /** Cash that arrived on this bucket's deals. Net of refunds. */
  collected: number
}

export interface SourceReport {
  rows: SourceRow[]
  customers: number
  known: number
  /** 0..100, or null with no customers. A big number is a DATA-QUALITY finding
   *  to show, not a rounding error to hide. */
  unknownPct: number | null
  minSampleForRate: number
}

// ── Movement ─────────────────────────────────────────────────────────────────

export interface MovementRow {
  quoteId: string
  quoteNumber: string
  name: string
  service: string
  stage: SalesStage
  /** The deal's value at its current rung. Null when nobody has priced it. */
  value: number | null
  /** The most recent REAL timestamp on the record (never updated_at). */
  at: string
  href: string
}

export interface SalesAnalyticsReport {
  period: Period
  /** The sentence the screen must show about what a date filter here means. */
  cohortNote: string
  snapshot: SalesSnapshot
  funnel: SalesFunnel
  sources: SourceReport
  /** Deals per rung, over the cohort — HISTORY, so nothing leaves. */
  stageCounts: Record<SalesStage, number>
  /** Value per rung, same cohort. */
  stageValue: Record<SalesStage, number>
  movement: MovementRow[]
}

const EMPTY_STAGES = (): Record<SalesStage, number> =>
  ({ new_lead: 0, contacted: 0, quote_draft: 0, quote_sent: 0, won: 0, lost: 0 })

/**
 * The value a quote counts for at its rung.
 *
 * A WON deal counts at `accepted_price` when that snapshot exists — the figure
 * recorded when the deal was marked won. On a multi-option quote that is the
 * chosen option's price, which can differ from the recommended one the quote was
 * reported at while it was open. Everything else counts at `total` (the
 * GENERATED column every other surface reports).
 *
 * ⚠️ `accepted_price` is NOT proof the customer agreed to that figure. S121
 * established that STATUS IS NOT ACCEPTANCE EVIDENCE: a status flip or a
 * born-accepted insert can leave a snapshot behind with no `quote_acceptances`
 * row at all. This function is deliberately still right, because the question it
 * answers is HISTORICAL — what the owner recorded as won, and at what figure —
 * not whether that deal may be charged today. Current charge authority is a
 * different question with a different answer (`quote_acceptance_is_current`,
 * `depositChargeBlock`), and it is asked at the money doors, not here.
 *
 * ⛔ DO NOT "fix" this by falling back to the live `total` on a drifted quote.
 * Proven both directions: a deal accepted at $1,400 whose document was later
 * revised to $500 would be UNDERSTATED by $900, and one accepted at $500 whose
 * document later grew to $2,000 would be INFLATED fourfold. The snapshot is the
 * historical fact; the live total is a different quantity.
 *
 * ⭐ Every tile fed from here is labelled "Won" / "Won value" / "Collected" —
 * a statement about what the owner marked and what money arrived, never a claim
 * that a customer consented. Keep it that way: relabelling these as "Accepted"
 * would turn an accurate status figure into a consent claim the data cannot
 * support.
 *
 * NULL when there is no price at all. Never 0 — an unpriced draft is a deal
 * worth an unknown amount, and rendering it as $0 drags every average down.
 */
export function dealValue(q: SAQuote): number | null {
  if (isWon(q.status) && q.accepted_price != null) {
    const a = num(q.accepted_price)
    if (a > 0) return round2(a)
  }
  if (q.total == null) return null
  const t = num(q.total)
  return t > 0 ? round2(t) : null
}

/** Sum of `dealValue` over quotes, skipping the unpriced. */
const sumValue = (qs: SAQuote[]) => round2(qs.reduce((s, q) => s + (dealValue(q) ?? 0), 0))

// ═════════════════════════════════════════════════════════════════════════════
// THE engine
// ═════════════════════════════════════════════════════════════════════════════
export function computeSalesAnalytics(i: SalesAnalyticsInput): SalesAnalyticsReport {
  const { quotes, jobs, invoices, payments, changeOrders, customers, feeSettings, period } = i
  const nowMs = i.nowMs ?? Date.now()

  const cohortQuoteIds = new Set(quotes.map(q => q.id))

  // ── Deal → visits, so change orders can find their deal ────────────────────
  // A job carries the quote it came from. A job created directly (no quote) has
  // none, and its change orders are therefore not attributable to any deal in
  // this cohort — correctly excluded rather than attached to the nearest guess.
  const quoteOfJob = new Map<string, string>()
  for (const j of jobs) {
    if (j.quote_id && cohortQuoteIds.has(j.quote_id)) quoteOfJob.set(j.id, j.quote_id)
  }

  // ── Invoice → deal ─────────────────────────────────────────────────────────
  // `quote_id` is the direct weld. An invoice raised against a JOB carries the
  // deal transitively, so the fallback is a real resolution, not a guess — and
  // it is the only way a recurring series' invoices reach their originating
  // quote at all.
  const dealOfInvoice = (inv: SAInvoice): string | null => {
    if (inv.quote_id && cohortQuoteIds.has(inv.quote_id)) return inv.quote_id
    if (inv.job_id) return quoteOfJob.get(inv.job_id) ?? null
    return null
  }
  const cohortInvoices = invoices.filter(inv => dealOfInvoice(inv) !== null)
  const cohortInvoiceIds = new Set(cohortInvoices.map(inv => inv.id))

  // ── Quote buckets ──────────────────────────────────────────────────────────
  const drafts = quotes.filter(q => q.status === 'draft')
  const issued = quotes.filter(q => q.status !== 'draft')
  const wonQuotes = quotes.filter(q => isWon(q.status))
  const lostQuotes = quotes.filter(q => isLost(q.status))
  const openQuotes = quotes.filter(q => stageOfQuote(q.status) === 'quote_sent')

  // THE staleness rule, asked exactly as every owner-facing surface asks it.
  // quoteIsQuiet's own terminal guard (`status !== 'sent'`) means a decided quote
  // can never land here, so the split below is total over `openQuotes`.
  const quiet = openQuotes.filter(q => quoteIsQuiet(q as unknown as Quote, FOLLOW_UP_DAYS, nowMs))
  const quietIds = new Set(quiet.map(q => q.id))
  const awaiting = openQuotes.filter(q => !quietIds.has(q.id))

  // ── Authorized ─────────────────────────────────────────────────────────────
  // authorizedValue() is asked ONCE PER DEAL, with the accepted deal value as the
  // original and every approved change order across that deal's visits.
  //
  // ⚠️ It is deliberately NOT asked per visit and summed. A recurring quote
  // spawns a job per visit, so a per-visit sum would multiply one $65 deal into
  // twenty-five and report "won $12,400 → authorized $89,000". The deal is the
  // unit the owner asked the question at.
  //
  // `lineItems` is deliberately not passed: job_line_items are priced EXTRAS,
  // and this figure is AUTHORIZED value (original + approved changes), not
  // billable. Reading `.authorized` rather than `.billable` is the same choice.
  const changeOrdersOfDeal = new Map<string, SAChangeOrder[]>()
  for (const co of changeOrders) {
    if (!co.job_id) continue
    const deal = quoteOfJob.get(co.job_id)
    if (!deal) continue
    const list = changeOrdersOfDeal.get(deal)
    if (list) list.push(co)
    else changeOrdersOfDeal.set(deal, [co])
  }

  let authorized = 0
  let approvedChanges = 0
  let pendingChanges = 0
  let pendingChangeCount = 0
  for (const q of wonQuotes) {
    const original = dealValue(q) ?? 0
    const av = authorizedValue({
      originalValue: original,
      // The row shapes above are what the DATABASE returns (amount is numeric
      // and nullable); authorizedValue takes the app's ChangeOrder shape. Coerce
      // at the boundary rather than widening the engine — a null amount is a
      // change order worth nothing, which is exactly what `num` produces.
      changeOrders: (changeOrdersOfDeal.get(q.id) ?? []).map(co => ({
        status: co.status as ChangeOrderStatus,
        amount: num(co.amount),
      })),
    })
    authorized += av.authorized
    approvedChanges += av.approvedChanges
    pendingChanges += av.pending
    pendingChangeCount += av.pendingCount
  }

  // ── Invoiced ───────────────────────────────────────────────────────────────
  // ⚠️ A CANCELLED invoice keeps its full balance in the ledger, so every money
  // door has to check the status and not just the number. Cancelled is excluded
  // from `invoiced` and from `outstanding`, and SURFACED as a count so the owner
  // can see that a figure moved because work was cancelled.
  let invoiced = 0, invoicedCount = 0
  let invoiceDraft = 0, invoiceDraftCount = 0
  let cancelledCount = 0
  let outstanding = 0
  for (const inv of cohortInvoices) {
    const total = invoiceTotals(inv.amount, feeSettings, { type: inv.discount_type, value: inv.discount_value }).total
    if (inv.status === 'cancelled') { cancelledCount++; continue }
    if (inv.status === 'draft') { invoiceDraft += total; invoiceDraftCount++; continue }
    invoiced += total
    invoicedCount++
    // `amount_paid` is nullable in the row we read and non-null in the app type.
    // Null means the recompute trigger has never fired for this invoice, i.e.
    // nothing is paid — `undefined` is how invoiceBalance already spells that.
    const { balance } = invoiceBalance({ ...inv, amount_paid: inv.amount_paid ?? undefined }, feeSettings)
    if (balance > 0.01) outstanding += balance
  }

  // ── Collected ──────────────────────────────────────────────────────────────
  // A payment reaches a deal two ways, and a Set of payment ids makes taking
  // both routes safe: by its invoice, or — for a deposit taken to secure a
  // BOOKING before any invoice existed — by `payments.quote_id`.
  //
  // cashAmountOf is THE definition of "this row is cash". It returns 0 for
  // credit-ledger rows and for invoices settled FROM credit, so a customer's
  // deposit is counted once, when it arrived, and never again on settlement.
  const seenPayments = new Set<string>()
  let collected = 0, refunded = 0
  for (const p of payments) {
    const onDeal =
      (p.invoice_id && cohortInvoiceIds.has(p.invoice_id)) ||
      (p.quote_id && cohortQuoteIds.has(p.quote_id))
    if (!onDeal || seenPayments.has(p.id)) continue
    seenPayments.add(p.id)
    const cash = cashAmountOf(p)
    if (cash > 0) collected += cash
    else if (cash < 0) refunded += Math.abs(cash)
  }

  const wonValue = sumValue(wonQuotes)
  const lostValue = sumValue(lostQuotes)
  const decided = wonQuotes.length + lostQuotes.length

  const snapshot: SalesSnapshot = {
    quoted: sumValue(issued),
    quotedCount: issued.length,
    draft: sumValue(drafts),
    draftCount: drafts.length,

    open: sumValue(openQuotes),
    openCount: openQuotes.length,
    followUpValue: sumValue(quiet),
    followUpCount: quiet.length,
    awaitingValue: sumValue(awaiting),
    awaitingCount: awaiting.length,

    won: wonValue,
    wonCount: wonQuotes.length,
    lost: lostValue,
    lostCount: lostQuotes.length,
    // Below the floor a single deal swings the rate by tens of points, and an
    // owner would act on it. Counts are always shown; a percentage is not.
    winRate: decided >= MIN_SAMPLE_FOR_RATE ? wonQuotes.length / decided : null,
    undecidedCount: quotes.length - decided,

    authorized: round2(authorized),
    approvedChanges: round2(approvedChanges),
    pendingChanges: round2(pendingChanges),
    pendingChangeCount,

    invoiced: round2(invoiced),
    invoicedCount,
    invoiceDraft: round2(invoiceDraft),
    invoiceDraftCount,
    cancelledCount,
    collected: round2(collected),
    refunded: round2(refunded),
    netCollected: round2(collected - refunded),
    outstanding: round2(outstanding),
  }

  // ── Stage rollup (history — nothing leaves) ────────────────────────────────
  const stageCounts = EMPTY_STAGES()
  const stageValue = EMPTY_STAGES()
  for (const q of quotes) {
    const stage = stageOfQuote(q.status)
    stageCounts[stage]++
    stageValue[stage] = round2(stageValue[stage] + (dealValue(q) ?? 0))
  }

  // ── Funnel ─────────────────────────────────────────────────────────────────
  const quotedCustomerIds = new Set(issued.map(q => q.customer_id).filter((c): c is string => !!c))
  const inPeriod = (iso: string) => {
    const day = iso.slice(0, 10)
    return day >= period.from && day <= period.to
  }
  const unquotedLeads = customers.filter(c => inPeriod(c.created_at) && !quotedCustomerIds.has(c.id)).length

  const funnel: SalesFunnel = {
    unquotedLeads,
    hasUnstampedSends: issued.some(q => !q.sent_at),
    stages: [
      {
        key: 'leads', label: 'Leads',
        count: unquotedLeads + quotedCustomerIds.size,
        // Nobody priced a lead. NULL, never 0.
        value: null,
        meaning: 'People who came to you in this period, counted once each.',
      },
      {
        key: 'quoted', label: 'Quote sent',
        count: snapshot.quotedCount, value: snapshot.quoted,
        meaning: 'Quotes that left the desk. Drafts are not counted.',
      },
      {
        key: 'won', label: 'Quote accepted',
        count: snapshot.wonCount, value: snapshot.won,
        meaning: 'They said yes. Valued at what they agreed to.',
      },
      {
        key: 'authorized', label: 'Work authorized',
        count: snapshot.wonCount, value: snapshot.authorized,
        meaning: 'The accepted value plus change orders they approved.',
      },
      {
        key: 'invoiced', label: 'Invoiced',
        count: snapshot.invoicedCount, value: snapshot.invoiced,
        meaning: 'Actually billed. Drafts and cancelled invoices are not counted.',
      },
      {
        key: 'collected', label: 'Collected',
        count: seenPayments.size, value: snapshot.netCollected,
        meaning: 'Money that arrived, less anything refunded.',
      },
    ],
  }

  // ── Sources ────────────────────────────────────────────────────────────────
  // The unit is the CUSTOMER for the count columns — a customer with five won
  // quotes contributes exactly 1 — and the DEAL for the money columns, because a
  // dollar belongs to the deal that earned it. Each is summed once.
  const customerOfQuote = new Map<string, string>()
  for (const q of quotes) if (q.customer_id) customerOfQuote.set(q.id, q.customer_id)

  const collectedByCustomer = new Map<string, number>()
  const seenForSource = new Set<string>()
  for (const p of payments) {
    if (seenForSource.has(p.id)) continue
    let cust: string | null = p.customer_id ?? null
    const viaInvoice = p.invoice_id ? cohortInvoices.find(inv => inv.id === p.invoice_id) : undefined
    const onDeal =
      (p.invoice_id && cohortInvoiceIds.has(p.invoice_id)) ||
      (p.quote_id && cohortQuoteIds.has(p.quote_id))
    if (!onDeal) continue
    seenForSource.add(p.id)
    if (!cust) cust = viaInvoice?.customer_id ?? (p.quote_id ? customerOfQuote.get(p.quote_id) ?? null : null)
    if (!cust) continue
    collectedByCustomer.set(cust, (collectedByCustomer.get(cust) ?? 0) + cashAmountOf(p))
  }

  const wonValueByCustomer = new Map<string, number>()
  for (const q of wonQuotes) {
    if (!q.customer_id) continue
    wonValueByCustomer.set(q.customer_id, (wonValueByCustomer.get(q.customer_id) ?? 0) + (dealValue(q) ?? 0))
  }
  const wonCustomerIds = new Set(wonQuotes.map(q => q.customer_id).filter((c): c is string => !!c))

  interface Acc extends Omit<SourceRow, 'details'> { rawSeen: Set<string> }
  const acc = new Map<SourceCategory, Acc>()
  const rowFor = (cat: SourceCategory): Acc => {
    let r = acc.get(cat)
    if (!r) {
      r = {
        category: cat, label: sourceLabel(cat), customers: 0, quoted: 0, won: 0,
        wonRate: null, wonValue: 0, collected: 0, rawSeen: new Set<string>(),
      }
      acc.set(cat, r)
    }
    return r
  }

  // Only customers this cohort actually involves: the ones behind a quote in the
  // period, plus the ones who arrived in the period and were never quoted.
  const cohortCustomers = customers.filter(c => quotedCustomerIds.has(c.id) || customerOfQuote.has(c.id) || inPeriod(c.created_at))
  const relevant = cohortCustomers.filter((c, idx, arr) => arr.findIndex(x => x.id === c.id) === idx)

  let known = 0
  for (const c of relevant) {
    const d = describeSource(c.acquisition_source)
    const r = rowFor(d.category)
    r.customers++
    if (d.category !== 'unknown') known++
    if (d.detail) r.rawSeen.add(d.detail)
    if (quotedCustomerIds.has(c.id)) r.quoted++
    if (wonCustomerIds.has(c.id)) r.won++
    r.wonValue = round2(r.wonValue + (wonValueByCustomer.get(c.id) ?? 0))
    r.collected = round2(r.collected + (collectedByCustomer.get(c.id) ?? 0))
  }

  const rows: SourceRow[] = [...acc.values()].map(({ rawSeen, ...r }) => ({
    ...r,
    details: [...rawSeen].sort((a, b) => a.localeCompare(b)),
    wonRate: r.customers >= MIN_SAMPLE_FOR_RATE ? r.won / r.customers : null,
  }))
  // `unknown` is always LAST and never dropped: a source report that ranks its
  // own blind spot first buries the channels underneath it, and one that omits
  // the blind spot lies about the total.
  rows.sort((a, b) =>
    (a.category === 'unknown' ? 1 : 0) - (b.category === 'unknown' ? 1 : 0) ||
    b.customers - a.customers ||
    a.label.localeCompare(b.label))

  const totalCustomers = relevant.length
  const sources: SourceReport = {
    rows,
    customers: totalCustomers,
    known,
    unknownPct: totalCustomers > 0 ? Math.round(((totalCustomers - known) / totalCustomers) * 100) : null,
    minSampleForRate: MIN_SAMPLE_FOR_RATE,
  }

  // ── Movement ───────────────────────────────────────────────────────────────
  // ⚠️ Ordered by the most recent REAL timestamp, never `updated_at` — a re-save
  // would otherwise present an untouched quote as the day's news.
  const movement: MovementRow[] = quotes
    .map(q => ({
      quoteId: q.id,
      quoteNumber: q.quote_number,
      name: q.customer_name || 'Unnamed',
      service: q.service_type || '',
      stage: stageOfQuote(q.status),
      value: dealValue(q),
      at: q.last_followed_up_at || q.sent_at || q.created_at,
      href: `/dashboard/quotes/${q.id}`,
    }))
    .sort((a, b) => b.at.localeCompare(a.at))

  return {
    period,
    cohortNote:
      'Every figure follows the quotes you created in this period. ' +
      'Money is counted in full whenever it arrived, even after the period ended — ' +
      'Accepted quotes stay in their original creation period.',
    snapshot,
    funnel,
    sources,
    stageCounts,
    stageValue,
    movement,
  }
}
