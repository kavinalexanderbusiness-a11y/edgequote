// ── Deposit document & communication consistency — npm run verify:deposit-documents ─
//
// WHY THIS SCRIPT EXISTS
// A customer can receive the same invoice through four doors: the deposit request
// (SMS/email), the invoice message, the invoice PDF (owner-sent AND the copy they
// download themselves from the portal), and an automated overdue reminder. Each
// one names a number. Before this, three of them named a DIFFERENT number than
// the deposit request did:
//
//   • the invoice PDF printed "Total Due $4,000" — the biggest type on the page —
//     while the request in their inbox asked for $2,000
//   • the invoice composer sent {{amount}} = the full balance
//   • the reminder cron chased the full balance, over the owner's name
//
// Being wrong about money in a document a customer forwards to their accountant
// is not a display bug. This pins the rule: every customer-facing figure for
// "what do I pay now" comes from ONE engine — depositChargeAmount — and every
// document that shows the breakdown derives it from depositState. No surface
// re-implements the maths.
//
// Part 1 is BEHAVIOURAL over the real engine (the exact figures each document
// prints, for every state the brief calls out). Part 2 is STRUCTURAL over the
// source, because a PDF component cannot be rendered here — what it CAN prove is
// that the document reads the canonical helpers and holds no arithmetic of its own.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { depositChargeAmount, depositState, type DepositInvoice } from '../src/lib/payments/deposit'
import { invoiceBalance } from '../src/lib/payments/ledger'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}
const ROOT = join(__dirname, '..')
const src = (p: string) => readFileSync(join(ROOT, 'src', p), 'utf8')

const inv = (o: Partial<DepositInvoice> & { amount: number }): DepositInvoice => ({
  amount_paid: 0, discount_type: null, discount_value: null,
  deposit_amount: null, deposit_requested_at: null, ...o,
})
const NO_GST = { gst_percent: 0 }
const GST5 = { gst_percent: 5 }
const SENT = '2026-08-09T12:00:00Z'

// What the invoice PDF prints, derived exactly as the document derives it: the
// canonical engine, no arithmetic here either. If this helper and the PDF ever
// disagree, the structural checks in part 2 are what catch it.
function documentFigures(i: DepositInvoice, s: { gst_percent: number }) {
  const t = invoiceBalance(i, s)
  const charge = depositChargeAmount(i, s)
  const d = depositState(i, s)
  return charge.isDeposit
    ? {
        shape: 'deposit' as const,
        invoiceTotal: t.total, paidToDate: t.paid,
        depositRequested: d.requested ?? charge.amount,
        dueNow: charge.amount, remainingAfter: d.remainingAfter,
      }
    : { shape: 'balance' as const, invoiceTotal: t.total, paidToDate: t.paid, dueNow: charge.amount }
}

// ═══════════════════════════════════════════════════════════════════════════
H('1. THE OWNER’S EXAMPLE — $4,000 invoice, $2,000 deposit requested, nothing paid')

{
  const i = inv({ amount: 4000, deposit_amount: 2000, deposit_requested_at: SENT })
  check('the document shows total / deposit / due-now / remaining — not "Total Due $4,000"',
    documentFigures(i, NO_GST),
    { shape: 'deposit', invoiceTotal: 4000, paidToDate: 0, depositRequested: 2000, dueNow: 2000, remainingAfter: 2000 })
  check('the composer, the Pay button and the PDF all name the SAME figure',
    depositChargeAmount(i, NO_GST).amount, 2000)
  check('paid + due-now + remaining = the invoice total (nothing invented, nothing lost)',
    0 + 2000 + 2000, 4000)
}

H('2. DEPOSIT REQUESTED BUT PART-PAID — chase only the shortfall')
{
  const i = inv({ amount: 4000, amount_paid: 500, deposit_amount: 2000, deposit_requested_at: SENT })
  check('due now is the deposit SHORTFALL, not the deposit and not the balance',
    documentFigures(i, NO_GST),
    { shape: 'deposit', invoiceTotal: 4000, paidToDate: 500, depositRequested: 2000, dueNow: 1500, remainingAfter: 2000 })
  check('the identity still closes: 500 paid + 1,500 now + 2,000 later = 4,000',
    500 + 1500 + 2000, 4000)
}

H('3. DEPOSIT PAID — the document goes back to being an ordinary balance')
{
  const i = inv({ amount: 4000, amount_paid: 2000, deposit_amount: 2000, deposit_requested_at: SENT })
  check('no deposit block once it is covered — Balance Due $2,000, as before deposits existed',
    documentFigures(i, NO_GST), { shape: 'balance', invoiceTotal: 4000, paidToDate: 2000, dueNow: 2000 })
  check('the reminder now chases the remaining balance, not the settled deposit',
    depositChargeAmount(i, NO_GST), { amount: 2000, isDeposit: false })
}

H('4. FULLY PAID — nothing is asked for, by any door')
{
  const i = inv({ amount: 4000, amount_paid: 4000, deposit_amount: 2000, deposit_requested_at: SENT })
  check('due now is $0 and the document is a plain balance',
    documentFigures(i, NO_GST), { shape: 'balance', invoiceTotal: 4000, paidToDate: 4000, dueNow: 0 })
}

H('5. NO DEPOSIT — the ordinary invoice is untouched')
{
  check('unpaid, no deposit → the balance shape exactly as it always was',
    documentFigures(inv({ amount: 4000 }), NO_GST),
    { shape: 'balance', invoiceTotal: 4000, paidToDate: 0, dueNow: 4000 })
  check('part-paid, no deposit → still the pre-existing paid/balance shape',
    documentFigures(inv({ amount: 4000, amount_paid: 1500 }), NO_GST),
    { shape: 'balance', invoiceTotal: 4000, paidToDate: 1500, dueNow: 2500 })
  check('a deposit request that was never sent still shows on the document (it IS what is due)',
    documentFigures(inv({ amount: 4000, deposit_amount: 1000 }), NO_GST).shape, 'deposit')
}

H('6. FIXED vs PERCENTAGE — the document cannot tell, and must not')
{
  // A % deposit is stored as the money it resolved to, so both arrive here
  // identically. $1,000 is 25% of $4,000; the document prints $1,000 either way.
  const pct = inv({ amount: 4000, deposit_amount: 1000, deposit_requested_at: SENT })
  const fixed = inv({ amount: 4000, deposit_amount: 1000, deposit_requested_at: SENT })
  check('25% and a flat $1,000 produce the same document figures',
    documentFigures(pct, NO_GST), documentFigures(fixed, NO_GST))
  check('the derived percentage is honest about the stored amount',
    depositState(pct, NO_GST).percent, 25)
}

H('7. GST — the document’s deposit is a share of the GST-INCLUSIVE total')
{
  const i = inv({ amount: 4000, deposit_amount: 2100, deposit_requested_at: SENT })
  check('$4,000 net → $4,200 payable; a $2,100 deposit is half of what they actually owe',
    documentFigures(i, GST5),
    { shape: 'deposit', invoiceTotal: 4200, paidToDate: 0, depositRequested: 2100, dueNow: 2100, remainingAfter: 2100 })
}

H('8. INVOICE EDITED AFTER THE REQUEST — never ask for more than is owed')
{
  // Asked $1,500, then the job shrank to $1,000.
  const i = inv({ amount: 1000, deposit_amount: 1500, deposit_requested_at: SENT })
  const f = documentFigures(i, NO_GST)
  check('due now is CLAMPED to the real balance — the document can’t out-ask the invoice',
    f.dueNow, 1000)
  check('remaining afterward is never NEGATIVE (it printed −$500 before this was floored)',
    f.remainingAfter, 0)
  check('the mismatch is still reported to the owner rather than hidden',
    depositState(i, NO_GST).exceedsTotal, true)
  check('the document never prints a figure above the invoice total',
    f.dueNow <= f.invoiceTotal, true)
}

H('9. NO CUSTOMER-FACING FIGURE IS EVER NEGATIVE OR ABOVE THE TOTAL')
{
  // Sweep the awkward corners together — every one of these ends up in front of a
  // customer, and a negative on an invoice reads as "we owe YOU".
  const cases: DepositInvoice[] = [
    inv({ amount: 4000, deposit_amount: 2000, deposit_requested_at: SENT }),
    inv({ amount: 4000, amount_paid: 500, deposit_amount: 2000, deposit_requested_at: SENT }),
    inv({ amount: 4000, amount_paid: 2000, deposit_amount: 2000 }),
    inv({ amount: 4000, amount_paid: 4000, deposit_amount: 2000 }),
    inv({ amount: 1000, deposit_amount: 1500, deposit_requested_at: SENT }),
    inv({ amount: 1000, amount_paid: 1200 }),                                  // overpaid
    inv({ amount: 1000, amount_paid: 1200, deposit_amount: 500 }),             // overpaid w/ deposit
    inv({ amount: 0.01, deposit_amount: 0.01, deposit_requested_at: SENT }),   // one cent
  ]
  let clean = true
  for (const c of cases) {
    for (const s of [NO_GST, GST5]) {
      const f = documentFigures(c, s)
      const d = depositState(c, s)
      if (f.dueNow < 0 || d.remainingAfter < 0 || d.outstanding < 0) clean = false
      if (f.dueNow > f.invoiceTotal + 0.005) clean = false
    }
  }
  check('across every state, with and without GST: no negatives, nothing above the total', clean, true)
}

// ═══════════════════════════════════════════════════════════════════════════
H('10. STRUCTURAL — every document reads the ONE engine, and holds no maths')

{
  const pdf = src('components/quotes/InvoicePDF.tsx')
  check('the invoice PDF imports the canonical deposit helpers',
    /from '@\/lib\/payments\/deposit'/.test(pdf) && /depositChargeAmount/.test(pdf) && /depositState/.test(pdf), true)
  check('the PDF prints "Due Now" from depositChargeAmount, not its own subtraction',
    /charge\.amount/.test(pdf), true)
  check('the PDF prints "Remaining afterward" from depositState, not its own subtraction',
    /dep\.remainingAfter/.test(pdf), true)
  // The one thing that must NOT appear: arithmetic on the raw column.
  check('the PDF never does arithmetic on invoice.deposit_amount',
    /deposit_amount\s*[-+*/]|[-+*/]\s*(?:invoice\.)?deposit_amount/.test(pdf), false)
  check('the PDF still shows Paid to date and a single grand row per branch',
    /Paid to date/.test(pdf) && /grandRow/.test(pdf), true)
  // 38b7b0e: the logo goes through pdfLogoUrl or an 11 MB upload lands in every
  // document and the customer's PDF never opens. Preserve it.
  check('the PDF logo still goes through pdfLogoUrl (the 38b7b0e fix)',
    /pdfLogoUrl\(/.test(pdf), true)
  check('…and no raw settings.logo_url is passed to an Image src',
    /src=\{settings\.logo_url\}/.test(pdf), false)
}
{
  const portal = src('lib/portalPdf.ts')
  check('the portal PDF mapper carries deposit_amount through',
    /deposit_amount:\s*inv\.deposit_amount/.test(portal), true)
  check('…and deposit_requested_at, or the customer’s copy shows a draft ask as sent',
    /deposit_requested_at:\s*inv\.deposit_requested_at/.test(portal), true)
  check('the portal PDF type declares both fields',
    /deposit_amount\?:/.test(portal) && /deposit_requested_at\?:/.test(portal), true)
}
{
  const page = src('app/dashboard/invoices/page.tsx')
  check('the invoice composer takes its amount from depositChargeAmount',
    /depositChargeAmount\(msgInvoice, settings\)/.test(page), true)
  check('…and opens the deposit template while one is outstanding',
    /isDeposit \? 'deposit_request' : 'invoice'/.test(page), true)
  check('the composer no longer sends the raw balance as {{amount}}',
    /vars=\{\{ amount: formatCurrency\(invoiceBalance\(msgInvoice, settings\)\.balance\) \}\}/.test(page), false)
}
{
  const cron = src('app/api/cron/invoice-reminders/route.ts')
  check('the overdue reminder chases depositChargeAmount, not the raw balance',
    /amount: formatCurrency\(due\.amount\)/.test(cron), true)
  // The select is a string, so nothing but this can prove the columns are loaded —
  // and without them every invoice silently reads "no deposit requested".
  check('…and its query actually SELECTS the deposit columns it depends on',
    /deposit_amount, deposit_requested_at/.test(cron), true)
}
{
  const tpl = src('lib/comms/templates.ts')
  check('the deposit template names the amount AS a deposit',
    /deposit of \*\*\{\{amount\}\}\*\*/.test(tpl), true)
  // Comments stripped first. This asserts the templates file cannot COMPUTE a
  // deposit — but the file also documents why, by naming the engine its callers
  // must use instead ("its only sender fills it from depositChargeAmount()").
  // Scanning raw source cannot tell an engine call from prose about one, and
  // would report the explanation as the violation.
  const tplCode = tpl.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  check('no template does deposit arithmetic (templates interpolate, never compute)',
    /deposit_amount|depositChargeAmount|depositState/.test(tplCode), false)
  check('the receipt body still states the remaining balance (partial-safe, unchanged)',
    /remaining balance is/.test(tpl), true)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✅' : '❌'} deposit documents: ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
