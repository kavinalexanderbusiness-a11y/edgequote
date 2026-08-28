// ── "Leads needing a response" — the ONE unread-lead count ───────────────────
// A lead can reach EdgeHQ by three different doors, and until this existed no
// single place counted all three, so the owner's "new leads" number silently
// undercounted every online booking:
//
//   1. Website quote form  → submit_website_lead writes a website_leads row AND
//                            stamps conversations.lead_status='new' (the Messages
//                            inbox "Website Leads" filter reads exactly this).
//   2. A reply we owe      → the customer messaged and the last message is still
//                            theirs (conversations.last_direction='inbound') —
//                            the same rule lib/crm/radar.ts uses.
//   3. Online booking form → submit_booking writes NEITHER of the above. It only
//                            creates a DRAFT QUOTE carrying lead_meta. Invisible
//                            to doors 1 and 2 — this is the leak this file closes.
//
// Reuses the existing predicates rather than inventing new ones, so each part
// agrees with the surface it came from (inbox badge, follow-up radar, quotes).
// Counting is deliberately de-duplicated by customer where the sources overlap.

export type LeadSource = 'website' | 'reply' | 'booking'

export interface LeadNeedingResponse {
  key: string
  source: LeadSource
  name: string
  /** When the lead arrived / the customer last messaged (ISO). Oldest = rudest wait. */
  at: string
  customerId: string | null
  href: string
}

export interface LeadResponseReport {
  items: LeadNeedingResponse[]
  total: number
  bySource: Record<LeadSource, number>
  /** Longest a lead has been waiting, in whole hours. Drives the urgency tone. */
  oldestHours: number | null
}

export type LeadConvRow = {
  id: string; customer_id: string | null; lead_status: string | null
  last_direction: string | null; last_message_at: string | null; created_at: string
  /** Snoozed conversations are excluded — the inbox already hides them (the
   *  `awake` predicate), and a count that keeps nagging about a lead the owner
   *  deliberately parked contradicts the surface it links to. */
  snoozed_until?: string | null
  customers: { name: string | null } | { name: string | null }[] | null
}
export type LeadQuoteRow = {
  id: string; customer_id: string | null; customer_name: string | null
  created_at: string; status?: string; lead_meta?: unknown
}

/** Rows a caller has already loaded — pass them and this fetches nothing. */
export interface LeadResponsePreloaded {
  conversations: LeadConvRow[]
  /** ALL quotes; the booking filter (draft + lead_meta) is applied here. */
  quotes: LeadQuoteRow[]
}

/**
 * Pure core. The dashboard already holds both tables, so it passes them in
 * rather than making this re-read them — and its copies are PAGED, so the union
 * can't be computed from a silently truncated read.
 */
export function computeLeadsNeedingResponse(pre: LeadResponsePreloaded, now: Date = new Date()): LeadResponseReport {
  const items: LeadNeedingResponse[] = []
  // A customer who both submitted the form and is awaiting a reply is ONE person
  // to call, not two — count them once, under the stronger signal (website lead).
  const seen = new Set<string>()

  // Booking-draft customers, known up front: a fresh booking ALSO writes an
  // inbound portal message into the conversation, so its conversation used to win
  // the dedupe as a generic "reply" pointing at the bare inbox — every booking
  // lead misfiled, and the item that actually answers the request (the draft
  // quote, with the plan/photos/notes) never shown. The booking identity wins;
  // an open WEBSITE lead (lead_status='new') still outranks it.
  const bookingCustomers = new Set<string>()
  for (const q of pre.quotes) {
    if (q.status === 'draft' && q.lead_meta != null && q.customer_id) bookingCustomers.add(q.customer_id)
  }

  for (const c of pre.conversations) {
    // Snoozed = deliberately parked. The inbox hides it (`awake`); the dashboard
    // nagging about it anyway sent the owner to a list where it isn't.
    if (c.snoozed_until && new Date(c.snoozed_until).getTime() > now.getTime()) continue
    const nameRow = Array.isArray(c.customers) ? c.customers[0] : c.customers
    const name = nameRow?.name || 'New lead'
    const at = c.last_message_at || c.created_at
    const dedupe = c.customer_id || c.id
    if (c.lead_status === 'new') {
      // ?f= — the key the Messages page actually reads. The old ?filter= was
      // silently dropped and the #1 priority row landed on the unfiltered inbox.
      items.push({ key: `w-${c.id}`, source: 'website', name, at, customerId: c.customer_id, href: '/dashboard/messages?f=website_lead' })
      seen.add(dedupe)
    } else if (c.last_direction === 'inbound') {
      if (c.customer_id && bookingCustomers.has(c.customer_id)) continue // the booking item below carries the real door
      // ?c=<customerId> opens THAT conversation — the door the bell and push
      // already land on. Without it the dashboard row named the person and then
      // dropped the owner on an unfiltered inbox to find them again. No
      // customer_id (anonymous inbound) still falls back to the plain list.
      items.push({
        key: `r-${c.id}`, source: 'reply', name, at, customerId: c.customer_id,
        href: c.customer_id ? `/dashboard/messages?c=${c.customer_id}` : '/dashboard/messages',
      })
      seen.add(dedupe)
    }
  }

  // Door 3 — a booking arrives as a draft quote carrying lead_meta. Its item
  // links to the DRAFT QUOTE, the one page that answers what they asked for.
  for (const q of pre.quotes) {
    if (q.status !== 'draft' || q.lead_meta == null) continue
    const dedupe = q.customer_id || q.id
    if (seen.has(dedupe)) continue // already counted via a stronger signal
    items.push({
      key: `b-${q.id}`, source: 'booking', name: q.customer_name || 'Online booking',
      at: q.created_at, customerId: q.customer_id, href: `/dashboard/quotes/${q.id}`,
    })
  }

  // Oldest first — the longest wait is the most urgent call to make.
  items.sort((a, b) => a.at.localeCompare(b.at))

  const bySource: Record<LeadSource, number> = { website: 0, reply: 0, booking: 0 }
  for (const i of items) bySource[i.source]++

  const oldestHours = items.length
    ? Math.max(0, Math.floor((Date.now() - new Date(items[0].at).getTime()) / 3_600_000))
    : null

  return { items, total: items.length, bySource, oldestHours }
}
