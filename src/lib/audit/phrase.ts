// ── Saying what an audit event means, in the owner's words ───────────────────
//
// Pure, I/O-free, and the ONLY place audit vocabulary lives. The UI renders what
// this returns; it invents no phrasing of its own. That split is what lets a row
// read the same on the customer page, the job card and the business feed.
//
// Three rules the wording follows:
//
//  ⭐ THE VOCABULARY IS THE OWNER'S, NOT THE SCHEMA'S. A `jobs` row IS a visit, so
//    acting on one says "visit" — never "job", which means the ongoing arrangement.
//    Copy written straight off a table name says the wrong word here.
//
//  ⭐ NEVER CLAIM MORE THAN THE EVENT KNOWS. An event whose actor is `system` says
//    "Automatically" — not the owner's name. An unknown worker says "A team
//    member", not a guess.
//
//  ⭐ A CHANGE IS TWO VALUES, FORMATTED THE SAME WAY. "$5,500 → $6,075", never
//    "5500 → 6075.00". Formatting is chosen by what the key MEANS, so a price
//    reads as money and a date as a date, wherever it appears.

import { formatCurrency, parseLocalDate } from '@/lib/utils'
import type { AuditEvent } from './history'

/** Coarse grouping, for filter chips on the business feed. */
export type AuditCategory = 'sales' | 'work' | 'money' | 'people' | 'record'

interface ActionMeta {
  /** Sentence fragment: what happened. Subject is the actor. */
  label: string
  category: AuditCategory
}

// Every action the triggers can emit. A missing entry falls back to a humanised
// form of the action name rather than rendering a blank row.
const ACTIONS: Record<string, ActionMeta> = {
  // sales
  quote_created: { label: 'Created quote', category: 'sales' },
  quote_sent: { label: 'Sent quote', category: 'sales' },
  // ⭐ THREE EVENTS, THREE ROWS (Session 121). These used to be one action —
  // 'quote_accepted' — emitted on every transition into 'accepted', so a portal
  // approval, an owner recording a phone call, and an owner correcting a stuck
  // row all read identically in the feed. audit_quotes() now picks between them
  // by asking the acceptance ledger what actually happened.
  quote_accepted: { label: 'Accepted quote', category: 'sales' },
  quote_acceptance_recorded: { label: 'Recorded the customer’s acceptance', category: 'sales' },
  // ⚠️ Deliberately dull, and deliberately not the word "accepted". Nobody
  // consented; a label was changed. Saying anything warmer here is the exact lie
  // this session exists to remove.
  quote_status_overridden: { label: 'Set quote to Accepted by hand', category: 'sales' },
  quote_declined: { label: 'Declined quote', category: 'sales' },
  quote_scheduled: { label: 'Scheduled quote', category: 'sales' },
  quote_completed: { label: 'Quote completed', category: 'sales' },
  quote_paid: { label: 'Quote paid', category: 'sales' },
  quote_status_changed: { label: 'Changed quote status', category: 'sales' },
  quote_price_changed: { label: 'Changed quote price', category: 'sales' },
  quote_deleted: { label: 'Deleted quote', category: 'sales' },
  change_order_created: { label: 'Created change', category: 'sales' },
  change_order_sent: { label: 'Sent change for approval', category: 'sales' },
  change_order_approved: { label: 'Approved change', category: 'sales' },
  change_order_declined: { label: 'Declined change', category: 'sales' },
  change_order_cancelled: { label: 'Cancelled change', category: 'sales' },
  change_order_status_changed: { label: 'Changed a change order', category: 'sales' },
  request_received: { label: 'Sent a request', category: 'sales' },
  request_resolved: { label: 'Resolved a request', category: 'sales' },

  // work
  visit_booked: { label: 'Booked visit', category: 'work' },
  visit_rescheduled: { label: 'Rescheduled visit', category: 'work' },
  visit_started: { label: 'Started work', category: 'work' },
  visit_completed: { label: 'Completed visit', category: 'work' },
  visit_cancelled: { label: 'Cancelled visit', category: 'work' },
  visit_reopened: { label: 'Reopened visit', category: 'work' },
  visit_status_changed: { label: 'Changed visit status', category: 'work' },
  visit_crew_changed: { label: 'Reassigned crew', category: 'work' },
  visit_price_changed: { label: 'Changed visit price', category: 'work' },
  visit_deleted: { label: 'Deleted visit', category: 'work' },
  work_paused: { label: 'Stopped for the day', category: 'work' },
  work_resumed: { label: 'Resumed work', category: 'work' },
  work_recorded: { label: 'Recorded work', category: 'work' },
  work_edited: { label: 'Edited recorded work', category: 'work' },
  work_removed: { label: 'Removed recorded work', category: 'work' },
  plan_created: { label: 'Started a repeating plan', category: 'work' },
  plan_changed: { label: 'Changed the repeating plan', category: 'work' },
  plan_removed: { label: 'Ended the repeating plan', category: 'work' },

  // money
  invoice_created: { label: 'Created invoice', category: 'money' },
  invoice_issued: { label: 'Issued invoice', category: 'money' },
  invoice_edited: { label: 'Edited invoice', category: 'money' },
  invoice_paid: { label: 'Invoice paid in full', category: 'money' },
  invoice_partially_paid: { label: 'Invoice partly paid', category: 'money' },
  invoice_cancelled: { label: 'Cancelled invoice', category: 'money' },
  invoice_reactivated: { label: 'Reactivated invoice', category: 'money' },
  invoice_status_changed: { label: 'Changed invoice status', category: 'money' },
  invoice_deleted: { label: 'Deleted invoice', category: 'money' },
  payment_recorded: { label: 'Recorded payment', category: 'money' },
  payment_removed: { label: 'Removed payment', category: 'money' },
  payment_status_changed: { label: 'Changed payment status', category: 'money' },
  credit_recorded: { label: 'Recorded credit', category: 'money' },
  refund_recorded: { label: 'Issued refund', category: 'money' },

  // people
  worker_added: { label: 'Added team member', category: 'people' },
  worker_removed: { label: 'Removed team member', category: 'people' },
  worker_access_enabled: { label: 'Enabled access', category: 'people' },
  worker_access_disabled: { label: 'Disabled access', category: 'people' },
  worker_archived: { label: 'Archived team member', category: 'people' },
  worker_restored: { label: 'Restored team member', category: 'people' },
  worker_crew_changed: { label: 'Moved between crews', category: 'people' },
  worker_account_linked: { label: 'Linked a login', category: 'people' },
  worker_account_unlinked: { label: 'Unlinked a login', category: 'people' },

  // record
  customer_added: { label: 'Added customer', category: 'record' },
  customer_contact_updated: { label: 'Updated contact details', category: 'record' },
  customer_archived: { label: 'Archived customer', category: 'record' },
  customer_restored: { label: 'Restored customer', category: 'record' },
  customer_deleted: { label: 'Deleted customer', category: 'record' },
}

export const CATEGORY_LABELS: Record<AuditCategory, string> = {
  sales: 'Sales', work: 'Work', money: 'Money', people: 'Team', record: 'Records',
}

export const AUDIT_CATEGORIES: AuditCategory[] = ['sales', 'work', 'money', 'people', 'record']

/** Humanise an action nobody has phrased yet, rather than rendering nothing. */
const humanise = (action: string) => {
  const s = action.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function actionLabel(action: string): string {
  return ACTIONS[action]?.label ?? humanise(action)
}

export function actionCategory(action: string): AuditCategory {
  return ACTIONS[action]?.category ?? 'record'
}

/** Every action this build knows how to phrase. Used by the filter UI. */
export function actionsInCategory(c: AuditCategory): string[] {
  return Object.entries(ACTIONS).filter(([, m]) => m.category === c).map(([a]) => a)
}

/**
 * WHO — the name to print.
 *
 * ⛔ Never resolves an id to a current name: `actor_label` is the snapshot taken
 * when it happened, so a renamed or departed worker still reads correctly and a
 * deleted one does not become "Unknown".
 */
export function actorName(e: Pick<AuditEvent, 'actor_type' | 'actor_label'>): string {
  if (e.actor_label) return e.actor_label
  switch (e.actor_type) {
    case 'owner': return 'You'
    case 'worker': return 'A team member'
    case 'customer': return 'The customer'
    default: return 'Automatically'
  }
}

/** A short badge for where the act came from. Null when it adds nothing. */
export function sourceLabel(e: Pick<AuditEvent, 'actor_type' | 'source'>): string | null {
  if (e.actor_type === 'customer') return 'Customer portal'
  if (e.actor_type === 'system') return 'System'
  if (e.source === 'crew') return 'Crew app'
  return null
}

// ── value formatting ─────────────────────────────────────────────────────────

const MONEY_KEYS = new Set(['amount', 'price', 'total', 'accepted_price', 'discount_value', 'amount_paid'])
const DATE_KEYS = new Set(['scheduled_date', 'end_date', 'start_date', 'worked_on', 'preferred_date'])

const STATUS_WORDS: Record<string, string> = {
  draft: 'Draft', sent: 'Sent', accepted: 'Accepted', declined: 'Declined',
  scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed',
  cancelled: 'Cancelled', unpaid: 'Unpaid', partial: 'Partly paid', paid: 'Paid',
  pending: 'Awaiting approval', approved: 'Approved', new: 'New', handled: 'Handled',
  weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly',
}

/** hh:mm[:ss] → "1:00 PM". Time-only strings have no zone, so no Date is involved. */
function formatClock(t: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(t)
  if (!m) return t
  const h = Number(m[1])
  const suffix = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${m[2]} ${suffix}`
}

/**
 * Format one before/after value according to what its KEY means.
 *
 * ⚠️ Dates go through parseLocalDate. `new Date('2026-08-20')` is UTC midnight,
 * which is the 19th in this owner's zone — a history that files an event under
 * the wrong day is a history nobody trusts twice.
 */
export function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') {
    if (key === 'is_active') return value ? 'Active' : 'Disabled'
    if (key === 'from_portal') return value ? 'Customer portal' : 'Office'
    return value ? 'Yes' : 'No'
  }
  if (MONEY_KEYS.has(key)) {
    const n = Number(value)
    return Number.isFinite(n) ? formatCurrency(n) : String(value)
  }
  if (DATE_KEYS.has(key) && typeof value === 'string') {
    const d = parseLocalDate(value)
    return Number.isNaN(d.getTime())
      ? String(value)
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  }
  if (key === 'start_time' && typeof value === 'string') return formatClock(value)
  if (key === 'minutes' || key === 'labour_minutes') {
    const n = Number(value)
    if (!Number.isFinite(n)) return String(value)
    const h = Math.floor(n / 60), m = n % 60
    return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`
  }
  if (typeof value === 'string') return STATUS_WORDS[value] ?? value
  return String(value)
}

const FIELD_LABELS: Record<string, string> = {
  scheduled_date: 'Date', start_time: 'Time', status: 'Status', crew: 'Crew',
  price: 'Price', amount: 'Amount', total: 'Total', accepted_price: 'Accepted price',
  freq: 'Repeats', interval_count: 'Every', interval_unit: 'Unit', end_date: 'Ends',
  end_count: 'Occurrences', is_active: 'Access', minutes: 'Time on site',
  workers: 'People', worked_on: 'Worked on', name: 'Name', email: 'Email',
  phone: 'Phone', decided_via: 'Decided', method: 'Method', amount_paid: 'Paid',
  discount_value: 'Discount', selected_cadence: 'Cadence', entry: 'Entry',
  decline_reason: 'Reason', kind: 'Kind', description: 'Scope', source: 'Source',
}

export const fieldLabel = (key: string) => FIELD_LABELS[key] ?? humanise(key)

export interface ValueChange {
  key: string
  label: string
  from: string | null
  to: string | null
}

/**
 * The before → after pairs worth showing.
 *
 * Keys present in EITHER side are included, so a value that appeared (null → set)
 * or vanished (set → null) is visible rather than silently dropped. "end_date: —
 * → Oct 15" is the whole point of recording a season gaining an end.
 */
export function changes(e: Pick<AuditEvent, 'before' | 'after'>): ValueChange[] {
  const before = e.before ?? {}
  const after = e.after ?? {}
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
  return keys
    .filter(k => !(k in before) || !(k in after) || before[k] !== after[k])
    .map(k => ({
      key: k,
      label: fieldLabel(k),
      from: k in before ? formatValue(k, before[k]) : null,
      to: k in after ? formatValue(k, after[k]) : null,
    }))
}

/**
 * The one-line summary shown under a row without expanding it.
 *
 * Prefers the change that IS the act — a reschedule is about its date, not the
 * time that moved with it — and collapses a date+time pair into one phrase so the
 * row reads "Aug 18, 10:00 AM → Aug 20, 1:00 PM" rather than two ragged lines.
 */
export function summary(e: Pick<AuditEvent, 'action' | 'before' | 'after'>): string | null {
  const before = e.before ?? {}
  const after = e.after ?? {}

  if ('scheduled_date' in after && 'scheduled_date' in before) {
    const stamp = (src: Record<string, unknown>) => {
      const d = formatValue('scheduled_date', src.scheduled_date)
      const t = src.start_time ? formatValue('start_time', src.start_time) : null
      return t ? `${d}, ${t}` : d
    }
    return `${stamp(before)} → ${stamp(after)}`
  }

  const list = changes(e)
  if (!list.length) return null
  const first = list[0]
  if (first.from && first.to) return `${first.from} → ${first.to}`
  if (first.to) return `${first.label}: ${first.to}`
  return `${first.label}: ${first.from} removed`
}
