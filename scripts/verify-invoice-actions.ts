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
// §2 pins the route and UI gates structurally, and — just as importantly — pins
// that the SIBLING doors still refuse, so the rule stays uniform instead of being
// re-litigated one surface at a time.

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
  // The two money buttons. Both gates live on one line each; assert the status
  // check sits in the same condition as the balance check.
  check('"Take payment" is hidden on a cancelled invoice',
    /inv\.status !== 'draft' && inv\.status !== 'cancelled' && invoiceBalance/.test(page), true)
  check('"Charge card" is hidden on a cancelled invoice',
    /cardCustomers\.has\(inv\.customer_id\) && inv\.job_id && inv\.status !== 'cancelled'/.test(page), true)
  check('a refused card charge says WHY instead of "could not charge"',
    /reason === 'cancelled'/.test(page) && /reactivate it first/i.test(page), true)
  // The siblings that were already right — pinned so the rule can't erode from
  // the other end.
  // "How much is still owed" is the question the list exists to answer, and the
  // card's headline figure is the invoice TOTAL. Overdue already appended the
  // remaining balance; Partially Paid is the same gap and must stay covered.
  check('both part-paid states show what is LEFT, from the ledger',
    /\(ds === 'overdue' \|\| ds === 'partial'\)[\s\S]{0,220}invoiceBalance\(inv, settings\)\.balance/.test(page), true)

  check('Send still refuses a cancelled invoice',
    /inv\.customer_id && inv\.status !== 'cancelled'/.test(page), true)
  check('Edit still refuses a cancelled invoice',
    /inv\.status !== 'cancelled' \? \[/.test(page), true)
}
{
  const controls = src('components/payments/InvoicePaymentControls.tsx')
  check('Record payment still refuses a cancelled invoice',
    /invoice\.status !== 'cancelled'/.test(controls), true)
}
{
  const panel = src('components/payments/DepositRequestPanel.tsx')
  check('Request deposit still refuses a cancelled invoice',
    /invoice\.status !== 'cancelled'/.test(panel), true)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✅' : '❌'} invoice actions: ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('verify:invoice-actions threw:', e); process.exit(1) })
