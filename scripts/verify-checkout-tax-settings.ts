// Execute the real owner checkout route and money helpers with synthetic I/O.
// All imports in the route are explicitly supplied; no Supabase/Stripe client,
// credentials, network, customer writes or real payment sessions are used.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { depositChargeAmount } from '../src/lib/payments/deposit'
import { validateTipRequest } from '../src/lib/payments/tips'

const source = readFileSync('src/app/api/payments/checkout/route.ts', 'utf8')
const executable = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

type Row = Record<string, unknown>
type Result = { data: unknown; error: { message: string } | null }
type Response = { status: number; body: Row }
type Options = {
  settings?: { gst_percent: number | string | null } | null
  settingsError?: boolean
  invoice?: Row | null
  signedIn?: boolean
  capable?: boolean
  stripeEnabled?: boolean
  customer?: Row | null
  customerId?: string | null
  stripeFailure?: boolean
}
const invoice = {
  id: 'fixture-invoice', user_id: 'fixture-owner', customer_id: 'fixture-customer',
  invoice_number: 'TEST-1', service_type: 'Synthetic service', status: 'sent',
  amount: 1000, amount_paid: null, discount_type: null, discount_value: null,
  deposit_amount: null, deposit_requested_at: null,
  customers: { email: 'fixture@example.invalid' },
}

function fixture(options: Options = {}) {
  const reads: string[] = []
  const ensures: Row[] = []
  const sessions: Row[] = []
  let clients = 0
  let settings: Result = {
    data: options.settings === undefined ? { gst_percent: 5 } : options.settings,
    error: options.settingsError ? { message: 'Synthetic private database error' } : null,
  }
  const supabase = {
    auth: { getUser: async () => ({ data: { user: options.signedIn === false ? null : { id: 'fixture-owner' } } }) },
    from(table: string) {
      assert.ok(['invoices', 'business_settings', 'customers'].includes(table), `unexpected table: ${table}`)
      reads.push(table)
      const filters: Row = {}
      const query = {
        select(columns: string) {
          if (table === 'business_settings') assert.equal(columns, 'gst_percent')
          return query
        },
        eq(column: string, value: unknown) { filters[column] = value; return query },
        async maybeSingle(): Promise<Result> {
          // These reads must remain scoped to the owner even with a valid invoice ID.
          assert.deepEqual(filters, table === 'business_settings'
            ? { user_id: 'fixture-owner' }
            : { id: table === 'invoices' ? 'fixture-invoice' : 'fixture-customer', user_id: 'fixture-owner' })
          if (table === 'business_settings') return settings
          return {
            data: table === 'invoices'
              ? options.invoice === null ? null : { ...invoice, ...options.invoice }
              : options.customer === undefined ? { id: 'fixture-customer', email: 'fixture@example.invalid' } : options.customer,
            error: null,
          }
        },
      }
      return query
    },
  }
  const modules: Record<string, unknown> = {
    'next/server': { NextResponse: { json: (body: Row, init?: { status: number }) => ({ body, status: init?.status ?? 200 }) } },
    '@/lib/supabase/server': { createClient: async () => { clients++; return supabase } },
    '@/lib/stripe/config': {
      stripeEnabled: () => options.stripeEnabled !== false,
      createInvoiceCheckoutSession: async (actualInvoice: Row, params: Row) => {
        assert.equal(actualInvoice.id, 'fixture-invoice')
        sessions.push(params)
        return options.stripeFailure
          ? { ok: false, error: 'Synthetic checkout failure' }
          : { ok: true, url: 'https://checkout.example.invalid/synthetic' }
      },
    },
    '@/lib/payments/cards': {
      ensureStripeCustomerId: async (client: unknown, customer: Row, scope: Row) => {
        assert.equal(client, supabase)
        assert.equal(scope.userId, 'fixture-owner')
        ensures.push(customer)
        return { id: options.customerId === undefined ? 'cus_synthetic' : options.customerId }
      },
    },
    '@/lib/payments/deposit': { depositChargeAmount },
    '@/lib/payments/tips': { validateTipRequest },
    '@/lib/capabilities': {
      tenantCapabilities: async (client: unknown, userId: string) => {
        assert.equal(client, supabase)
        assert.equal(userId, 'fixture-owner')
        return { onlinePayments: options.capable !== false }
      },
      CAPABILITY_MESSAGE: { payments: 'Synthetic payments capability denied' },
    },
    '@/lib/appOrigin': { appOrigin: () => 'https://app.example.invalid' },
  }
  const exports: { POST?: (req: unknown) => Promise<Response> } = {}
  runInNewContext(executable, {
    exports,
    require(id: string) {
      assert.ok(Object.hasOwn(modules, id), `unexpected import: ${id}`)
      return modules[id]
    },
    // Share Error so the real tip helper's error follows the route's instanceof branch.
    Error,
  })
  assert.ok(exports.POST, 'route exports POST')
  const post = exports.POST
  return {
    reads, ensures, sessions,
    clients: () => clients,
    recoverSettings() { settings = { data: { gst_percent: 5 }, error: null } },
    run: (body: Row = { invoiceId: 'fixture-invoice' }) => post({ json: async () => body }),
  }
}

type Fixture = ReturnType<typeof fixture>
function noCustomerOrCheckout(f: Fixture) {
  assert.ok(!f.reads.includes('customers'), 'must stop before customer lookup')
  assert.equal(f.ensures.length, 0, 'must stop before customer creation')
  assert.equal(f.sessions.length, 0, 'must stop before Stripe checkout')
}
let passed = 0
async function check(name: string, run: () => Promise<void>) {
  await run()
  passed++
  console.log(`  PASS ${name}`)
}
async function charged(options: Options, cents: number, body?: Row) {
  const f = fixture(options)
  const response = await f.run(body)
  assert.equal(response.status, 200)
  assert.equal(response.body.url, 'https://checkout.example.invalid/synthetic')
  assert.equal(f.sessions.length, 1)
  assert.equal(f.sessions[0].chargeCents, cents)
  return f
}

async function main() {
  for (const data of [null, { gst_percent: 5 }]) {
    await check(`settings error with ${data === null ? 'null' : 'partial'} data blocks all customer/Stripe work`, async () => {
      const f = fixture({ settings: data, settingsError: true })
      const response = await f.run()
      assert.equal(response.status, 502)
      assert.match(String(response.body.error), /Could not load payment settings.*try again/i)
      assert.ok(!('url' in response.body))
      assert.doesNotMatch(JSON.stringify(response.body), /private database/)
      assert.deepEqual(f.reads, ['invoices', 'business_settings'])
      noCustomerOrCheckout(f)
    })
  }
  await check('retry after settings recovery computes the full synthetic GST amount', async () => {
    const f = fixture({ settings: null, settingsError: true })
    assert.equal((await f.run()).status, 502)
    noCustomerOrCheckout(f)
    f.recoverSettings()
    assert.equal((await f.run()).status, 200)
    assert.equal(f.sessions.length, 1)
    assert.equal(f.sessions[0].chargeCents, 105000)
    assert.equal(f.ensures.length, 1)
  })
  for (const settings of [null, { gst_percent: null }, { gst_percent: 0 }, { gst_percent: '0' }]) {
    await check(`successful settings ${JSON.stringify(settings)} retain zero-tax behavior`, async () => {
      await charged({ settings }, 100000)
    })
  }
  await check('numeric GST includes tax before creating checkout', async () => { await charged({}, 105000) })
  await check('PostgREST numeric strings and null paid amounts retain money coercion', async () => {
    await charged({ settings: { gst_percent: '5' }, invoice: { amount: '1000', amount_paid: null } }, 105000)
  })
  await check('partial payment subtracts money already received', async () => {
    await charged({ invoice: { amount_paid: '250' } }, 80000)
  })
  await check('outstanding deposit retains the deposit amount and label', async () => {
    const f = await charged({ invoice: { amount_paid: 100, deposit_amount: '300', deposit_requested_at: '2026-01-01' } }, 20000)
    assert.equal(f.sessions[0].chargeLabel, 'Deposit — Invoice TEST-1')
  })
  await check('covered deposit collects the remaining taxed invoice balance', async () => {
    const f = await charged({ invoice: { amount_paid: 300, deposit_amount: 300, deposit_requested_at: '2026-01-01' } }, 75000)
    assert.equal(f.sessions[0].chargeLabel, null)
  })
  await check('deposit never exceeds the real GST-inclusive balance', async () => {
    await charged({ invoice: { deposit_amount: 2000, deposit_requested_at: '2026-01-01' } }, 105000)
  })
  for (const discount_type of ['amount', 'percent']) {
    await check(`${discount_type} discount already included in stored net amount is not applied twice`, async () => {
      await charged({ invoice: { amount: 900, discount_type, discount_value: discount_type === 'amount' ? 100 : 10 } }, 94500)
    })
  }
  await check('percentage tips use the trusted taxed base and remain separate', async () => {
    const f = await charged({}, 105000, { invoiceId: 'fixture-invoice', tip: { kind: 'percent', value: 10 } })
    assert.equal(f.sessions[0].tipCents, 10500)
    assert.equal(f.sessions[0].tipSelection, '10')
  })
  await check('valid custom tip is preserved', async () => {
    const f = await charged({}, 105000, { invoiceId: 'fixture-invoice', tip: { kind: 'custom', cents: 1234 } })
    assert.equal(f.sessions[0].tipCents, 1234)
    assert.equal(f.sessions[0].tipSelection, 'custom')
  })
  await check('invalid tip still fails before customer/Stripe work', async () => {
    const f = fixture()
    assert.equal((await f.run({ invoiceId: 'fixture-invoice', tip: { kind: 'custom', cents: -1 } })).status, 400)
    noCustomerOrCheckout(f)
  })
  await check('cancelled invoice remains blocked before settings are read', async () => {
    const f = fixture({ invoice: { status: 'cancelled' }, settingsError: true })
    assert.equal((await f.run()).status, 409)
    assert.deepEqual(f.reads, ['invoices'])
    noCustomerOrCheckout(f)
  })
  await check('fully paid invoice remains blocked', async () => {
    const f = fixture({ invoice: { amount_paid: 1050 } })
    assert.equal((await f.run()).status, 409)
    noCustomerOrCheckout(f)
  })
  for (const [name, options, status] of [
    ['unsigned owner', { signedIn: false }, 401],
    ['missing tenant capability', { capable: false }, 503],
    ['disabled Stripe', { stripeEnabled: false }, 503],
  ] as const) {
    await check(`${name} cannot read invoices or start payment work`, async () => {
      const f = fixture(options)
      assert.equal((await f.run()).status, status)
      assert.equal(f.reads.length, 0)
      noCustomerOrCheckout(f)
      if ('stripeEnabled' in options) assert.equal(f.clients(), 0)
    })
  }
  await check('missing invoice returns 404 before settings/customer reads', async () => {
    const f = fixture({ invoice: null })
    assert.equal((await f.run()).status, 404)
    assert.deepEqual(f.reads, ['invoices'])
    noCustomerOrCheckout(f)
  })
  await check('missing invoice ID returns 400 without data reads', async () => {
    const f = fixture()
    assert.equal((await f.run({})).status, 400)
    assert.equal(f.reads.length, 0)
    noCustomerOrCheckout(f)
  })
  await check('request cannot override amount, GST, deposit or checkout destinations', async () => {
    const f = await charged({}, 105000, {
      invoiceId: 'fixture-invoice', amount: 1, chargeCents: 1, gst_percent: 0,
      deposit_amount: 1, successUrl: 'https://untrusted.example.invalid',
    })
    assert.equal(f.sessions[0].successUrl, 'https://app.example.invalid/dashboard/invoices?paid=1')
    assert.equal(f.sessions[0].cancelUrl, 'https://app.example.invalid/dashboard/invoices')
    assert.equal(f.sessions[0].tipCents, 0)
  })
  await check('healthy checkout keeps saving cards for an ensured customer', async () => {
    const f = await charged({}, 105000)
    assert.equal(f.ensures.length, 1)
    assert.equal(f.sessions[0].stripeCustomerId, 'cus_synthetic')
    assert.equal(f.sessions[0].offerSaveCard, true)
  })
  await check('missing customer retains email-only checkout fallback', async () => {
    const f = await charged({ customer: null }, 105000)
    assert.equal(f.ensures.length, 0)
    assert.equal(f.sessions[0].stripeCustomerId, null)
    assert.equal(f.sessions[0].offerSaveCard, false)
    assert.equal(f.sessions[0].customerEmail, 'fixture@example.invalid')
  })
  await check('customer ensure failure retains checkout without card saving', async () => {
    const f = await charged({ customerId: null }, 105000)
    assert.equal(f.sessions[0].stripeCustomerId, null)
    assert.equal(f.sessions[0].offerSaveCard, false)
  })
  await check('Stripe failure retains the existing 502 response', async () => {
    const f = fixture({ stripeFailure: true })
    const response = await f.run()
    assert.equal(response.status, 502)
    assert.equal(response.body.error, 'Synthetic checkout failure')
    assert.ok(!('url' in response.body))
  })
  console.log(`\nverify:checkout-tax-settings — ${passed} passed, 0 failed (synthetic I/O; no network or real charges)`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
