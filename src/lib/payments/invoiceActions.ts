import type { Invoice, InvoiceDisplayStatus } from '@/types'
import type { FeeSettings } from '@/lib/invoiceTotals'
import { invoiceBalance, displayInvoiceStatus } from '@/lib/payments/ledger'
import { depositState, depositChargeAmount, type DepositState } from '@/lib/payments/deposit'

// ── What does this invoice need next? ────────────────────────────────────────
//
// One pure module answering the two questions an open invoice used to answer
// with seven equally-weighted buttons:
//
//   1. WHICH DOORS ARE OPEN on this invoice at all (`invoiceDoors`)
//   2. WHICH ONE is the owner most likely here to do (`invoiceNextActions`)
//
// WHY THIS EXISTS — the money half
// ⚠️ `invoiceBalance(inv).balance > 0` is TRUE on a CANCELLED invoice: cancelling
// requires that nothing has been paid, so a withdrawn bill keeps its entire
// balance and every "is there something to collect?" test in the app passes on
// it. That has already cost this product two live collection doors on cancelled
// production invoices. The rule is therefore stated ONCE, here, as `owes` — and
// every money door in the UI is an AND onto it, instead of six hand-written
// copies of `status !== 'cancelled' && balance > 0` that have to all stay right.
//
// WHY THIS EXISTS — the hierarchy half
// The invoice detail offered Card-payment-link, Charge-card, Send, Record
// payment, Request deposit, the status menu and an overflow menu at the same
// visual weight, in an order decided by markup rather than by state. So the
// screen never answered "what do I do next?" — it listed everything that was
// possible and left the ranking to the owner, every time they opened an invoice.
//
// NO MONEY IS COMPUTED HERE. Every figure is a read-through of the canonical
// engines (`invoiceBalance` / `depositState` / `depositChargeAmount` /
// `displayInvoiceStatus`); this module only compares them and picks a label.
// A local `total - paid` in here would be a second opinion about money, which is
// the one thing a simpler interface must not buy.

/** A cent, as a comparison epsilon — money equality is never exact. */
const CENT = 0.01

/**
 * Every canonical figure for one invoice, fetched once.
 *
 * Exists so a surface can lay out the financial truth without calling four
 * engines by hand and risking one of them being called with different arguments
 * than its neighbour (the `settings`-less call that quietly drops GST).
 */
export interface InvoiceMoney {
  /** GST-inclusive, discount-aware invoice total — what was invoiced. */
  total: number
  /** Received against this invoice (net of refunds) — what was collected. */
  paid: number
  /** Still owed. NOT a statement that it is collectable — see `owes`. */
  balance: number
  /** Paid beyond the total, or 0. */
  overpaid: number
  /** The deposit request's full state — requested / collected / still due. */
  deposit: DepositState
  /** THE collection figure: the outstanding deposit while one is owed, else the balance. */
  due: { amount: number; isDeposit: boolean }
  /** Stored status overlaid with the derived states (overdue / viewed). */
  display: InvoiceDisplayStatus
}

type MoneyInvoice = Parameters<typeof depositState>[0] &
  Pick<Invoice, 'status' | 'due_date'> & { viewed_at?: string | null }

export function invoiceMoney(
  inv: MoneyInvoice,
  settings: FeeSettings | null | undefined,
  todayISO: string,
): InvoiceMoney {
  const { total, paid, balance, overpaid } = invoiceBalance(inv, settings)
  return {
    total, paid, balance, overpaid,
    deposit: depositState(inv, settings),
    due: depositChargeAmount(inv, settings),
    display: displayInvoiceStatus(inv, settings, todayISO),
  }
}

/**
 * Money already settled → the figures are history. Notes stay editable; amount,
 * line items and discount don't. Derived from the LEDGER's balance rather than a
 * status string, so it can't disagree with what the list, PDF and charge routes
 * think this invoice is worth. `amount_paid > 0` keeps a $0 draft (balance 0,
 * nothing received) out of the locked branch.
 */
export function financiallyLocked(
  inv: Pick<Invoice, 'amount' | 'amount_paid' | 'discount_type' | 'discount_value'>,
  settings: FeeSettings | null | undefined,
): boolean {
  return (Number(inv.amount_paid) || 0) > 0 && invoiceBalance(inv, settings).balance <= CENT
}

/** Runtime facts the invoice row itself cannot know. */
export interface InvoiceDoorContext {
  /** Stripe is configured for this business. */
  paymentsEnabled: boolean
  /** This customer has a card on file. */
  hasSavedCard: boolean
  /** This invoice has at least one ledger row (so a receipt exists). */
  hasPayments?: boolean
}

/**
 * Which doors this invoice has. Each one reproduces the gate its button already
 * carried — the point is that they now share `owes` instead of restating it.
 */
export interface InvoiceDoors {
  cancelled: boolean
  /** Fully paid off: money arrived and nothing is left. */
  settled: boolean
  /**
   * ⭐ THE money rule. Real, collectable money is outstanding.
   * A cancelled invoice is never `owes`, however large its balance.
   */
  owes: boolean
  /** Write down money already in hand. */
  canRecord: boolean
  /** Mint a Stripe payment link. Never on a draft — the customer has no invoice yet. */
  canCardLink: boolean
  /** Charge the card on file directly. Recurring invoices only (they have a job). */
  canChargeSavedCard: boolean
  /** Ask for money up front. Only where nothing has been asked for yet. */
  canAskDeposit: boolean
  /** Put the invoice in the customer's hands. */
  canSend: boolean
  /** Change the document. Cancelled is terminal. */
  canEdit: boolean
}

export function invoiceDoors(
  inv: MoneyInvoice & Pick<Invoice, 'customer_id' | 'job_id'>,
  settings: FeeSettings | null | undefined,
  ctx: InvoiceDoorContext,
): InvoiceDoors {
  const { total, paid, balance } = invoiceBalance(inv, settings)
  const d = depositState(inv, settings)
  const cancelled = inv.status === 'cancelled'
  // ⚠️ `balance > 0` alone is the trap this whole module exists to close.
  const owes = !cancelled && balance > 0
  return {
    cancelled,
    settled: paid > CENT && balance <= CENT,
    owes,
    canRecord: owes && inv.status !== 'paid',
    canCardLink: owes && ctx.paymentsEnabled && inv.status !== 'draft',
    canChargeSavedCard: owes && ctx.paymentsEnabled && ctx.hasSavedCard && !!inv.customer_id && !!inv.job_id,
    // The deposit engine's own askable rule: something to ask for, and nothing
    // asked for yet (one request per invoice — that is the duplicate guard).
    canAskDeposit: !cancelled && total > 0 && d.remainingAfter > 0.005 && d.status === 'none',
    canSend: !cancelled && !!inv.customer_id,
    canEdit: !cancelled,
  }
}

// ── The financial headline ───────────────────────────────────────────────────
// One figure per state, and it is the figure that is TRUE NOW.
//
// ⚠️ Measured before this existed: on every one of the twelve invoice states the
// detail rendered exactly ONE money figure at 18px — the invoice TOTAL — and it
// was the only figure above 14px. On a part-paid invoice the balance the owner is
// chasing appeared at 10px inside the status pill; a $2,100 outstanding deposit
// appeared at 14px inside a panel; a $300 overpayment appeared nowhere large. The
// most prominent number on the screen was a historical fact in every state where
// something else mattered more.
export type HeadlineKind =
  | 'balance'    // money is owed
  | 'deposit-due'// a deposit is owed — that is what "now" means on this invoice
  | 'overdue'    // owed, and late
  | 'paid'       // settled
  | 'overpaid'   // more arrived than was invoiced
  | 'draft-total'// not issued yet, so nothing is owed by anyone
  | 'unpriced'   // no price yet
  | 'cancelled'  // withdrawn: it has a balance, and nobody owes it

export interface InvoiceHeadline {
  kind: HeadlineKind
  /** What the big number IS. Never ambiguous between total / paid / balance. */
  label: string
  amount: number
  /** Supporting figures in reading order — engine outputs, never re-derived. */
  facts: { label: string; amount: number }[]
}

/**
 * THE money hierarchy for one invoice.
 *
 * Same shape of ladder as the action rules and for the same reason: the order is
 * the argument. `facts` deliberately omits any figure equal to the headline —
 * "Balance due $4,200 / Invoiced $4,200" teaches the owner nothing and trains
 * them to stop reading the labels, which is how a total gets mistaken for a
 * balance later.
 */
export function invoiceHeadline(
  inv: MoneyInvoice,
  settings: FeeSettings | null | undefined,
  todayISO: string,
): InvoiceHeadline {
  const m = invoiceMoney(inv, settings, todayISO)
  const invoiced = { label: 'Invoiced', amount: m.total }
  const received = { label: 'Received', amount: m.paid }
  const some = (cond: boolean, f: { label: string; amount: number }) => (cond ? [f] : [])

  // Cancelled first: it keeps its full balance, so every balance-shaped headline
  // below would read as money owed on a bill the owner has withdrawn.
  if (inv.status === 'cancelled') {
    return { kind: 'cancelled', label: 'Cancelled — not owed', amount: m.total, facts: some(m.paid > CENT, received) }
  }
  if (m.overpaid > CENT) {
    return { kind: 'overpaid', label: 'Overpaid', amount: m.overpaid, facts: [invoiced, received] }
  }
  if (m.paid > CENT && m.balance <= CENT) {
    return { kind: 'paid', label: 'Paid in full', amount: m.total, facts: [] }
  }
  if (m.total <= 0) {
    return { kind: 'unpriced', label: 'No price yet', amount: 0, facts: [] }
  }
  // A deposit that is still owed IS what this invoice is asking for right now —
  // it outranks both the draft total and the balance, because it is the figure
  // the customer was told and the figure every charge door will collect.
  if (m.due.isDeposit) {
    return {
      kind: 'deposit-due',
      label: 'Deposit due',
      amount: m.due.amount,
      facts: [invoiced, ...some(m.paid > CENT, received), { label: 'Remaining after', amount: m.deposit.remainingAfter }],
    }
  }
  if (inv.status === 'draft') {
    return { kind: 'draft-total', label: 'Draft total', amount: m.total, facts: some(m.paid > CENT, received) }
  }
  const facts = [...some(Math.abs(m.total - m.balance) > CENT, invoiced), ...some(m.paid > CENT, received)]
  if (m.display === 'overdue') return { kind: 'overdue', label: 'Overdue', amount: m.balance, facts }
  return {
    kind: 'balance',
    label: m.paid > CENT ? 'Balance remaining' : 'Balance due',
    amount: m.balance,
    facts,
  }
}

export type InvoiceActionKind =
  | 'price'                 // it has no price yet — nothing else can happen
  | 'send'                  // it isn't in the customer's hands
  | 'send-deposit'          // a deposit was asked for but never sent
  | 'remind'               // it's late; nudge them
  | 'record'                // money is owed — write down what arrives
  | 'card-link'             // hand them a way to pay by card
  | 'receipt'               // settled; the receipt is the remaining artefact
  | 'resolve-overpayment'   // they paid too much; that has to be resolved
  | 'none'                  // nothing is the obvious next step

export interface InvoiceAction {
  kind: InvoiceActionKind
  label: string
}

export interface InvoiceNextActions {
  /** The one action that gets primary weight. Never null — 'none' means "no primary". */
  primary: InvoiceAction
  /** The one other action worth a button. Everything else belongs in the menu. */
  secondary: InvoiceAction | null
}

/** Deposit-aware label for the card door — the SAME two strings it has always used. */
function cardLinkLabel(isDeposit: boolean): string {
  return isDeposit ? 'Card link — deposit' : 'Card payment link'
}

/**
 * THE LADDER — one primary action per state, in priority order.
 *
 * Read top to bottom; the first rule that matches wins. The order is the
 * argument, so each rule says why it outranks the ones below it.
 */
export function invoiceNextActions(
  inv: MoneyInvoice & Pick<Invoice, 'customer_id' | 'job_id'>,
  settings: FeeSettings | null | undefined,
  todayISO: string,
  ctx: InvoiceDoorContext,
): InvoiceNextActions {
  const m = invoiceMoney(inv, settings, todayISO)
  const doors = invoiceDoors(inv, settings, ctx)
  const record: InvoiceAction = { kind: 'record', label: 'Record payment' }
  const cardLink: InvoiceAction = { kind: 'card-link', label: cardLinkLabel(m.due.isDeposit) }

  // The alternate collection door, once collecting is the primary job. Card
  // first: it is the only one of the two the owner cannot do without the app.
  const collectSecondary = (): InvoiceAction | null =>
    doors.canCardLink ? cardLink
      : doors.canSend ? { kind: 'send', label: 'Send again' }
        : null

  // 1. Cancelled — the owner has said this money is not owed. Offering to
  //    collect on it is the defect this module was built around; Reactivate
  //    lives on the status pill, where every other lifecycle move already is.
  if (doors.cancelled) return { primary: { kind: 'none', label: '' }, secondary: null }

  // 2. Overpaid — money is sitting on the invoice that does not belong to it.
  //    That outranks everything: until it is credited, refunded or absorbed, the
  //    books are wrong.
  if (m.overpaid > CENT) {
    return { primary: { kind: 'resolve-overpayment', label: 'Resolve overpayment' }, secondary: null }
  }

  // 3. Settled — there is nothing to collect and nothing to chase. What remains
  //    is proof of payment. (A $0 invoice is not settled: nothing arrived.)
  if (doors.settled) {
    return {
      primary: ctx.hasPayments ? { kind: 'receipt', label: 'Receipt' } : { kind: 'none', label: '' },
      secondary: null,
    }
  }

  // 4. No price — both charge routes reject a $0 balance and the customer would
  //    receive a document that dead-ends, so pricing it is the only real step.
  if (m.total <= 0 && doors.canEdit) {
    return { primary: { kind: 'price', label: 'Add a price' }, secondary: null }
  }

  // 5. A deposit was asked for and never sent. The money cannot arrive until the
  //    customer is told, and this outranks "send the invoice" because sending the
  //    ask ISSUES the invoice too (same one-intent-one-action rule).
  if (m.deposit.status === 'draft' && doors.canSend) {
    return {
      primary: { kind: 'send-deposit', label: 'Send deposit request' },
      secondary: doors.canRecord ? record : null,
    }
  }

  // 6. Not in the customer's hands yet (draft / issued-but-unsent). Nobody can
  //    pay an invoice they have not seen.
  if (inv.status === 'draft' || inv.status === 'unpaid') {
    return {
      primary: doors.canSend ? { kind: 'send', label: 'Send invoice' }
        : doors.canRecord ? record : { kind: 'none', label: '' },
      secondary: doors.canSend && doors.canRecord ? record : null,
    }
  }

  // 7. Late. They already have it and the date has passed, so the next move is a
  //    nudge rather than waiting for money that is already overdue.
  if (m.display === 'overdue' && doors.owes) {
    return {
      primary: doors.canSend ? { kind: 'remind', label: 'Send reminder' }
        : doors.canRecord ? record : { kind: 'none', label: '' },
      secondary: doors.canSend && doors.canRecord ? record : null,
    }
  }

  // 8. Sent, seen or part-paid with money still owed: the job is to collect.
  if (doors.owes && doors.canRecord) {
    return { primary: record, secondary: collectSecondary() }
  }

  return { primary: { kind: 'none', label: '' }, secondary: null }
}
