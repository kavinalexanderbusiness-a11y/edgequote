// ── Verify: a deposit is a partial payment — never a second bill, never a double charge ─
//   npm run verify:deposit
//
// WHY THIS SCRIPT EXISTS
// Deposits are the highest-risk feature the payments lane has taken since the
// ledger shipped: every failure mode is money — charged twice, counted twice, or
// an invoice closed with half the job unpaid. The engines are deliberately thin
// (lib/payments/deposit derives everything from lib/payments/ledger, which reads
// the trigger-maintained invoices.amount_paid), so what needs pinning is the
// CONTRACT: the maths, the collection rule, the status transitions, and the
// structural facts that keep every charge path on the one engine.
//
// THE CANONICAL MODEL (do not relitigate — lib/payments/deposit.ts states it):
//   • invoice total    = invoiceTotals(amount).total        (GST-inclusive)
//   • amount paid      = invoices.amount_paid               (trigger rollup of payments)
//   • balance          = invoiceBalance().balance           (total − paid)
//   • status           = recompute_invoice_paid_for         (DB trigger; partial/paid/overpaid)
//   • deposit          = invoices.deposit_amount            (a REQUEST, not money)
//   • amount to charge = depositChargeAmount()              (outstanding deposit, else balance,
//                                                            always clamped to balance)
// A deposit payment is an ordinary `payments` row. Nothing about it is a new kind
// of money, which is precisely why none of the revenue/GST/report maths changes.
//
// Runs the REAL engines against hand-built rows plus structural checks over the
// charge routes and the webhook. No network, no DB — the trigger's status rule is
// transcribed below and asserted against the live formula's known shape.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  depositFromPercent, depositPercentOf, validateDeposit, depositState, depositChargeAmount,
  type DepositInvoice,
} from '../src/lib/payments/deposit'
import { invoiceBalance } from '../src/lib/payments/ledger'
import { ledgerRowType } from '../src/lib/payments/analytics'
import { computeCustomerHealth } from '../src/lib/customerHealth'
import { settingsToSeasons } from '../src/lib/seasons'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const round2 = (n: number) => Math.round(n * 100) / 100

/** An invoice as the engines see it. amount = NET (pre-GST) stored subtotal. */
function inv(p: {
  amount: number; paid?: number; deposit?: number | null; sentAt?: string | null
}): DepositInvoice {
  return {
    amount: p.amount,
    amount_paid: p.paid ?? 0,
    discount_type: null, discount_value: null,
    deposit_amount: p.deposit ?? null,
    deposit_requested_at: p.sentAt ?? null,
  }
}
const NO_GST = { gst_percent: 0 }
const GST5 = { gst_percent: 5 }

/**
 * The DB status rule, transcribed VERBATIM from recompute_invoice_paid_for
 * (fetched live via pg_get_functiondef — see the migration RUN-2026-07-26):
 *
 *   v_total := round(amount × (1 + gst/100), 2)
 *   v_paid  := Σ payments where kind='payment' and status='paid'
 *   status  := 'partial'  when v_paid + 0.01 <  v_total
 *              'paid'     when v_paid       <= v_total + 0.01
 *              'overpaid' otherwise            (v_paid > 0; draft/cancelled pass through)
 *
 * If the trigger formula ever changes, change THIS transcription with it — the
 * point is that the scenarios below walk the exact thresholds Postgres applies.
 */
function triggerStatus(netAmount: number, gstPercent: number, paidSum: number): 'unpaid' | 'partial' | 'paid' | 'overpaid' {
  const vTotal = round2(netAmount * (1 + gstPercent / 100))
  if (paidSum <= 0) return 'unpaid'
  if (paidSum + 0.01 < vTotal) return 'partial'
  if (paidSum <= vTotal + 0.01) return 'paid'
  return 'overpaid'
}

// ── 1. The product's own example, end to end ─────────────────────────────────
console.log('\nThe $4,000 / 50% example — request, pay, settle:')
{
  // $4,000 GST-free total, 50% requested.
  const half = depositFromPercent(4000, 50)
  eq('50% of $4,000 is $2,000', half, 2000)

  const requested = inv({ amount: 4000, deposit: half, sentAt: '2026-08-09T12:00:00Z' })
  const before = depositState(requested, NO_GST)
  eq('before payment: the deposit is outstanding', before.outstanding, 2000)
  eq('before payment: status is sent', before.status, 'sent')
  eq('the charge routes would collect the deposit', depositChargeAmount(requested, NO_GST).amount, 2000)
  eq('…and say so', depositChargeAmount(requested, NO_GST).isDeposit, true)

  // $2,000 lands (webhook records amount_total = the CHARGED cents — the ledger
  // sum and therefore amount_paid becomes exactly 2000).
  const paid = inv({ amount: 4000, paid: 2000, deposit: half, sentAt: '2026-08-09T12:00:00Z' })
  const b = invoiceBalance({ amount: 4000, amount_paid: 2000, discount_type: null, discount_value: null }, NO_GST)
  eq('total stays $4,000', b.total, 4000)
  eq('paid reads $2,000', b.paid, 2000)
  eq('balance reads $2,000 — the $2,000 is never counted twice', b.balance, 2000)
  eq('the DB trigger lands the invoice on partial', triggerStatus(4000, 0, 2000), 'partial')

  const after = depositState(paid, NO_GST)
  eq('the deposit reads paid', after.status, 'paid')
  eq('nothing more is asked for up front', after.outstanding, 0)
  eq('remaining after the deposit is the other half', after.remainingAfter, 2000)
  const settle = depositChargeAmount(paid, NO_GST)
  eq('the next charge is the remaining $2,000 — never $4,000 again', settle.amount, 2000)
  eq('…and it is no longer a deposit', settle.isDeposit, false)

  // The rest arrives.
  eq('after the final $2,000 the trigger lands on paid', triggerStatus(4000, 0, 4000), 'paid')
  eq('and the balance is $0', invoiceBalance({ amount: 4000, amount_paid: 4000, discount_type: null, discount_value: null }, NO_GST).balance, 0)
}

// ── 2. GST: the deposit is a share of what the customer actually pays ────────
console.log('\nA deposit is taken from the GST-inclusive total:')
{
  // $4,000 net + 5% GST = $4,200 payable. "Half now" must mean $2,100 — half of
  // the net would collect $2,000 now and leave $2,200 later, which is not half.
  const s = depositState(inv({ amount: 4000, deposit: depositFromPercent(4200, 50) }), GST5)
  eq('the payable total is $4,200', s.total, 4200)
  eq('50% of it is $2,100', s.requested, 2100)
  eq('the derived percent reads 50%', s.percent, 50)
  eq('after the deposit, $2,100 remains', s.remainingAfter, 2100)
  eq('the trigger agrees $2,100 of $4,200 is partial', triggerStatus(4000, 5, 2100), 'partial')
  eq('…and $4,200 is paid', triggerStatus(4000, 5, 4200), 'paid')
}

// ── 3. Rounding: cents resolve once, at the request ──────────────────────────
console.log('\nPercentages resolve to cents once, in the request:')
{
  eq('33% of $100 is $33.00', depositFromPercent(100, 33), 33)
  eq('a third-ish of an odd total rounds to a cent', depositFromPercent(1234.56, 33.3), 411.11) // 411.10848 → .11
  eq('50% of $99.99 is $50.00 (banker-free half-up)', depositFromPercent(99.99, 50), 50)
  eq('100% is the whole total', depositFromPercent(4200, 100), 4200)
  eq('the display percent is one decimal', depositPercentOf(4200, 1400), 33.3)
  eq('percent of nothing is null, not 0%', depositPercentOf(0, 100), null)

  // The invariant that matters: deposit + remainder always reconstructs the total
  // to the cent — no lost or invented penny at any percentage.
  let holes = 0
  for (let pct = 1; pct <= 99; pct++) {
    const total = 4200.37
    const dep = depositFromPercent(total, pct)
    const rest = round2(total - dep)
    if (round2(dep + rest) !== round2(total)) holes++
  }
  eq('deposit + remainder = total at every whole percent of an awkward total', holes, 0)
}

// ── 4. Validation: never request money that is not owed ──────────────────────
console.log('\nA deposit request can never exceed what is owed:')
{
  // The result is a discriminated union on `ok` — unwrap once so a shape change
  // is one edit here, not ten.
  const amountOf = (r: ReturnType<typeof validateDeposit>) => (r.ok ? r.amount : null)
  const rejects = (r: ReturnType<typeof validateDeposit>) => !r.ok

  check('more than 100% is rejected', rejects(validateDeposit({ kind: 'percent', value: 101 }, 4000)), 'percent > 100 must be an error')
  check('a fixed amount above the total is rejected', rejects(validateDeposit({ kind: 'amount', value: 4001 }, 4000)), 'amount > total must be an error')
  eq('exactly the total is allowed — "pay in full up front"', amountOf(validateDeposit({ kind: 'amount', value: 4000 }, 4000)), 4000)
  check('$0 is not a request', rejects(validateDeposit({ kind: 'amount', value: 0 }, 4000)), 'zero must be an error')
  check('a negative deposit is not a refund path', rejects(validateDeposit({ kind: 'amount', value: -50 }, 4000)), 'negative must be an error')

  // Existing partial payment: $1,500 of $4,000 already in. Only $2,500 is owed.
  check('asking beyond the remaining balance is rejected',
    rejects(validateDeposit({ kind: 'amount', value: 3000 }, 4000, 1500)),
    'a request above total − paid must be an error')
  eq('asking exactly the remaining balance is allowed', amountOf(validateDeposit({ kind: 'amount', value: 2500 }, 4000, 1500)), 2500)
  check('a fully paid invoice takes no deposit', rejects(validateDeposit({ kind: 'amount', value: 1 }, 4000, 4000)), 'paid in full must be an error')
}

// ── 5. The collection rule: one answer for every payment surface ─────────────
console.log('\ndepositChargeAmount is the one answer to "charge how much now":')
{
  // Non-deposit invoices are UNTOUCHED: null deposit_amount = the whole balance,
  // exactly what both charge routes did before deposits existed.
  const plain = depositChargeAmount(inv({ amount: 4000, paid: 1000 }), NO_GST)
  eq('no deposit → the ordinary balance', plain.amount, 3000)
  eq('…not labelled a deposit', plain.isDeposit, false)

  // Multiple payments toward one deposit: $1,000 asked, $400 arrived.
  const partway = depositChargeAmount(inv({ amount: 4000, deposit: 1000, paid: 400 }), NO_GST)
  eq('a part-paid deposit collects only what is left of it', partway.amount, 600)
  eq('…still labelled a deposit', partway.isDeposit, true)

  // Scenario: $1,000 deposit paid, then the $3,000 remainder.
  eq('deposit satisfied → the remainder', depositChargeAmount(inv({ amount: 4000, deposit: 1000, paid: 1000 }), NO_GST).amount, 3000)
  eq('everything paid → nothing chargeable', depositChargeAmount(inv({ amount: 4000, deposit: 1000, paid: 4000 }), NO_GST).amount, 0)

  // CHANGED INVOICE, the double-charge case: $2,000 deposit requested, then the
  // invoice edited down to $1,500 total. The charge is clamped to the real
  // balance — the stale request can never over-collect.
  const shrunk = depositChargeAmount(inv({ amount: 1500, deposit: 2000 }), NO_GST)
  eq('a deposit outliving an edited-down invoice charges only the balance', shrunk.amount, 1500)
  check('…and depositState surfaces the mismatch instead of hiding it',
    depositState(inv({ amount: 1500, deposit: 2000 }), NO_GST).exceedsTotal,
    'exceedsTotal must be true when the request is larger than the invoice now is')

  // Money that arrived by ANY method satisfies the deposit — an e-transfer counts.
  eq('an e-transfer covering the deposit reads as deposit paid',
    depositState(inv({ amount: 4000, deposit: 2000, paid: 2000 }), NO_GST).status, 'paid')

  // A failed payment writes no ledger row → amount_paid unchanged → nothing here
  // moves. (The webhook's payment_failed branch is checked structurally below.)
  eq('a failed payment changes nothing', depositChargeAmount(inv({ amount: 4000, deposit: 2000 }), NO_GST).amount, 2000)
}

// ── 6. Status transitions across the whole journey ───────────────────────────
console.log('\nThe trigger walks partial → paid and never closes early:')
{
  eq('nothing paid → unpaid', triggerStatus(4000, 0, 0), 'unpaid')
  eq('the deposit lands on partial, not paid', triggerStatus(4000, 0, 2000), 'partial')
  eq('a cent short is still partial', triggerStatus(4000, 0, 3999.98), 'partial')
  eq('within a cent of the total counts as paid (the trigger’s own tolerance)', triggerStatus(4000, 0, 3999.99), 'paid')
  eq('exact payment is paid', triggerStatus(4000, 0, 4000), 'paid')
  eq('a cent over is still paid (tolerance is symmetric)', triggerStatus(4000, 0, 4000.01), 'paid')
  eq('more than a cent over is overpaid', triggerStatus(4000, 0, 4100), 'overpaid')
  // A refund is a NEGATIVE payment row in the same sum: refunding the deposit
  // reopens the balance through the identical formula, no special case.
  eq('deposit paid then refunded → back to unpaid', triggerStatus(4000, 0, 2000 - 2000), 'unpaid')
  eq('deposit paid, half refunded → still partial', triggerStatus(4000, 0, 2000 - 1000), 'partial')
}

// ── 7. Revenue taxonomy: a deposit is cash, never counted twice ──────────────
console.log('\nThe ledger classifier keeps a deposit from double-counting:')
{
  // A deposit paid AGAINST an invoice is one ordinary payment row: cash, once.
  eq('an invoice deposit payment is a Payment', ledgerRowType({ kind: 'payment', provider: 'stripe', amount: 2000 }), 'Payment')
  // A PRE-invoice deposit (recordDeposit) is two legs — cash + liability. Only
  // the payment leg is cash; the credit leg must never read as more money.
  eq('the cash leg is a Payment', ledgerRowType({ kind: 'payment', provider: 'cash', amount: 500 }), 'Payment')
  eq('the credit leg is Credit issued — not cash', ledgerRowType({ kind: 'credit', provider: 'credit', amount: 500 }), 'Credit issued')
  // Settling the invoice later from that credit is NOT new cash — the dollar
  // arrived when the deposit was taken.
  eq('settlement from credit is not cash', ledgerRowType({ kind: 'payment', provider: 'credit', amount: 500 }), 'Settled from credit')
  eq('a refund is a Refund', ledgerRowType({ kind: 'payment', provider: 'refund', amount: -500 }), 'Refund')
}

// ── 8. Structural: every charge path on the ONE engine ───────────────────────
console.log('\nThe charge paths all ask the engine, and the webhook cannot double-record:')
{
  const checkout = read('src/app/api/payments/checkout/route.ts')
  const portal = read('src/app/api/portal/pay/route.ts')
  const autopay = read('src/lib/payments/autopay.ts')
  const webhook = read('src/app/api/stripe/webhook/route.ts')
  const engine = read('src/lib/payments/deposit.ts')

  check('the owner checkout route uses depositChargeAmount', /depositChargeAmount\(/.test(checkout),
    'src/app/api/payments/checkout/route.ts must derive its amount from lib/payments/deposit')
  check('the portal pay route uses depositChargeAmount', /depositChargeAmount\(/.test(portal),
    'src/app/api/portal/pay/route.ts must derive its amount from lib/payments/deposit')
  for (const [name, src] of [['checkout', checkout], ['portal pay', portal]] as const) {
    check(`the ${name} route keeps no inline balance arithmetic`,
      !/total\s*-\s*\(Number\(invoice\.amount_paid\)/.test(src),
      'an inline `total − amount_paid` is a second balance definition — use the engine')
  }
  check('neither charge route takes an amount from the client',
    !/body\.(amount|chargeCents|depositCents)/.test(checkout) && !/body\.(amount|chargeCents|depositCents)/.test(portal),
    'the amount must be derived server-side from the invoice — a client-named amount is a tampering vector')

  check('the deposit engine derives from invoiceBalance (one balance definition)',
    /invoiceBalance/.test(engine),
    'lib/payments/deposit.ts must read lib/payments/ledger.invoiceBalance, not restate totals')
  check('the deposit engine never stores a percentage',
    !/deposit_percent/.test(engine) && !/deposit_percent/.test(read('supabase/archive/run/RUN-2026-08-09-invoice-deposit-request.sql')),
    'the percent is derived from amount ÷ live total; storing it would drift from the canonical total')

  // AutoPay charges the BALANCE and — deliberately — not the deposit: its dedupe
  // key is one-charge-per-invoice, so a deposit-sized AutoPay charge would make
  // the remainder uncollectable by AutoPay forever. Recurring invoices are not
  // the deposit case; if that ever changes the key design must change WITH it.
  check('autopay derives its amount from invoiceBalance', /invoiceBalance\(/.test(autopay),
    'lib/payments/autopay.ts must charge the ledger balance')
  check('autopay keeps its one-charge-per-invoice dedupe', /autopay:\$\{invoiceId\}/.test(autopay),
    'the pre-charge dedupe on autopay:<invoiceId> is the durable no-double-charge guarantee')

  // Webhook idempotency: every money-in write dedupes on the UNIQUE
  // stripe_session_id (DB: payments_stripe_session_id_key). A duplicate delivery
  // — Stripe retries, at-least-once — must be a no-op, for deposits exactly as
  // for full payments.
  const upserts = webhook.match(/onConflict:\s*'stripe_session_id',\s*ignoreDuplicates:\s*true/g) || []
  check(`every webhook money write dedupes on stripe_session_id (found ${upserts.length}, need ≥3)`,
    upserts.length >= 3,
    'checkout, autopay and refund branches must all upsert with onConflict stripe_session_id + ignoreDuplicates')
  check('the webhook records the amount CHARGED, never the invoice total',
    /amount:\s*\(s\.amount_total\s*\?\?\s*0\)\s*\/\s*100/.test(webhook),
    'a deposit charge must land in the ledger as the charged amount_total — recording the invoice total would close the invoice on a deposit')
  check('the webhook never writes invoice status directly',
    !/from\('invoices'\)\.update\(\{[^}]*status/.test(webhook),
    'the recompute trigger owns status; the webhook only stamps payment_method')
  // A failed charge must not touch the ledger: the payment_failed branch notifies
  // and nothing else.
  // Split on the if-condition, not the bare event name — the file's header
  // comment lists every event type and would match first, swallowing the
  // checkout/autopay branches (which legitimately write payments) into "the
  // failed branch".
  const failedBranch = webhook.split("event.type === 'payment_intent.payment_failed'")[1]?.split('── Refund')[0] ?? ''
  check('the payment_failed branch writes no payment rows',
    failedBranch.length > 0 && !/from\('payments'\)/.test(failedBranch),
    'a failed payment must never create ledger rows — only a notification')
  // Client-request-fails path: nothing client-side writes paid-state at all.
  // ⚠️ RE-POINTED, NOT RELAXED (Session 110). The flag used to be spelled inline
  // as `?paid=1`; /api/portal/pay now asks lib/portal's one link builder for it
  // — `portalUrl(token, base, { paid: 1 })` — so that the host, path and token of
  // a customer-facing URL have exactly one spelling. The CONTRACT is untouched:
  // the success URL carries a display-only flag and writes nothing. So the
  // assertion follows the flag to its new home rather than being deleted, and
  // still fails if the flag stops being sent at all.
  const carriesPaidFlag = (s: string) =>
    /\?paid=1/.test(s) || /portalUrl\([^)]*\bpaid:\s*1/.test(s)
  check('the success URL is display-only (a paid flag), never a writer',
    carriesPaidFlag(checkout) && carriesPaidFlag(portal),
    'the webhook is the one writer of paid-state; the redirect only decorates the UI')
}

// ── 9. The migration is additive and guarded ─────────────────────────────────
console.log('\nThe schema change cannot corrupt existing invoices:')
{
  const mig = read('supabase/archive/run/RUN-2026-08-09-invoice-deposit-request.sql')
  // `not null` appears legitimately in the partial index's WHERE — the ban is on
  // a NOT NULL column constraint or a DEFAULT, either of which would rewrite what
  // every existing invoice means.
  check('columns are nullable adds — existing invoices read "no deposit"',
    /add column if not exists deposit_amount numeric(?!\s+(not null|default))/.test(mig) && !/deposit_amount numeric\s+(not null|default)/i.test(mig),
    'deposit_amount must be a nullable, default-less add')
  check('a $0-or-negative deposit is rejected by the DB, not just the UI',
    /deposit_amount is null or deposit_amount > 0/.test(mig),
    'the positive-amount check constraint must exist')
  check('no trigger, status or payments-table change rides along',
    !/create trigger/i.test(mig) && !/on public\.payments/i.test(mig),
    'the deposit migration must not touch the payment ledger or the status engine')
}

// ── 10. Downstream: who-owes surfaces survive a deposit payment ──────────────
// A deposit payment flips an invoice to 'partial'. Every downstream figure that
// answers "who still owes me" must keep counting it — and must count the LEDGER
// balance, not the raw ex-GST amount of a possibly-part-paid invoice.
console.log('\nCustomer health keeps a part-paid customer on the books:')
{
  const seasons = settingsToSeasons(null)
  const today = '2026-08-09'
  const cust = [{ id: 'c1', name: 'Dana', created_at: '2025-01-01T00:00:00Z' }]
  const health = (invoices: Parameters<typeof computeCustomerHealth>[4]) =>
    computeCustomerHealth(cust, [], {}, {}, invoices, seasons, today, GST5)[0]

  // No deposit, plain unpaid invoice: counted, at the GST-inclusive balance.
  const plain = health([{ customer_id: 'c1', status: 'unpaid', amount: 4000, amount_paid: 0 }])
  eq('an unpaid invoice counts once', plain.unpaidCount, 1)
  eq('…at the payable balance, not the ex-GST amount', plain.unpaidAmount, 4200)
  check('…and flags the customer', plain.flags.includes('unpaid'), 'the unpaid flag must be set')

  // THE deposit case: $2,100 of $4,200 paid → status 'partial'. This used to
  // vanish entirely (only 'unpaid'/'sent' were counted), so paying a deposit
  // read as healthier than paying nothing.
  const partial = health([{ customer_id: 'c1', status: 'partial', amount: 4000, amount_paid: 2100 }])
  eq('a part-paid (deposit-paid) invoice still counts', partial.unpaidCount, 1)
  eq('…for exactly the remaining balance', partial.unpaidAmount, 2100)
  check('…and still flags the customer', partial.flags.includes('unpaid'), 'partial must keep the unpaid flag')

  // Fully paid: gone. Refund reopening: back. The trigger writes the status;
  // health only has to believe the ledger's arithmetic.
  const paid = health([{ customer_id: 'c1', status: 'paid', amount: 4000, amount_paid: 4200 }])
  eq('a paid invoice drops out', paid.unpaidCount, 0)
  const reopened = health([{ customer_id: 'c1', status: 'partial', amount: 4000, amount_paid: 2100 - 2100 }])
  eq('a refunded deposit reopens the full exposure', reopened.unpaidAmount, 4200)

  // A stale status with no real balance must not invent debt: 'partial' with the
  // money actually all in counts nothing (balance ≤ 0 guard).
  const settled = health([{ customer_id: 'c1', status: 'partial', amount: 4000, amount_paid: 4200 }])
  eq('a settled-but-stale row counts nothing', settled.unpaidCount, 0)
}

// ── 11. Downstream structural: the AI context speaks ledger, not arithmetic ──
console.log('\nThe AI assist context derives money from the engines:')
{
  const assist = read('src/lib/ai/assist.ts')
  check('assist imports invoiceBalance', /import \{ invoiceBalance \} from '@\/lib\/payments\/ledger'/.test(assist),
    'src/lib/ai/assist.ts must read balances from the ledger engine')
  check('assist imports depositChargeAmount', /depositChargeAmount/.test(assist),
    'the ask-now figure must come from the deposit engine')
  check('assist selects the deposit columns', /deposit_amount, deposit_requested_at/.test(assist),
    'customerContext cannot state a deposit ask it never loaded')
  check('no inline amount-minus-paid arithmetic survives',
    !/Number\(i\.amount\)\s*-\s*Number\(i\.amount_paid/.test(assist),
    '`amount − amount_paid` mixes the ex-GST net with the GST-inclusive rollup — use invoiceBalance')
  check('the deposit_request template has a stated intent',
    /deposit_request:\s*'ask for the deposit/.test(assist),
    'without a TEMPLATE_INTENT entry the deposit ask falls through to `custom` — a blind write on a money message')
  check('…which forbids restating the number',
    /deposit_request:[^']*'[^']*never restate or recompute/.test(assist),
    'the {{amount}} token carries the deposit figure; the model must not name its own')
}

if (failures) {
  console.log(`\n❌ verify:deposit — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:deposit — a deposit is a partial payment; nothing counts twice, nothing closes early\n')
