// ── Invoice action guards — npm run verify:invoice-actions ──────────────────
//
// WHY THIS EXISTS
// A CANCELLED invoice is the owner saying "this money is not owed". Cancelling is
// only permitted while NOTHING has been paid (ledger.cancelInvoice enforces it),
// so a cancelled invoice still carries its full balance — and every "is there
// something to collect?" test in the app therefore passes on it.
//
// That is the trap. Four sibling doors already refused cancelled invoices — Send,
// Edit, Record payment, Request deposit — and so did the customer's own portal
// (canPay). But the two doors that actually MOVE MONEY did not:
//
//   • "Take payment"  → /api/payments/checkout minted a live Stripe link for a
//                       withdrawn bill, which the customer could reasonably pay
//   • "Charge card"   → attemptAutoPayCharge ran all the way to a real
//                       off-session charge on the saved card; the only status it
//                       excluded was 'paid'
//
// Production had 2 cancelled invoices carrying a live balance when this was found.
// The customer could not pay them; the owner could charge them.
//
// §1 drives the REAL engine with a fake Supabase client (attemptAutoPayCharge
// takes `sb` as a parameter, so no network and no mocking framework is needed).
// §2 pins the route and UI gates, and — just as importantly — pins that the
// SIBLING doors still refuse, so the rule stays uniform instead of being
// re-litigated one surface at a time.
//
// ⭐ UPDATED when the invoice detail got a single action ladder: the six inline
// copies of `status !== 'cancelled' && balance > 0` that this file used to grep
// for became ONE predicate, `invoiceDoors().owes`, which every door ANDs onto.
// So §2 now DRIVES that predicate through the real engines for every state
// instead of pattern-matching six conditions — a stronger check, because a
// regex can only see the copies it was written to expect, and the seventh copy
// is the one that goes wrong. The structural half is now "no door re-derives
// the rule inline", which is what actually has to stay true.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

// The engine refuses before Stripe is ever reached, but its FIRST two gates are
// env-based — set them so the test exercises the invoice rules, not the config.
process.env.STRIPE_SECRET_KEY = 'sk_test_verify_invoice_actions'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_verify_invoice_actions'

// Imported AFTER the env is set: config.ts reads process.env at call time, but
// keeping the order explicit makes the dependency obvious to the next reader.
import { attemptAutoPayCharge } from '../src/lib/payments/autopay'
import { invoiceDoors, invoiceNextActions } from '../src/lib/payments/invoiceActions'
import { invoiceBalance } from '../src/lib/payments/ledger'

// ── A fake Supabase client ───────────────────────────────────────────────────
// Only the shape attemptAutoPayCharge actually uses: from(table) →
// .select().eq().eq().maybeSingle(). Any table it asks for beyond `invoices`
// means the guard did NOT fire, so those return null and the call fails loudly
// rather than silently taking a different path.
function fakeSupabase(invoice: Record<string, unknown> | null) {
  const tablesTouched: string[] = []
  const chain = (data: unknown) => {
    const c: Record<string, unknown> = {}
    c.select = () => c; c.eq = () => c; c.limit = () => c
    c.maybeSingle = async () => ({ data, error: null })
    c.single = async () => ({ data, error: null })
    c.order = () => c
    return c
  }
  return {
    tablesTouched,
    from(table: string) {
      tablesTouched.push(table)
      return chain(table === 'invoices' ? invoice : null)
    },
  } as unknown as Parameters<typeof attemptAutoPayCharge>[0] & { tablesTouched: string[] }
}

const invoice = (o: Record<string, unknown>) => ({
  id: 'inv-1', amount: 140, amount_paid: 0, discount_type: null, discount_value: null,
  status: 'unpaid', job_id: 'job-1', customer_id: 'cust-1',
  invoice_number: 'INV-0001', service_type: 'Yard Cleanup', internal_notes: null, ...o,
})

// ═══════════════════════════════════════════════════════════════════════════
async function main() {
H('1. THE ENGINE — a cancelled invoice is never charged')

{
  // The exact production shape: cancelled, nothing paid, full balance intact.
  const sb = fakeSupabase(invoice({ status: 'cancelled' }))
  const res = await attemptAutoPayCharge(sb, { invoiceId: 'inv-1', userId: 'u-1', manual: true })
  check('cancelled → skipped with a reason that names WHY',
    res, { result: 'skipped', reason: 'cancelled' })
  // Proof the guard fired EARLY: reaching the customer/job lookups would mean the
  // refusal came from something incidental (no card, not recurring) rather than
  // from the cancellation — which would silently start charging again the moment
  // that incidental condition changed.
  check('…and it refused before looking up the job or the customer’s card',
    sb.tablesTouched, ['invoices'])
}
{
  const sb = fakeSupabase(invoice({ status: 'cancelled', amount_paid: 0, job_id: 'job-1' }))
  const res = await attemptAutoPayCharge(sb, { invoiceId: 'inv-1', userId: 'u-1' })
  check('the nightly cron path refuses it too (not just the manual button)',
    res, { result: 'skipped', reason: 'cancelled' })
}
{
  const sb = fakeSupabase(invoice({ status: 'paid' }))
  check('the pre-existing paid guard still fires (unchanged)',
    await attemptAutoPayCharge(sb, { invoiceId: 'inv-1', userId: 'u-1' }),
    { result: 'skipped', reason: 'already-paid' })
}
{
  // A live invoice must still reach the LATER gates — the fix must not become a
  // blanket refusal. This one has no customer row in the fake, so it stops there,
  // which proves the cancelled guard let it through.
  const sb = fakeSupabase(invoice({ status: 'unpaid' }))
  const res = await attemptAutoPayCharge(sb, { invoiceId: 'inv-1', userId: 'u-1' })
  check('an UNPAID invoice still passes the status gates and proceeds',
    res.reason !== 'cancelled' && res.reason !== 'already-paid', true)
  check('…reaching the job/customer lookups it is supposed to reach',
    sb.tablesTouched.includes('jobs'), true)
}
{
  const sb = fakeSupabase(null)
  check('a missing invoice is still its own distinct reason',
    await attemptAutoPayCharge(sb, { invoiceId: 'nope', userId: 'u-1' }),
    { result: 'skipped', reason: 'no-invoice' })
}

// ═══════════════════════════════════════════════════════════════════════════
H('2. THE OTHER DOORS — one rule, every surface')

{
  const route = src('app/api/payments/checkout/route.ts')
  check('the checkout route refuses a cancelled invoice',
    /invoice\.status === 'cancelled'/.test(route), true)
  check('…with a 409 and a message naming the fix, not a generic failure',
    /cancelled[\s\S]{0,120}409/.test(route) && /reactivate/i.test(route), true)
  check('…and it still never takes the amount from the request body',
    /body\.(amount|amountCents|chargeCents)/.test(route), false)
}
{
  const page = src('app/dashboard/invoices/page.tsx')
  check('a refused card charge says WHY instead of "could not charge"',
    /reason === 'cancelled'/.test(page) && /reactivate it first/i.test(page), true)
  // The manual charge shares the AutoPay engine, which deliberately charges the
  // FULL BALANCE, never the deposit (its one-charge-per-invoice key would make
  // the remainder uncollectable). A confirm quoting depositChargeAmount would
  // name a figure that is not about to leave the customer's card.
  check('the charge-card confirm quotes the balance, not the deposit',
    /Charge \$\{formatCurrency\(invoiceBalance\(inv, settings\)\.balance\)\}/.test(page), true)
}

// ── EVERY money door, driven through the ONE rule ───────────────────────────
// A cancelled invoice keeps its whole balance, so `balance > 0` is TRUE on it.
// These assertions are what stops that from reopening a collection door.
{
  const S = { gst_percent: 5 }
  const base = {
    amount: 4000, amount_paid: 0, discount_type: null, discount_value: null,
    due_date: '2026-09-01', deposit_amount: null, deposit_requested_at: null,
    customer_id: 'c1', job_id: 'j1', status: 'sent',
  }
  const ctx = { paymentsEnabled: true, hasSavedCard: true, hasPayments: false }
  const doorsFor = (over: Record<string, unknown>) => invoiceDoors({ ...base, ...over } as never, S, ctx)

  // The trap itself, stated as a test: the balance is real, the collectability is not.
  const cancelled = { ...base, status: 'cancelled' }
  check('a cancelled invoice still carries its full balance (the trap is real)',
    invoiceBalance(cancelled as never, S).balance, 4200)
  const cd = doorsFor({ status: 'cancelled' })
  check('…and NOTHING is collectable on it',
    { owes: cd.owes, record: cd.canRecord, cardLink: cd.canCardLink, charge: cd.canChargeSavedCard, deposit: cd.canAskDeposit, send: cd.canSend, edit: cd.canEdit },
    { owes: false, record: false, cardLink: false, charge: false, deposit: false, send: false, edit: false })

  // …while an ordinary issued invoice opens every one of them, so the guard above
  // cannot be satisfied by a predicate that simply returns false.
  const sd = doorsFor({})
  check('an issued invoice with a balance opens every door',
    { owes: sd.owes, record: sd.canRecord, cardLink: sd.canCardLink, charge: sd.canChargeSavedCard, deposit: sd.canAskDeposit, send: sd.canSend, edit: sd.canEdit },
    { owes: true, record: true, cardLink: true, charge: true, deposit: true, send: true, edit: true })

  // The remaining per-door rules, each one a real product decision.
  check('a DRAFT has no card link — the customer has no invoice to pay yet',
    doorsFor({ status: 'draft' }).canCardLink, false)
  check('…but a draft can still be recorded against (cash in the driveway)',
    doorsFor({ status: 'draft' }).canRecord, true)
  check('a settled invoice offers no collection door',
    (() => { const d = doorsFor({ status: 'paid', amount_paid: 4200 }); return { owes: d.owes, record: d.canRecord, cardLink: d.canCardLink } })(),
    { owes: false, record: false, cardLink: false })
  check('a part-paid invoice still collects the remainder',
    doorsFor({ status: 'partial', amount_paid: 1500 }).canRecord, true)
  check('no saved card → no charge-card door',
    invoiceDoors(base as never, S, { ...ctx, hasSavedCard: false }).canChargeSavedCard, false)
  check('no job (one-off invoice) → no charge-card door',
    doorsFor({ job_id: null }).canChargeSavedCard, false)
  check('Stripe not configured → neither card door',
    (() => { const d = invoiceDoors(base as never, S, { ...ctx, paymentsEnabled: false }); return { cardLink: d.canCardLink, charge: d.canChargeSavedCard } })(),
    { cardLink: false, charge: false })
  check('no customer → nothing can be sent',
    doorsFor({ customer_id: null }).canSend, false)
  check('an invoice that already has a deposit request cannot be asked twice',
    doorsFor({ deposit_amount: 2100 }).canAskDeposit, false)

  // ⭐ The regression this pass FIXED: a deposit request survives its invoice
  // being cancelled, and the old panel kept offering "Send request" on it — a
  // collection ask, over the owner's name, for a bill they had withdrawn.
  check('a deposit ask on a CANCELLED invoice cannot be sent',
    (() => {
      const n = invoiceNextActions({ ...base, status: 'cancelled', deposit_amount: 2100 } as never, S, '2026-08-10', ctx)
      return { primary: n.primary.kind, secondary: n.secondary }
    })(),
    { primary: 'none', secondary: null })
}

// ── …and no door re-derives the rule inline ─────────────────────────────────
// The point of one predicate is that there is one place to be right. A hand-
// written `status !== 'cancelled' && balance > 0` beside a button is how the
// sixth copy drifts from the other five.
{
  const detail = src('components/payments/InvoiceDetail.tsx')
  check('the detail asks invoiceDoors instead of testing status by hand',
    /invoiceDoors\(inv, settings, ctx\)/.test(detail), true)
  check('…and does not re-derive collectability at a button',
    /status !== 'cancelled'[\s\S]{0,40}balance > 0/.test(detail), false)
  for (const [door, needle] of [
    ['the card link', 'doors.canCardLink'],
    ['charge-saved-card', 'doors.canChargeSavedCard'],
    ['record payment', 'doors.canRecord'],
    ['the deposit ask', 'doors.canAskDeposit'],
    ['send', 'doors.canSend'],
    ['edit', 'doors.canEdit'],
  ] as const) {
    check(`${door} is gated on the shared rule`, detail.includes(needle), true)
  }

  const controls = src('components/payments/InvoicePaymentControls.tsx')
  check('Record payment still refuses a cancelled invoice at its own door',
    /invoice\.status !== 'cancelled'/.test(controls), true)
  const panel = src('components/payments/DepositRequestPanel.tsx')
  check('the deposit form still refuses a cancelled invoice at its own door',
    /invoice\.status === 'cancelled'/.test(panel), true)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✅' : '❌'} invoice actions: ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('verify:invoice-actions threw:', e); process.exit(1) })
