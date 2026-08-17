// ── Verify: an open invoice answers five questions, in order ─────────────────
//   npm run verify:invoice-detail
//
// WHY THIS SCRIPT EXISTS
// The invoice list/detail split fixed the LIST. The detail it opened onto was
// still a control panel: measured in real Chrome at 390px, across twelve states,
// it carried 6–14 things you could act with, was 411–787px tall, and had ZERO
// accent-weighted primary action on draft / paid / overpaid / cancelled while
// having TWO on any invoice with a deposit. Nothing was disclosed. And the single
// largest figure on the screen was the invoice TOTAL in all twelve states —
// including every state where the owner is chasing a balance, waiting on a
// deposit, or holding an overpayment.
//
// So an owner opening an invoice could not answer, in a few seconds:
//   who is this for · how much was invoiced · how much is still owed ·
//   what state is it in · what is the one thing I should do next
//
// This guard pins the answers, because the failure mode is gradual: one more
// "while I'm here" button in the action row, one more figure at the top, one more
// always-open panel, until the ranking is gone and it is a list again.
//
// It is deliberately BEHAVIOURAL where it can be. The financial hierarchy and the
// action ladder are pure functions (lib/payments/invoiceActions), so this drives
// them through the REAL engines for every state an owner will meet, rather than
// asserting on markup that any refactor would break. The structural checks that
// remain are about SHAPE — what is disclosed, what is controlled, what must not
// be restated — which is the part markup is actually evidence of.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { invoiceBalance, displayInvoiceStatus } from '../src/lib/payments/ledger'
import { depositState, depositChargeAmount } from '../src/lib/payments/deposit'
import {
  invoiceHeadline, invoiceNextActions, invoiceDoors, invoiceMoney, financiallyLocked,
} from '../src/lib/payments/invoiceActions'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const DETAIL = read('src/components/payments/InvoiceDetail.tsx')
const CONTROLS = read('src/components/payments/InvoicePaymentControls.tsx')
const PANEL = read('src/components/payments/DepositRequestPanel.tsx')
const ACTIONS = read('src/lib/payments/invoiceActions.ts')
const PAGE = read('src/app/dashboard/invoices/page.tsx')

// ── The states an owner will actually meet ──────────────────────────────────
// $4,000 net + 5% GST = $4,200 GST-inclusive, and 50% of that is $2,100 — the
// shape every deposit example in this codebase uses.
const S = { gst_percent: 5 }
const TODAY = '2026-08-10'
const BASE = {
  amount: 4000, amount_paid: 0, discount_type: null, discount_value: null,
  issued_date: '2026-07-28', due_date: '2026-09-01',
  deposit_amount: null, deposit_requested_at: null,
  customer_id: 'c1', job_id: 'j1', status: 'sent', viewed_at: null,
}
const inv = (over: Record<string, unknown> = {}) => ({ ...BASE, ...over }) as never

const STATES = {
  draft: inv({ status: 'draft', issued_date: null }),
  unpaid: inv({ status: 'unpaid' }),
  sent: inv({}),
  'deposit-draft': inv({ deposit_amount: 2100 }),
  'deposit-sent': inv({ deposit_amount: 2100, deposit_requested_at: '2026-08-01T09:00:00Z' }),
  'deposit-paid': inv({ status: 'partial', amount_paid: 2100, deposit_amount: 2100, deposit_requested_at: '2026-08-01T09:00:00Z' }),
  partial: inv({ status: 'partial', amount_paid: 1500 }),
  paid: inv({ status: 'paid', amount_paid: 4200 }),
  overdue: inv({ due_date: '2026-07-20' }),
  cancelled: inv({ status: 'cancelled' }),
  overpaid: inv({ status: 'overpaid', amount_paid: 4500 }),
  unpriced: inv({ status: 'draft', amount: 0 }),
}
const CTX = { paymentsEnabled: true, hasSavedCard: true, hasPayments: true }

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE FINANCIAL HEADLINE — one figure, and it is true NOW
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nThe biggest number on the screen is the one that matters now:')
{
  // What each state's headline must BE, expressed as the engine call that
  // produces it. Writing the expectation as a call rather than a literal is the
  // point: if the engines change, this guard follows them instead of pinning a
  // number that has quietly become wrong.
  const cases: [keyof typeof STATES, string, string, (i: never) => number][] = [
    ['draft', 'draft-total', 'Draft total', i => invoiceBalance(i, S).total],
    ['unpaid', 'balance', 'Balance due', i => invoiceBalance(i, S).balance],
    ['sent', 'balance', 'Balance due', i => invoiceBalance(i, S).balance],
    ['deposit-draft', 'deposit-due', 'Deposit due', i => depositChargeAmount(i, S).amount],
    ['deposit-sent', 'deposit-due', 'Deposit due', i => depositChargeAmount(i, S).amount],
    ['deposit-paid', 'balance', 'Balance remaining', i => invoiceBalance(i, S).balance],
    ['partial', 'balance', 'Balance remaining', i => invoiceBalance(i, S).balance],
    ['paid', 'paid', 'Paid in full', i => invoiceBalance(i, S).total],
    ['overdue', 'overdue', 'Overdue', i => invoiceBalance(i, S).balance],
    ['cancelled', 'cancelled', 'Cancelled — not owed', i => invoiceBalance(i, S).total],
    ['overpaid', 'overpaid', 'Overpaid', i => invoiceBalance(i, S).overpaid],
    ['unpriced', 'unpriced', 'No price yet', () => 0],
  ]
  for (const [state, kind, label, expected] of cases) {
    const i = STATES[state]
    const h = invoiceHeadline(i, S, TODAY)
    eq(`${state} → “${label}”`, { kind: h.kind, label: h.label }, { kind, label })
    eq(`…and the figure is the engine's`, h.amount, expected(i))
  }
}

console.log('\n…and it is NOT the invoice total whenever something else is owed:')
{
  // The exact defect that was measured: on these four states the largest figure
  // used to be `invoiceTotals().total` — a historical fact — while the number the
  // owner was acting on was rendered at 10–14px somewhere below it.
  for (const state of ['partial', 'deposit-sent', 'deposit-draft', 'overpaid'] as const) {
    const i = STATES[state]
    const h = invoiceHeadline(i, S, TODAY)
    const total = invoiceBalance(i, S).total
    check(`${state} does not lead with the $${total} total`, Math.abs(h.amount - total) > 0.01,
      `the headline is ${h.amount}, which IS the invoice total — that is the regression this guard exists for`)
  }
  eq('partial leads with the balance', invoiceHeadline(STATES.partial, S, TODAY).amount, 2700)
  eq('a deposit invoice leads with the deposit still owed', invoiceHeadline(STATES['deposit-sent'], S, TODAY).amount, 2100)
  eq('an overpaid invoice leads with the overpayment', invoiceHeadline(STATES.overpaid, S, TODAY).amount, 300)
}

console.log('\nEvery figure in the headline is an engine output — nothing is re-derived:')
{
  for (const [state, i] of Object.entries(STATES)) {
    const m = invoiceMoney(i as never, S, TODAY)
    const legal = [m.total, m.paid, m.balance, m.overpaid, m.due.amount, m.deposit.remainingAfter, 0]
      .map(n => Math.round(n * 100) / 100)
    const h = invoiceHeadline(i as never, S, TODAY)
    const emitted = [h.amount, ...h.facts.map(f => f.amount)].map(n => Math.round(n * 100) / 100)
    const stray = emitted.filter(n => !legal.some(l => Math.abs(l - n) < 0.005))
    check(`${state}: ${emitted.length} figure${emitted.length === 1 ? '' : 's'}, all canonical`, stray.length === 0,
      `${JSON.stringify(stray)} matches no engine output — a figure computed here is a second opinion about money`)
  }
  // "Balance due $4,200 / Invoiced $4,200" teaches nothing and trains the owner
  // to stop reading the labels — which is exactly how a total gets mistaken for a
  // balance later.
  //
  // ⚠️ Scoped to the INVOICED fact on purpose. A 50% deposit makes "Remaining
  // after" numerically equal to the deposit due, and "Received" equal to the
  // balance — those are different questions that happen to share an answer, and
  // suppressing them would hide a fact rather than a repetition. The rule is "do
  // not state the same QUANTITY twice", not "do not print the same number twice".
  for (const [state, i] of Object.entries(STATES)) {
    const h = invoiceHeadline(i as never, S, TODAY)
    const dupes = h.facts.filter(f => f.label === 'Invoiced' && Math.abs(f.amount - h.amount) < 0.005)
    check(`${state}: the total is not restated as the headline`, dupes.length === 0,
      `${JSON.stringify(dupes)} is the headline figure under a second label`)
  }
  // …and on a fixture where every figure differs, all of them are distinct — so
  // the check above cannot be satisfied by a headline that emits no facts.
  {
    const asym = inv({ deposit_amount: 1200, deposit_requested_at: '2026-08-01T09:00:00Z', amount_paid: 500, status: 'partial' })
    const h = invoiceHeadline(asym, S, TODAY)
    eq('a 1,200-of-4,200 deposit with 500 received states four distinct figures',
      [h.label, h.amount, ...h.facts.map(f => `${f.label} ${f.amount}`)],
      ['Deposit due', 700, 'Invoiced 4200', 'Received 500', 'Remaining after 3000'])
  }
  // …and the facts that DO belong are present, named unambiguously.
  eq('a part-paid invoice states what was invoiced and what was received',
    invoiceHeadline(STATES.partial, S, TODAY).facts,
    [{ label: 'Invoiced', amount: 4200 }, { label: 'Received', amount: 1500 }])
  eq('a deposit invoice states the invoice, and what is left after the deposit',
    invoiceHeadline(STATES['deposit-sent'], S, TODAY).facts,
    [{ label: 'Invoiced', amount: 4200 }, { label: 'Remaining after', amount: 2100 }])
  check('the four money words are never used interchangeably',
    new Set(['Invoiced', 'Received', 'Remaining after']).size === 3
    && !/label: 'Revenue'|label: 'Collected'/.test(ACTIONS),
    'invoiced / received / balance / deposit / revenue are five different questions')
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. ONE PRIMARY ACTION, DECIDED BY STATE
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nEach state has exactly one most-likely next action:')
{
  const ladder: [keyof typeof STATES, string, string | null][] = [
    // draft/unpaid: nobody can pay an invoice they have not seen.
    ['draft', 'send', 'record'],
    ['unpaid', 'send', 'record'],
    // sent and owed: the job is to collect. Card is the alternate door.
    ['sent', 'record', 'card-link'],
    // a deposit asked for and never sent outranks everything — the money cannot
    // arrive until the customer is told.
    ['deposit-draft', 'send-deposit', 'record'],
    ['deposit-sent', 'record', 'card-link'],
    ['deposit-paid', 'record', 'card-link'],
    ['partial', 'record', 'card-link'],
    // settled: the receipt is the only artefact left.
    ['paid', 'receipt', null],
    // late: they already have it, so the move is a nudge.
    ['overdue', 'remind', 'record'],
    // withdrawn: no money action at all. Reactivate lives on the status pill.
    ['cancelled', 'none', null],
    // the books are wrong until this is answered — and it is a question with
    // three answers, so it is a panel, not a button.
    ['overpaid', 'resolve-overpayment', null],
    // it has no price; nothing else can happen.
    ['unpriced', 'price', null],
  ]
  for (const [state, primary, secondary] of ladder) {
    const n = invoiceNextActions(STATES[state], S, TODAY, CTX)
    eq(`${state} → ${primary}${secondary ? ` (then ${secondary})` : ''}`,
      { primary: n.primary.kind, secondary: n.secondary?.kind ?? null }, { primary, secondary })
  }
  // The labels an owner reads, pinned for the states where the wording IS the
  // product decision (a deposit ask must not be called "send invoice").
  eq('the draft primary says what it does', invoiceNextActions(STATES.draft, S, TODAY, CTX).primary.label, 'Send invoice')
  eq('the deposit ask names the deposit', invoiceNextActions(STATES['deposit-draft'], S, TODAY, CTX).primary.label, 'Send deposit request')
  eq('an overdue invoice offers a nudge', invoiceNextActions(STATES.overdue, S, TODAY, CTX).primary.label, 'Send reminder')
  eq('the card door stays deposit-aware',
    invoiceNextActions(STATES['deposit-sent'], S, TODAY, CTX).secondary?.label, 'Card link — deposit')
  eq('…and says plain card when no deposit is owed',
    invoiceNextActions(STATES.sent, S, TODAY, CTX).secondary?.label, 'Card payment link')

  check('the primary and secondary are never the same action',
    Object.keys(STATES).every(k => {
      const n = invoiceNextActions(STATES[k as keyof typeof STATES], S, TODAY, CTX)
      return !n.secondary || n.secondary.kind !== n.primary.kind
    }), 'two buttons doing the same thing is the density this pass removed')

  // Degraded contexts must still produce a sensible single primary, not a blank
  // action row: these are real businesses (no Stripe, no card on file, no email).
  eq('with Stripe off, a sent invoice falls back to record + send-again',
    (() => { const n = invoiceNextActions(STATES.sent, S, TODAY, { ...CTX, paymentsEnabled: false }); return [n.primary.kind, n.secondary?.kind] })(),
    ['record', 'send'])
  eq('with no customer, a draft is recorded against rather than sent',
    (() => { const n = invoiceNextActions(inv({ status: 'draft', customer_id: null }), S, TODAY, CTX); return [n.primary.kind, n.secondary?.kind ?? null] })(),
    ['record', null])
  eq('a settled invoice with no ledger rows offers no phantom receipt',
    invoiceNextActions(STATES.paid, S, TODAY, { ...CTX, hasPayments: false }).primary.kind, 'none')
}

console.log('\nThe action row renders that ranking, and nothing else:')
{
  check('one primary slot, and it is the only accent button',
    /variant=\{kind === 'primary' \? 'primary' : 'secondary'\}/.test(DETAIL),
    'a second accent button is a second primary, whatever the markup intended')
  check('the primary is full-width on a phone',
    /kind === 'primary' \? 'w-full sm:w-auto'/.test(DETAIL),
    'the one thing to do next should be the easiest thing to hit with a thumb')
  check('“no primary” renders no button rather than a dead one',
    /primary\.kind !== 'none' && primary\.kind !== 'resolve-overpayment'/.test(DETAIL),
    'a button that cannot do anything is worse than an empty row')
  check('every other action is reachable by name in one menu',
    /ariaLabel="More actions"/.test(DETAIL) && /menuItems/.test(DETAIL),
    'capability must move behind a menu, never out of the product')
  check('an action shown as a button is not repeated in the menu',
    /const shown = new Set<InvoiceActionKind>/.test(DETAIL) && (DETAIL.match(/!shown\.has\(/g) || []).length >= 5,
    'the same door twice is what made the old row unreadable')
  check('one map decides what each action DOES',
    /const run: Record<InvoiceActionKind, \(\) => void>/.test(DETAIL),
    'an action must behave identically as a button and as a menu item')
}

console.log('\nNothing was removed from the product:')
{
  // Every capability the dense version had, still reachable.
  for (const [what, needle] of [
    ['download the PDF', "key: 'pdf'"],
    ['a Stripe payment link', "key: 'card-link'"],
    ['charge the saved card', "key: 'charge'"],
    ['record a payment', "key: 'record'"],
    ['download a receipt', "key: 'receipt'"],
    ['request a deposit', "key: 'ask-deposit'"],
    ['edit or remove a deposit request', "key: 'edit-deposit'"],
    ['send / resend', "key: 'send'"],
    ['send the deposit ask', "key: 'send-deposit'"],
    ['edit the invoice', "key: 'edit'"],
    ['delete a draft', "key: 'delete'"],
  ] as const) {
    check(`…${what}`, DETAIL.includes(needle), `${needle} disappeared — simplification must not cost capability`)
  }
  // The lifecycle control is unchanged: still the status pill, still refusing to
  // let a money state be set by hand.
  for (const [what, needle] of [
    ['approve a draft', "key: 'approve'"],
    ['mark sent', "key: 'mark-sent'"],
    ['mark not sent', "key: 'mark-not-sent'"],
    ['cancel', "key: 'cancel'"],
    ['reactivate', "key: 'reactivate'"],
  ] as const) {
    check(`…${what}, still on the status pill`, DETAIL.includes(needle), 'the pill is THE lifecycle control')
  }
  check('money states are still not settable by hand',
    /statusClickable = inv\.status === 'draft' \|\| inv\.status === 'unpaid' \|\| inv\.status === 'sent' \|\| inv\.status === 'cancelled'/.test(DETAIL),
    'partial/paid/overpaid are derived by the ledger trigger — a menu must never write them')
  check('the credit door still names its amount',
    /Apply \{formatCurrency\(applyable\)\} credit/.test(CONTROLS),
    'credit that can settle this invoice is information, not clutter')
  check('refunds, reverts and per-row receipts all survive',
    /recordRefund/.test(CONTROLS) && /removePayment/.test(CONTROLS) && /downloadRowReceipt/.test(CONTROLS), '')
  check('the overpayment resolver still offers all three answers',
    /overpaymentToCredit/.test(CONTROLS) && /Record refund/.test(CONTROLS) && /raiseTotal/.test(CONTROLS), '')
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. WHAT IS DISCLOSED, AND WHAT MUST NOT BE RESTATED
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nFirst paint carries who / how much / what next — and nothing else:')
{
  check('the deposit form is not rendered until the owner opens it',
    /\{depositForm && \([\s\S]{0,120}<DepositRequestPanel/.test(DETAIL),
    'the deposit panel used to render on EVERY invoice with a balance, in businesses that never take deposits')
  check('the deposit panel is a form, not a second state display',
    !/StatusChip/.test(PANEL) && /mode: 'new' \| 'edit'/.test(PANEL),
    'the headline states requested/received/still-due once; a panel restating them is a second source')
  check('…and it still refuses a cancelled invoice at its own door',
    /invoice\.status === 'cancelled'\) return null/.test(PANEL), '')
  check('the line-item breakdown is disclosed, not stacked above the money',
    /title="What's on this invoice"/.test(DETAIL) && /<Collapsible/.test(DETAIL),
    'the breakdown sat at 12px above the total and above every action, on every invoice')
  // The summary must name the RECEIVED figure, and it must be `paid` — the
  // ledger's trigger-maintained number, not something recomputed for the label.
  // This used to be pinned as `received\``, i.e. "received is the last thing in
  // the template". That was incidental: the tip lane appends a second clause
  // (`… · $75.00 tip`) and the disclosure is no less honest for it. Pinning the
  // interpolation instead is stricter about the part that matters.
  check('payment history is disclosed and says what it holds',
    /title="Payment history"/.test(CONTROLS) && /\$\{formatCurrency\(paid\)\} received/.test(CONTROLS),
    'a summary the owner can read without opening is what makes a disclosure honest')
  check('…and stays closed even when settled',
    !/title="Payment history"[\s\S]{0,300}defaultOpen/.test(CONTROLS),
    'the receipt from a paid invoice is the primary action — opening a six-button ledger to reach the same PDF is not simpler')
  check('the payment controls no longer restate paid / balance',
    !/text-ink-muted">Paid <span/.test(CONTROLS),
    'two places stating the balance is two figures to keep in step; the headline owns it')
  check('the record-payment form is controlled by the action that opens it',
    /open: boolean/.test(CONTROLS) && /onOpenChange: \(open: boolean\) => void/.test(CONTROLS)
    && /open=\{recordOpen\}/.test(DETAIL),
    'a form three panels below its button reads as a button that did nothing')
  check('?pay=1 still lands with the form open',
    /useState\(payIntent\)/.test(DETAIL) && /payIntent && focused\?\.length === 1/.test(PAGE),
    'the field "Get paid" tap is a shipped deep link')
}

console.log('\nThe detail is presentation; the page still owns every write:')
{
  for (const [what, needle] of [
    ['status changes', 'async function setInvoiceStatus'],
    ['approving a draft', 'async function approveDraft'],
    ['cancelling (with undo)', 'async function cancelWithUndo'],
    ['sending', 'async function sendInvoice'],
    ['the card-charge confirm', 'async function confirmChargeSavedCard'],
    ['the receipt download', 'async function downloadLatestReceipt'],
  ] as const) {
    check(`…${what}`, PAGE.includes(needle), 'a detail card that writes is a second writer')
  }
  check('the detail imports no supabase client',
    !/supabase\/client/.test(DETAIL),
    'presentation that can write is presentation that can disagree with the page')
  check('the cancel undo checks whether its write landed',
    /reactivateInvoice\(supabase, inv\.id\)[\s\S]{0,140}r\.error/.test(PAGE),
    'a failed reactivate used to dismiss the toast and leave the invoice cancelled, silently')
  check('the settled-invoice lock is one shared rule',
    /financiallyLocked/.test(ACTIONS) && /financiallyLocked/.test(DETAIL) && /financiallyLocked/.test(PAGE)
    && financiallyLocked(STATES.paid, S) === true && financiallyLocked(STATES.partial, S) === false
    && financiallyLocked(STATES.unpriced, S) === false,
    'a $0 draft is not "settled", and a part-paid invoice is not locked')
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. THE STATES THE LADDER MUST NEVER GET WRONG
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nThe money rules the hierarchy must not soften:')
{
  // Cancelled keeps its whole balance. Every state-driven decision has to know
  // that, or the calm new action row is a calm new way to collect on a
  // withdrawn bill. (verify:invoice-actions drives the doors; this pins that the
  // HEADLINE says it too, because the figure is what the owner reads first.)
  const c = invoiceHeadline(STATES.cancelled, S, TODAY)
  check('a cancelled invoice says its money is not owed',
    c.kind === 'cancelled' && /not owed/i.test(c.label) && invoiceBalance(STATES.cancelled, S).balance === 4200,
    'the balance is real; the claim on it is not')
  eq('…and offers no next action', invoiceNextActions(STATES.cancelled, S, TODAY, CTX).primary.kind, 'none')

  // Overdue is derived, not stored — the ladder has to read the overlay.
  eq('overdue is read from the display overlay, not the stored status',
    displayInvoiceStatus(STATES.overdue, S, TODAY), 'overdue')
  eq('…and an invoice due tomorrow is not overdue',
    invoiceNextActions(inv({ due_date: '2026-08-11' }), S, TODAY, CTX).primary.kind, 'record')

  // The deposit engine stays the only authority on "what do I collect now".
  eq('the collection figure is depositChargeAmount, on both doors',
    invoiceMoney(STATES['deposit-sent'], S, TODAY).due,
    depositChargeAmount(STATES['deposit-sent'], S))
  eq('a deposit already covered stops being what is due',
    depositChargeAmount(STATES['deposit-paid'], S).isDeposit, false)
  // An invoice edited DOWN below its deposit ask must keep saying so.
  const shrunk = inv({ amount: 1000, deposit_amount: 2100, deposit_requested_at: '2026-08-01T09:00:00Z' })
  check('an over-large deposit request is still surfaced, never clamped silently',
    depositState(shrunk, S).exceedsTotal === true && /exceedsTotal/.test(DETAIL),
    'the customer was told a figure the invoice no longer supports — that has to be visible')
  check('…and remainingAfter never goes negative',
    depositState(shrunk, S).remainingAfter >= 0, '')

  // No local money maths anywhere in the new presentation layer.
  const bodies = [DETAIL, ACTIONS].join('\n')
  check('no surface subtracts amount_paid by hand',
    !/amount_paid\s*\)?\s*[-−]\s*|[-−]\s*Number\(inv\.amount_paid/.test(bodies),
    'ex-GST net minus a GST-inclusive rollup is a bug this codebase has already shipped once')
  check('the doors are the only collectability test',
    (ACTIONS.match(/!cancelled && balance > 0/g) || []).length === 1,
    'the rule exists once, on purpose')
}

if (failures) {
  console.log(`\n❌ verify:invoice-detail — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:invoice-detail — who, how much, how much is left, what state, what next\n')
