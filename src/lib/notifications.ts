// ── Notification grouping + prioritization (the ONE notification organizer) ──────
// The notifications table already captures every throughout-the-day event
// (quote_accepted, invoice_paid, new_message, payment_failed, …) via DB triggers.
// This pure layer turns that raw stream into something calm: it dedupes exact
// repeats, splits out the few items that truly NEED attention, and groups the rest
// by type ("3 invoices paid") so the owner sees signal, not noise. No new table,
// no new fetch — callers pass the rows they already loaded.

import type { AppNotification } from '@/components/notifications/NotificationBell'

export type NotifPriority = 'action' | 'update' | 'info'

// Only money/trust problems demand attention; wins are updates; chatter is info.
const PRIORITY: Record<string, NotifPriority> = {
  payment_failed: 'action',
  payment_disputed: 'action',
  // Money the owner thinks they have and doesn't — the loudest thing in here.
  payment_dispute_lost: 'action',
  autopay_review: 'action',
  payment_refunded: 'action',
  // Nothing to do; it's the reassuring half of a dispute they already worried about.
  payment_dispute_won: 'update',
  quote_accepted: 'update',
  invoice_paid: 'update',
  review_received: 'update',
  website_lead: 'update',
  portal_request: 'update',
  new_message: 'info',
  // The crew said something about a visit. NOT 'action' — that tier is reserved
  // for money and trust problems and is shown item-by-item, never buried, which
  // is exactly the wrong treatment for a conversation: a chatty morning would
  // fill the "needs you" list and push a lost payment out of sight. As an
  // 'update' it groups ("3 crew messages") and sorts unread-first, which is the
  // anti-spam behaviour this feature was asked to have. The bell is also
  // deduped at the source — the DB trigger will not ring again for a visit that
  // already has an UNREAD bell waiting.
  crew_message: 'update',
  // A customer's own answer on added scope. 'update', not 'action': when they
  // say yes the money is already added (the approval trigger mints the line), so
  // there is nothing here for the owner to repair — which is exactly what
  // separates this tier from a failed payment.
  change_order_approved: 'update',
  // A no is not a problem either: nothing was added and nothing is owed. Whether
  // to re-price it is a decision, not a repair.
  change_order_declined: 'update',
  // A worker asked for a day off. A real decision, but NOT 'action': that tier
  // is money and trust problems, shown item-by-item and never buried, and a
  // leave request is neither urgent nor a repair. Nothing breaks while it
  // waits — the plan simply keeps counting on them, which is the truthful
  // state until the owner answers. It groups as an update and the time-off
  // page carries the queue with its own count.
  time_off_requested: 'update',
}
export function notifPriority(type: string): NotifPriority {
  return PRIORITY[type] ?? 'update'
}

// The one-click action verb per type — every notification offers an obvious next
// step (it navigates to the notification's href). Falls back to "View".
const ACTION_VERB: Record<string, string> = {
  quote_accepted: 'Schedule',
  invoice_paid: 'View',
  new_message: 'Reply',
  portal_request: 'View',
  review_received: 'View',
  website_lead: 'Build quote',
  payment_failed: 'Fix payment',
  autopay_review: 'Review',
  payment_refunded: 'View',
  payment_disputed: 'Review',
  payment_dispute_lost: 'Review',
  payment_dispute_won: 'View',
  // Its href is the visit (/dashboard/schedule?job=…), which is where the
  // conversation lives — so the verb promises what the tap actually does.
  crew_message: 'Open visit',
  // Both hrefs are the visit the change belongs to, so the verb promises what
  // the tap actually does.
  change_order_approved: 'Open visit',
  change_order_declined: 'Open visit',
  // Its href opens the time-off page on the requests queue, so the verb
  // promises what the tap actually does.
  time_off_requested: 'Review',
}
export function notificationActionLabel(type: string): string {
  return ACTION_VERB[type] ?? 'View'
}

// Singular noun per type, for "3 invoices paid"-style group titles.
const TYPE_NOUN: Record<string, string> = {
  quote_accepted: 'quote accepted',
  invoice_paid: 'invoice paid',
  new_message: 'new message',
  portal_request: 'portal request',
  review_received: 'review',
  website_lead: 'website lead',
  payment_failed: 'payment failed',
  autopay_review: 'autopay to review',
  payment_refunded: 'refund',
  payment_disputed: 'dispute',
  payment_dispute_lost: 'dispute lost',
  payment_dispute_won: 'dispute resolved',
  crew_message: 'crew message',
  change_order_approved: 'change approved',
  change_order_declined: 'change declined',
}
function groupTitle(type: string, n: number): string {
  const noun = TYPE_NOUN[type] ?? type.replace(/_/g, ' ')
  if (n === 1) return noun.charAt(0).toUpperCase() + noun.slice(1)
  // "invoice paid" → "3 invoices paid"; "review" → "3 reviews"
  const plural = noun.includes(' ')
    ? noun.replace(/^(\w+)/, (w) => (w.endsWith('s') ? w : w + 's'))
    : (noun.endsWith('s') ? noun : noun + 's')
  return `${n} ${plural}`
}

// ── The snooze vocabulary ────────────────────────────────────────────────────
// "Remind me later" means the same thing everywhere it is offered (the Inbox's
// event actions and the notifications page), so it is defined once, here, beside
// the rest of the notification vocabulary. Local time deliberately: 8am is a
// promise about the owner's morning, not about UTC.
/** "Remind me later" → tomorrow at 8am **local** time, as an ISO instant. */
export function tomorrow8am(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(8, 0, 0, 0)
  return d.toISOString()
}

export interface NotifGroup {
  key: string
  type: string
  priority: NotifPriority
  title: string
  body: string | null            // single item's body, or null for a multi-item group
  href: string | null
  count: number
  unread: number
  latestAt: string               // ISO of the newest item in the group
  ids: string[]                  // underlying notification ids (for mark-read)
  items: AppNotification[]       // newest-first, for inline expansion
}

export interface GroupedNotifications {
  actionNeeded: NotifGroup[]     // each shown individually — never buried
  activity: NotifGroup[]         // grouped by type, unread first
  totalUnread: number
}

// Items must be newest-first (the page/bell already query that way).
export function groupNotifications(items: AppNotification[]): GroupedNotifications {
  // 1) Suppress exact duplicates (same type + title + href) — keep the newest.
  const seen = new Set<string>()
  const deduped: AppNotification[] = []
  for (const n of items) {
    const k = `${n.type}|${n.title}|${n.href ?? ''}`
    if (seen.has(k)) continue
    seen.add(k)
    deduped.push(n)
  }

  // 2) Action items stay individual; everything else groups by type.
  const actionNeeded: NotifGroup[] = []
  const byType: Record<string, AppNotification[]> = {}
  for (const n of deduped) {
    if (notifPriority(n.type) === 'action') {
      actionNeeded.push({
        key: n.id, type: n.type, priority: 'action', title: n.title, body: n.body, href: n.href,
        count: 1, unread: n.read ? 0 : 1, latestAt: n.created_at, ids: [n.id], items: [n],
      })
    } else {
      (byType[n.type] ||= []).push(n)
    }
  }

  const activity: NotifGroup[] = Object.entries(byType).map(([type, ns]) => {
    const single = ns.length === 1
    return {
      key: `g:${type}`, type, priority: notifPriority(type),
      title: groupTitle(type, ns.length),
      body: single ? ns[0].body : null,
      href: single ? ns[0].href : '/dashboard/notifications',
      count: ns.length,
      unread: ns.filter(n => !n.read).length,
      latestAt: ns[0].created_at,
      ids: ns.map(n => n.id),
      items: ns,
    }
  }).sort((a, b) => (b.unread - a.unread) || b.latestAt.localeCompare(a.latestAt))

  actionNeeded.sort((a, b) => (b.unread - a.unread) || b.latestAt.localeCompare(a.latestAt))

  return { actionNeeded, activity, totalUnread: deduped.filter(n => !n.read).length }
}
