import type {
  MerchantConnection, MerchantConnectionReader, MerchantIdentity, MerchantObjectType,
  MerchantProviderObject, MerchantRead, MerchantResolution, MerchantScope, MerchantTarget,
} from './types'

// Pure, inactive server contract: no environment, fetch, Supabase or Stripe import.
// Authenticated owner and verified webhook are CALLER preconditions. These helpers
// establish stored identity only; they do not authenticate or enable collections.
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const account = (v: unknown): v is string => typeof v === 'string' && /^acct_[A-Za-z0-9_]{1,250}$/.test(v)
const PREFIX: Record<MerchantObjectType, string> = {
  customer: 'cus_', payment_method: 'pm_', setup_intent: 'seti_',
  checkout_session: 'cs_', payment_intent: 'pi_', charge: 'ch_',
}
const objectType = (v: unknown): v is MerchantObjectType => typeof v === 'string' && Object.hasOwn(PREFIX, v)
const objectId = (type: MerchantObjectType, value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_]{1,255}$/.test(value) && value.startsWith(PREFIX[type]) && value.length > PREFIX[type].length

function one<T>(read: MerchantRead<T>): MerchantResolution<T> {
  if (!read?.ok || !Array.isArray(read.rows)) return { ok: false, reason: 'read_failed' }
  if (read.rows.length !== 1) return { ok: false, reason: read.rows.length ? 'ambiguous' : 'not_found' }
  return { ok: true, value: read.rows[0] }
}

function validConnection(c: MerchantConnection): boolean {
  return !!c && uuid(c.id) && uuid(c.user_id) && account(c.stripe_platform_account_id)
    && account(c.stripe_account_id) && c.stripe_platform_account_id !== c.stripe_account_id
    && typeof c.livemode === 'boolean'
    && (c.disconnected_at === null || (typeof c.disconnected_at === 'string' && Number.isFinite(Date.parse(c.disconnected_at))))
}

function identity(c: MerchantConnection): MerchantIdentity {
  // Project fields explicitly: a future adapter cannot leak excess row fields.
  return { connectionId: c.id, ownerId: c.user_id, platformAccountId: c.stripe_platform_account_id, stripeAccountId: c.stripe_account_id, livemode: c.livemode }
}

async function currentOwner(reader: MerchantConnectionReader, ownerId: string): Promise<boolean | null> {
  const result = await reader.owner(ownerId)
  if (!result?.ok || !Array.isArray(result.rows)) return null
  return result.rows.length === 1 && result.rows[0]?.user_id === ownerId
}

/** ownerId must come from authenticated owner context, never a request body. */
export async function resolveMerchantOwnerIdentity(
  reader: MerchantConnectionReader,
  scope: { ownerId: string; platformAccountId: string; livemode: boolean },
): Promise<MerchantResolution<MerchantIdentity>> {
  if (!uuid(scope.ownerId) || !account(scope.platformAccountId) || typeof scope.livemode !== 'boolean') return { ok: false, reason: 'invalid_scope' }
  try {
    const owner = await currentOwner(reader, scope.ownerId)
    if (owner === null) return { ok: false, reason: 'read_failed' }
    if (!owner) return { ok: false, reason: 'not_owner' }
    const result = one(await reader.byOwner(scope))
    if (!result.ok) return result
    const c = result.value
    if (!validConnection(c) || c.user_id !== scope.ownerId || c.stripe_platform_account_id !== scope.platformAccountId || c.livemode !== scope.livemode) return { ok: false, reason: 'scope_mismatch' }
    if (c.disconnected_at !== null) return { ok: false, reason: 'disconnected' }
    return { ok: true, value: identity(c) }
  } catch { return { ok: false, reason: 'read_failed' } }
}

function target(binding: MerchantProviderObject): MerchantTarget | null {
  const { customer_id: customer, invoice_id: invoice, quote_id: quote } = binding
  if ([customer, invoice, quote].filter(v => v !== null).length !== 1) return null
  const value: MerchantTarget | null = customer !== null ? { kind: 'customer', id: customer }
    : invoice !== null ? { kind: 'invoice', id: invoice } : quote !== null ? { kind: 'quote', id: quote } : null
  if (!value || !uuid(value.id)) return null
  if (['customer', 'payment_method', 'setup_intent'].includes(binding.object_type) && value.kind !== 'customer') return null
  if (['payment_intent', 'charge'].includes(binding.object_type) && value.kind === 'customer') return null
  return value
}

/**
 * CALLER must first verify raw webhook signature with the Connect endpoint's
 * secret and supply the actual configured platform account plus event.account
 * and event.livemode. Metadata is deliberately absent from this interface.
 * Historical disconnected connections still resolve: money already moved and
 * must be recorded. A resolved identity never authorizes a new charge.
 */
export async function resolveMerchantEventIdentity(
  reader: MerchantConnectionReader,
  scope: MerchantScope & { objectType: MerchantObjectType; objectId: string },
): Promise<MerchantResolution<{ identity: MerchantIdentity; target: MerchantTarget }>> {
  if (!account(scope.platformAccountId) || !account(scope.stripeAccountId) || scope.platformAccountId === scope.stripeAccountId
    || typeof scope.livemode !== 'boolean' || !objectType(scope.objectType) || !objectId(scope.objectType, scope.objectId)) return { ok: false, reason: 'invalid_scope' }
  try {
    const connection = one(await reader.byAccount(scope))
    if (!connection.ok) return connection
    const c = connection.value
    if (!validConnection(c) || c.stripe_platform_account_id !== scope.platformAccountId || c.stripe_account_id !== scope.stripeAccountId || c.livemode !== scope.livemode) return { ok: false, reason: 'scope_mismatch' }
    const owner = await currentOwner(reader, c.user_id)
    if (owner === null) return { ok: false, reason: 'read_failed' }
    if (!owner) return { ok: false, reason: 'not_owner' }
    const object = one(await reader.object(scope))
    if (!object.ok) return object
    const b = object.value
    if (!b || b.connection_id !== c.id || b.user_id !== c.user_id || b.stripe_platform_account_id !== c.stripe_platform_account_id
      || b.stripe_account_id !== c.stripe_account_id || b.livemode !== c.livemode || b.object_type !== scope.objectType || b.object_id !== scope.objectId) return { ok: false, reason: 'scope_mismatch' }
    const localTarget = target(b)
    if (!localTarget) return { ok: false, reason: 'invalid_binding' }
    return { ok: true, value: { identity: identity(c), target: localTarget } }
  } catch { return { ok: false, reason: 'read_failed' } }
}
