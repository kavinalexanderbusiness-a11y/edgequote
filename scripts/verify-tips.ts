// ── Verify: a tip is money BESIDE the invoice, never money IN it ─────────────
//   npm run verify:tips
//
// WHY THIS SCRIPT EXISTS
// A gratuity rides inside the SAME Stripe charge as an invoice payment. That one
// sentence is the whole risk: every downstream figure in this app derives from
// the `payments` ledger, so a tip that lands in the wrong column does not produce
// a cosmetic bug — it closes an invoice that was underpaid, or reopens one that
// was settled and starts texting the customer for money they already sent.
//
// THE CANONICAL MODEL (lib/payments/tips.ts states it; do not relitigate):
//   invoice total        = invoiceTotals(amount).total     ← never sees a tip
//   applied to invoice   = payments.amount, kind='payment' ← the ONLY thing summed
//   tip                  = payments.amount, kind='tip'     ← a separate row
//   gross Stripe charge  = applied + tip                   ← ONE charge
//   invoice balance      = total − amount_paid             ← unchanged by a tip
//
// The separation is a MECHANISM, not a convention:
//   • recompute_invoice_paid_for sums `kind = 'payment'` only  → §2, transcribed
//   • isCashRow requires kind === 'payment'                    → §5
//   • capture_integration_event requires kind='payment'        → §9
//   • paymentForIntent filters kind='payment' AND amount > 0   → §9
// §2/§5/§9 transcribe those filters so a future edit that drops one fails HERE,
// on a laptop, instead of on an owner's books.
//
// Pure + structural. No network, no DB: the engines run against hand-built rows,
// and the routes/webhook/baseline are asserted as source text. Same discipline as
// verify-deposit / verify-invoice-totals, runnable in CI beside them.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  TIP_MAX_CENTS, TIP_MAX_PRESETS, TIP_DEFAULT_PRESETS, TIPS_OFF,
  tipConfig, tipPresetsFor, resolveTipCents, splitGrossCents, apportionRefund,
  isTipRow, tipAmountOf, summarizeTips, tipSessionKey, tipRefundKey,
  parseTipInputToCents, tipCheckoutBreakdown,
} from '../src/lib/payments/tips'
import { invoiceBalance, isCashRow } from '../src/lib/payments/ledger'
import { invoiceTotals } from '../src/lib/invoiceTotals'
import { ledgerRowType, summarizeTransactions, cashAmountOf } from '../src/lib/payments/analytics'
import { depositChargeAmount } from '../src/lib/payments/deposit'
import { baselineFile, baselineSql, functionSql } from './lib/schema-source'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)
const deep = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
const H = (t: string) => console.log(`\n═══ ${t} ═══`)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n')
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Source with its COMMENTS removed.
 *
 * Needed by the checks that assert an ABSENCE — "no guilt copy", "not
 * type=number", "reads no crew membership". Every one of those failed on its
 * first run against the very comment explaining why the thing is forbidden, and
 * a guard that fires on its own rationale trains people to delete the rationale.
 *
 * Line comments are stripped BEFORE block comments (the other order lets a `//`
 * inside a block comment terminate it early), and a `//` preceded by `:` is left
 * alone so a URL in a string cannot truncate the rest of its line — which on an
 * absence check would hide exactly what we are looking for. `read` has already
 * normalised CRLF, so `.` cannot stop short at a stray \r.
 */
const stripComments = (src: string) =>
  src.replace(/(?<!:)\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
const readCode = (p: string) => stripComments(read(p))

/** One `create table if not exists public."<name>" ( … );` block from the baseline. */
function tableSql(name: string): string {
  const m = baselineSql().match(
    new RegExp(`create table if not exists public\\."${name}" \\(([\\s\\S]*?)\\n\\);`, 'i'),
  )
  return m ? m[1] : ''
}

const NO_GST = { gst_percent: 0 }
const GST5 = { gst_percent: 5 }
const ON = { tips_enabled: true, tip_presets: [10, 15, 20], tip_custom_enabled: true }
const CFG = tipConfig(ON)

/** A ledger row as the engines see it. */
const row = (p: { amount: number; kind?: string; provider?: string; status?: string }) => ({
  kind: p.kind ?? 'payment', provider: p.provider ?? 'stripe', status: p.status ?? 'paid', amount: p.amount,
})

// ═══════════════════════════════════════════════════════════════════════════
H('1. THE HEADLINE CASES — $500 invoice, every tip the customer can choose')
// The exact table from the specification. `charge` is what depositChargeAmount
// derives for a $500 invoice with nothing paid and no deposit: $500.
{
  const invoice = {
    amount: 500, amount_paid: 0, discount_type: null, discount_value: null,
    deposit_amount: null, deposit_requested_at: null,
  }
  const charge = depositChargeAmount(invoice, NO_GST)
  eq('the charge the engine derives is the full balance', charge.amount, 500)
  eq('  …and it is not a deposit, so it may carry a tip', charge.isDeposit, false)
  const chargeCents = Math.round(charge.amount * 100)

  const presets = tipPresetsFor(chargeCents, [10, 15, 20])
  deep('presets of a $500 charge are 10% $50 / 15% $75 / 20% $100', presets,
    [{ percent: 10, cents: 5000 }, { percent: 15, cents: 7500 }, { percent: 20, cents: 10000 }])

  const cases: [string, number, number][] = [
    // label,                       tipCents, expected TOTAL cents
    ['$500 + no tip      = $500.00', 0, 50000],
    ['$500 + 10%   ($50) = $550.00', 5000, 55000],
    ['$500 + 15%   ($75) = $575.00', 7500, 57500],
    ['$500 + 20%  ($100) = $600.00', 10000, 60000],
    ['$500 + custom $25  = $525.00', 2500, 52500],
  ]
  for (const [label, tipCents, expectedTotal] of cases) {
    const resolved = resolveTipCents(tipCents, { chargeCents, config: CFG, tippable: true })
    const b = tipCheckoutBreakdown(chargeCents, resolved.cents)
    check(label, b.totalCents === expectedTotal && b.invoiceCents === chargeCents && b.tipCents === tipCents,
      `got invoice ${b.invoiceCents}, tip ${b.tipCents}, total ${b.totalCents}`)
  }

  // ── The invariant those five cases exist to protect ──────────────────────
  // The invoice half is BYTE-IDENTICAL across all of them. If a tip ever
  // reached the invoice figure, exactly one of these would move.
  const invoiceHalves = cases.map(([, tip]) =>
    tipCheckoutBreakdown(chargeCents, tip).invoiceCents)
  check('the invoice half is identical at every tip level',
    new Set(invoiceHalves).size === 1 && invoiceHalves[0] === 50000,
    `invoice halves diverged: ${JSON.stringify(invoiceHalves)}`)
}

// ═══════════════════════════════════════════════════════════════════════════
H('2. THE INVOICE IS UNTOUCHED — total, amount_paid, balance, status')
{
  // The DB trigger's rule, transcribed VERBATIM from recompute_invoice_paid_for
  // in the generated baseline (which is produced FROM the live catalogue). This
  // is the load-bearing filter: it is why a kind='tip' row cannot move a single
  // invoice figure, and no application code can restore that guarantee if it
  // is ever dropped from the function.
  const fn = functionSql('recompute_invoice_paid_for')
  check('recompute_invoice_paid_for exists in the baseline', fn.length > 0,
    'the trigger that owns amount_paid/status was not found — the whole model rests on it')
  check("  …and it sums ONLY kind = 'payment'",
    /sum\(p\.amount\)[\s\S]*from public\.payments p[\s\S]*p\.kind\s*=\s*'payment'/.test(fn),
    "the tip's separation IS this filter. Without it a kind='tip' row enters amount_paid")
  check('  …and it also requires status = \'paid\'',
    /p\.status\s*=\s*'paid'/.test(fn), 'an unpaid row must not count toward the invoice')
  check('  …and the total it compares against is amount × (1 + gst/100) — no tip term',
    /v_total\s*:=\s*round\(v_inv\.amount\s*\*\s*\(1\s*\+\s*v_gst\s*\/\s*100\)/.test(fn)
    && !/tip/i.test(fn),
    'the invoice total must be derived from invoices.amount alone; a tip term here would bill it')

  // Now the app-side halves, run for real.
  const base = { amount: 500, discount_type: null, discount_value: null }
  // Simulating the trigger: amount_paid is the sum of kind='payment' rows only.
  const ledger = [
    row({ amount: 500, kind: 'payment' }),
    row({ amount: 75, kind: 'tip' }),
  ]
  const amountPaid = round2(ledger.filter(r => r.kind === 'payment' && r.status === 'paid')
    .reduce((s, r) => s + r.amount, 0))
  eq('amount_paid excludes the tip ($500, not $575)', amountPaid, 500)

  const withTip = invoiceBalance({ ...base, amount_paid: amountPaid }, NO_GST)
  const noTip = invoiceBalance({ ...base, amount_paid: 500 }, NO_GST)
  deep('invoiceBalance is identical with and without a tip in the ledger', withTip, noTip)
  eq('  …total stays $500', withTip.total, 500)
  eq('  …paid stays $500', withTip.paid, 500)
  eq('  …balance is exactly $0', withTip.balance, 0)
  eq('  …and NOTHING is overpaid', withTip.overpaid, 0)

  // invoiceTotals never sees a tip at all — it reads invoices.amount.
  deep('invoiceTotals(500) is unchanged by any tip', invoiceTotals(500, GST5), invoiceTotals(500, GST5))
  eq('  …GST rides the invoice amount only (5% of 500 = 25)', invoiceTotals(500, GST5).gstAmount, 25)
  eq('  …so the invoice total is 525, never 525 + tip', invoiceTotals(500, GST5).total, 525)

  // The specification's own worked example: $500 invoice, $100 tip, $600 charge.
  const big = invoiceBalance({ ...base, amount_paid: 500 }, NO_GST)
  check('invoice $500 + tip $100 + charge $600 → paid 500, balance 0, status paid',
    big.paid === 500 && big.balance === 0 && big.overpaid === 0,
    JSON.stringify(big))
}

// ═══════════════════════════════════════════════════════════════════════════
H('3. PARTIAL PAYMENTS — a tip must never reduce the remaining balance')
{
  // The specification's case: invoice $1,000, $400 applied, $60 tip, $460 charged.
  // The remaining balance must be $600 — NOT $540.
  //
  // V1 does not OFFER a tip on a deposit/part payment (§4), but the ledger
  // arithmetic must be right regardless: the UI rule is a product decision and
  // this is the money invariant underneath it.
  const partial = {
    amount: 1000, amount_paid: 400, discount_type: null, discount_value: null,
  }
  const b = invoiceBalance(partial, NO_GST)
  eq('$1,000 invoice with $400 applied → balance $600', b.balance, 600)
  // A $60 tip row exists in the ledger; the trigger's sum ignores it entirely.
  const ledger = [row({ amount: 400, kind: 'payment' }), row({ amount: 60, kind: 'tip' })]
  const paid = round2(ledger.filter(r => r.kind === 'payment').reduce((s, r) => s + r.amount, 0))
  eq('  …the tip row does not change amount_paid', paid, 400)
  eq('  …so the remaining balance is still $600, not $540',
    invoiceBalance({ ...partial, amount_paid: paid }, NO_GST).balance, 600)
}

// ═══════════════════════════════════════════════════════════════════════════
H('4. WHERE A TIP MAY BE OFFERED — never on a communicated deposit ask')
{
  // A deposit ask is a number already texted to the customer. Adding a tip would
  // make Stripe's total disagree with it at the moment the card is out — the
  // display-vs-charge split the whole deposit lane exists to prevent.
  const withDeposit = {
    amount: 4000, amount_paid: 0, discount_type: null, discount_value: null,
    deposit_amount: 2000, deposit_requested_at: '2026-08-01T12:00:00Z',
  }
  const dep = depositChargeAmount(withDeposit, NO_GST)
  eq('an outstanding deposit charges the deposit', dep.amount, 2000)
  eq('  …and reports isDeposit', dep.isDeposit, true)
  const refused = resolveTipCents(1000, { chargeCents: 200000, config: CFG, tippable: !dep.isDeposit })
  eq('  …so a tip on it is REJECTED, not silently dropped', refused.rejected, 'not-tippable')
  eq('  …and carries no money', refused.cents, 0)

  // The final instalment of a part-paid invoice IS tippable: the deposit is
  // settled, so what is being charged is the ordinary remaining balance.
  const settled = { ...withDeposit, amount_paid: 2000 }
  const rest = depositChargeAmount(settled, NO_GST)
  eq('once the deposit is paid, the rest is an ordinary balance', rest.amount, 2000)
  eq('  …not a deposit', rest.isDeposit, false)
  eq('  …so it MAY carry a tip',
    resolveTipCents(5000, { chargeCents: 200000, config: CFG, tippable: !rest.isDeposit }).cents, 5000)

  // The UI half of the same rule, asserted structurally.
  const billing = read('src/app/portal/[token]/components/BillingTab.tsx')
  check('the portal only offers a tip when the charge is NOT a deposit',
    /const canTip\s*=[^\n]*!d\.payIsDeposit/.test(billing),
    'BillingTab must gate the tip selector on !d.payIsDeposit')
  check('  …and only when the owner enabled tips',
    /const canTip\s*=[^\n]*actions\.tips\.enabled/.test(billing),
    'the selector must be gated on the owner configuration, not rendered always')

  const pay = read('src/app/api/portal/pay/route.ts')
  check('the SERVER enforces the same rule (tippable: !charge.isDeposit)',
    /tippable:\s*!charge\.isDeposit/.test(pay),
    'the UI gate is not a gate — /api/portal/pay must refuse a tip on a deposit itself')

  // AutoPay is structurally untippable: nobody is present to choose. Assert the
  // off-session path never learned about tips rather than leaving it implicit.
  const autopay = read('src/lib/payments/autopay.ts')
  check('AutoPay (off-session) knows nothing about tips — nobody is present to choose',
    !/tip/i.test(autopay),
    'an off-session charge must never carry a gratuity: there is no customer at the keyboard')
  const quoteDeposit = read('src/app/api/portal/quote-deposit/route.ts')
  check('the pre-invoice scheduling deposit carries no tip either',
    !/tip/i.test(quoteDeposit),
    'that money has no invoice to sit beside — out of scope for v1, and it must stay out')
}

// ═══════════════════════════════════════════════════════════════════════════
H('5. THE TIP IS NOT CASH — every collected/revenue figure excludes it')
{
  // isCashRow is THE definition of "money arriving" that every report, tile and
  // dashboard reads. Transcribed here because it is the second mechanism (after
  // the trigger) keeping a gratuity out of revenue.
  const ledgerSrc = read('src/lib/payments/ledger.ts')
  check("isCashRow requires kind === 'payment'",
    /export function isCashRow[\s\S]{0,400}?r\.kind === 'payment'/.test(ledgerSrc),
    'if isCashRow ever accepts another kind, a tip enters every revenue figure in the app')
  check("collectedBetween filters kind='payment' IN THE QUERY",
    /collectedBetween[\s\S]{0,900}?\.eq\('kind',\s*'payment'\)/.test(ledgerSrc),
    'the date-range cash figure must exclude tips at the database, not in a caller')

  eq('isCashRow rejects a positive tip', isCashRow(row({ amount: 75, kind: 'tip' })), false)
  eq('isCashRow rejects a reversed tip', isCashRow(row({ amount: -75, kind: 'tip' })), false)
  eq('isCashRow still accepts an ordinary payment', isCashRow(row({ amount: 500 })), true)
  eq('cashAmountOf reports $0 of cash for a tip', cashAmountOf(row({ amount: 75, kind: 'tip' })), 0)

  const mixed = [
    row({ amount: 500, kind: 'payment' }),
    row({ amount: 75, kind: 'tip' }),
    row({ amount: -25, kind: 'tip' }),
  ]
  const cash = summarizeTransactions(mixed as never)
  eq('Collected over a tipped charge is $500, not $575', cash.collected, 500)
  eq('  …Refunded is $0 — a reversed TIP is not a refunded payment', cash.refunded, 0)
  eq('  …Net is $500', cash.net, 500)
  eq('  …and it counts ONE payment, not two money-in events', cash.count, 1)

  // The documented invariant of cashAmountOf: sum over any slice === summary.net.
  const summed = round2(mixed.reduce((s, r) => s + cashAmountOf(r), 0))
  eq('sum(cashAmountOf) still equals summarizeTransactions().net', summed, cash.net)

  const tips = summarizeTips(mixed)
  eq('summarizeTips reports the gratuity: received $75', tips.received, 75)
  eq('  …refunded $25', tips.refunded, 25)
  eq('  …net $50', tips.net, 50)
  eq('  …over ONE tip event', tips.count, 1)
  eq('tipAmountOf is 0 for an ordinary payment', tipAmountOf(row({ amount: 500 })), 0)
  eq('tipAmountOf is signed for a reversal', tipAmountOf(row({ amount: -25, kind: 'tip' })), -25)

  // Two summaries, two questions. Folding them is how a tip lands in revenue.
  check('summarizeTips is a SEPARATE function, not a field on the cash summary',
    !Object.prototype.hasOwnProperty.call(cash, 'tips'),
    'a tip figure inside the cash summary is one refactor away from being added to net')
}

// ═══════════════════════════════════════════════════════════════════════════
H('6. SERVER DERIVATION — the browser may ask, it may never decide')
{
  const chargeCents = 50000

  // The attack list from the specification, one by one.
  eq('negative tip → rejected', resolveTipCents(-100, { chargeCents, config: CFG, tippable: true }).rejected, 'negative')
  eq('fractional cents → rejected', resolveTipCents(12.5, { chargeCents, config: CFG, tippable: true }).rejected, 'not-an-integer')
  eq('NaN → rejected', resolveTipCents(NaN, { chargeCents, config: CFG, tippable: true }).rejected, 'not-an-integer')
  eq('Infinity → rejected', resolveTipCents(Infinity, { chargeCents, config: CFG, tippable: true }).rejected, 'not-an-integer')
  eq('1e21 (beyond safe integers) → rejected', resolveTipCents(1e21, { chargeCents, config: CFG, tippable: true }).rejected, 'not-an-integer')
  eq('Number.MAX_SAFE_INTEGER → over-maximum, never charged',
    resolveTipCents(Number.MAX_SAFE_INTEGER, { chargeCents, config: CFG, tippable: true }).rejected, 'over-maximum')
  eq('a boolean → rejected', resolveTipCents(true, { chargeCents, config: CFG, tippable: true }).rejected, 'not-an-integer')
  eq('an object → rejected', resolveTipCents({ valueOf: () => 5000 }, { chargeCents, config: CFG, tippable: true }).rejected, 'not-an-integer')
  eq('an array → rejected', resolveTipCents([5000], { chargeCents, config: CFG, tippable: true }).rejected, 'not-an-integer')
  eq("the string '15%' → rejected", resolveTipCents('15%', { chargeCents, config: CFG, tippable: true }).rejected, 'not-an-integer')
  eq("the string '0.1' → rejected", resolveTipCents('0.1', { chargeCents, config: CFG, tippable: true }).rejected, 'not-an-integer')
  eq("a numeric string '2500' → accepted as 2500 cents", resolveTipCents('2500', { chargeCents, config: CFG, tippable: true }).cents, 2500)

  // Absent is not an error: it is the shape every untipped payment sends.
  eq('undefined → no tip, no rejection', resolveTipCents(undefined, { chargeCents, config: CFG, tippable: true }).cents, 0)
  eq('null → no tip, no rejection', resolveTipCents(null, { chargeCents, config: CFG, tippable: true }).cents, 0)
  eq("'' → no tip, no rejection", resolveTipCents('', { chargeCents, config: CFG, tippable: true }).cents, 0)
  eq('  …and none of those is flagged as a rejection',
    resolveTipCents(undefined, { chargeCents, config: CFG, tippable: true }).rejected, undefined)

  // ── The ceilings: both apply ────────────────────────────────────────────
  eq(`the absolute ceiling is $${TIP_MAX_CENTS / 100}`, TIP_MAX_CENTS, 100_000)
  eq('exactly at the absolute ceiling on a large charge → accepted',
    resolveTipCents(TIP_MAX_CENTS, { chargeCents: 5_000_00, config: CFG, tippable: true }).cents, TIP_MAX_CENTS)
  eq('one cent over the absolute ceiling → rejected',
    resolveTipCents(TIP_MAX_CENTS + 1, { chargeCents: 5_000_00, config: CFG, tippable: true }).rejected, 'over-maximum')
  eq('100% of the charge → accepted (an abuse bound, not a taste bound)',
    resolveTipCents(5000, { chargeCents: 5000, config: CFG, tippable: true }).cents, 5000)
  eq('101% of the charge → rejected',
    resolveTipCents(5001, { chargeCents: 5000, config: CFG, tippable: true }).rejected, 'over-maximum')
  eq('a $1,000 tip on a $60 invoice → rejected by the PROPORTIONAL bound',
    resolveTipCents(100_000, { chargeCents: 6000, config: CFG, tippable: true }).rejected, 'over-maximum')

  // ── Rejection, never a silent clamp ─────────────────────────────────────
  const huge = resolveTipCents(500_000, { chargeCents: 5_000_00, config: CFG, tippable: true })
  check('an over-limit tip is REFUSED, not quietly reduced to the ceiling',
    huge.cents === 0 && huge.rejected === 'over-maximum',
    `a clamp would charge ${huge.cents} after the customer asked for 500000 — an overcharge from where they sit`)

  // ── The order of refusals ───────────────────────────────────────────────
  eq('a business with tips off is told "disabled", not its ceiling',
    resolveTipCents(999_999, { chargeCents, config: TIPS_OFF, tippable: true }).rejected, 'tips-disabled')

  // ── A zero-or-negative charge cannot carry a tip ────────────────────────
  eq('a $0 charge cannot carry a tip', resolveTipCents(500, { chargeCents: 0, config: CFG, tippable: true }).rejected, 'not-tippable')
  eq('a negative charge cannot carry a tip', resolveTipCents(500, { chargeCents: -100, config: CFG, tippable: true }).rejected, 'not-tippable')

  // ── The structural half: the route may not read an AMOUNT from the body ──
  const pay = read('src/app/api/portal/pay/route.ts')
  check('the pay route still takes NO amount from the client',
    !/body\.(amount|chargeCents|depositCents|grossCents|totalCents)/.test(pay),
    'the amount owed is server-derived; only the tip INTENT may come from the browser')
  check('  …and the one client field it does read goes through resolveTipCents',
    /resolveTipCents\(\s*body\.tipCents/.test(pay),
    'body.tipCents must never reach Stripe without the engine re-deriving and bounding it')
  check('  …with the charge the engine derived, not a client figure',
    /chargeCents\s*=\s*Math\.round\(charge\.amount\s*\*\s*100\)/.test(pay),
    'the tip ceiling is proportional to the SERVER-derived charge')
  // Anchored on the `if (` itself. A looser match stayed green when the branch
  // was neutered to `if (false && tip.rejected)`, because the words were all
  // still there — the mutation harness caught that.
  check('  …and a rejected tip is a 400, not a charge',
    /\n\s*if \(tip\.rejected\) \{[\s\S]{0,240}status:\s*400/.test(pay),
    'a refused tip must fail the request; charging a different amount is an overcharge')
}

// ═══════════════════════════════════════════════════════════════════════════
H('7. THE STRIPE SESSION — a second line item, and metadata we control')
{
  const cfg = read('src/lib/stripe/config.ts')
  check('the tip is its OWN Checkout line item',
    /line_items\[1\]\[price_data\]\[unit_amount\]'\s*,\s*String\(tipCents\)/.test(cfg),
    'the customer must see "Invoice N" and "Tip" separately on Stripe\'s page and receipt')
  check("  …named 'Tip'", /line_items\[1\]\[price_data\]\[product_data\]\[name\]'\s*,\s*'Tip'/.test(cfg),
    'an unnamed second line reads as a surprise charge')
  check('  …and only when there IS one',
    /if \(tipCents > 0\) \{[\s\S]{0,400}line_items\[1\]/.test(cfg),
    'an untipped payment must build the identical session it always did')
  check('the invoice line item keeps its own label',
    /line_items\[0\]\[price_data\]\[product_data\]\[name\]'\s*,\s*opts\.chargeLabel \|\| `Invoice \$\{invoice\.invoice_number\}`/.test(cfg),
    'folding the tip into line 0 would destroy the "Deposit — Invoice N" naming')
  check('the tip is declared in SESSION metadata',
    /metadata\[tip_cents\]'\s*,\s*String\(tipCents\)/.test(cfg),
    'the webhook reads the split from metadata we wrote — a server→server channel')
  check('  …and on the PaymentIntent too',
    /payment_intent_data\[metadata\]\[tip_cents\]'\s*,\s*String\(tipCents\)/.test(cfg),
    'the PaymentIntent copy is what survives when only the intent is in hand')
  check('the session function re-validates the tip it was handed',
    /Number\.isSafeInteger\(opts\.tipCents\)/.test(cfg),
    'defence in depth: a non-integer reaching Stripe is a 400 at best, a wrong charge at worst')
  // BOTH sessions, counted. Asserting "at least one" left the invoice session
  // free to grow a 24-hour expiry while the quote-deposit session kept the check
  // green — an abandoned tab that stays payable overnight is a second real
  // charge. (Found by mutate-tips.)
  eq('the 30-minute expiry is unchanged on BOTH checkout sessions',
    (cfg.match(/expires_at',\s*String\(Math\.floor\(Date\.now\(\) \/ 1000\) \+ 30 \* 60\)\)/g) || []).length, 2)
  check("no Stripe 'customer chooses price' / pay-what-you-want mode",
    !/custom_unit_amount|pay_what_you_want/i.test(cfg),
    'Stripe documents restrictions combining a customer-chosen price with other line items — the tip is chosen BEFORE checkout')
  check('the quote-deposit session never carries tip metadata',
    !/createQuoteDepositCheckoutSession[\s\S]*?tip_cents/i.test(cfg),
    'the deposit and invoice metadata vocabularies must not cross')
}

// ═══════════════════════════════════════════════════════════════════════════
H('8. THE SPLIT — arithmetic that cannot create or lose a cent')
{
  deep('gross 57500 with a declared 7500 tip → 50000 + 7500',
    splitGrossCents(57500, 7500), { invoiceCents: 50000, tipCents: 7500 })
  deep('no declaration → the whole charge is the invoice payment',
    splitGrossCents(50000, undefined), { invoiceCents: 50000, tipCents: 0 })
  deep("the string '7500' (metadata is always a string) → parsed",
    splitGrossCents(57500, '7500'), { invoiceCents: 50000, tipCents: 7500 })
  deep('a garbage declaration → treated as no tip, never as a negative payment',
    splitGrossCents(50000, 'nonsense'), { invoiceCents: 50000, tipCents: 0 })
  deep('a NEGATIVE declaration → no tip', splitGrossCents(50000, -5000), { invoiceCents: 50000, tipCents: 0 })

  // The clamp, and why it is the safe direction.
  deep('a declaration LARGER than the gross is clamped to the gross',
    splitGrossCents(50000, 90000), { invoiceCents: 0, tipCents: 50000 })
  check('  …so the invoice half is never negative',
    splitGrossCents(50000, 90000).invoiceCents >= 0,
    'a negative payment row would drive amount_paid down, reopen the balance, and start the chaser')

  // Conservation, exhaustively over an awkward grid.
  for (const gross of [1, 99, 100, 12345, 57500, 99999, 1_000_000]) {
    for (const tip of [0, 1, 33, 7500, gross - 1, gross, gross + 1]) {
      const s = splitGrossCents(gross, tip)
      if (s.invoiceCents + s.tipCents !== gross || s.invoiceCents < 0 || s.tipCents < 0) {
        fail(`conservation at gross=${gross} tip=${tip}`, `got ${JSON.stringify(s)}`)
      }
    }
  }
  ok('the two halves always sum to the gross exactly, and neither is ever negative')

  // The webhook's use of it.
  const wh = read('src/app/api/stripe/webhook/route.ts')
  check('the webhook splits the gross before recording anything',
    /splitGrossCents\(s\.amount_total \?\? 0,\s*s\.metadata\?\.tip_cents\)/.test(wh),
    'recording amount_total against the invoice books the gratuity as invoice revenue')
  check('  …and records the INVOICE half against the invoice',
    /invoice_id:\s*invoiceId,\s*\n\s*amount:\s*invoiceCents \/ 100/.test(wh),
    'the invoice row must carry the invoice half only')
  check("  …and the tip half as kind='tip'",
    /kind:\s*'tip',\s*provider:\s*'stripe'/.test(wh),
    "the kind is the entire mechanism — a kind='payment' tip enters amount_paid")
  check('  …only when there is a tip',
    /if \(tipCents > 0\) \{[\s\S]{0,600}kind:\s*'tip'/.test(wh),
    'an untipped payment must write exactly one row, as it always did')
  // The tip leg needs its OWN key in the unique namespace. Without this the two
  // legs share `s.id`, the second upsert conflicts, and one of them silently
  // never lands — a green guard over a lost tip. (Found by mutate-tips.)
  check('  …under its own idempotency key, never the payment row’s',
    /kind:\s*'tip'[\s\S]{0,300}stripe_session_id:\s*tipSessionKey\(s\.id\)/.test(wh),
    "both legs on `s.id` means the second upsert conflicts and one leg is lost")
  check('the webhook never writes invoice status directly',
    !/from\('invoices'\)\.update\(\{[^}]*status/.test(wh),
    'the recompute trigger owns status; the webhook only stamps payment_method')
  check('the webhook still derives nothing from the client',
    !/req\.(json|body)/.test(wh),
    'the webhook reads a signature-verified Stripe payload and nothing else')
}

// ═══════════════════════════════════════════════════════════════════════════
H('9. IDEMPOTENCY — a replayed webhook writes nothing twice')
{
  const wh = read('src/app/api/stripe/webhook/route.ts')
  const upserts = wh.match(/onConflict:\s*'stripe_session_id',\s*ignoreDuplicates:\s*true/g) || []
  check(`every money write dedupes on the UNIQUE stripe_session_id (found ${upserts.length}, need ≥5)`,
    upserts.length >= 5,
    'invoice, tip, autopay, refund and tip-refund writes must all be upserts on the unique key')

  const base = baselineSql()
  check('payments.stripe_session_id is UNIQUE in the schema',
    /alter table public\."payments" add constraint "payments_stripe_session_id_key" UNIQUE \(stripe_session_id\)/.test(base),
    'the entire idempotency guarantee is this one constraint — there is no event-id table')

  // The namespaces. A collision would make one leg silently no-op forever.
  eq('the tip leg is keyed tip:<session>', tipSessionKey('cs_test_123'), 'tip:cs_test_123')
  eq('the tip refund leg is keyed refund-tip:<charge>:<cumulative cents>',
    tipRefundKey('ch_1', 12345), 'refund-tip:ch_1:12345')
  const keys = [
    'cs_test_123',                    // the invoice payment leg
    tipSessionKey('cs_test_123'),     // the tip leg
    'credit:cs_test_123',             // the quote-deposit credit leg
    'autopay:inv_1',                  // the off-session leg
    'refund:ch_1:12345',              // the invoice refund leg
    'refund-credit:ch_1:12345',       // the deposit-credit refund leg
    tipRefundKey('ch_1', 12345),      // the tip refund leg
  ]
  eq('all seven ledger key namespaces are distinct', new Set(keys).size, keys.length)
  check("  …and 'refund-tip:' cannot be matched by the 'refund:<charge>:%' LIKE lookup",
    !tipRefundKey('ch_1', 100).startsWith('refund:'),
    'the invoice refund branch pages prior rows with LIKE refund:<charge>:% — a prefix collision would double-count')
  check("  …nor by 'refund-credit:'",
    !tipRefundKey('ch_1', 100).startsWith('refund-credit:'), 'namespace collision')

  // The side-effect gate must stay on the INVOICE row, not the tip row.
  check('the receipt/notification gate is the INVOICE row insert',
    /payRes\.data\?\.length \?\? 0\) > 0/.test(wh),
    'gating on the tip row would re-send on redelivery, or suppress the receipt entirely')
  check('a failed tip write returns 500 so Stripe retries',
    /tip upsert failed[\s\S]{0,220}status:\s*500/.test(wh),
    'silently 200-ing a failed write LOSES the tip')

  // The two other kind='payment' filters that keep tips out of trouble.
  check("paymentForIntent still filters kind='payment' AND amount > 0",
    /\.eq\('stripe_payment_intent',\s*piId\)\.eq\('kind',\s*'payment'\)\.gt\('amount',\s*0\)/.test(wh),
    'without this the refund/dispute lookup gets two candidates for one PaymentIntent and no ORDER BY')
  const capture = functionSql('capture_integration_event')
  check("capture_integration_event fires payment.recorded for kind='payment' only",
    /coalesce\(new\.kind,\s*'payment'\)\s*=\s*'payment'/.test(capture),
    'a tip must not fire an outbound payment.recorded webhook as though the invoice collected it')
}

// ═══════════════════════════════════════════════════════════════════════════
H('10. REFUNDS — tip-first, cumulative, and it cannot reopen a settled invoice')
{
  // The specification's worked example:
  //   original payment $500, original tip $75, gross $575
  //   refunded service $100, refunded tip $25
  //   → net service $400, net tip $50
  //
  // Stripe tells us ONE cumulative number, so we apportion. Tip first.
  {
    // Delivery 1: a $25 refund. Tip-first places all of it on the tip.
    const a = apportionRefund({ refundedTotal: 25, alreadyInvoice: 0, alreadyTip: 0, tipRecorded: 75 })
    deep('a $25 refund on a $500+$75 charge comes off the tip first', a, { invoiceDelta: 0, tipDelta: 25, basis: 'tip-first' })
    // Delivery 2: cumulative $125. Tip has $50 left, so $50 more tip + $75 invoice.
    const b = apportionRefund({ refundedTotal: 125, alreadyInvoice: 0, alreadyTip: 25, tipRecorded: 75 })
    deep('  …a further refund exhausts the tip, then reaches the invoice', b, { invoiceDelta: 50, tipDelta: 50, basis: 'tip-first' })
  }

  // A FULL refund of the gross: every ordering agrees, and the invoice is
  // reversed by EXACTLY what it received — never by the gross.
  {
    const r = apportionRefund({ refundedTotal: 575, alreadyInvoice: 0, alreadyTip: 0, tipRecorded: 75, invoiceRecorded: 500 })
    deep('a full $575 refund reverses $500 invoice + $75 tip', r, { invoiceDelta: 500, tipDelta: 75, basis: 'full' })
    // …and it reaches the same AMOUNTS without invoiceRecorded, via the fallback.
    deep('  …same amounts through the fallback when the invoice side is unknown',
      apportionRefund({ refundedTotal: 575, alreadyInvoice: 0, alreadyTip: 0, tipRecorded: 75 }),
      { invoiceDelta: 500, tipDelta: 75, basis: 'tip-first' })
    check('  …the invoice is NOT reversed by the gross',
      r.invoiceDelta === 500,
      'reversing 575 against an invoice that received 500 drives amount_paid to −75, reopens the balance, and starts the chaser')
    // And the resulting ledger is honest.
    const after = round2(500 - r.invoiceDelta)
    eq('  …amount_paid lands at exactly $0, never negative', after, 0)
    eq('  …and the invoice balance returns to its full $500', invoiceBalance(
      { amount: 500, amount_paid: after, discount_type: null, discount_value: null }, NO_GST).balance, 500)
  }

  // Idempotency: a re-delivered cumulative figure writes nothing.
  {
    const replay = apportionRefund({ refundedTotal: 575, alreadyInvoice: 500, alreadyTip: 75, tipRecorded: 75 })
    deep('a re-delivered refund event computes deltas of zero', replay, { invoiceDelta: 0, tipDelta: 0, basis: 'none' })
  }

  // A charge with NO tip behaves exactly as it always did.
  {
    const r = apportionRefund({ refundedTotal: 100, alreadyInvoice: 0, alreadyTip: 0, tipRecorded: 0 })
    deep('an untipped charge refunds entirely against the invoice', r, { invoiceDelta: 100, tipDelta: 0, basis: 'tip-first' })
  }

  // Never reverse more tip than was collected.
  {
    const r = apportionRefund({ refundedTotal: 200, alreadyInvoice: 0, alreadyTip: 0, tipRecorded: 20 })
    deep('the tip leg is capped at the tip actually recorded', r, { invoiceDelta: 180, tipDelta: 20, basis: 'tip-first' })
  }

  // Defensive: nonsense inputs must not invent money.
  deep('a negative cumulative figure writes nothing',
    apportionRefund({ refundedTotal: -50, alreadyInvoice: 0, alreadyTip: 0, tipRecorded: 75 }),
    { invoiceDelta: 0, tipDelta: 0, basis: 'none' })
  deep('an already-fully-reversed charge writes nothing',
    apportionRefund({ refundedTotal: 100, alreadyInvoice: 100, alreadyTip: 0, tipRecorded: 0 }),
    { invoiceDelta: 0, tipDelta: 0, basis: 'none' })

  // Conservation across a partial-refund grid.
  for (const total of [0, 0.01, 25, 75, 100, 500, 575]) {
    const r = apportionRefund({ refundedTotal: total, alreadyInvoice: 0, alreadyTip: 0, tipRecorded: 75 })
    const placed = round2(r.invoiceDelta + r.tipDelta)
    const expected = total <= 0.005 ? 0 : round2(total)
    if (placed !== expected) fail(`refund conservation at ${total}`, `placed ${placed}, expected ${expected}`)
    if (r.tipDelta > 75.005) fail(`refund over-reverses the tip at ${total}`, `tipDelta ${r.tipDelta}`)
  }
  ok('every partial refund places exactly the outstanding amount, tip first, tip capped')

  // ── UNAMBIGUOUS BEATS THE FALLBACK ────────────────────────────────────────
  // With invoiceRecorded known, most real refunds stop being a guess. tip-first
  // is now reserved for a partial that genuinely matches neither side.
  {
    const P = { alreadyInvoice: 0, alreadyTip: 0, tipRecorded: 75, invoiceRecorded: 500 }
    deep('a refund of exactly the tip is READ as a tip refund',
      apportionRefund({ ...P, refundedTotal: 75 }),
      { invoiceDelta: 0, tipDelta: 75, basis: 'exact-tip' })
    deep('a refund of exactly the invoice payment is READ as a service refund',
      apportionRefund({ ...P, refundedTotal: 500 }),
      { invoiceDelta: 500, tipDelta: 0, basis: 'exact-service' })
    check('  …and it does NOT eat the tip (the case tip-first used to get wrong)',
      apportionRefund({ ...P, refundedTotal: 500 }).tipDelta === 0,
      'a service-only refund must leave the gratuity alone — that is the whole point of the exact rules')
    deep('a refund of the whole gross reverses both legs in full',
      apportionRefund({ ...P, refundedTotal: 575 }),
      { invoiceDelta: 500, tipDelta: 75, basis: 'full' })
    deep('anything else is ambiguous and falls back to tip-first',
      apportionRefund({ ...P, refundedTotal: 200 }),
      { invoiceDelta: 125, tipDelta: 75, basis: 'tip-first' })
    // A TIE is not evidence: equal remainders match both rules, so neither fires.
    deep('equal remainders are a TIE, not an exact match → fallback',
      apportionRefund({ refundedTotal: 75, alreadyInvoice: 0, alreadyTip: 0, tipRecorded: 75, invoiceRecorded: 75 }),
      { invoiceDelta: 0, tipDelta: 75, basis: 'tip-first' })
    // Without invoiceRecorded the exact rules cannot fire — the degradation is
    // the previous behaviour, which is safe.
    deep('omitting invoiceRecorded degrades to tip-first, never to a wrong exact match',
      apportionRefund({ refundedTotal: 500, alreadyInvoice: 0, alreadyTip: 0, tipRecorded: 75 }),
      { invoiceDelta: 425, tipDelta: 75, basis: 'tip-first' })
    // After an exact tip refund, a second refund that clears the rest is 'full'
    // (everything outstanding on both legs) — not 'exact-service'. The tip leg has
    // nothing left, so the two rules describe the same money and the broader one
    // wins. What matters is the AMOUNTS: the tip is never double-reversed.
    {
      const second = apportionRefund({ refundedTotal: 575, alreadyInvoice: 0, alreadyTip: 75, tipRecorded: 75, invoiceRecorded: 500 })
      deep('after an exact tip refund, clearing the rest touches only the invoice',
        second, { invoiceDelta: 500, tipDelta: 0, basis: 'full' })
      check('  …and the tip is NOT reversed twice', second.tipDelta === 0,
        'the tip was already given back; reversing it again would invent money')
    }
  }

  // ── OWNER-ORIGINATED REFUNDS ARE EXPLICIT, NOT APPORTIONED ────────────────
  // recordRefund is the door the OWNER drives, so it never guesses: the service
  // portion and the gratuity are separate arguments with separate caps.
  {
    const led = read('src/lib/payments/ledger.ts')
    check('recordRefund takes an explicit tipAmount alongside the service amount',
      led.includes('userId: string; invoice: Invoice; amount: number; notes?: string; tipAmount?: number'),
      'an owner-originated refund must be able to name which side it is refunding')
    check("  …and writes the tip leg as kind='tip', so amount_paid cannot move",
      led.includes("amount: -tipAmt, provider: 'refund', kind: 'tip'"),
      "a kind='payment' tip refund would reduce the invoice balance")
    check("  …while the service leg stays kind='payment'",
      led.includes("amount: -amt, provider: 'refund', kind: 'payment'"),
      'the service leg is what the recompute trigger must see')
    check('  …with the tip leg capped against the LIVE tip held on the invoice',
      led.includes('tipHeldOnInvoice(sb, p.invoice.id)'),
      'assertCurrent compares amount_paid, which a tip movement never touches — so it cannot speak for this leg')
    check('  …and the tip amount is actually COMPARED against it',
      led.includes('if (tipAmt > held + 0.005) {'),
      'a cap that is read and then never compared is not a cap — mutate-tips caught exactly this')
    check('  …and a failed tip read REFUSES rather than reading as no tip',
      led.includes('if (held === null) return { error:'),
      '"could not check" spent as "no tip" turns a cap into no cap at all')
    check('  …and either leg alone is a valid refund',
      led.includes('if (!(amt > 0) && !(tipAmt > 0))'),
      'a tip-only refund must be recordable without inventing a $0 service refund')
    check('tipHeldOnInvoice reports null on a failed read, never 0',
      led.includes('export async function tipHeldOnInvoice') && led.includes('if (error) return null'),
      'a cap derived from a failed read is not a cap')

    const ctl = read('src/components/payments/InvoicePaymentControls.tsx')
    check('the owner refund form offers the tip leg when a tip is held',
      ctl.includes('{tips.net > 0 && (') && ctl.includes('Refund from the tip'),
      'the explicit path needs a way in')
    check('  …capped in the UI too', ctl.includes('max={tips.net}'),
      'the field should not let the owner ask for more than is there')
    check('  …and passes BOTH legs to the engine',
      ctl.includes('amount: Number(refundAmount) || 0, tipAmount: Number(refundTip) || 0'),
      'the form must not collapse the two legs into one number')
    check('  …and says a tip refund leaves the balance alone',
      ctl.includes('change the invoice balance'),
      'the owner should be told what will NOT move')
    check('the card dead-end explains how Stripe’s number will be read',
      ctl.includes('comes off the tip first'),
      'for a card charge the owner refunds in Stripe — they need to know what an unmatched partial does')
  }

  const wh = read('src/app/api/stripe/webhook/route.ts')
  check('the webhook supplies invoiceRecorded so exact matches can be recognised',
    wh.includes('invoiceRecorded: Number(p.amount) || 0'),
    'without it every external refund degrades to the tip-first guess')
  check('  …and the notification distinguishes a READ split from a GUESSED one',
    wh.includes("refundBasis === 'tip-first'"),
    '"we matched it exactly" and "we had to choose" are different claims; only one asks the owner to check')
  check('the refund branch apportions rather than booking the gross',
    /apportionRefund\(\{/.test(wh),
    'without apportionment a full refund of a tipped charge reopens a settled invoice')
  check('  …reading the split from OUR ledger, by PaymentIntent',
    /\.eq\('stripe_payment_intent',\s*piId\)\.eq\('kind',\s*'tip'\)/.test(wh),
    'the owner refunds in the Stripe dashboard, so no refund object carries our metadata')
  check('  …never from the Stripe charge payload',
    !/ch\.metadata/.test(wh),
    'whether a charge mirrors PaymentIntent metadata is API-version-sensitive on an unpinned account')
  // Anchored on the `if (`. The words alone stayed green when the branch was
  // neutered, because the same identifiers appear in its console.error.
  check('  …and a failed apportionment READ is a 500, not a guess',
    /\n\s*if \(priorErr \|\| tipErr\) \{[\s\S]{0,300}status:\s*500/.test(wh),
    'a read we cannot complete would make the apportionment guess, and a guess here writes money')
  check('the owner notification names the tip portion of a refund',
    /of that came off the tip/.test(wh),
    'a wrong guess on a partial must be visible and correctable, not silent')
  check('a lost dispute names the tip inside the disputed gross',
    /part of the disputed amount/.test(wh),
    'a disputed charge is the gross — reporting only the service half pretends the tip was not taken back')
  check('disputes still write NOTHING automatically',
    !/charge\.dispute[\s\S]{0,3000}from\('payments'\)\.(upsert|insert)/.test(wh),
    'a negative row on a lost dispute reopens the balance past the due date and starts texting the customer')
}

// ═══════════════════════════════════════════════════════════════════════════
H('11. CAPABILITY + SETTINGS — a tip cannot outlive the payment rail')
{
  const pay = read('src/app/api/portal/pay/route.ts')
  check('the pay route still gates on the tenant capability',
    /tenantCapabilities\(admin,\s*invoice\.user_id\)\)\.onlinePayments/.test(pay),
    'a tenant without online_payments must not have its customers charged — tips included')
  check('  …resolved from the OWNER the invoice belongs to, never the client',
    /invoice\.user_id/.test(pay) && !/body\.(userId|user_id|tenant)/.test(pay),
    'the client names a token; the server resolves the tenant')

  const status = read('src/app/api/payments/status/route.ts')
  check('the portal only learns about tips when payments are enabled',
    /tips:\s*enabled\s*\?\s*tips\s*:\s*TIPS_OFF/.test(status),
    'a tip offer must fail closed with the capability that carries it')

  // ── The deploy is order-independent ──────────────────────────────────────
  // The three tip columns arrive in a migration, and PostgREST fails the WHOLE
  // select on a column it does not know. Folded into the GST read, this route
  // would 502 on EVERY payment attempt between the code deploying and the
  // migration being applied — the Pay button dead for a feature nobody had
  // switched on. Separate reads keep the pre-migration behaviour identical to
  // today's.
  check('the tip columns are read SEPARATELY from the GST/deposit reads',
    /select\('gst_percent'\)/.test(pay)
    && /select\('tips_enabled, tip_presets, tip_custom_enabled'\)/.test(pay),
    'one select over both means an unapplied migration takes the whole charge door down')
  check('  …and an unreadable tip config only refuses when a tip was ASKED for',
    /if \(tipErr\) \{\s*\n\s*if \(body\.tipCents\) \{/.test(pay),
    'an untipped payment must not care that the tip columns are unreadable; a tipped one must never be charged unverified')
  check('the status route degrades to TIPS_OFF rather than throwing',
    /if \(error\) return TIPS_OFF/.test(status),
    'the portal must render no tip section pre-migration, not an error')
  check('  …and the owner is resolved from the portal TOKEN server-side',
    /from\('customer_portal_tokens'\)[\s\S]{0,200}\.eq\('token',\s*portalToken\)/.test(status),
    'the client must never be able to name which tenant it is asking about')

  const caps = read('src/lib/capabilities.ts')
  check('no fifth capability column was invented for tips',
    !/tip/i.test(caps),
    'tips use the same Stripe account online_payments already governs; a new grant needs operator SQL and has no app write path')

  // ── The cross-tenant wall a tip row inherits (S75 B2) ────────────────────
  // payments.invoice_id is welded COMPOSITE: (user_id, invoice_id) must name a
  // row that exists in invoices as (user_id, id). A tip row carries both, taken
  // from the SAME Stripe metadata as its payment row, so a forged or mismatched
  // tenant/invoice pair is refused by Postgres rather than by a code path. This
  // is asserted here because a tip is a SECOND row shape on that ledger and must
  // never be the one that slips a single-column FK back in.
  const base = baselineSql()
  check('payments.invoice_id is tenant-welded, so a tip row cannot cross tenants',
    /payments_invoice_tenant_fkey" FOREIGN KEY \(user_id, invoice_id\) REFERENCES invoices\(user_id, id\)/.test(base),
    'a single-column invoice FK lets an attacker-chosen invoice_id move another tenant’s invoice — the tip row would inherit that hole')
  check('  …and invoices carries the UNIQUE (user_id, id) the weld references',
    /invoices_user_id_id_key" UNIQUE \(user_id, id\)/.test(base),
    'the composite FK cannot exist without it')
  const wh = read('src/app/api/stripe/webhook/route.ts')
  check('  …and the tip row takes BOTH keys from the same verified metadata',
    /kind:\s*'tip'[\s\S]{0,400}|user_id: userId,\s*\n\s*customer_id: s\.metadata\?\.customer_id \?\? null,\s*\n\s*invoice_id: invoiceId,[\s\S]{0,400}kind:\s*'tip'/.test(wh),
    'the tip must be scoped to the owner the invoice resolved to, never to anything a client sent')

  // Owner configuration, and the closed-by-default rule.
  deep('a business with no configuration gets NO tips', tipConfig(null), TIPS_OFF)
  deep('a business that never heard of tips gets NO tips', tipConfig({}), TIPS_OFF)
  deep('tips_enabled=false gets NO tips', tipConfig({ tips_enabled: false, tip_presets: [10, 15, 20] }), TIPS_OFF)
  check('the schema default is OFF',
    /add column if not exists "tips_enabled" boolean default false not null/.test(read('supabase/migrations/20260823120000_tips_gratuity_v1.sql')),
    'most trades do not take gratuity; a tip prompt must never appear uninvited')

  // Half-configured collapses to off rather than showing an empty box.
  deep('presets cleared AND custom off → tips off entirely',
    tipConfig({ tips_enabled: true, tip_presets: [], tip_custom_enabled: false }), TIPS_OFF)
  deep('presets cleared but custom on → still a usable tip UI',
    tipConfig({ tips_enabled: true, tip_presets: [], tip_custom_enabled: true }),
    { enabled: true, presets: [], customAllowed: true })

  // Preset normalisation — the column CHECK is a backstop, not the message.
  deep('presets are de-duplicated, sorted and capped at three',
    tipConfig({ tips_enabled: true, tip_presets: [20, 10, 15, 25, 10] }).presets, [10, 15, 20])
  deep('out-of-range presets are dropped, not clamped',
    tipConfig({ tips_enabled: true, tip_presets: [0, -5, 101, 15] }).presets, [15])
  deep('non-numeric presets are dropped',
    tipConfig({ tips_enabled: true, tip_presets: [NaN, Infinity, 15] as number[] }).presets, [15])
  deep('a non-array presets column is treated as empty',
    tipConfig({ tips_enabled: true, tip_presets: 'oops' as unknown as number[], tip_custom_enabled: true }).presets, [])
  eq(`the preset cap is ${TIP_MAX_PRESETS}`, TIP_MAX_PRESETS, 3)
  deep('the shipped default is 10 / 15 / 20', [...TIP_DEFAULT_PRESETS], [10, 15, 20])
  eq('custom defaults to allowed when the column is absent',
    tipConfig({ tips_enabled: true, tip_presets: [15] }).customAllowed, true)
  eq('  …and is respected when explicitly off',
    tipConfig({ tips_enabled: true, tip_presets: [15], tip_custom_enabled: false }).customAllowed, false)

  // No industry heuristic anywhere. Tips are the business's decision.
  const tipsSrc = read('src/lib/payments/tips.ts')
  check('nothing infers tipping from the trade or service name',
    !/(hvac|plumb|electric|clean|lawn|landscap|business_type|service_type|industry)/i.test(tipsSrc),
    'no "cleaning gets tips, electricians do not" logic — the business decides')
}

// ═══════════════════════════════════════════════════════════════════════════
H('12. CURRENCY + PRECISION')
{
  // Integer minor units from the browser to the ledger. A fractional cent is a
  // malformed request, not a rounding question.
  eq("parse '25' → 2500 cents", parseTipInputToCents('25'), 2500)
  eq("parse '25.50' → 2550 cents", parseTipInputToCents('25.50'), 2550)
  eq("parse '$25.50' → 2550 cents", parseTipInputToCents('$25.50'), 2550)
  eq("parse '  25 ' → 2500 cents", parseTipInputToCents('  25 '), 2500)
  eq("parse '0' → 0 cents", parseTipInputToCents('0'), 0)
  eq("parse '25.555' → null (three decimals is not money)", parseTipInputToCents('25.555'), null)
  eq("parse '-25' → null", parseTipInputToCents('-25'), null)
  eq("parse '1e5' → null", parseTipInputToCents('1e5'), null)
  eq("parse '1,000' → null (no thousands separators)", parseTipInputToCents('1,000'), null)
  eq("parse 'abc' → null", parseTipInputToCents('abc'), null)
  eq("parse '' → null", parseTipInputToCents(''), null)
  eq('parse Infinity-ish → null', parseTipInputToCents('Infinity'), null)

  // The float trap, explicitly: 0.1 + 0.2 money must not survive as a tip.
  eq('a float-arithmetic amount cannot become a tip',
    resolveTipCents(0.1 + 0.2, { chargeCents: 50000, config: CFG, tippable: true }).rejected, 'not-an-integer')

  // Percentages round to the cent ONCE.
  deep('33% of $10.00 rounds once, to 330 cents', tipPresetsFor(1000, [33]), [{ percent: 33, cents: 330 }])
  deep('15% of $0.03 rounds to 0 and the chip is DROPPED, not shown as $0.00',
    tipPresetsFor(3, [15]), [])
  deep('a zero charge offers no presets', tipPresetsFor(0, [10, 15, 20]), [])
  deep('a negative charge offers no presets', tipPresetsFor(-100, [10, 15, 20]), [])
  // Every preset of every plausible charge is a whole number of cents.
  for (const charge of [1, 7, 99, 333, 50000, 123457, 9_999_99]) {
    for (const pct of [10, 15, 18, 20, 33]) {
      const p = tipPresetsFor(charge, [pct])[0]
      if (p && !Number.isInteger(p.cents)) fail(`preset precision ${pct}% of ${charge}`, `got ${p.cents}`)
    }
  }
  ok('every preset resolves to a whole number of cents')

  // Currency is CAD end to end. A tip must not introduce a second currency.
  const tipsSrc = read('src/lib/payments/tips.ts')
  check('the tip engine never introduces a currency of its own',
    !/currency:\s*['"](?!cad)/i.test(tipsSrc), 'currency is CAD deployment-wide; a per-tip currency would be a new concept')
  const wh = read('src/app/api/stripe/webhook/route.ts')
  check('the tip row inherits the session currency, exactly as the payment row does',
    /kind:\s*'tip'[\s\S]{0,300}|currency:\s*s\.currency \?\? 'cad',[\s\S]{0,200}kind:\s*'tip'/.test(wh)
    && (wh.match(/currency:\s*s\.currency \?\? 'cad'/g) || []).length >= 3,
    'the tip and its payment must never disagree about currency')
  const cfg = read('src/lib/stripe/config.ts')
  eq('the tip line item is priced in the same currency as the invoice line',
    (cfg.match(/line_items\[\d\]\[price_data\]\[currency\]'\s*,\s*'cad'/g) || []).length >= 3, true)
}

// ═══════════════════════════════════════════════════════════════════════════
H('13. WHAT THE OWNER AND THE CUSTOMER SEE')
{
  // ── The classifier every list, table and export reads ────────────────────
  eq('a positive tip row is named "Tip"', ledgerRowType(row({ amount: 75, kind: 'tip' })), 'Tip')
  eq('a reversed tip row is named "Tip refunded"', ledgerRowType(row({ amount: -75, kind: 'tip' })), 'Tip refunded')
  eq('  …and it is checked BEFORE the payment fall-through',
    ledgerRowType({ kind: 'tip', provider: 'stripe', amount: 75 }), 'Tip')
  eq('an ordinary payment is still "Payment"', ledgerRowType(row({ amount: 500 })), 'Payment')
  eq('a credit application is still "Settled from credit"',
    ledgerRowType(row({ amount: 200, provider: 'credit' })), 'Settled from credit')

  // ── The customer's portal ────────────────────────────────────────────────
  // Comment-stripped: these assert what the customer actually SEES, and the file
  // documents the dark patterns it refuses to use.
  const sel = readCode('src/app/portal/[token]/components/TipSelector.tsx')
  check('"No tip" is the FIRST choice', /chip\('none', 'No tip'/.test(sel),
    'the no-tip option must be first, not buried after the suggestions')
  check('  …and nothing is pre-selected',
    /useState<TipChoice>\(\{ kind: 'none' \}\)/.test(readCode('src/app/portal/[token]/components/BillingTab.tsx')),
    'the initial choice must be "none" — a pre-ticked percentage charges a customer who did not choose it')
  check('the custom field opens a NUMERIC keypad', /inputMode="decimal"/.test(sel),
    'a text keyboard for a money amount on a phone is a mis-typed tip')
  check('  …and is not type="number"', !/type="number"/.test(sel),
    'type=number silently accepts 1e5 and reports "" for invalid — we could not tell cleared from nonsense')
  // Counted, not merely present: the chips and the custom money field each need
  // it, and asserting "somewhere in the file" let the chips shrink while the
  // input kept the check green. (Found by mutate-tips.)
  check('the tip chips AND the custom field both clear the 44px touch target',
    (sel.match(/tap-target-y/g) || []).length >= 2,
    'a mis-tap here is a mis-tap on somebody\'s money')
  // Two columns, at every width, with no responsive escape hatch. Measured in
  // real Chrome at 320/375/390/430: 123/151/158/178px wide, 44px tall, nothing
  // clipped, nothing overflowing. Three would put "20% $100.00" in ~100px.
  check('the chips are exactly two columns, at every width',
    /grid grid-cols-2 gap-2/.test(sel) && !/grid-cols-[34]/.test(sel),
    'four chips across a 375px phone is four 80px targets — a mis-tap on somebody’s money')
  check('the breakdown shows invoice / tip / total separately',
    /Invoice payment[\s\S]{0,400}Tip[\s\S]{0,400}Total charged/.test(sel),
    'the customer must see that the invoice figure did not move')
  check('the copy states the invoice total is unchanged',
    /invoice total doesn’t change|not part of the invoice total/.test(sel),
    'the accounting model must be said to the person paying, not only asserted in the ledger')
  // No dark patterns, stated as an assertion rather than a hope.
  for (const pattern of [/most (customers|people) tip/i, /are you sure/i, /don’t you want/i, /no thanks, I/i]) {
    check(`no guilt copy: ${pattern.source}`, !pattern.test(sel), 'the tip must not be pressured')
  }

  // ── The owner's surfaces ─────────────────────────────────────────────────
  const payments = readCode('src/app/dashboard/payments/page.tsx')
  check('the payments list can filter to tips',
    /if \(kind === 'tips' && r\.kind !== 'tip'\) return false/.test(payments),
    'a tip must be findable, and it must not appear under Payments or Refunds')
  check("  …and the Payments filter requires kind === 'payment'",
    /kind === 'payments' && !\(r\.kind === 'payment'/.test(payments),
    'a tip must not appear under Payments — the filter has to name the kind it wants, not exclude the ones it knows')
  check("  …and the Refunds filter requires kind === 'payment' too",
    /kind === 'refunds' && !\(r\.kind === 'payment'/.test(payments),
    'a reversed tip is not a refunded payment and must not be listed as one')
  check('the payments CSV has a Tip Amount column',
    /label: 'Tip Amount'/.test(payments),
    'without it a tip exports with Cash blank AND Credit blank — a lossy row that looks complete')
  check('the reports CSV has a Tip column',
    /label: 'Tip'/.test(read('src/lib/reports/exports.ts')),
    'a tip row with Cash=0 and a bare Amount is indistinguishable from a credit application')
  check('the Tips tile is separate from Collected/Refunded/Net',
    /label="Tips"/.test(payments) && /summarizeTips\(visible\)/.test(payments),
    'a tip inside a cash tile is a tip inside revenue')

  const controls = read('src/components/payments/InvoicePaymentControls.tsx')
  check('the invoice detail shows the tip beside the received figure',
    /tips\.net > 0 \? ` · \$\{?/.test(controls) || /formatCurrency\(tips\.net\)\} tip/.test(controls),
    'the owner should see payment received / tip received / total on the invoice')
  check('  …labelled "not part of the invoice total"',
    /not part of the invoice total/.test(controls),
    'a tip rendered beside payments without a label reads as money the invoice collected')
  check('  …and a tip row offers NO receipt document',
    /\{!isTip && <button onClick=\{\(\) => downloadRowReceipt/.test(controls),
    'ReceiptPDF backs GST OUT of payment.amount — on a gratuity that prints tax for a supply never invoiced')
  check('the refund door still asks about kind=\'payment\' money only',
    /\.filter\(p => p\.kind === 'payment' && Number\(p\.amount\) > 0\)/.test(controls),
    'a tip must not become the "last money in" that decides whether the refund door is a Stripe dead-end')

  // ── The customer/job history ─────────────────────────────────────────────
  const timeline = read('src/lib/timeline.ts')
  check('the timeline emits a tip as its OWN event',
    /Tip received|Tip refunded/.test(timeline),
    'folding a tip into "Payment received" tells the owner the bill collected money it never did')
  check("  …and the deposit-coverage walk counts kind='payment' only",
    /p\.kind !== 'payment' \|\| !p\.invoice_id\) continue/.test(timeline),
    'a tip carrying invoice_id would count toward covering a deposit ask it has nothing to do with')

  const model = read('src/app/portal/[token]/model.ts')
  check('the portal names a tip as a tip in recent activity',
    /Tip — thank you/.test(model),
    'the customer must not be told their bill collected the tip')
  check("  …and 'did my payment land?' still tests kind='payment'",
    /p\.kind != null && p\.kind !== 'payment'\) continue/.test(model),
    'a tip alone must not clear the confirming banner')
}

// ═══════════════════════════════════════════════════════════════════════════
H('14. ATTRIBUTION — context, never payroll')
{
  // The specification is explicit: record that a tip arrived with a job, but do
  // NOT claim any individual earned it. This asserts the ABSENCE of the thing
  // that must not exist, which is the only way to keep it from arriving later.
  // Comment-stripped throughout: these files EXPLAIN what they refuse to do, and
  // a guard that trips on its own rationale gets fixed by deleting the rationale.
  const files = [
    'src/lib/payments/tips.ts',
    'src/app/api/stripe/webhook/route.ts',
    'src/app/api/portal/pay/route.ts',
    'src/lib/timeline.ts',
    'src/app/portal/[token]/components/TipSelector.tsx',
  ]
  for (const f of files) {
    const src = readCode(f)
    check(`${f} does not distribute a tip to a person`,
      !/(technician_id|hourly_wage|pay_run|payroll|earned|per_worker|tip_split|tipPool|tip_pool)/i.test(src),
      'V1 must not build payroll, tip splitting or employee payouts — no mechanism exists to pay one out')
  }
  const wh = read('src/app/api/stripe/webhook/route.ts')
  check('the tip is welded to the INVOICE, which is what carries the job',
    /kind:\s*'tip'[\s\S]{0,300}|invoice_id:\s*invoiceId,[\s\S]{0,300}kind:\s*'tip'/.test(wh),
    'payments.invoice_id → invoices.job_id is the whole attribution; no new column, and no claim about people')
  // The payroll tables, read as their own CREATE TABLE blocks rather than a
  // character window — a loose window matched `ot_mul-TIP-lier` on a neighbouring
  // constraint and reported a payout mechanism that does not exist.
  for (const t of ['pay_runs', 'pay_run_lines', 'time_entries', 'technicians']) {
    const ddl = tableSql(t)
    check(`${t} has no tip column`, ddl.length > 0 && !/\btip/i.test(ddl),
      ddl.length === 0 ? `could not isolate ${t} from the baseline`
        : 'a tip column on a payroll table would be a payout mechanism this session must not build')
  }

  // Crew membership is not proof of work — assert we never used it as such.
  check('no tip surface reads crew membership as proof anyone worked',
    !files.some(f => /crew_id|\bcrews\b/i.test(readCode(f))),
    'jobs.crew_id is a PLANNED assignment; the only per-person evidence is time_entries, which is empty in production')
}

// ═══════════════════════════════════════════════════════════════════════════
H('14b. QUOTED / AUTHORIZED VALUE — a tip is not service revenue')
{
  // A tip is post-service voluntary money. It must never reach the figures that
  // answer "what was this job worth" or "what did we sell" — quoted value,
  // authorized value, pipeline, margin. verify:sales-analytics owns the rule
  // from its own side (its §12 bans the words outright); this asserts the
  // DEPENDENCY DIRECTION, which is the tips lane's own business: nothing in the
  // value/revenue engines may import the tip engine, in either spelling.
  for (const f of ['src/lib/sales/analytics.ts', 'src/lib/sales/data.ts', 'src/lib/visitValue.ts', 'src/lib/invoicing.ts', 'src/lib/invoiceTotals.ts']) {
    let src = null
    try { src = readCode(f) } catch { src = null }
    if (src === null) { ok(`${f} is absent on this tree (nothing to assert)`); continue }
    check(`${f} does not import the tip engine`,
      !src.includes('payments/tips') && !src.includes('summarizeTips') && !src.includes('tipAmountOf'),
      'quoted/authorized/service revenue must not be able to see a gratuity — the import itself is the hazard')
  }
  // And the reverse: the tip engine must not reach into the value engines either,
  // which is what would let a tip be derived FROM a quote.
  const tipsSrc = readCode('src/lib/payments/tips.ts')
  check('the tip engine reads no quote/authorized value',
    !/quote|authorized|margin|pipeline/i.test(tipsSrc),
    'a tip is chosen by the customer against a charge, never derived from what was quoted')
}

// ═══════════════════════════════════════════════════════════════════════════
H('15. TAX — the seam is preserved, and no opinion is encoded')
{
  const tipsSrc = read('src/lib/payments/tips.ts')
  check('the tip engine computes no tax',
    !/(gst|hst|pst|qst|vat|tax_rate|taxable)/i.test(tipsSrc.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    'gratuity tax treatment varies by jurisdiction and is an owner + accountant decision — the code must not decide it')

  // The seam: tax is computed from invoices.amount, which a tip never touches.
  const totals = read('src/lib/invoiceTotals.ts')
  check('GST is still computed from the invoice amount alone',
    /gstAmount\s*=\s*gstPercent > 0 \?\s*round2\(net \* gstPercent \/ 100\)/.test(totals),
    'the entire tax seam is that tax rides invoices.amount; a tip term here would file gratuity GST with the CRA')
  eq('a tip changes no invoice tax figure', invoiceTotals(500, GST5).gstAmount, 25)

  // Stripe Tax is not in use anywhere; a tip must not be the thing that introduces it.
  const cfg = read('src/lib/stripe/config.ts')
  check('no Stripe Tax / automatic_tax was introduced by tips',
    !/automatic_tax|tax_behavior|tax_code|tax_rates/.test(cfg),
    'this deployment has no tax engine at Stripe; a tip must not silently start one')

  // The GST back-out documents must never see a tip row.
  const receipt = read('src/components/payments/ReceiptPDF.tsx')
  check('the receipt document still backs GST out of payment.amount',
    /gst/i.test(receipt),
    'if this ever stops being true the tip-row suppression above needs revisiting')
  const portalPayments = read('src/app/portal/[token]/components/PaymentsSection.tsx')
  check('the portal offers no receipt document for a tip row',
    /\{inv && !isTip &&/.test(portalPayments),
    'a tip receipt would print a tax figure for a gratuity that was never a taxable supply')
}

// ═══════════════════════════════════════════════════════════════════════════
H('16. SCHEMA — the migration says exactly what the code assumes')
{
  const mig = read('supabase/migrations/20260823120000_tips_gratuity_v1.sql')
  const base = baselineSql()
  check("the kind CHECK is widened to include 'tip'",
    /payments_kind_check"?\s*\n?\s*CHECK \(\(kind = ANY \(ARRAY\['payment'::text, 'credit'::text, 'refund'::text, 'tip'::text\]\)\)\)/.test(mig),
    'without this the tip INSERT fails the constraint and the webhook 500s forever')
  check('  …additively — every existing kind survives',
    ["'payment'", "'credit'", "'refund'"].every(k => mig.includes(k)),
    'dropping an existing kind would invalidate live rows')
  check('the three settings columns are added if-not-exists',
    /add column if not exists "tips_enabled"/.test(mig)
    && /add column if not exists "tip_presets"/.test(mig)
    && /add column if not exists "tip_custom_enabled"/.test(mig),
    'the migration must be safe to re-run')
  check('tip_presets is bounded by a DB CHECK, not only by app code',
    /business_settings_tip_presets_check[\s\S]{0,400}array_length\(tip_presets, 1\) <= 3/.test(mig),
    'a constraint in the database is the only bound an app bug cannot walk around')
  check('  …and every element is 1..100',
    /0 < ALL \(tip_presets\)[\s\S]{0,80}100 >= ALL \(tip_presets\)/.test(mig),
    'a 5000% preset is not a preset')
  // ── The version floor, MEASURED, never hardcoded ────────────────────────
  // This was pinned as a literal pair of version strings and rotted the moment
  // main regenerated its baseline and landed two migrations above it: the
  // assertion still passed while the file it described had fallen BELOW the
  // floor. So it now reads the apply path and asserts the real property —
  // this migration is the highest-sorting file there, and therefore replays
  // last on a from-zero rebuild, in the order production will actually see it.
  const applyPath = readdirSync(join(ROOT, 'supabase', 'migrations'))
    .filter(n => n.endsWith('.sql') && n.length > 15 && /^[0-9]+$/.test(n.slice(0, 14))).sort()
  const mine = applyPath.find(n => n.includes('tips_gratuity')) || ''
  const others = applyPath.filter(n => n !== mine)
  check('the tips migration is present in the apply path', !!mine,
    'supabase/migrations is THE apply path; a migration outside it never runs')
  check(`  …and sorts after every other migration there (floor ${others.slice(-1)[0] || 'none'})`,
    others.every(n => mine.slice(0, 14) > n.slice(0, 14)),
    `${mine} must sort above the floor so a from-zero rebuild replays it in production's order`)
  check('  …including the generated baseline',
    mine.slice(0, 14) > ((baselineFile().match(/([0-9]{14})_baseline/) || ['',''])[1]),
    'a migration that sorts before the baseline never runs on a fresh database')
  check('the migration adds no new TABLE (so no grants trap)',
    !/create table/i.test(mig),
    'a new table on Supabase inherits full grants from ALTER DEFAULT PRIVILEGES and must revoke them explicitly')
  check('the baseline still has exactly one payments kind CHECK',
    (base.match(/payments_kind_check/g) || []).length >= 1,
    'the constraint the migration alters must exist to be altered')
  check('the tip lookup index exists (the refund apportioner runs it per delivery)',
    /create index if not exists "payments_tip_intent_idx"/.test(mig),
    'without it every charge.refunded delivery scans the ledger')
}

// ═══════════════════════════════════════════════════════════════════════════
H('17. THE PARITY CONTRACT — this guard is actually wired up')
{
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
  eq('package.json wires verify:tips to this exact file',
    pkg.scripts['verify:tips'], 'tsx scripts/verify-tips.ts')
  check('  …so `npm run verify` picks it up',
    Object.keys(pkg.scripts).includes('verify:tips'),
    'verify-all enforces file↔script parity BEFORE any guard runs')
  check('the mutation harness is NOT a verify: entry',
    !Object.keys(pkg.scripts).some(k => k.startsWith('verify:') && k.includes('mutate')),
    'a mutation harness edits source files — it must never run inside the ordinary suite')
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(64)}`)
if (failures === 0) {
  console.log('  ✅ TIPS — a gratuity is money beside the invoice, never money in it')
  process.exit(0)
}
console.log(`  ❌ ${failures} FAILED`)
process.exit(1)
