// Actual raw-body transport + provider adapter + reconciliation core. All I/O
// below is synthetic. No environment file, provider SDK or network is loaded.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { handlePlatformBillingWebhook, validPlatformSignature } from '../src/lib/billing/webhook'
import { platformProvider, platformProviderConfig, PLATFORM_STRIPE_API_VERSION } from '../src/lib/billing/provider'

const NOW = 1788600000000
const env = {
  PLATFORM_BILLING_RECONCILIATION_ENABLED: 'true', PLATFORM_STRIPE_SECRET_KEY: 'sk_test_syntheticplatform',
  PLATFORM_STRIPE_WEBHOOK_SECRET: 'whsec_synthetic', STRIPE_SECRET_KEY: 'sk_test_syntheticmerchant',
  PLATFORM_STRIPE_ACCOUNT_ID: 'acct_platform', MERCHANT_STRIPE_ACCOUNT_ID: 'acct_merchant', PLATFORM_STRIPE_MODE: 'test',
}
const config = platformProviderConfig(env)!
const sign = (raw: string, time = NOW / 1000, secret = env.PLATFORM_STRIPE_WEBHOOK_SECRET) =>
  `t=${time},v1=${createHmac('sha256', secret).update(`${time}.${raw}`).digest('hex')}`
const subscription = (id = 'sub_current') => ({ id, object: 'subscription', customer: 'cus_owner', livemode: false,
  status: 'active', trial_start: null, trial_end: null, cancel_at: null, canceled_at: null, ended_at: null,
  cancel_at_period_end: false, items: { has_more: false, data: [{ price: { id: 'price_chosen', livemode: false },
    current_period_start: NOW / 1000 - 100, current_period_end: NOW / 1000 + 100 }] } })
const event = () => ({ id: 'evt_current', object: 'event', created: NOW / 1000 - 3600, type: 'customer.subscription.updated',
  livemode: false, data: { object: subscription() } })
type Json = Record<string, any>
function fixture() {
  const stored = event() as Json
  let canonical = subscription() as Json
  const calls: { path: string; merchant: boolean }[] = [], writes: { name: string; args: Json }[] = []
  let claim = { kind: 'claimed', billingAccountId: 'synthetic-account', userId: 'synthetic-owner', attempt: 1,
    leaseUntil: new Date(NOW + 60000).toISOString(), requiredSubscriptionIds: ['sub_current'] } as Json
  let commit = { kind: 'processed' } as Json
  let merchantId = 'acct_merchant', listOverride: Json | undefined, providerFailure = false
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers)
    assert.equal(url.origin, 'https://api.stripe.com')
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store')
    assert.equal(headers.get('Stripe-Version'), PLATFORM_STRIPE_API_VERSION)
    assert.equal(headers.get('Stripe-Account'), null)
    const merchant = headers.get('Authorization') === `Bearer ${env.STRIPE_SECRET_KEY}`
    if (!merchant) assert.equal(headers.get('Authorization'), `Bearer ${env.PLATFORM_STRIPE_SECRET_KEY}`)
    calls.push({ path: url.pathname + url.search, merchant })
    if (merchant) assert.equal(url.pathname, '/v1/account', 'EPS key only verifies the account identity')
    if (providerFailure) throw new Error('synthetic secret details must not escape')
    if (url.pathname === '/v1/account') return Response.json({ id: merchant ? merchantId : 'acct_platform', object: 'account' })
    if (url.pathname === '/v1/events/evt_current') return Response.json(stored)
    if (url.pathname === '/v1/subscriptions') {
      assert.equal(url.searchParams.get('customer'), 'cus_owner'); assert.equal(url.searchParams.get('status'), 'all')
      return Response.json(listOverride ?? { object: 'list', has_more: false, data: [canonical] })
    }
    if (url.pathname === '/v1/subscriptions/sub_current') return Response.json(canonical)
    throw new Error('Unexpected provider path')
  }) as typeof fetch
  const store = { rpc: async (name: string, args: Json) => {
    writes.push({ name, args })
    if (name === 'platform_billing_claim_event') return { data: claim, error: null }
    if (name === 'platform_billing_commit_event') return { data: commit, error: null }
    if (name === 'platform_billing_fail_event') return { data: { kind: 'retry', code: 'attempt_failed' }, error: null }
    throw new Error('Unexpected RPC')
  } }
  return { calls, writes, stored, fetcher, store,
    canonical: (value: Json) => { canonical = value }, claim: (value: Json) => { claim = value }, commit: (value: Json) => { commit = value },
    merchant: (id: string) => { merchantId = id }, list: (value: Json) => { listOverride = value }, failProvider: () => { providerFailure = true },
    async run(payload: unknown = event(), environment = env, signature?: string, noStore = false) {
      const raw = typeof payload === 'string' ? payload : JSON.stringify(payload)
      const request = new Request('https://fixture.invalid/billing', { method: 'POST', body: raw,
        headers: { 'stripe-signature': signature ?? sign(raw) } })
      const result = await handlePlatformBillingWebhook(request, { environment, createStore: () => noStore ? null : store, fetcher, now: () => NOW })
      assert.equal(result.headers.get('Cache-Control'), 'private, no-store')
      if (result.status === 503) assert.equal(result.headers.get('Retry-After'), '30')
      const body = await result.json()
      assert.deepEqual(body, result.status === 200 ? { received: true } : { error: 'Billing event could not be processed.' })
      return result.status
    },
  }
}
let passed = 0
async function check(name: string, fn: () => unknown | Promise<unknown>) { await fn(); console.log(`PASS ${name}`); passed++ }
async function main() {
  await check('inactive or incomplete configuration cannot touch providers or a store', async () => {
    for (const field of Object.keys(env)) {
      const f = fixture(); assert.equal(await f.run(event(), { ...env, [field]: '' }), 503)
      assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0)
    }
    assert.equal(platformProviderConfig({ ...env, PLATFORM_STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY }), null)
    assert.equal(platformProviderConfig({ ...env, PLATFORM_STRIPE_ACCOUNT_ID: env.MERCHANT_STRIPE_ACCOUNT_ID }), null)
  })
  await check('signature checks raw bytes, freshness, one timestamp and v1 with rotation', () => {
    const raw = JSON.stringify(event())
    assert.equal(validPlatformSignature(raw, sign(raw), config.webhookSecret, NOW), true)
    assert.equal(validPlatformSignature(raw, `${sign(raw)},v1=${'0'.repeat(64)}`, config.webhookSecret, NOW), true)
    for (const sig of [null, '', sign(raw).replace('v1=', 'v0='), sign(raw, NOW / 1000 - 301), sign(raw, NOW / 1000 + 301),
      `${sign(raw)},t=${NOW / 1000}`, sign(raw, NOW / 1000, 'whsec_wrong'), `t=${NOW / 1000},v1=00`, `${sign(raw)}=bad`]) {
      assert.equal(validPlatformSignature(raw, sig, config.webhookSecret, NOW), false)
    }
    assert.equal(validPlatformSignature(raw + ' ', sign(raw), config.webhookSecret, NOW), false)
  })
  await check('invalid signatures/body/oversize input perform no I/O', async () => {
    for (const [payload, sig] of [[event(), 't=0,v1=00'], ['{', undefined], ['x'.repeat(1024 * 1024 + 1), undefined]] as const) {
      const f = fixture(); assert.equal(await f.run(payload, env, sig), 400)
      assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0)
    }
  })
  await check('unsigned leading BOM cannot alter the exact signed bytes', async () => {
    const raw = JSON.stringify(event()), f = fixture()
    assert.equal(await f.run('\uFEFF' + raw, env, sign(raw)), 400)
    assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0)
  })
  await check('signed event identity rejects Connect/organization/wrong mode before I/O', async () => {
    for (const change of [{ account: 'acct_foreign' }, { context: 'acct_foreign' }, { livemode: true }, { created: null }, { id: 'evt_/escape' }]) {
      const f = fixture(); assert.equal(await f.run({ ...event(), ...change }), 400)
      assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0)
    }
  })
  await check('actual provider identity beats different key names', async () => {
    const f = fixture(); f.merchant('acct_platform')
    assert.equal(await f.run(), 503); assert.equal(f.writes.length, 0)
  })
  await check('event must exist in exact provider account/mode and match signed identity', async () => {
    for (const mutate of [(e: Json) => { e.livemode = true }, (e: Json) => { e.id = 'evt_other' },
      (e: Json) => { e.data.object.customer = 'cus_foreign' }, (e: Json) => { e.data.object.id = 'sub_foreign' },
      (e: Json) => { e.created++ }, (e: Json) => { e.type = 'customer.subscription.deleted' }]) {
      const f = fixture(); mutate(f.stored); assert.equal(await f.run(), 503); assert.equal(f.writes.length, 0)
    }
  })
  await check('completed event returns 200 only after scoped canonical state commit', async () => {
    const f = fixture(); const sent = event(); sent.data.object.status = 'past_due'
    assert.equal(await f.run(sent), 200)
    assert.deepEqual(f.writes.map(w => w.name), ['platform_billing_claim_event', 'platform_billing_commit_event'])
    const saved = f.writes[1].args.p_subscriptions[0]
    assert.equal(saved.status, 'active', 'never mirror stale event payload status')
    assert.equal(saved.current_period_end, new Date(NOW + 100000).toISOString(), 'Basil item-level period')
    assert.equal(f.writes[0].args.p_stripe_account_id, 'acct_platform')
  })
  await check('busy is retryable; only durable completed state acknowledges duplicate', async () => {
    for (const [claim, status] of [[{ kind: 'retry', code: 'busy' }, 503], [{ kind: 'already_completed' }, 200],
      [{ kind: 'retry', code: 'unknown_account' }, 503], [{ kind: 'received' }, 503]] as const) {
      const f = fixture(); f.claim(claim); assert.equal(await f.run(), status)
      assert.equal(f.calls.some(c => c.path.startsWith('/v1/subscriptions')), false)
      assert.equal(f.writes.length, 1)
    }
  })
  await check('failed commit/provider/missing database cannot acknowledge success or expose details', async () => {
    const failed = fixture(); failed.commit({ kind: 'retry', code: 'stale_attempt' }); assert.equal(await failed.run(), 503)
    const provider = fixture(); provider.failProvider(); assert.equal(await provider.run(), 503); assert.equal(provider.writes.length, 0)
    const noStore = fixture(); assert.equal(await noStore.run(event(), env, undefined, true), 503)
  })
  await check('malformed canonical states and multiple items never reach commit', async () => {
    for (const mutate of [(s: Json) => { s.customer = 'cus_other' }, (s: Json) => { s.livemode = true },
      (s: Json) => { s.status = 'unknown' }, (s: Json) => { s.items.has_more = true },
      (s: Json) => { s.items.data.push(s.items.data[0]) }, (s: Json) => { s.items.data[0].price.livemode = true },
      (s: Json) => { delete s.items.data[0].current_period_end }, (s: Json) => { s.cancel_at_period_end = null },
      (s: Json) => { s.items.data[0].current_period_end = 1 }]) {
      const f = fixture(), s = subscription(); mutate(s); f.canonical(s)
      assert.equal(await f.run(), 503); assert.equal(f.writes.some(w => w.name === 'platform_billing_commit_event'), false)
    }
  })
  await check('missing required subscription is explicitly retrieved, never assumed canceled', async () => {
    const f = fixture(); f.list({ object: 'list', has_more: false, data: [] })
    assert.equal(await f.run(), 200); assert.equal(f.calls.some(c => c.path === '/v1/subscriptions/sub_current'), true)
  })
  await check('unknown subscription event retries; verified unrelated event has explicit no-op policy', async () => {
    for (const [type, status] of [['customer.subscription.new_event', 503], ['payment_intent.succeeded', 200]] as const) {
      const f = fixture(); f.stored.type = type
      assert.equal(await f.run({ ...event(), type }), status); assert.equal(f.writes.length, 0)
    }
  })
  await check('every subscription page is read using the provider cursor and all statuses', async () => {
    let reads = 0
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input)); reads++
      assert.equal(url.searchParams.get('status'), 'all')
      assert.equal(url.searchParams.get('starting_after'), reads === 1 ? null : 'sub_old')
      const row = subscription(reads === 1 ? 'sub_old' : 'sub_current')
      if (reads === 1) row.status = 'canceled'
      return Response.json({ object: 'list', has_more: reads === 1, data: [row] })
    }) as typeof fetch
    const result = await platformProvider(config, fetcher).readCanonicalSubscriptions({ stripeAccountId: 'acct_platform', livemode: false,
      stripeCustomerId: 'cus_owner', requiredSubscriptionIds: ['sub_current'] })
    assert.equal(reads, 2); assert.equal(result.complete, true); assert.equal(result.subscriptions.length, 2)
  })
  await check('empty unfinished pages and duplicate cursors remain retryable', async () => {
    for (const data of [[], [subscription()]]) {
      const f = fixture(); f.list({ object: 'list', has_more: true, data })
      assert.equal(await f.run(), 503); assert.equal(f.writes.some(w => w.name === 'platform_billing_commit_event'), false)
    }
  })
  await check('ten distinct unfinished pages never become a truncated success', async () => {
    let pages = 0
    const fetcher = (async () => Response.json({ object: 'list', has_more: true, data: [subscription(`sub_page${++pages}`)] })) as typeof fetch
    await assert.rejects(() => platformProvider(config, fetcher).readCanonicalSubscriptions({ stripeAccountId: 'acct_platform', livemode: false,
      stripeCustomerId: 'cus_owner', requiredSubscriptionIds: ['sub_current'] }), /incomplete_subscription_list/)
    assert.equal(pages, 10)
  })
  await check('required subscription retrieval failure remains retryable and uncommitted', async () => {
    const f = fixture(); f.list({ object: 'list', has_more: false, data: [] })
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => String(input).includes('/subscriptions/sub_current')
      ? new Response('synthetic private provider detail', { status: 404 }) : f.fetcher(input, init)) as typeof fetch
    const raw = JSON.stringify(event())
    const result = await handlePlatformBillingWebhook(new Request('https://fixture.invalid/billing', { method: 'POST', body: raw,
      headers: { 'stripe-signature': sign(raw) } }), { environment: env, createStore: () => f.store, fetcher, now: () => NOW })
    assert.equal(result.status, 503); assert.equal(f.writes.some(w => w.name === 'platform_billing_commit_event'), false)
    assert.equal(f.writes.at(-1)?.name, 'platform_billing_fail_event')
  })
  console.log(`Platform billing transport: ${passed} passed, 0 failed. Synthetic I/O only; no mounted route or provider test-mode proof.`)
}
main().catch(() => { console.error('FAIL platform billing transport'); process.exitCode = 1 })
