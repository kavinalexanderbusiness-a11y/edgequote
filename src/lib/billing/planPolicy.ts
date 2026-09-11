// B3 preparation only. No application route imports this server policy.
// This is NOT an implementation of paid entitlement enforcement. B1/B2 lack
// durable opt-in and complete commercial subscription facts; guessing a plan
// from their price/status columns would manufacture authority.
import { PRODUCT_PLANS, type ProductFeatureId } from '../productPlans'

export interface PlatformPlanPolicyPorts {
  /** Fresh server auth.getUser(), never a cookie, getSession() or browser ID. */
  getVerifiedUser(): Promise<{ id: string } | null>
  /** Database current_app_role() in that same authenticated server session. */
  getCurrentAppRole(): Promise<'owner' | 'crew' | 'none'>
}

export interface PlatformPlanPolicy {
  readonly authority: 'verified_owner' | 'not_owner' | 'unavailable'
  readonly ownerId: string | null
  readonly billingStatus: 'inactive'
  readonly currentPaidPlanId: null
  readonly enforcementEnabled: false
  readonly subscribeEnabled: false
  readonly manageSubscriptionEnabled: false
  readonly planChangesEnabled: false
  readonly existingAccess: 'preserve_existing_role_permissions'
  readonly protectedActions: readonly ['records', 'payment_recording', 'exports', 'finish_existing_work', 'recovery']
  /** Packaging only. These are NOT effective permissions or provider grants. */
  readonly proposedBundles: Readonly<Record<'base' | 'plus' | 'premium', readonly ProductFeatureId[]>>
}

const proposedBundles = Object.freeze(Object.fromEntries(PRODUCT_PLANS.map(plan => [
  plan.id, Object.freeze(plan.features.map(feature => feature.id)),
])) as Record<'base' | 'plus' | 'premium', readonly ProductFeatureId[]>)
const protectedActions = Object.freeze(['records', 'payment_recording', 'exports', 'finish_existing_work', 'recovery'] as const)
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function policy(authority: PlatformPlanPolicy['authority'], ownerId: string | null): PlatformPlanPolicy {
  return Object.freeze({
    authority, ownerId, billingStatus: 'inactive', currentPaidPlanId: null,
    enforcementEnabled: false, subscribeEnabled: false, manageSubscriptionEnabled: false,
    planChangesEnabled: false, existingAccess: 'preserve_existing_role_permissions',
    protectedActions, proposedBundles,
  })
}

/** One dormant server policy for the preview phase. Visiting Plans, signup,
 * a missing row, a provider price or a Checkout return cannot enroll anyone.
 * Errors leave existing access alone; no state here grants owner/crew access.
 * A future mount needs the reviewed schema, server adapters and direct-writer
 * closure. Changing one flag here can never implement that migration. */
export async function resolvePlatformPlanPolicy(ports: PlatformPlanPolicyPorts): Promise<PlatformPlanPolicy> {
  try {
    const before = await ports.getVerifiedUser()
    if (!before || !uuid.test(before.id)) return policy('not_owner', null)
    // Capture the value rather than retaining a mutable authentication object.
    const ownerId = before.id
    const role = await ports.getCurrentAppRole()
    if (role !== 'owner') return policy('not_owner', null)
    const after = await ports.getVerifiedUser()
    if (!after || after.id !== ownerId) return policy('unavailable', null)
    return policy('verified_owner', ownerId)
  } catch { return policy('unavailable', null) }
}
