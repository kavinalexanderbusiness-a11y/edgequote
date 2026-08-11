// ── Verify: the invoice list is a list, and the detail is where you act ──────
//   npm run verify:invoice-list
//
// WHY THIS SCRIPT EXISTS
// /dashboard/invoices had no detail route, so every row rendered the whole
// product for that invoice: identity, money breakdown, status menu, Stripe link,
// charge-saved-card, send, an overflow menu, the deposit request panel AND the
// payment controls — ~418px and 6–8 decisions per row, on every invoice in the
// book. The list could not answer "which invoice?" because it was busy answering
// "what can I do with it?" for all of them at once.
//
// The fix added NO route and NO second data path. `?invoice=` already narrowed
// the page to one invoice (a Convert toast, a completed job's link); that focus
// mechanism simply became the detail surface, and rows that aren't focused
// collapse to a summary whose one action is to open them.
//
// This guard pins the two halves apart, because the failure mode is gradual: one
// more "handy" control on the row at a time until the list is a stack of detail
// pages again.
//
// It also pins what must NOT change: the canonical engines still decide every
// figure, the deep links still work, and the search/filters are untouched.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { invoiceBalance, displayInvoiceStatus } from '../src/lib/payments/ledger'
import { depositState } from '../src/lib/payments/deposit'
import { INVOICE_STATUS_COLORS, INVOICE_STATUS_LABELS } from '../src/types'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

const PAGE = readFileSync(join(process.cwd(), 'src/app/dashboard/invoices/page.tsx'), 'utf8')
// The detail is its own component now — see the note on the capability check
// below. Its own guard is verify:invoice-detail; this file only cares that the
// LIST half stays a list and that no capability vanished in the move.
const DETAIL = readFileSync(join(process.cwd(), 'src/components/payments/InvoiceDetail.tsx'), 'utf8')

// The list branch is everything the `detailMode ? … : …` ternary renders when
// FALSE. Slicing on the marker comment keeps this honest as the file moves.
const listBranch = PAGE.split('── The LIST row ─')[1]?.split('))}')[0] ?? ''

// ── 1. The split exists, and it is one concept ──────────────────────────────
console.log('\nOne mechanism decides list vs detail:')
{
  check('detailMode is derived from the SAME focused set the filter uses',
    /const detailMode = !!focus && focused !== null && focused\.length > 0/.test(PAGE),
    'a second "which invoice is open" concept would let the filter and the renderer disagree')
  check('the rows branch on it',
    /visible\.map\(\(inv, i\) => detailMode \? \(/.test(PAGE),
    'the list/detail split must be the row renderer, not a prop passed into a panel')
  check('the list branch was found by the guard',
    listBranch.length > 400,
    'the "── The LIST row ─" marker moved — fix this scan before trusting the checks below')
}

// ── 2. The list answers "which invoice?" ────────────────────────────────────
console.log('\nThe list row carries identity, state and one way in:')
{
  for (const [what, re] of [
    ['the invoice number', /inv\.invoice_number/],
    ['the customer', /inv\.customer_name/],
    ['the status pill', /INVOICE_STATUS_LABELS\[ds\]/],
    ['a money figure', /formatCurrency\(partPaid \? bal\.balance : bal\.total\)/],
    ['an open affordance', /ChevronRight/],
  ] as const) {
    check(`…${what}`, re.test(listBranch), `the list must still answer "which invoice?" — ${what} is missing`)
  }
  check('the whole row is the open action',
    /onClick=\{\(\) => openInvoice\(inv\)\}/.test(listBranch),
    'one obvious action per row; the row itself is the biggest target on a phone')
  check('…with an accessible name naming the invoice',
    /aria-label=\{`Open \$\{inv\.invoice_number\}/.test(listBranch),
    'a row of identical "Open" buttons is unusable with a screen reader')
}

// ── 3. The list does NOT carry the detail's actions ─────────────────────────
console.log('\nThe list row carries nothing you can act with:')
{
  for (const [what, needle] of [
    ['the payment controls', 'InvoicePaymentControls'],
    ['the deposit request panel', 'DepositRequestPanel'],
    ['the draft editor', 'DraftInvoiceEditor'],
    ['the Stripe payment link', 'payNow'],
    ['charge-saved-card', 'chargeSavedCard'],
    ['the send dialog trigger', 'setMsgInvoice'],
    ['the overflow menu', 'MoreHorizontal'],
    ['the status-change menu', 'statusItems'],
  ] as const) {
    check(`…no ${what}`, !listBranch.includes(needle),
      `${needle} belongs to the detail. Every one of these on every row is what made the list ~418px per invoice`)
  }
  // The detail must still have all of them — a "simplification" that deletes
  // capability is not the trade being made here.
  //
  // ⚠️ The detail now lives in components/payments/InvoiceDetail.tsx: it was
  // ~310 lines of JSX inline in this page, which is also why it could not be
  // rendered and measured. Capability is therefore checked across BOTH halves —
  // the page still owns every write and both send dialogs, the component owns
  // the layout. Scanning only the page would let the whole surface disappear.
  const BOTH = PAGE + '\n' + DETAIL
  for (const needle of ['InvoicePaymentControls', 'DepositRequestPanel', 'DraftInvoiceEditor', 'payNow', 'chargeSavedCard', 'setMsgInvoice']) {
    check(`the detail still has ${needle}`, BOTH.includes(needle),
      'moving an action out of the list must not remove it from the product')
  }
  check('the page renders the detail component when focused',
    /detailMode \? \([\s\S]{0,80}<InvoiceDetail/.test(PAGE),
    'the list/detail split must stay the row renderer, not a prop passed into a panel')
}

// ── 4. Deep links keep working, and now go both ways ────────────────────────
console.log('\nDeep links survive, and Back closes the detail:')
{
  check('?invoice= / ?job= still seed the focus',
    /p\.get\('invoice'\)/.test(PAGE) && /p\.get\('job'\)/.test(PAGE),
    'the Convert toast and the completed-job Invoice link both rely on these')
  check('?pay=1 still opens the record-payment form',
    /payIntent && focused\?\.length === 1/.test(PAGE),
    'the field "Get paid" tap must still land with the form open')
  check('opening an invoice writes the same URL a deep link uses',
    /pushState\(\{ eqInvoice[\s\S]{0,120}\?invoice=\$\{encodeURIComponent\(inv\.invoice_number\)\}/.test(PAGE),
    'the URL after a click must be the shareable link, or the detail is unaddressable')
  check('history is PUSHED, so Back closes the detail',
    /window\.addEventListener\('popstate'/.test(PAGE),
    'without a popstate listener the phone Back gesture leaves Invoices entirely')
}

// ── 5. Search and the filters are untouched ─────────────────────────────────
console.log('\nSearch and the status/deposit filters still drive the list:')
{
  check('the search index still narrows the chosen status',
    /entryMatches\(e, tokens\)/.test(PAGE) && /buildInvoiceSearchIndex/.test(PAGE),
    'invoice search is a shipped feature of this page; the split must not touch it')
  check('the deposit-due filter still uses depositState',
    /d\.status === 'draft' \|\| d\.status === 'sent'/.test(PAGE),
    'the deposit filter is canonical — never re-derive "waiting on a deposit"')
  check('the status filter still uses displayInvoiceStatus',
    /displayInvoiceStatus\(i, settings, today\) === filter/.test(PAGE),
    'filtering must use the same overlay the pill shows')
}

// ── 6. Every figure still comes from the canonical engines ──────────────────
console.log('\nNo new money maths — the row asks the same engines:')
{
  check('the row figure comes from invoiceBalance',
    /const bal = invoiceBalance\(inv, settings\)/.test(listBranch),
    'a hand-rolled total on the row is how the list and the detail start disagreeing')
  check('the deposit chip comes from depositState',
    /const dep = depositState\(inv, settings\)/.test(listBranch),
    'never re-derive "a deposit is outstanding"')
  check('the pill comes from displayInvoiceStatus',
    /const ds = displayInvoiceStatus\(inv, settings, today\)/.test(listBranch),
    'the derived states (Overdue, Viewed) exist only in that overlay')

  // …and the values those engines produce for each state the owner will meet.
  const S = { gst_percent: 5 }
  const base = { discount_type: null, discount_value: null, due_date: '2026-09-01', deposit_amount: null, deposit_requested_at: null }
  const today = '2026-08-10'
  const row = (inv: Record<string, unknown>) => {
    const i = { ...base, ...inv } as never
    const bal = invoiceBalance(i, S)
    const partPaid = bal.paid > 0.01 && bal.balance > 0.01
    const d = depositState(i, S)
    return {
      pill: INVOICE_STATUS_LABELS[displayInvoiceStatus(i, S, today)],
      figure: partPaid ? bal.balance : bal.total,
      sub: partPaid ? 'left' : bal.balance <= 0.01 && bal.total > 0 ? 'paid' : 'total',
      deposit: d.status === 'draft' || d.status === 'sent',
    }
  }

  // THE case the split exists for: on a part-paid invoice the number an owner is
  // chasing is the BALANCE. It used to render at 10px inside the status pill
  // while the 18px slot showed the total.
  const partial = row({ status: 'partial', amount: 4000, amount_paid: 2100 })
  eq('a part-paid row leads with the balance', partial.figure, 2100)
  eq('…labelled as what is left', partial.sub, 'left')
  eq('…and says Partially Paid', partial.pill, 'Partially Paid')

  const unpaid = row({ status: 'sent', amount: 4000, amount_paid: 0 })
  eq('an untouched invoice leads with the total', unpaid.figure, 4200)
  eq('…labelled total', unpaid.sub, 'total')

  const paid = row({ status: 'paid', amount: 4000, amount_paid: 4200 })
  eq('a settled invoice reads paid', paid.sub, 'paid')

  const dep = row({ status: 'sent', amount: 4000, amount_paid: 0, deposit_amount: 2100, deposit_requested_at: '2026-08-09T00:00:00Z' })
  check('a deposit-due row is flagged', dep.deposit,
    '"money was asked for up front and hasn\'t arrived" is a state the status vocabulary cannot express')
  check('…and a plain invoice is not', !unpaid.deposit, 'the chip must mean something')

  const cancelled = row({ status: 'cancelled', amount: 4000, amount_paid: 0 })
  eq('a cancelled invoice still says cancelled', cancelled.pill, 'Cancelled')
  const draft = row({ status: 'draft', amount: 4000, amount_paid: 0 })
  eq('a draft still says draft', draft.pill, 'Draft')
  const overdue = row({ status: 'sent', amount: 4000, amount_paid: 0, due_date: '2026-08-01' })
  eq('a past-due invoice still says overdue', overdue.pill, 'Overdue')
}

// ── 7. The pill can actually be told apart ──────────────────────────────────
console.log('\nThe status pill is a scan signal, not three shades of blue:')
{
  // The list now leans on this pill to answer "which invoice?", so the state that
  // differs by MONEY HAVING ARRIVED must not be a third blue beside sent/viewed.
  const hue = (s: string) => (s.match(/text-([a-z]+)-\d+/) || [])[1]
  const sent = hue(INVOICE_STATUS_COLORS.sent)
  const viewed = hue(INVOICE_STATUS_COLORS.viewed)
  const partial = hue(INVOICE_STATUS_COLORS.partial)
  check('partial is not the same family as sent/viewed',
    partial !== sent && partial !== viewed && !['blue', 'sky', 'cyan'].includes(partial || ''),
    `sent=${sent}, viewed=${viewed}, partial=${partial} — at 10px three adjacent blues are one colour, and the money-bearing one was the least visible`)
  check('paid and overdue stay unmistakable',
    hue(INVOICE_STATUS_COLORS.paid) === 'emerald' && hue(INVOICE_STATUS_COLORS.overdue) === 'red',
    'the two ends of the money axis carry the most meaning')
}

if (failures) {
  console.log(`\n❌ verify:invoice-list — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:invoice-list — the list says which, the detail says what you can do\n')
