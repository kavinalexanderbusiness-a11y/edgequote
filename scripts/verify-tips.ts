import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { validateTipRequest, splitRefundCents } from '../src/lib/payments/tips'
import { createInvoiceCheckoutSession } from '../src/lib/stripe/config'
import { summarizeTransactions, ledgerRowType } from '../src/lib/payments/analytics'
import type { Payment } from '../src/types'

let passed = 0
const check = (name: string, fn: () => void | Promise<void>) => Promise.resolve().then(fn).then(() => { passed++; console.log(`✓ ${name}`) })

async function main() {
  await check('preset tips derive from the trusted base', () => {
    assert.deepEqual(validateTipRequest({ kind: 'percent', value: 10 }, 12_345), { cents: 1235, selection: '10' })
    assert.deepEqual(validateTipRequest({ kind: 'percent', value: 0 }, 12_345), { cents: 0, selection: 'none' })
  })
  await check('custom tip is integer cents and capped at base / CAD $500', () => {
    assert.deepEqual(validateTipRequest({ kind: 'custom', cents: 2500 }, 10_000), { cents: 2500, selection: 'custom' })
    assert.throws(() => validateTipRequest({ kind: 'custom', cents: 10_001 }, 10_000))
    assert.throws(() => validateTipRequest({ kind: 'custom', cents: 50_001 }, 100_000))
    assert.throws(() => validateTipRequest({ kind: 'percent', value: 25 }, 10_000))
    assert.throws(() => validateTipRequest({ kind: 'custom', cents: 1.2 }, 10_000))
  })
  await check('refunds reverse tip first, then invoice payment', () => {
    assert.deepEqual(splitRefundCents(1_000, 10_000, 1_500), { tipCents: 1_000, baseCents: 0 })
    assert.deepEqual(splitRefundCents(2_000, 10_000, 1_500), { tipCents: 1_500, baseCents: 500 })
    assert.deepEqual(splitRefundCents(99_999, 10_000, 1_500), { tipCents: 1_500, baseCents: 10_000 })
  })
  await check('Stripe Checkout gets separate base/tip line items and metadata', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_fixture'
    let form: URLSearchParams | null = null
    const oldFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      form = init?.body as URLSearchParams
      return new Response(JSON.stringify({ url: 'https://checkout.stripe.test/session' }), { status: 200 })
    }) as typeof fetch
    try {
      const result = await createInvoiceCheckoutSession({ id: 'inv', invoice_number: 'INV-1', service_type: 'Cleanup', amount: 100, user_id: 'u', customer_id: 'c' }, {
        successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel', chargeCents: 10_000,
        tipCents: 1_500, tipSelection: '15', stripeCustomerId: 'cus_fixture', offerSaveCard: true,
      })
      assert.equal(result.ok, true)
      const params = form as unknown as URLSearchParams
      assert.equal(params.get('line_items[0][price_data][unit_amount]'), '10000')
      assert.equal(params.get('line_items[1][price_data][product_data][name]'), 'Tip')
      assert.equal(params.get('line_items[1][price_data][unit_amount]'), '1500')
      assert.equal(params.get('metadata[base_amount_cents]'), '10000')
      assert.equal(params.get('metadata[tip_amount_cents]'), '1500')
      assert.equal(params.get('payment_intent_data[metadata][tip_amount_cents]'), '1500')
      assert.equal(params.get('saved_payment_method_options[payment_method_save]'), 'enabled')
    } finally { globalThis.fetch = oldFetch; delete process.env.STRIPE_SECRET_KEY }
  })
  await check('tips are visible but excluded from invoice cash/revenue summary', () => {
    const rows = [
      { kind: 'payment', provider: 'stripe', status: 'paid', amount: 100 },
      { kind: 'tip', provider: 'stripe', status: 'paid', amount: 15 },
      { kind: 'tip', provider: 'stripe', status: 'paid', amount: -5 },
    ] as Payment[]
    const result = summarizeTransactions(rows)
    assert.equal(result.collected, 100)
    assert.equal(result.net, 100)
    assert.equal(result.tips, 10)
    assert.equal(result.tipCount, 1)
    assert.equal(ledgerRowType(rows[1]), 'Tip')
  })
  await check('webhook writes distinct idempotent payment and tip rows', () => {
    const webhook = fs.readFileSync(path.join(process.cwd(), 'src/app/api/stripe/webhook/route.ts'), 'utf8')
    assert.match(webhook, /kind: 'tip'/)
    assert.match(webhook, /stripe_session_id: `tip:\$\{s\.id\}`/)
    assert.match(webhook, /baseCents \+ tipCents !== totalCents/)
    assert.match(webhook, /hasAmountSplit \? Number\(s\.metadata\?\.base_amount_cents\) : totalCents/)
    assert.match(webhook, /splitRefundCents/)
  })
  await check('migration permits tip while invoice recompute remains payment-only', () => {
    const migration = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20260922004851_add_payment_tip_kind.sql'), 'utf8')
    const baseline = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20260830150001_baseline.sql'), 'utf8')
    assert.match(migration, /'tip'::text/)
    assert.match(baseline, /p\.kind = 'payment' and p\.status = 'paid'/)
  })
  await check('AutoPay stays off-session and contains no tip path', () => {
    const stripe = fs.readFileSync(path.join(process.cwd(), 'src/lib/stripe/config.ts'), 'utf8')
    const autoPay = stripe.slice(stripe.indexOf('export async function chargeSavedCardOffSession'))
    assert.match(autoPay, /off_session', 'true'/)
    assert.doesNotMatch(autoPay, /tipCents|tip_amount_cents|line_items\[1\]/)
  })
  console.log(`\n${passed} tip-support checks passed.`)
}

main().catch(err => { console.error(err); process.exitCode = 1 })
