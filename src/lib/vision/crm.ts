import type { CrmBlock, OpportunityBlock } from './types'
import { SERVICE_MATCHERS, serviceLabel } from './services'

// ── AI Vision — CRM block (never-purchased + natural recommendations) ─────────
// Turns the read-only purchase history + scored opportunities into the CRM-facing
// view: which services the customer has never bought, and which of those THIS
// property's condition naturally recommends. Pure. Exposed for CRM to consume — it
// does not edit CRM.

export function buildCrm(opts: {
  purchased: Set<string>
  hasCustomer: boolean
  opportunities: OpportunityBlock
}): CrmBlock {
  const { purchased, hasCustomer, opportunities } = opts
  // Without a linked customer we can't assert "never purchased".
  if (!hasCustomer) return { never_purchased: [], recommendations: [] }

  const neverPurchased = SERVICE_MATCHERS.map(m => m.key).filter(k => !purchased.has(k))

  // Recommend the never-purchased services THIS property actually warrants
  // (i.e. surfaced as opportunities), highest value first.
  const recommendations = opportunities.items
    .filter(o => o.never_purchased)
    .slice(0, 4)
    .map(o => ({ key: o.key, label: serviceLabel(o.key), why: o.reason }))

  return { never_purchased: neverPurchased, recommendations }
}
