// ── "Leads needing a response" — the ONE unread-lead count ───────────────────
// A lead can reach EdgeQuote by three different doors, and until this existed no
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
export function computeLeadsNeedingResponse(pre: LeadResponsePreloaded): LeadResponseReport {
  const items: LeadNeedingResponse[] = []
  // A customer who both submitted the form and is awaiting a reply is ONE person
  // to call, not two — count them once, under the stronger signal (website lead).
  const seen = new Set<string>()

  for (const c of pre.conversations) {
    const nameRow = Array.isArray(c.customers) ? c.customers[0] : c.customers
    const name = nameRow?.name || 'New lead'
    const at = c.last_message_at || c.created_at
    const dedupe = c.customer_id || c.id
    if (c.lead_status === 'new') {
      items.push({ key: `w-${c.id}`, source: 'website', name, at, customerId: c.customer_id, href: '/dashboard/messages?filter=website_lead' })
      seen.add(dedupe)
    } else if (c.last_direction === 'inbound') {
      items.push({ key: `r-${c.id}`, source: 'reply', name, at, customerId: c.customer_id, href: '/dashboard/messages' })
      seen.add(dedupe)
    }
  }

  // Door 3 — a booking arrives as a draft quote carrying lead_meta, nothing else.
  for (const q of pre.quotes) {
    if (q.status !== 'draft' || q.lead_meta == null) continue
    const dedupe = q.customer_id || q.id
    if (seen.has(dedupe)) continue // already counted via their conversation
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
