import type { BusinessSettings, ExpenseWithRelations, Invoice } from '@/types'
import { invoiceTotals, gstRegistrationNumber } from '@/lib/invoiceTotals'
import { invoiceBalance } from '@/lib/payments/ledger'
import { isCapital } from '@/lib/accounting/expenses'
import { inPeriod, type Period } from '@/lib/accounting/period'

// ── THE GST/HST return ───────────────────────────────────────────────────────
// What you owe the CRA for a period: tax collected on sales, less input tax credits
// on what you bought.
//
// ══ THIS IS ACCRUAL, AND THAT IS NOT A STYLE CHOICE ══════════════════════════
// Every other statement in lib/accounting is CASH basis — money that actually
// moved. This one is not, and must not be.
//
// Under the Excise Tax Act, GST/HST becomes payable on the EARLIER of when
// consideration is paid or becomes DUE — i.e. when you invoice. You remit tax on an
// invoice you sent in March even if the customer pays in June. There is no general
// cash-basis election for GST (the Quick Method is a simplified RATE, not a cash
// basis, and is a different thing entirely).
//
// So a cash-basis GST figure is the wrong number to file. `ProfitAndLoss.
// salesTaxCollected` exists ONLY to net collected cash down to revenue for the P&L;
// it is an estimate over cash and is never the filing figure. THIS module is.
//
// ══ WHY IT LIVES HERE, and what it fixes ═════════════════════════════════════
// /dashboard/reports already reported GST COLLECTED on an accrual basis, correctly —
// but Phase 1 had no expenses, so it had no input tax credits and therefore could
// never show net tax owing. It reported one side of a subtraction. This module is
// that page's engine now (it calls in here rather than keeping its own copy), plus
// the ITC half it could never have had.
//
// The invoice half is read through `invoiceTotals` — the same engine the invoice,
// the PDF and the charge route use — so the return can never disagree with the
// paper the customer was actually sent.

const round2 = (n: number) => Math.round(n * 100) / 100

export interface GstReturnRow {
  invoiceNumber: string | null
  issuedDate: string | null
  customerName: string
  /** Post-discount revenue, ex-GST. */
  net: number
  gst: number
  total: number
  paid: boolean
  balance: number
}

export interface GstReturn {
  period: Period
  registrant: boolean
  gstPercent: number
  /** The CRA needs this on the return. Null when not registered / not entered. */
  gstNumber: string | null
  /** Always 'accrual' — GST is owed when invoiced, not when collected. */
  basis: 'accrual'

  /** Line 101 — revenue invoiced in the period, ex-GST. */
  sales: number
  /** Line 105 — GST/HST charged on those invoices. */
  taxCollected: number
  /** Line 108 — GST/HST paid on what you bought (input tax credits). */
  inputTaxCredits: number
  /** Line 109 — taxCollected − inputTaxCredits. Positive = remit. Negative = refund due. */
  netTax: number

  invoiceCount: number
  expenseCount: number
  /** Unsent paper: excluded from the return, disclosed so it isn't silently missing. */
  excludedDrafts: { count: number; total: number }
  /** ITCs on capital purchases — claimable, and worth seeing separately in a big year. */
  capitalItcs: number
  rows: GstReturnRow[]
}

/** One reading of gst_percent for the whole module, through the shared engine. */
export function gstPercentOf(settings: BusinessSettings | null | undefined): number {
  return invoiceTotals(0, settings).gstPercent
}

export interface GstInput {
  invoices: (Pick<Invoice, 'id' | 'amount' | 'amount_paid' | 'status' | 'issued_date' | 'invoice_number' | 'discount_type' | 'discount_value'> & {
    customers?: { name?: string | null } | null
  })[]
  expenses: ExpenseWithRelations[]
  settings: BusinessSettings | null | undefined
  period: Period
}

/**
 * Input tax credits for a period.
 *
 * ACCRUAL, dated by `bill_date`: an ITC is claimable when the supplier invoices you,
 * not when you get round to paying — the mirror of the rule on the sales side. Using
 * `spent_at` would push credits into the wrong period and, for an unpaid bill, drop
 * them entirely.
 *
 * Capital purchases ARE included: a registrant reclaims the GST on a mower in full,
 * in the period they bought it. Excluding them (as the P&L rightly does for COST)
 * would understate the claim by the tax on every asset the business buys.
 */
export function inputTaxCredits(expenses: ExpenseWithRelations[], period: Period): number {
  return round2(
    expenses
      .filter(e => inPeriod(e.bill_date, period))
      .reduce((s, e) => s + (Number(e.tax_amount) || 0), 0),
  )
}

/**
 * THE GST return for a period. Pure over rows the caller already fetched.
 *
 * Returns zeroed lines for a non-registrant: they charge no GST and reclaim none, so
 * there is no return to file. The rows are still built so the UI can show the sales
 * that WOULD be taxed if they registered.
 */
export function gstReturn(input: GstInput): GstReturn {
  const { settings, period } = input
  const gstPercent = gstPercentOf(settings)
  const registrant = gstPercent > 0

  // Cancelled is void paper. Drafts are excluded and disclosed: completing a job
  // auto-drafts an invoice stamped with today's date, so a draft sits in the period
  // looking exactly like billed work — but nobody was ever charged, and you do not
  // remit GST on paper that never left the building.
  const inScope = input.invoices.filter(
    i => inPeriod(i.issued_date, period) && i.status !== 'cancelled',
  )
  const issued = inScope.filter(i => i.status !== 'draft')

  const built = issued.map(inv => ({
    inv,
    t: invoiceTotals(inv.amount, settings, { type: inv.discount_type, value: inv.discount_value }),
    b: invoiceBalance(inv as Invoice, settings),
  }))

  const sales = round2(built.reduce((s, x) => s + x.t.discountedSubtotal, 0))
  const taxCollected = round2(built.reduce((s, x) => s + x.t.gstAmount, 0))

  const itcs = registrant ? inputTaxCredits(input.expenses, period) : 0
  const capitalItcs = registrant
    ? round2(
        input.expenses
          .filter(e => isCapital(e) && inPeriod(e.bill_date, period))
          .reduce((s, e) => s + (Number(e.tax_amount) || 0), 0),
      )
    : 0

  const drafts = inScope.filter(i => i.status === 'draft')

  return {
    period,
    registrant,
    gstPercent,
    gstNumber: gstRegistrationNumber(settings),
    basis: 'accrual',
    sales,
    taxCollected,
    inputTaxCredits: itcs,
    // Negative is REAL and unclamped: a big equipment year can mean the CRA owes
    // you. Clamping it to zero would hide a refund the business is entitled to.
    netTax: round2(taxCollected - itcs),
    invoiceCount: built.length,
    expenseCount: input.expenses.filter(e => inPeriod(e.bill_date, period)).length,
    excludedDrafts: {
      count: drafts.length,
      total: round2(
        drafts.reduce(
          (s, i) => s + invoiceTotals(i.amount, settings, { type: i.discount_type, value: i.discount_value }).total,
          0,
        ),
      ),
    },
    capitalItcs,
    rows: built.map(({ inv, t, b }) => ({
      invoiceNumber: inv.invoice_number,
      issuedDate: inv.issued_date,
      customerName: inv.customers?.name || 'Customer',
      net: t.discountedSubtotal,
      gst: t.gstAmount,
      total: t.total,
      paid: b.balance <= 0.01,
      balance: b.balance,
    })),
  }
}
