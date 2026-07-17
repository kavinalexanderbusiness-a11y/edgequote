import type { Invoice } from '@/types'
import type { FeeSettings } from '@/lib/invoiceTotals'
import { type ChasePolicy, resolveChasePolicy } from '@/lib/automation/policy'
import { parseLocalDate } from '@/lib/utils'
import { displayInvoiceStatus } from './ledger'

// ── Invoice reminder policy ──────────────────────────────────────────────────
// The cadence layer for automatic payment reminders. It owns NO opinion about
// whether an invoice is overdue — that is `displayInvoiceStatus` in the ledger,
// the same call the invoices list, the dashboard and the portal read. This only
// decides "given it IS overdue, is it time to chase again, and are there chases
// left?" so the automation and every screen can never disagree about who owes.
//
// Tuning lives on the business_settings.automations jsonb the toggles already
// use, so an unset key simply falls back to the defaults below (no migration for
// the config; the anchor columns are RUN-2026-07-14-invoice-reminders.sql).

// Days of silence before the first chase (measured from the due date) and
// between chases thereafter.
export const REMINDER_DELAY_DAYS = 3
// Three nudges on money already owed, then stop and leave it to the owner.
export const REMINDER_MAX = 3

// Same shape every chaser uses — the parse + clamps live in automation/policy.
export type ReminderPolicy = ChasePolicy

export const DEFAULT_REMINDER_POLICY: ReminderPolicy = { delayDays: REMINDER_DELAY_DAYS, maxCount: REMINDER_MAX }

// Which jsonb keys this chaser reads is the only thing that's genuinely its own;
// the tolerance and the clamps are shared with the quote chaser.
export function resolveReminderPolicy(raw: unknown): ReminderPolicy {
  return resolveChasePolicy(raw, { delayKey: 'invoice_reminder_delay_days', maxKey: 'invoice_reminder_max' }, DEFAULT_REMINDER_POLICY)
}

export type RemindableInvoice = Pick<Invoice,
  'status' | 'due_date' | 'amount' | 'amount_paid' | 'discount_type' | 'discount_value'
> & { viewed_at?: string | null; last_reminded_at?: string | null; reminder_count?: number | null }

// The clock the next reminder is spaced from: the last reminder, or — before any
// reminder — the due date itself. 'overdue' already means we're past due, so the
// first chase lands delayDays after the money was actually late.
export function reminderAnchor(inv: RemindableInvoice): string | null {
  return inv.last_reminded_at || inv.due_date || null
}

// Whole days since a date-only ('2026-07-10') OR timestamptz value, anchored to
// LOCAL midnight for the date-only case — a due date must not read as a day
// earlier west of UTC (the same trap parseLocalDate exists for).
export function daysSinceLocal(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null
  return Math.floor((Date.now() - parseLocalDate(dateStr).getTime()) / 86_400_000)
}

// Already chased as often as the owner allows.
export function remindersExhausted(inv: RemindableInvoice, policy: ReminderPolicy): boolean {
  return (inv.reminder_count ?? 0) >= policy.maxCount
}

// THE gate for the automatic chaser.
//
// Every stop condition falls out of the ledger rather than a list this file has
// to keep in sync: displayInvoiceStatus only returns 'overdue' while there's a
// balance owing, the due date has passed, and the invoice is still unpaid/sent/
// partial. So paid, overpaid, cancelled, draft and not-yet-due all stop chasing
// on their own the moment the money (or the owner) says so.
export function dueForAutoReminder(
  inv: RemindableInvoice,
  settings: FeeSettings | null | undefined,
  todayISO: string,
  policy: ReminderPolicy,
): boolean {
  if (displayInvoiceStatus(inv, settings, todayISO) !== 'overdue') return false
  if (remindersExhausted(inv, policy)) return false
  const since = daysSinceLocal(reminderAnchor(inv))
  return since != null && since >= policy.delayDays
}
