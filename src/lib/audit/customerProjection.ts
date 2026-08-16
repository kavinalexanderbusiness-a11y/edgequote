// ── What a CUSTOMER may see of the audit trail ───────────────────────────────
//
// The audit trail is an INTERNAL record. A customer portal must never receive it
// wholesale: it names workers, prices, staffing decisions and internal notes.
//
// So this module is the projection, and it is an ALLOW-LIST. That direction is the
// whole design:
//
//   a deny-list leaks every action added after it was written.
//
// Someone adding `worker_wage_reviewed` next year does not have to remember this
// file for the portal to stay safe — an unlisted action is invisible by default.
//
// ⛔ What a projected row must NOT carry, and why:
//   actor identity — a customer learning that "Mike" (not "Dave") did the work is
//     staffing information they were never promised, and it makes a worker's day
//     legible to strangers. Projected rows say WHAT happened, not WHO did it.
//   before/after   — internal price movements, statuses and staffing live there.
//   meta           — cascade counts, session ids, invoice ids: plumbing.
//
// ⭐ This is a PURE function over rows the caller already loaded. It performs no
// reads and owns no tokens — the portal's own RPC boundary decides which customer
// is asking, exactly as every other portal surface does. A projection that fetched
// its own data would be a second portal door.

/** The shape this module needs. Deliberately a subset of the audit_events row. */
export type AuditRowForProjection = {
  id: string
  occurred_at: string
  action: string
  entity_type: string
  entity_label: string | null
  customer_id: string | null
}

/** What a customer receives. Note the absence of actor, before, after and meta. */
export type CustomerVisibleEvent = {
  id: string
  at: string
  /** A complete sentence about the customer's own account, in their words. */
  title: string
  entity: string
}

/**
 * The allow-list: business facts the customer was already told, or was party to.
 *
 * Each entry is here because the customer either performed the act, received the
 * document, or was notified of it at the time. Nothing here reveals anything they
 * could not already see in their portal.
 */
const CUSTOMER_SAFE_ACTIONS = new Map<string, (label: string | null) => string>([
  // Their own decisions
  ['quote_accepted', l => `You approved quote ${l ?? ''}`.trim()],
  ['quote_declined', l => `You declined quote ${l ?? ''}`.trim()],
  ['change_order_approved', l => `You approved change ${l ?? ''}`.trim()],
  ['change_order_declined', l => `You declined change ${l ?? ''}`.trim()],
  ['request_received', () => 'You sent a request'],

  // Documents they were sent
  ['quote_sent', l => `Quote ${l ?? ''} sent to you`.trim()],
  ['change_order_sent', l => `Change ${l ?? ''} sent for your approval`.trim()],
  ['invoice_created', l => `Invoice ${l ?? ''} issued`.trim()],
  ['invoice_issued', l => `Invoice ${l ?? ''} issued`.trim()],

  // Work on their property, and money they paid
  ['visit_booked', () => 'Visit scheduled'],
  ['visit_rescheduled', () => 'Visit rescheduled'],
  ['visit_completed', () => 'Work completed'],
  ['payment_recorded', () => 'Payment received'],
  ['refund_recorded', () => 'Refund issued'],
  ['invoice_paid', l => `Invoice ${l ?? ''} paid in full`.trim()],
])

/** Is this action safe to show the customer it belongs to? */
export function isCustomerSafeAction(action: string): boolean {
  return CUSTOMER_SAFE_ACTIONS.has(action)
}

/**
 * Project internal audit rows down to what one customer may see.
 *
 * Two filters, both required:
 *   1. the row must belong to THAT customer — a token proves which tenant, never
 *      which row, so the caller's customer id is checked here as well;
 *   2. the action must be on the allow-list.
 */
export function projectForCustomer(
  rows: AuditRowForProjection[],
  customerId: string,
): CustomerVisibleEvent[] {
  if (!customerId) return []
  return rows
    .filter(r => r.customer_id === customerId)
    .filter(r => CUSTOMER_SAFE_ACTIONS.has(r.action))
    .map(r => ({
      id: r.id,
      at: r.occurred_at,
      title: CUSTOMER_SAFE_ACTIONS.get(r.action)!(r.entity_label),
      entity: r.entity_type,
    }))
}
