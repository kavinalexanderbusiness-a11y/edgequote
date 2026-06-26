// ── Follow-up radar (loader) ─────────────────────────────────────────────────
// "Customers needing follow-up" + "Customers not contacted in X days", computed
// from data the app already has: customers.last_contacted_at (maintained from
// outbound messages by the trigger in migration 2026-06-25h) and the existing
// conversations summary (last_direction / unread). No new tables. A customer
// surfaces when they have an unanswered inbound message OR we've gone quiet on
// them for longer than the threshold (never-contacted counts from when they were
// added, so brand-new customers don't show until they've aged past the window).

import type { SupabaseClient } from '@supabase/supabase-js'
import { daysSince } from '@/lib/followup'

export interface RadarItem {
  customerId: string
  name: string
  phone: string | null
  email: string | null
  lastContactedAt: string | null
  daysQuiet: number            // days since last outbound (or since added, if never)
  neverContacted: boolean
  unansweredInbound: boolean   // customer messaged and the last message is still theirs
  unread: number
  reason: string
  priority: number             // higher = more urgent
}

interface CustRow { id: string; name: string; phone: string | null; email: string | null; created_at: string; last_contacted_at: string | null }
interface ConvoRow { customer_id: string; last_direction: string | null; unread: number | null }

// thresholdDays: a customer counts as "quiet" at or beyond this many days.
export async function loadFollowUpRadar(supabase: SupabaseClient, thresholdDays = 30): Promise<RadarItem[]> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []
  const [custRes, convoRes] = await Promise.all([
    supabase.from('customers').select('id, name, phone, email, created_at, last_contacted_at').eq('user_id', user.id).is('archived_at', null),
    supabase.from('conversations').select('customer_id, last_direction, unread').eq('user_id', user.id),
  ])
  const custs = (custRes.data as CustRow[]) || []
  const convoByCust: Record<string, ConvoRow> = {}
  for (const c of (convoRes.data as ConvoRow[]) || []) convoByCust[c.customer_id] = c

  const items: RadarItem[] = []
  for (const c of custs) {
    const convo = convoByCust[c.id]
    const unansweredInbound = convo?.last_direction === 'inbound'
    const unread = convo?.unread || 0
    const neverContacted = !c.last_contacted_at
    // Days quiet: time since last outbound, or — if we've never reached out — how
    // long they've been a customer.
    const daysQuiet = (c.last_contacted_at ? daysSince(c.last_contacted_at) : daysSince(c.created_at)) ?? 0

    const quiet = daysQuiet >= thresholdDays
    if (!unansweredInbound && !quiet) continue

    let reason: string, priority: number
    if (unansweredInbound) {
      reason = unread > 0 ? `${unread} unread ${unread === 1 ? 'reply' : 'replies'} — awaiting your response` : 'Replied — awaiting your response'
      priority = 10_000 + unread
    } else if (neverContacted) {
      reason = `Never contacted · added ${daysQuiet}d ago`
      priority = 1_000 + daysQuiet
    } else {
      reason = `Last contacted ${daysQuiet}d ago`
      priority = daysQuiet
    }
    items.push({ customerId: c.id, name: c.name, phone: c.phone, email: c.email, lastContactedAt: c.last_contacted_at, daysQuiet, neverContacted, unansweredInbound, unread, reason, priority })
  }
  items.sort((a, b) => b.priority - a.priority)
  return items
}
