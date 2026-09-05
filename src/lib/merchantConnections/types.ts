/** C1 is an inactive ownership contract. Identity is never permission to charge. */
export type MerchantObjectType = 'customer' | 'payment_method' | 'setup_intent' | 'checkout_session' | 'payment_intent' | 'charge'

export interface MerchantConnection {
  id: string
  user_id: string
  stripe_platform_account_id: string
  stripe_account_id: string
  livemode: boolean
  disconnected_at: string | null
}

export interface MerchantProviderObject {
  connection_id: string
  user_id: string
  stripe_platform_account_id: string
  stripe_account_id: string
  livemode: boolean
  object_type: MerchantObjectType
  object_id: string
  customer_id: string | null
  invoice_id: string | null
  quote_id: string | null
}

export interface MerchantScope {
  platformAccountId: string
  stripeAccountId: string
  livemode: boolean
}

/** Contains neither provider credentials nor an enabled/ready assertion. */
export interface MerchantIdentity extends MerchantScope {
  connectionId: string
  ownerId: string
}

export type MerchantTarget = { kind: 'customer' | 'invoice' | 'quote'; id: string }
export type MerchantRead<T> = { ok: true; rows: readonly T[] } | { ok: false }

/**
 * Future server-owned adapter only. C1 supplies no database implementation.
 * Each read must return failure on an I/O error, never a substituted empty set.
 * Owner reads resolve business_settings.user_id, not auth user existence alone.
 */
export interface MerchantConnectionReader {
  owner(ownerId: string): Promise<MerchantRead<{ user_id: string }>>
  /** Query current rows only (disconnected_at IS NULL); do not discard duplicates. */
  byOwner(scope: { ownerId: string; platformAccountId: string; livemode: boolean }): Promise<MerchantRead<MerchantConnection>>
  /** Include disconnected history: late events still belong to their original owner. */
  byAccount(scope: MerchantScope): Promise<MerchantRead<MerchantConnection>>
  object(scope: MerchantScope & { objectType: MerchantObjectType; objectId: string }): Promise<MerchantRead<MerchantProviderObject>>
}

export type MerchantIdentityFailure = 'invalid_scope' | 'read_failed' | 'not_found' | 'ambiguous' | 'not_owner' | 'scope_mismatch' | 'disconnected' | 'invalid_binding'
export type MerchantResolution<T> = { ok: true; value: T } | { ok: false; reason: MerchantIdentityFailure }
