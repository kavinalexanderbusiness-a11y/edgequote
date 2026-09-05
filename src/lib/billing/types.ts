/** B1 schema contract only. The draft SQL is unapplied and nothing imports these
 * types into an application path. No status here grants or removes CRM access. */
export type PlatformSubscriptionStatus =
  | 'incomplete' | 'incomplete_expired' | 'trialing' | 'active'
  | 'past_due' | 'canceled' | 'unpaid' | 'paused'

export interface PlatformBillingAccountRow {
  id: string
  user_id: string
  stripe_account_id: string
  livemode: boolean
  stripe_customer_id: string
  created_at: string
  updated_at: string
}

export interface PlatformSubscriptionRow {
  id: string
  billing_account_id: string
  user_id: string
  stripe_account_id: string
  livemode: boolean
  stripe_subscription_id: string
  stripe_price_id: string | null
  status: PlatformSubscriptionStatus
  trial_start: string | null
  trial_end: string | null
  current_period_start: string | null
  current_period_end: string | null
  cancel_at_period_end: boolean
  cancel_at: string | null
  canceled_at: string | null
  ended_at: string | null
  last_synced_at: string | null
  created_at: string
  updated_at: string
}

export type PlatformBillingEventState = 'received' | 'processing' | 'processed' | 'ignored' | 'failed'

/** Private processing ledger. Existence is receipt of an event, not completion.
 * Lease acquisition and stale-worker fencing belong to the future B2 handler. */
export interface PlatformBillingEventRow {
  stripe_account_id: string
  livemode: boolean
  event_id: string
  event_type: string
  event_created_at: string
  received_at: string
  state: PlatformBillingEventState
  attempt_count: number
  lease_until: string | null
  processed_at: string | null
  last_error_code: string | null
}
