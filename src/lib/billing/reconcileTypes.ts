import type { PlatformSubscriptionStatus } from './types'

/** Caller verifies the raw webhook signature and selects relevant event types.
 * The core accepts no request body, tenant metadata, credentials or price offer. */
export interface VerifiedPlatformSubscriptionEvent {
  stripeAccountId: string
  livemode: boolean
  eventId: string
  eventType: string
  eventCreatedAt: string
  stripeCustomerId: string
  stripeSubscriptionId: string
}

/** These IDs must come from verified provider accounts, not key names/prefixes. */
export interface VerifiedPlatformScope {
  platformAccountId: string
  merchantAccountId: string
  livemode: boolean
}

export interface CanonicalPlatformSubscription {
  stripeSubscriptionId: string
  stripeCustomerId: string
  livemode: boolean
  stripePriceId: string | null
  status: PlatformSubscriptionStatus
  trialStart: string | null
  trialEnd: string | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  cancelAt: string | null
  canceledAt: string | null
  endedAt: string | null
}

export interface CanonicalSubscriptionRequest {
  stripeAccountId: string
  livemode: boolean
  stripeCustomerId: string
  requiredSubscriptionIds: string[]
}

/** Adapter must fetch every page with status=all after the account lease claim.
 * Missing or partial results must not set complete=true. No event-payload mirror. */
export interface CanonicalSubscriptionEnvelope {
  stripeAccountId: string
  livemode: boolean
  stripeCustomerId: string
  complete: true
  subscriptions: CanonicalPlatformSubscription[]
}

export interface PlatformBillingStore {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>
}

export interface PlatformReconciliationDependencies {
  scope: VerifiedPlatformScope
  store: PlatformBillingStore
  readCanonicalSubscriptions(request: CanonicalSubscriptionRequest): Promise<unknown>
}

export type PlatformReconciliationResult = {
  kind: 'processed' | 'already_completed' | 'retry'
  /** Bounded internal code only; never raw SQL/provider errors. */
  code: string
}
