// Dormant server-side B2 adapter. No application route imports this module.
// These calls only read Stripe; customer creation and paid offers are separate.
import type { CanonicalPlatformSubscription, CanonicalSubscriptionRequest, VerifiedPlatformScope } from './reconcileTypes'
import type { PlatformSubscriptionStatus } from './types'

export const PLATFORM_STRIPE_API_VERSION = '2025-03-31.basil'
export type BillingEnvironment = Record<string, string | undefined>
export interface PlatformProviderConfig {
  secret: string
  webhookSecret: string
  merchantSecret: string
  platformAccountId: string
  merchantAccountId: string
  livemode: boolean
}
export function platformProviderConfig(env: BillingEnvironment): PlatformProviderConfig | null {
  if (env.PLATFORM_BILLING_RECONCILIATION_ENABLED !== 'true') return null
  const secret = env.PLATFORM_STRIPE_SECRET_KEY?.trim() ?? ''
  const webhookSecret = env.PLATFORM_STRIPE_WEBHOOK_SECRET?.trim() ?? ''
  // The existing merchant credential is used ONLY for GET /v1/account to prove
  // the two actual accounts differ. It never reads that account's money ledger.
  const merchantSecret = env.STRIPE_SECRET_KEY?.trim() ?? ''
  const platformAccountId = env.PLATFORM_STRIPE_ACCOUNT_ID?.trim() ?? ''
  const merchantAccountId = env.MERCHANT_STRIPE_ACCOUNT_ID?.trim() ?? ''
  const mode = env.PLATFORM_STRIPE_MODE
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(secret)
    || !/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(merchantSecret)
    || !/^whsec_[A-Za-z0-9]+$/.test(webhookSecret)
    || !/^acct_[A-Za-z0-9]+$/.test(platformAccountId)
    || !/^acct_[A-Za-z0-9]+$/.test(merchantAccountId)
    || platformAccountId === merchantAccountId || secret === merchantSecret
    || (mode !== 'test' && mode !== 'live')) return null
  return { secret, webhookSecret, merchantSecret, platformAccountId, merchantAccountId, livemode: mode === 'live' }
}

type Json = Record<string, unknown>
export function billingObject(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_provider_shape')
  return value as Json
}
export function billingId(value: unknown, prefix: string): string {
  if (typeof value !== 'string' || value.length > 255 || !new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value)) throw new Error('invalid_provider_id')
  return value
}
export function billingTime(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 253402300799) throw new Error('invalid_provider_date')
  return new Date(value * 1000).toISOString()
}

export function platformProvider(config: PlatformProviderConfig, fetcher: typeof fetch = fetch) {
  async function get(path: string, secret = config.secret): Promise<Json> {
    try {
      const result = await fetcher(`https://api.stripe.com/v1/${path}`, {
        method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${secret}`, 'Stripe-Version': PLATFORM_STRIPE_API_VERSION },
      })
      if (!result.ok) throw new Error('provider_read_failed')
      return billingObject(await result.json())
    } catch { throw new Error('provider_read_failed') }
  }
  async function verifyScope(): Promise<VerifiedPlatformScope> {
    const platform = await get('account')
    const merchant = await get('account', config.merchantSecret)
    if (platform.object !== 'account' || merchant.object !== 'account'
      || platform.id !== config.platformAccountId || merchant.id !== config.merchantAccountId
      || platform.id === merchant.id) throw new Error('provider_scope_mismatch')
    return { platformAccountId: config.platformAccountId, merchantAccountId: config.merchantAccountId, livemode: config.livemode }
  }
  function subscription(value: unknown, request: CanonicalSubscriptionRequest): CanonicalPlatformSubscription {
    const row = billingObject(value)
    const stripeSubscriptionId = billingId(row.id, 'sub')
    if (row.object !== 'subscription' || row.customer !== request.stripeCustomerId || row.livemode !== request.livemode) throw new Error('subscription_scope_mismatch')
    const statuses: PlatformSubscriptionStatus[] = ['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused']
    if (!statuses.includes(row.status as PlatformSubscriptionStatus) || typeof row.cancel_at_period_end !== 'boolean') throw new Error('unknown_subscription_state')
    const items = billingObject(row.items)
    // B1 has one nullable price/period pair. Do not silently flatten multiple
    // prices or mixed intervals into a claim this schema cannot represent.
    if (items.has_more !== false || !Array.isArray(items.data) || items.data.length !== 1) throw new Error('unsupported_subscription_items')
    const item = billingObject(items.data[0])
    const price = billingObject(item.price)
    if (price.livemode !== request.livemode) throw new Error('price_mode_mismatch')
    const trialStart = billingTime(row.trial_start), trialEnd = billingTime(row.trial_end)
    const currentPeriodStart = billingTime(item.current_period_start), currentPeriodEnd = billingTime(item.current_period_end)
    if ((trialStart && trialEnd && trialStart > trialEnd) || (currentPeriodStart && currentPeriodEnd && currentPeriodStart > currentPeriodEnd)) throw new Error('invalid_provider_date')
    return {
      stripeSubscriptionId, stripeCustomerId: request.stripeCustomerId, livemode: request.livemode,
      stripePriceId: billingId(price.id, 'price'), status: row.status as PlatformSubscriptionStatus,
      trialStart, trialEnd, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd: row.cancel_at_period_end,
      cancelAt: billingTime(row.cancel_at), canceledAt: billingTime(row.canceled_at), endedAt: billingTime(row.ended_at),
    }
  }
  async function readCanonicalSubscriptions(request: CanonicalSubscriptionRequest) {
    if (request.stripeAccountId !== config.platformAccountId || request.livemode !== config.livemode) throw new Error('provider_scope_mismatch')
    billingId(request.stripeCustomerId, 'cus')
    for (const id of request.requiredSubscriptionIds) billingId(id, 'sub')
    const found = new Map<string, CanonicalPlatformSubscription>()
    let cursor: string | undefined
    let complete = false
    // A pathological account is retryable and reviewable, never a truncated
    // success. This bounds work; the SQL fence still rejects an expired lease.
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({ customer: request.stripeCustomerId, status: 'all', limit: '100' })
      if (cursor) query.set('starting_after', cursor)
      const list = await get(`subscriptions?${query}`)
      if (list.object !== 'list' || !Array.isArray(list.data) || typeof list.has_more !== 'boolean') throw new Error('invalid_subscription_list')
      for (const value of list.data) {
        const mapped = subscription(value, request)
        if (found.has(mapped.stripeSubscriptionId)) throw new Error('unstable_subscription_list')
        found.set(mapped.stripeSubscriptionId, mapped)
      }
      if (!list.has_more) { complete = true; break }
      if (list.data.length === 0) throw new Error('incomplete_subscription_list')
      cursor = billingId(billingObject(list.data[list.data.length - 1]).id, 'sub')
    }
    if (!complete) throw new Error('incomplete_subscription_list')
    // A list omission is never a terminal transition. Retrieve a known/event
    // target explicitly; a 404 or mismatched owner/mode leaves the event retryable.
    for (const id of request.requiredSubscriptionIds) if (!found.has(id)) {
      const mapped = subscription(await get(`subscriptions/${encodeURIComponent(id)}`), request)
      if (mapped.stripeSubscriptionId !== id) throw new Error('subscription_id_mismatch')
      found.set(id, mapped)
    }
    return { stripeAccountId: request.stripeAccountId, livemode: request.livemode,
      stripeCustomerId: request.stripeCustomerId, complete: true as const, subscriptions: [...found.values()] }
  }
  return { verifyScope, readCanonicalSubscriptions, retrieveEvent: (id: string) => get(`events/${encodeURIComponent(billingId(id, 'evt'))}`) }
}
