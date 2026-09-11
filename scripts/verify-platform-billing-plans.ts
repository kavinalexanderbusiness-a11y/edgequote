// Source-stage B3 proof only. All auth/provider I/O is injected and synthetic;
// this suite neither creates billing records nor proves live paid enforcement.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PRODUCT_PLANS, PRODUCT_PLAN_STATUS } from '../src/lib/productPlans'
import { platformProviderConfig, PLATFORM_STRIPE_API_VERSION } from '../src/lib/billing/provider'
import { platformPlanPriceMapping, verifyPlatformPlanCatalogue } from '../src/lib/billing/planCatalogue'
import { resolvePlatformPlanPolicy, type PlatformPlanPolicyPorts } from '../src/lib/billing/planPolicy'

const ROOT = join(__dirname, '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const files = (path: string): string[] => readdirSync(join(ROOT, path), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(`${path}/${entry.name}`) : [`${path}/${entry.name}`])
type Json = Record<string, unknown>
const environment = {
  PLATFORM_BILLING_RECONCILIATION_ENABLED: 'true', PLATFORM_STRIPE_SECRET_KEY: 'sk_test_syntheticplatform',
  PLATFORM_STRIPE_WEBHOOK_SECRET: 'whsec_synthetic', STRIPE_SECRET_KEY: 'sk_test_syntheticmerchant',
  PLATFORM_STRIPE_ACCOUNT_ID: 'acct_platform', MERCHANT_STRIPE_ACCOUNT_ID: 'acct_merchant', PLATFORM_STRIPE_MODE: 'test',
  PLATFORM_STRIPE_PRICE_BASE: 'price_base', PLATFORM_STRIPE_PRODUCT_BASE: 'prod_base',
  PLATFORM_STRIPE_PRICE_PLUS: 'price_plus', PLATFORM_STRIPE_PRODUCT_PLUS: 'prod_plus',
  PLATFORM_STRIPE_PRICE_PREMIUM: 'price_premium', PLATFORM_STRIPE_PRODUCT_PREMIUM: 'prod_premium',
}
const config = platformProviderConfig(environment)!
const mapping = platformPlanPriceMapping(environment)!
function price(id: string): Json {
  const plan = PRODUCT_PLANS.find(plan => mapping[plan.id].priceId === id)!
  return {
    object: 'price', id, active: true, livemode: false, currency: 'cad', type: 'recurring',
    billing_scheme: 'per_unit', unit_amount: plan.monthlyPriceCents,
    unit_amount_decimal: String(plan.monthlyPriceCents), custom_unit_amount: null,
    transform_quantity: null, tiers_mode: null, tax_behavior: 'unspecified', currency_options: null,
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed', trial_period_days: null },
    product: { object: 'product', id: mapping[plan.id].productId, active: true, livemode: false },
  }
}
function providerFixture(options: {
  mutate?: (raw: Json) => void; sameAccount?: boolean; response?: () => Response; firstCall?: () => void
} = {}) {
  const calls: { path: string; merchant: boolean }[] = []
  const fetcher = (async (urlValue: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(urlValue)), headers = new Headers(init?.headers)
    assert.equal(url.origin, 'https://api.stripe.com')
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store')
    assert.ok(init?.signal); assert.equal(headers.get('Stripe-Version'), PLATFORM_STRIPE_API_VERSION)
    assert.equal(headers.get('Stripe-Account'), null)
    const merchant = headers.get('Authorization') === `Bearer ${environment.STRIPE_SECRET_KEY}`
    if (!merchant) assert.equal(headers.get('Authorization'), `Bearer ${environment.PLATFORM_STRIPE_SECRET_KEY}`)
    if (merchant) assert.equal(url.pathname, '/v1/account', 'Merchant credentials only identify their own account')
    calls.push({ path: url.pathname, merchant })
    if (calls.length === 1) options.firstCall?.()
    if (url.pathname === '/v1/account') return Response.json({ object: 'account',
      id: merchant && !options.sameAccount ? 'acct_merchant' : 'acct_platform' })
    assert.deepEqual(url.searchParams.getAll('expand[]'), ['product', 'currency_options'])
    assert.match(url.pathname, /^\/v1\/prices\/price_(base|plus|premium)$/)
    if (options.response) return options.response()
    const raw = price(url.pathname.split('/').at(-1)!)
    options.mutate?.(raw)
    return Response.json(raw)
  }) as typeof fetch
  return { calls, fetcher }
}
let passed = 0
async function check(name: string, run: () => unknown | Promise<unknown>) {
  await run(); passed++; console.log(`PASS ${name}`)
}
async function main() {
  await check('one approved CAD monthly catalogue, cumulative features, no billing or allowances', () => {
    assert.deepEqual(PRODUCT_PLANS.map(p => [p.id, p.name, p.monthlyPriceCents, p.currency, p.billingCadence]), [
      ['base', 'Base', 2900, 'CAD', 'month'], ['plus', 'Plus', 5900, 'CAD', 'month'], ['premium', 'Premium', 9900, 'CAD', 'month'],
    ])
    assert.deepEqual(PRODUCT_PLAN_STATUS, { status: 'preview', billingActive: false, enforcementEnabled: false })
    const sets = PRODUCT_PLANS.map(plan => plan.features.map(feature => feature.id))
    assert.deepEqual(sets[0], ['customers', 'quotes_invoices', 'scheduling'])
    assert.deepEqual(sets[1], [...sets[0], 'recurring_visits', 'team_crews', 'time_tracking', 'job_cost'])
    assert.deepEqual(sets[2], [...sets[1], 'advanced_insights', 'operational_suggestions'])
    for (const plan of PRODUCT_PLANS) {
      assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.features))
      assert.equal(new Set(plan.features.map(feature => feature.id)).size, plan.features.length)
      assert.doesNotMatch(JSON.stringify(plan), /allowance|unlimited|automatic.scan|autonomous|credit/i)
    }
  })
  await check('Plans consumes the canonical catalogue and signup links use all three names', () => {
    const page = read('src/app/plans/page.tsx')
    assert.match(page, /import\s*\{\s*PRODUCT_PLANS\s*\}\s*from\s*['"]@\/lib\/productPlans['"]/)
    assert.match(page, /early access/i)
    assert.match(page, /not available yet/i)
    assert.doesNotMatch(page, /CA\$49|Starter|>Pro<|checkout\.stripe\.com/)
    for (const file of ['src/app/login/page.tsx', 'src/app/signup/page.tsx', 'src/app/setup/page.tsx']) {
      assert.match(read(file), /Base, Plus and Premium/)
    }
  })
  await check('all six provider IDs are mandatory, unique, valid and server configured', () => {
    assert.ok(Object.isFrozen(mapping) && Object.isFrozen(mapping.base))
    const fields = Object.keys(environment).filter(key => /_(PRICE|PRODUCT)_/.test(key))
    for (const field of fields) {
      assert.equal(platformPlanPriceMapping({ ...environment, [field]: '' }), null)
      assert.equal(platformPlanPriceMapping({ ...environment, [field]: '../client-selected' }), null)
    }
    assert.equal(platformPlanPriceMapping({}), null)
    assert.equal(platformPlanPriceMapping({ ...environment, PLATFORM_STRIPE_PRICE_PLUS: 'price_base' }), null)
    assert.equal(platformPlanPriceMapping({ ...environment, PLATFORM_STRIPE_PRODUCT_PLUS: 'prod_base' }), null)
  })
  await check('actual account comparison precedes all prices and never enables payment or tax setup', async () => {
    const f = providerFixture(), result = await verifyPlatformPlanCatalogue(config, mapping, f.fetcher)
    assert.deepEqual(f.calls.map(call => call.path), ['/v1/account', '/v1/account', '/v1/prices/price_base', '/v1/prices/price_plus', '/v1/prices/price_premium'])
    assert.ok(result && Object.isFrozen(result))
    assert.equal(result.checkoutEnabled, false); assert.equal(result.taxSetupVerified, false)
    assert.equal(result.platformAccountId, 'acct_platform'); assert.equal(result.livemode, false)
    assert.doesNotMatch(JSON.stringify(result), /sk_test|whsec|secret/)
  })
  await check('same actual merchant and platform account refuses all price reads', async () => {
    const f = providerFixture({ sameAccount: true })
    assert.equal(await verifyPlatformPlanCatalogue(config, mapping, f.fetcher), null)
    assert.equal(f.calls.length, 2)
  })
  const mismatches: [string, (p: Json) => void][] = [
    ['wrong price', p => { p.id = 'price_attacker' }], ['inactive', p => { p.active = false }],
    ['wrong amount', p => { p.unit_amount = 4900 }], ['fractional amount', p => { p.unit_amount_decimal = '2900.01' }],
    ['USD', p => { p.currency = 'usd' }], ['live response in test scope', p => { p.livemode = true }],
    ['one-time', p => { p.type = 'one_time' }], ['tiered', p => { p.billing_scheme = 'tiered' }],
    ['custom amount', p => { p.custom_unit_amount = { enabled: true } }],
    ['transformed quantity', p => { p.transform_quantity = { divide_by: 10, round: 'up' } }],
    ['tier mode', p => { p.tiers_mode = 'volume' }], ['inclusive tax conflicts with before-tax offer', p => { p.tax_behavior = 'inclusive' }],
    ['annual', p => { (p.recurring as Json).interval = 'year' }],
    ['multiple months', p => { (p.recurring as Json).interval_count = 2 }],
    ['metered', p => { (p.recurring as Json).usage_type = 'metered' }],
    ['trial default', p => { (p.recurring as Json).trial_period_days = 14 }],
    ['wrong product', p => { (p.product as Json).id = 'prod_other' }],
    ['archived product', p => { (p.product as Json).active = false }],
    ['wrong product mode', p => { (p.product as Json).livemode = true }],
    ['unexpanded product', p => { p.product = 'prod_base' }],
    ['alternate currency', p => { p.currency_options = { usd: { unit_amount: 2900 } } }],
    ['contradictory CAD option', p => { p.currency_options = { cad: { unit_amount: 1 } } }],
    ['incomplete shape', p => { delete p.custom_unit_amount }],
    ['missing expanded currencies', p => { delete p.currency_options }],
  ]
  for (const [name, mutate] of mismatches) await check(`provider refuses ${name}`, async () => {
    const f = providerFixture({ mutate })
    assert.equal(await verifyPlatformPlanCatalogue(config, mapping, f.fetcher), null)
    assert.equal(f.calls.length, 3, 'Never continue to another offer after a mismatch')
  })
  await check('equivalent decimal and expanded CAD-only price are accepted without claiming tax readiness', async () => {
    const f = providerFixture({ mutate: raw => {
      raw.unit_amount_decimal = `${raw.unit_amount}.000000000000`
      raw.currency_options = { cad: { unit_amount: raw.unit_amount, unit_amount_decimal: raw.unit_amount_decimal,
        custom_unit_amount: null, tax_behavior: raw.tax_behavior } }
    } })
    assert.ok(await verifyPlatformPlanCatalogue(config, mapping, f.fetcher))
  })
  await check('malformed or unavailable provider reads return only null', async () => {
    for (const response of [() => new Response('private provider body', { status: 500 }), () => new Response('not json'),
      () => new Response('x'.repeat(65537)), () => Response.json(null)]) {
      const f = providerFixture({ response })
      assert.equal(await verifyPlatformPlanCatalogue(config, mapping, f.fetcher), null)
    }
    assert.equal(await verifyPlatformPlanCatalogue(config, mapping, (async () => { throw Error('private provider detail') }) as typeof fetch), null)
  })
  await check('invalid or extra mappings make zero calls; IDs cannot change during verification', async () => {
    const invalid = { ...mapping, base: { priceId: '../elsewhere', productId: 'prod_base' } }
    const f = providerFixture()
    assert.equal(await verifyPlatformPlanCatalogue(config, invalid, f.fetcher), null)
    assert.equal(await verifyPlatformPlanCatalogue(config, { ...mapping, other: mapping.base } as typeof mapping, f.fetcher), null)
    assert.equal(f.calls.length, 0)
    const mutable = structuredClone(mapping), mutableConfig = { ...config }
    const g = providerFixture({ firstCall: () => {
      Object.assign(mutable.base, { priceId: 'price_changed' })
      mutableConfig.secret = 'sk_test_changed'
    } })
    const result = await verifyPlatformPlanCatalogue(mutableConfig, mutable, g.fetcher)
    assert.equal(result?.prices.base.priceId, 'price_base')
  })
  const owner = '00000000-0000-0000-0000-00000000b301'
  const other = '00000000-0000-0000-0000-00000000b302'
  const ports = (role: 'owner' | 'crew' | 'none' = 'owner'): PlatformPlanPolicyPorts => ({
    getVerifiedUser: async () => ({ id: owner }), getCurrentAppRole: async () => role,
  })
  await check('fresh owner policy is immutable, preserves obligations and grants no paid state or action', async () => {
    const calls: string[] = [], result = await resolvePlatformPlanPolicy({
      getVerifiedUser: async () => { calls.push('getUser'); return { id: owner } },
      getCurrentAppRole: async () => { calls.push('databaseRole'); return 'owner' },
    })
    assert.deepEqual(calls, ['getUser', 'databaseRole', 'getUser'])
    assert.equal(result.authority, 'verified_owner'); assert.equal(result.ownerId, owner)
    assert.equal(result.currentPaidPlanId, null); assert.equal(result.billingStatus, 'inactive')
    for (const key of ['enforcementEnabled', 'subscribeEnabled', 'manageSubscriptionEnabled', 'planChangesEnabled'] as const) assert.equal(result[key], false)
    assert.equal(result.existingAccess, 'preserve_existing_role_permissions')
    assert.deepEqual(result.protectedActions, ['records', 'payment_recording', 'exports', 'finish_existing_work', 'recovery'])
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.proposedBundles.premium))
  })
  await check('crew, signed-out and failed authority cannot become billing owners', async () => {
    for (const role of ['crew', 'none'] as const) {
      const result = await resolvePlatformPlanPolicy(ports(role))
      assert.equal(result.authority, 'not_owner'); assert.equal(result.ownerId, null)
      assert.equal(result.manageSubscriptionEnabled, false)
    }
    for (const getVerifiedUser of [async () => null, async () => ({ id: 'browser-selected-owner' })]) {
      const result = await resolvePlatformPlanPolicy({ getVerifiedUser, getCurrentAppRole: async () => { assert.fail('No role query for an invalid user') } })
      assert.equal(result.authority, 'not_owner')
    }
    for (const fail of ['getVerifiedUser', 'getCurrentAppRole'] as const) {
      const p = ports(); p[fail] = async () => { throw Error('private auth details') }
      const result = await resolvePlatformPlanPolicy(p)
      assert.equal(result.authority, 'unavailable'); assert.equal(result.ownerId, null)
      assert.equal(result.existingAccess, 'preserve_existing_role_permissions')
      assert.doesNotMatch(JSON.stringify(result), /private auth/)
    }
  })
  await check('changed authority cannot reuse an earlier owner or browser-selected premium plan', async () => {
    let reads = 0
    const result = await resolvePlatformPlanPolicy({ ...ports(),
      getVerifiedUser: async () => ({ id: ++reads === 1 ? owner : other }),
      planId: 'premium', userId: owner, paid: true,
    } as PlatformPlanPolicyPorts)
    assert.equal(result.authority, 'unavailable'); assert.equal(result.ownerId, null)
    assert.equal(result.currentPaidPlanId, null); assert.equal(result.subscribeEnabled, false)
  })
  await check('new billing preparation stays unmounted, and no billing schema enters migrations', () => {
    for (const file of files('src').filter(f => /\.(ts|tsx)$/.test(f) && !f.startsWith('src/lib/billing/'))) {
      assert.doesNotMatch(read(file), /platform_billing_accounts|platform_subscriptions|platform_billing_events|from\s*['"][^'"]*\/billing\//, file)
    }
    for (const file of files('supabase/migrations')) assert.doesNotMatch(read(file), /platform_billing_accounts|platform_subscriptions|platform_billing_events/)
  })
  console.log(`\n${passed} platform plan preparation checks passed. Synthetic transport and dormant policy only; no paid enforcement or provider activation proof.`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
