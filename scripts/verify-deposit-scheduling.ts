// ── Verify: deposit-gated scheduling — approved ≠ secured, and only the ledger says secured ─
//   npm run verify:deposit-scheduling
//
// WHY THIS SCRIPT EXISTS
// The scheduling gate stands between an approved quote and the calendar, and
// every way it can be wrong is money or trust: a requested deposit treated as
// collected books unsecured work; a partial payment treated as satisfied books
// it 60% unsecured; the WRONG option's price computes the wrong ask; a refunded
// deposit that leaves readiness true books work whose security was handed back.
// The brief names those four as the mutation matrix — each is asserted here
// directly against the REAL engine, so the regression cannot re-enter quietly.
//
// THE CANONICAL MODEL (lib/payments/depositGate.ts states it — do not relitigate):
//   • rule       = quotes.deposit_type/deposit_value      (percent | fixed; NULL = no gate)
//   • basis      = quotes.accepted_price ?? total          (the CONSENTED figure —
//                    for an options quote, the SELECTED option + travel, snapshotted
//                    by quote_apply_option_choice; alternatives can never reach it)
//   • required   = depositFromPercent(basis, %) | min(fixed, basis)   (ONE maths — the
//                    invoice deposit engine's own cents-once rounding, imported, never copied)
//   • collected  = Σ signed CASH rows (ledger isCashRow) with payments.quote_id —
//                    a Stripe charge, an owner-recorded e-transfer and a refund
//                    (negative row) land in one sum; the held-as-credit leg and
//                    credit applications are excluded by the same isCashRow that
//                    excludes them from every cash figure in the app
//   • satisfied  = outstanding ≤ $0.005 — derived on EVERY read, stored NOWHERE
//
// Runs the real engines against hand-built rows, then pins the structural facts
// that keep every door on the one engine. No network, no DB, no fixtures in prod
// (Session 33 is separately repairing fixture isolation — this guard deliberately
// writes nothing anywhere).

import { portalDataSql } from './lib/schema-source'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  collectedTowardQuote, depositBasis, depositRuleFromForm, gateBlocksScheduling,
  requiredDeposit, schedulingGate, schedulingPreferenceLine, validateDepositRule,
  type GateLedgerRow, type GateQuote,
} from '../src/lib/payments/depositGate'
import { depositFromPercent } from '../src/lib/payments/deposit'
// Session 122: the WORDS moved here. See the re-pointed check in section 7.
import { paymentTiming, approvedTimingLine } from '../src/lib/payments/paymentTiming'
import { isCashRow } from '../src/lib/payments/ledger'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
// Strip comments BEFORE any absence assertion — a comment saying "never do X"
// must not satisfy (or fail) a check about doing X. CRLF-safe: normalize \r\n
// first, because `.` does not match \r and a CRLF checkout otherwise disarms
// every `.*$` stripper (the crlf-strippers lesson).
const stripComments = (s: string) => s.replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/([^:'"])\/\/[^\n]*/g, '$1')

// ── Fixtures ─────────────────────────────────────────────────────────────────
// The brief's worked example: Budget $1,800 / Recommended $2,700 / Premium
// $3,600, customer chooses Recommended, rule = 50%. accepted_price is the
// consent snapshot the approval RPC wrote — 2700 (+$0 travel here).
const q = (over: Partial<GateQuote> = {}): GateQuote => ({
  status: 'accepted', total: 2700, accepted_price: 2700,
  deposit_type: 'percent', deposit_value: 50, deposit_override_at: null,
  ...over,
})
const cash = (amount: number, over: Partial<GateLedgerRow> = {}): GateLedgerRow =>
  ({ amount, kind: 'payment', provider: 'stripe', status: 'paid', ...over })
// The held-as-credit leg recordDeposit / the webhook writes BESIDE every cash leg.
const creditLeg = (amount: number): GateLedgerRow =>
  ({ amount, kind: 'credit', provider: 'credit', status: 'paid' })

console.log('\n■ 1. The four named regressions (each must FAIL if reintroduced)')
{
  // 1a. Deposit REQUESTED is not deposit COLLECTED. A rule with zero ledger rows
  //     must never read satisfied — this is the load-bearing distinction the
  //     whole feature exists to keep.
  const g = schedulingGate(q(), [])
  check('requested ≠ collected: a rule with no money is NOT satisfied', g.status !== 'satisfied' && g.status === 'awaiting',
    `status=${g.status}`)
  eq('requested ≠ collected: required is the full $1,350', g.required, 1350)
  eq('requested ≠ collected: outstanding is the full $1,350', g.outstanding, 1350)
  check('requested ≠ collected: the gate BLOCKS scheduling', gateBlocksScheduling(q(), g))

  // 1b. PARTIAL payment does not satisfy. $1,000 against $1,350 (of the $2,700
  //     example: quote pays 50% = $1,350; the brief's $1,000-of-$2,700 shape is
  //     run at 100% below so both partial geometries are pinned).
  const gp = schedulingGate(q(), [cash(1000), creditLeg(1000)])
  check('partial: $1,000 of $1,350 is NOT satisfied', gp.status === 'partial', `status=${gp.status}`)
  eq('partial: outstanding = $350', gp.outstanding, 350)
  check('partial: still blocks scheduling', gateBlocksScheduling(q(), gp))
  const gFull = schedulingGate(q({ deposit_type: 'percent', deposit_value: 100 }), [cash(1000), creditLeg(1000)])
  check('partial (100% rule): $1,000 of $2,700 → still required $1,700',
    gFull.status === 'partial' && gFull.outstanding === 1700, `status=${gFull.status} outstanding=${gFull.outstanding}`)

  // 1c. The UNSELECTED option must never drive the ask. basis = accepted_price
  //     (2700, the chosen Recommended). Premium (3600), Budget (1800), the sum
  //     (8100) and a later-edited total are all wrong answers.
  const chosen = q({ total: 3600 /* an edit moved the live total */ })
  eq('selected option drives the ask: basis = accepted_price 2700, never the moved total', depositBasis(chosen), 2700)
  eq('selected option drives the ask: required = 50% of 2700 = 1350', requiredDeposit(chosen), 1350)
  check('selected option drives the ask: never 50% of Premium (1800) or of the sum (4050)',
    requiredDeposit(chosen) !== 1800 && requiredDeposit(chosen) !== 4050)

  // 1d. A REFUNDED deposit un-satisfies. The webhook writes the refund as a
  //     negative cash row with the same quote_id; the signed sum nets to zero
  //     and readiness must fall with it — no stored flag survives to lie.
  const paidThenRefunded = [cash(1350), creditLeg(1350), cash(-1350, { provider: 'stripe' }), creditLeg(-1350)]
  const gr = schedulingGate(q(), paidThenRefunded)
  eq('refund: collected nets to $0', gr.collected, 0)
  check('refund: readiness is NOT satisfied after the money went back', gr.status === 'awaiting', `status=${gr.status}`)
  check('refund: the gate blocks scheduling again', gateBlocksScheduling(q(), gr))
  const gPartRefund = schedulingGate(q(), [cash(1350), creditLeg(1350), cash(-500)])
  check('partial refund: $850 held → partial, outstanding $500',
    gPartRefund.status === 'partial' && gPartRefund.outstanding === 500,
    `status=${gPartRefund.status} outstanding=${gPartRefund.outstanding}`)
}

console.log('\n■ 2. The maths is THE deposit engine\'s, never a second copy')
{
  // Identity with depositFromPercent for awkward percentages (cents rounded ONCE).
  for (const [basis, pct] of [[2700, 50], [333.33, 33], [101, 15], [4000, 100]] as const) {
    const viaGate = requiredDeposit({ status: 'accepted', accepted_price: basis, deposit_type: 'percent', deposit_value: pct })
    eq(`percent ${pct}% of ${basis} ≡ depositFromPercent`, viaGate, depositFromPercent(basis, pct))
  }
  // Fixed asks: stated dollars, clamped to the basis when one exists.
  eq('fixed $500 on a $2,700 job = $500', requiredDeposit(q({ deposit_type: 'fixed', deposit_value: 500 })), 500)
  eq('fixed $500 on a $300 job clamps to $300', requiredDeposit({ status: 'accepted', accepted_price: 300, deposit_type: 'fixed', deposit_value: 500 }), 300)
  // No rule = no gate = the quote behaves exactly as before this feature.
  const plain = schedulingGate({ status: 'accepted', accepted_price: 2700, deposit_type: null, deposit_value: null }, [])
  check('no rule: status none, nothing blocks', plain.status === 'none' && !gateBlocksScheduling({ status: 'accepted', deposit_type: null }, plain))
  eq('no rule: required $0', plain.required, 0)
  // A forged >100% percent computes NO ask (the DB refuses storing it).
  eq('forged 150% rule computes $0, not $4,050', requiredDeposit(q({ deposit_value: 150 })), 0)
}

console.log('\n■ 3. Overpayment, tolerance, and what counts as cash')
{
  // Overpayment satisfies — the extra is the credit ledger's story.
  const gOver = schedulingGate(q(), [cash(2000), creditLeg(2000)])
  check('overpayment: $2,000 against $1,350 IS satisfied', gOver.status === 'satisfied')
  eq('overpayment: outstanding floors at $0, never negative', gOver.outstanding, 0)
  // A cent of float noise cannot leave the customer 99.99% paid.
  const gCent = schedulingGate(q(), [cash(1349.996)])
  check('cent tolerance: $1,349.996 of $1,350 is satisfied', gCent.status === 'satisfied')
  // The held-as-credit leg does NOT double-count: cash+credit legs of one $1,350
  // deposit collect $1,350, not $2,700.
  eq('credit leg excluded: one deposit counts once', collectedTowardQuote([cash(1350), creditLeg(1350)]), 1350)
  // A credit APPLICATION (provider=credit payment row) never counts as new cash —
  // the same isCashRow rule every cash figure in the app runs on.
  eq('credit application excluded', collectedTowardQuote([cash(1350), { amount: 1350, kind: 'payment', provider: 'credit', status: 'paid' }]), 1350)
  check('the exclusion IS ledger.isCashRow, asked directly',
    !isCashRow({ kind: 'credit', provider: 'credit', status: 'paid' }) && !isCashRow({ kind: 'payment', provider: 'credit', status: 'paid' }) && isCashRow({ kind: 'payment', provider: 'stripe', status: 'paid' }))
  // Pending/failed rows are not money.
  eq('pending rows are not collected', collectedTowardQuote([cash(1350, { status: 'pending' })]), 0)
}

console.log('\n■ 4. The gate only ever gates the moment it should')
{
  const rows: GateLedgerRow[] = []
  // Pre-consent there is nothing to secure; post-schedule the decision is made.
  for (const [status, expect] of [['draft', false], ['sent', false], ['accepted', true], ['scheduled', false], ['declined', false], ['completed', false]] as const) {
    const quote = q({ status })
    eq(`status ${status}: blocksScheduling=${expect}`, gateBlocksScheduling(quote, schedulingGate(quote, rows)), expect)
  }
  // The override stamp reports, never waives: money still outstanding.
  const gOv = schedulingGate(q({ deposit_override_at: '2026-08-11T00:00:00Z' }), [])
  check('override: recorded, but the money is still owed', gOv.overridden && gOv.outstanding === 1350)
}

console.log('\n■ 5. The owner\'s rule input — one mapping, fail-closed')
{
  check('percent 0 refused', !validateDepositRule('percent', 0).ok)
  check('percent 101 refused', !validateDepositRule('percent', 101).ok)
  check('percent 100 allowed (pay in full up front)', validateDepositRule('percent', 100).ok)
  check('fixed $0 refused', !validateDepositRule('fixed', 0).ok)
  check('fixed NaN refused', !validateDepositRule('fixed', Number('x')).ok)
  const off = depositRuleFromForm('', 50)
  check('toggle off → both columns null (the DB\'s no-rule shape)', off.ok && off.patch.deposit_type === null && off.patch.deposit_value === null)
  const on = depositRuleFromForm('percent', 50)
  check('percent 50 → stored pair', on.ok && on.patch.deposit_type === 'percent' && on.patch.deposit_value === 50)
  check('invalid input is an ERROR, never silently dropped', !depositRuleFromForm('percent', 150).ok)
  // The preference line never invents content.
  eq('no preference → no line', schedulingPreferenceLine({}, d => d), null)
  eq('preference line names both dates + timing',
    schedulingPreferenceLine({ preferred_date: 'Aug 18', preferred_date_2: 'Aug 20', preferred_timing: 'afternoon' }, d => d),
    '1st: Aug 18 · 2nd: Aug 20 · afternoon preferred')
}

console.log('\n■ 6. Structural: every door is on the ONE engine')
{
  const route = stripComments(read('src/app/api/portal/quote-deposit/route.ts'))
  check('charge route derives cents from the gate\'s outstanding',
    /chargeCents:\s*Math\.round\(gate\.outstanding\s*\*\s*100\)/.test(route))
  check('charge route never reads an amount from the client',
    !/body\.(amount|chargeCents|price|total)/.test(route))
  check('charge route resolves the customer from the TOKEN, server-side',
    /customer_portal_tokens/.test(route) && /eq\('customer_id',\s*t\.customer_id\)/.test(route))
  check('charge route requires an approved (or override-scheduled) quote',
    /'accepted'/.test(route) && /'scheduled'/.test(route))
  check('charge route refuses when the gate is already satisfied',
    /gate\.outstanding\s*<=\s*0/.test(route))

  const webhook = stripComments(read('src/app/api/stripe/webhook/route.ts'))
  check('webhook: quote-deposit branch is keyed on metadata.quote_deposit',
    /metadata\?\.quote_deposit\s*===\s*'1'/.test(webhook))
  check('webhook: the invoice branch is EXCLUDED from quote-deposit sessions',
    /metadata\?\.quote_deposit\s*!==\s*'1'/.test(webhook))
  check('webhook: writes BOTH ledger legs (cash + held-as-credit) with quote_id',
    /kind:\s*'payment',\s*provider:\s*'stripe'/.test(webhook) && /kind:\s*'credit',\s*provider:\s*'credit'/.test(webhook)
    && /stripe_session_id:\s*`credit:\$\{s\.id\}`/.test(webhook))
  check('webhook: refund branch reverses a QUOTE deposit (both legs, quote-scoped)',
    /!p\.invoice_id\s*&&\s*p\.quote_id\s*&&\s*refunded\s*>\s*0/.test(webhook)
    && /refund-credit:\$\{ch\.id\}/.test(webhook))
  check('webhook: both deposit legs are idempotent on stripe_session_id',
    (webhook.match(/onConflict:\s*'stripe_session_id',\s*ignoreDuplicates:\s*true/g) || []).length >= 4)

  const ledger = stripComments(read('src/lib/payments/ledger.ts'))
  check('recordDeposit welds BOTH legs to the booking (quote_id in the shared base)',
    /quote_id:\s*p\.quoteId\s*\?\?\s*null/.test(ledger))

  const engine = stripComments(read('src/lib/payments/depositGate.ts'))
  check('engine imports THE percent maths from the deposit engine (no second copy)',
    /import\s*\{[^}]*depositFromPercent[^}]*\}\s*from\s*'@\/lib\/payments\/deposit'/.test(engine))
  check('engine has no local percent arithmetic of its own',
    !/\*\s*p(ct|ercent)?\s*\/\s*100/.test(engine.replace(/depositFromPercent[\s\S]*?\n/g, '')))
  check('engine sums through ledger.isCashRow, not its own cash rule',
    /filter\(isCashRow\)/.test(engine))
  check('no stored readiness: the engine never writes a deposit_paid/satisfied column',
    !/deposit_paid|deposit_satisfied|is_secured/.test(engine))

  const model = stripComments(read('src/app/portal/[token]/model.ts'))
  check('portal model derives the row from schedulingGate (same engine as the route)',
    /schedulingGate\(/.test(model) && /from '@\/lib\/payments\/depositGate'/.test(model))

  const priorities = stripComments(read('src/lib/dashboard/priorities.ts'))
  check('command centre filters schedule-now through gateBlocksScheduling',
    /gateBlocksScheduling\(/.test(priorities))

  const quotePage = stripComments(read('src/app/dashboard/quotes/[id]/page.tsx'))
  check('quote page schedule button re-derives the gate at click time + confirms the override',
    /loadQuoteDepositRows\(/.test(quotePage) && /Schedule without deposit/.test(quotePage) && /stampDepositOverride\(/.test(quotePage))
  const schedulePage = stripComments(read('src/app/dashboard/schedule/page.tsx'))
  check('schedule page ?quote= door runs the same guard',
    /gateBlocksScheduling\(/.test(schedulePage) && /stampDepositOverride\(/.test(schedulePage))

  const canonical = portalDataSql()
  check('portal RPC serves the rule + preference + accepted_price on quotes',
    /qt\.accepted_price,\s*qt\.deposit_type,\s*qt\.deposit_value/.test(canonical)
    && /qt\.preferred_date,\s*qt\.preferred_date_2,\s*qt\.preferred_timing,\s*qt\.preferred_note/.test(canonical))
  check('portal RPC serves payments.quote_id (the gate\'s portal-side input)',
    /invoice_id,\s*quote_id,\s*created_at\s+from\s+public\.payments/.test(canonical))

  const migration = read('supabase/archive/run/RUN-2026-08-11-deposit-gated-scheduling.sql')
  check('preference writer is token-scoped and accepted-only',
    /portal_set_scheduling_preference/.test(migration)
    && /customer_id\s*=\s*v_customer/.test(migration)
    && /status\s*=\s*'accepted'/.test(migration))
  check('preference writer refuses past dates server-side',
    /p_date\s*<\s*current_date\s*-\s*1/.test(migration))
  check('grants name every role explicitly (the ALTER-DEFAULT-PRIVILEGES lesson)',
    /revoke all on function public\.portal_set_scheduling_preference[\s\S]*?from public, anon, authenticated, service_role/.test(migration))
  check('payments.quote_id FK is composite (user_id, quote_id) — cross-tenant attachment impossible',
    /foreign key \(user_id, quote_id\) references public\.quotes \(user_id, id\)/.test(migration))
  check('quote deletion releases the link, never the money (SET NULL (quote_id))',
    /on delete set null \(quote_id\)/.test(migration))
}

console.log('\n■ 7. The five states can never collapse (vocabulary pins)')
{
  const billing = read('src/app/portal/[token]/components/BillingTab.tsx')
  check('portal says the preference is a request, not a booking',
    /request, not a booking/i.test(billing) && /confirm the final date/i.test(billing))
  // ⭐ RE-POINTED, not relaxed (Session 122). This assertion used to grep the
  // sentence "…confirmed after the required deposit is received" out of
  // BillingTab, which pinned the copy to that FILE. Session 122 moved every
  // payment-timing sentence into lib/payments/paymentTiming so the quote card
  // could stop promising "an invoice once the work is done" on a gated quote —
  // a strictly better home, which this grep would have blocked.
  //
  // The CONTRACT is unchanged and still proven, now in two halves: the panel
  // renders the model's one line rather than composing its own, and the engine
  // that produces that line genuinely tells an approved-but-unpaid customer the
  // booking waits on the deposit. Both must hold.
  check('portal deposit copy: approved now, and the panel defers to THE timing engine',
    /approved/.test(billing) && /\{d\.depositTimingLine\}/.test(billing)
    && !/after the required deposit is received/i.test(stripComments(billing)),
    'BillingTab must render d.depositTimingLine, not a private sentence')
  check('…and that engine says the deposit is what secures the booking',
    /secures your booking/i.test(
      approvedTimingLine(paymentTiming(q()), { outstanding: 1350, status: 'awaiting' })))
  // "Deposit received" state exists and is distinct from "Scheduled": the
  // satisfied panel says ready-to-schedule language, never claims a booking.
  check('satisfied panel says ready-to-schedule, not scheduled',
    /Ready to schedule — we’ll confirm the final date/.test(billing))
  const home = read('src/app/portal/[token]/components/HomeTab.tsx')
  check('home hero never claims "we\'re arranging" while the deposit is owed',
    /deposit above secures your booking/i.test(home))
}

console.log(failures > 0 ? `\n✗ ${failures} FAILURE(S)` : '\n✓ all deposit-scheduling checks passed')
process.exit(failures > 0 ? 1 : 0)
