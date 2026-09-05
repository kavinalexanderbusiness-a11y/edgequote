import type {
  CanonicalPlatformSubscription, PlatformReconciliationDependencies,
  PlatformReconciliationResult, VerifiedPlatformSubscriptionEvent,
} from './reconcileTypes'

const STATUSES = new Set(['incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused'])
const TERMINAL = new Set(['canceled','incomplete_expired'])
const STORE_CODES = new Set(['invalid_event','event_identity_mismatch','unknown_account','busy','claim_failed',
  'stale_attempt','invalid_snapshot','incomplete_snapshot','commit_failed','invalid_error_code','attempt_failed','fail_failed'])
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const identifier = (value: unknown): value is string => typeof value === 'string' && /^\S{1,255}$/.test(value)
const timestamp = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value))
const nullableTime = (value: unknown) => value === null || timestamp(value)
const code = (value: unknown) => typeof value === 'string' && STORE_CODES.has(value) ? value : 'store_response_invalid'
const retry = (value: string): PlatformReconciliationResult => ({ kind: 'retry', code: value })

function canonicalRows(value: unknown, event: VerifiedPlatformSubscriptionEvent, required: string[]): CanonicalPlatformSubscription[] | null {
  if (!record(value) || value.complete !== true || value.stripeAccountId !== event.stripeAccountId
    || value.livemode !== event.livemode || value.stripeCustomerId !== event.stripeCustomerId
    || !Array.isArray(value.subscriptions) || value.subscriptions.length < 1 || value.subscriptions.length > 1000) return null
  const ids = new Set<string>()
  let nonterminal = 0
  for (const item of value.subscriptions) {
    if (!record(item) || !identifier(item.stripeSubscriptionId) || ids.has(item.stripeSubscriptionId)
      || item.stripeCustomerId !== event.stripeCustomerId || item.livemode !== event.livemode
      || (item.stripePriceId !== null && !identifier(item.stripePriceId))
      || typeof item.status !== 'string' || !STATUSES.has(item.status)
      || typeof item.cancelAtPeriodEnd !== 'boolean') return null
    for (const field of ['trialStart','trialEnd','currentPeriodStart','currentPeriodEnd','cancelAt','canceledAt','endedAt']) {
      if (!nullableTime(item[field])) return null
    }
    for (const [start,end] of [['trialStart','trialEnd'],['currentPeriodStart','currentPeriodEnd']]) {
      if (item[start] !== null && item[end] !== null && Date.parse(item[end] as string) < Date.parse(item[start] as string)) return null
    }
    ids.add(item.stripeSubscriptionId)
    if (!TERMINAL.has(item.status)) nonterminal++
  }
  if (nonterminal > 1 || required.some(id => !ids.has(id))) return null
  return value.subscriptions as unknown as CanonicalPlatformSubscription[]
}

/** Dormant reconciliation core; HTTP signature/account verification and provider
 * I/O belong to the server adapter. A returned retry must never become HTTP 2xx.
 * The lease is claimed BEFORE canonical reads, then account/event fencing and
 * subscription changes are committed together by the service-only SQL function. */
export async function reconcilePlatformSubscriptionEvent(
  event: VerifiedPlatformSubscriptionEvent, deps: PlatformReconciliationDependencies,
): Promise<PlatformReconciliationResult> {
  const scope = deps.scope
  if (!identifier(scope.platformAccountId) || !identifier(scope.merchantAccountId)
    || scope.platformAccountId === scope.merchantAccountId || typeof scope.livemode !== 'boolean'
    || event.stripeAccountId !== scope.platformAccountId || event.livemode !== scope.livemode) return retry('invalid_scope')
  if (![event.eventId,event.eventType,event.stripeCustomerId,event.stripeSubscriptionId].every(identifier)
    || !timestamp(event.eventCreatedAt)) return retry('invalid_event')
  const key = { p_stripe_account_id: event.stripeAccountId, p_livemode: event.livemode, p_event_id: event.eventId }
  let claim: Record<string, unknown>
  try {
    const response = await deps.store.rpc('platform_billing_claim_event', { ...key,
      p_event_type: event.eventType, p_event_created_at: event.eventCreatedAt,
      p_stripe_customer_id: event.stripeCustomerId, p_stripe_subscription_id: event.stripeSubscriptionId,
    })
    if (response.error || !record(response.data)) return retry('claim_failed')
    if (response.data.kind === 'already_completed') return { kind: 'already_completed', code: 'already_completed' }
    if (response.data.kind === 'retry') return retry(code(response.data.code))
    claim = response.data
  } catch { return retry('claim_failed') }
  if (claim.kind !== 'claimed' || !identifier(claim.billingAccountId) || !identifier(claim.userId)
    || !Number.isSafeInteger(claim.attempt) || (claim.attempt as number) < 1 || !timestamp(claim.leaseUntil)
    || !Array.isArray(claim.requiredSubscriptionIds) || !claim.requiredSubscriptionIds.every(identifier)
    || !claim.requiredSubscriptionIds.includes(event.stripeSubscriptionId)) return retry('store_response_invalid')
  const fence = { ...key, p_billing_account_id: claim.billingAccountId, p_attempt: claim.attempt, p_stripe_customer_id: event.stripeCustomerId }
  async function fail(reason: string) {
    // Failure cleanup has the same account + event + attempt + valid lease fence.
    // If cleanup fails or the lease was lost, a provider replay can reclaim it.
    try { await deps.store.rpc('platform_billing_fail_event', { ...fence, p_error_code: reason }) } catch { /* preserve retry */ }
    return retry(reason)
  }
  let snapshot: unknown
  try {
    snapshot = await deps.readCanonicalSubscriptions({ stripeAccountId: event.stripeAccountId,
      livemode: event.livemode, stripeCustomerId: event.stripeCustomerId,
      requiredSubscriptionIds: claim.requiredSubscriptionIds as string[],
    })
  } catch { return fail('provider_read_failed') }
  const subscriptions = canonicalRows(snapshot, event, claim.requiredSubscriptionIds as string[])
  if (!subscriptions) return fail('invalid_snapshot')
  // Only normalized fields cross into SQL; no raw provider payload or error text.
  const payload = subscriptions.map(s => ({ stripe_subscription_id: s.stripeSubscriptionId,
    stripe_customer_id: s.stripeCustomerId, livemode: s.livemode, stripe_price_id: s.stripePriceId,
    status: s.status, trial_start: s.trialStart, trial_end: s.trialEnd,
    current_period_start: s.currentPeriodStart, current_period_end: s.currentPeriodEnd,
    cancel_at_period_end: s.cancelAtPeriodEnd, cancel_at: s.cancelAt, canceled_at: s.canceledAt, ended_at: s.endedAt,
  }))
  try {
    const response = await deps.store.rpc('platform_billing_commit_event', { ...fence,
      p_stripe_subscription_id: event.stripeSubscriptionId, p_subscriptions: payload,
    })
    if (response.error || !record(response.data)) return fail('store_commit_failed')
    if (response.data.kind === 'processed') return { kind: 'processed', code: 'processed' }
    if (response.data.kind === 'retry') return fail(code(response.data.code))
    return fail('store_response_invalid')
  } catch { return fail('store_commit_failed') }
}
