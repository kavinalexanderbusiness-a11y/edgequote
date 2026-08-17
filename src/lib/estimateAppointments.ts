// ── Estimate appointments ────────────────────────────────────────────────────
//
// WHAT THIS IS. A scheduled visit to look at, measure or discuss work SO THAT a
// quote can be written. It is a `public.schedule_items` row with type
// 'estimate' — the non-job calendar table (lib/scheduleItems) — and it exists
// because the owner used to hold the slot with a $0 quote plus a $0 job, which
// made every jobs-shaped engine fire against something that was never work.
//
// ⛔ WHAT IT IS NOT, and why the list is worth writing down. It is not a job,
// not completed service, not invoiceable, not authorised value, not recurring
// service, not a proof-of-work event, not profit, and finishing one does not
// make anybody eligible for a review request. Every one of those engines reads
// `public.jobs`. An estimate appointment is not a row in `jobs`, so none of them
// can see it — the boundary is the table, not a rule this file remembers to
// follow. That is what makes it hold: there is nothing here to forget.
//
// ⭐ WHAT "COMPLETED" MEANS HERE. Exactly one thing: the estimating appointment
// happened. It does not mean the customer's work is done, and nothing about it
// is a promise that a quote now exists — the owner may have looked and decided
// not to bid. Writing the quote is a separate, deliberate step.

import type { ScheduleItem, ScheduleItemStatus } from './scheduleItems'
import type { DayVisitLike } from './dayFit'
import type { RouteStop } from './route'

/** A schedule item that is specifically an estimate visit. */
export type EstimateAppointment = ScheduleItem & { type: 'estimate' }

export function isEstimateAppointment(i: ScheduleItem): i is EstimateAppointment {
  return i.type === 'estimate'
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
// Four states, deliberately no more. `no_show` is separate from `cancelled`
// because the difference is the wasted trip, and that is the only signal that
// tells an unreliable customer from a considerate one.

export const ESTIMATE_STATUSES: ScheduleItemStatus[] = ['scheduled', 'completed', 'cancelled', 'no_show']

/** Terminal = the appointment is no longer on the books as something to do. */
export const TERMINAL_STATUSES: ScheduleItemStatus[] = ['completed', 'cancelled', 'no_show']

export function isTerminal(s: ScheduleItemStatus): boolean {
  return TERMINAL_STATUSES.includes(s)
}

export function isOpen(i: Pick<ScheduleItem, 'status'>): boolean {
  return i.status === 'scheduled'
}

export const STATUS_LABELS: Record<ScheduleItemStatus, string> = {
  scheduled: 'Scheduled',
  completed: 'Visit done',   // NOT "Job complete" — nothing was performed for the customer.
  cancelled: 'Cancelled',
  no_show: 'No-show',
}

/**
 * Legal transitions. An open appointment may reach any terminal state; a
 * terminal one may only be REOPENED back to scheduled. Going terminal→terminal
 * directly (cancelled → no_show) is refused so that correcting a mistake is a
 * visible reopen rather than a quiet overwrite of what was recorded.
 */
export function canTransition(from: ScheduleItemStatus, to: ScheduleItemStatus): boolean {
  if (from === to) return false
  if (from === 'scheduled') return isTerminal(to)
  return to === 'scheduled'
}

/** The row patch a status change writes. completed_at tracks `completed` ONLY. */
export function statusPatch(to: ScheduleItemStatus, reason?: string | null): {
  status: ScheduleItemStatus; completed_at: string | null; cancel_reason: string | null
} {
  return {
    status: to,
    completed_at: to === 'completed' ? new Date().toISOString() : null,
    // A reason belongs to the not-happening states. Reopening clears it, so a
    // reopened appointment never carries the explanation for a cancellation
    // that has been undone.
    cancel_reason: (to === 'cancelled' || to === 'no_show') ? (reason?.trim() || null) : null,
  }
}

// ── Duration ─────────────────────────────────────────────────────────────────
// Shorter than DEFAULT_JOB_MIN (45): walking a property and talking through
// scope is not a service visit. Stated minutes always win; this is only the
// floor for an owner who did not say.
export const DEFAULT_ESTIMATE_MIN = 30

export function estimateMinutes(i: Pick<ScheduleItem, 'duration_minutes'>): number {
  const n = Number(i.duration_minutes)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_ESTIMATE_MIN
}

// ── Day capacity ─────────────────────────────────────────────────────────────
// An estimate consumes TIME, so it must show up in the day's committed load and
// in conflict detection — but it must never reach revenue, productivity or
// service-completion metrics. Those read `jobs`; this adapts an appointment to
// the shape lib/dayFit already consumes, which is the ONE capacity arithmetic.
// It is an adapter, not a second engine.
//
// crew_size is left unstated on purpose: nobody typed it, and dayFit's own floor
// treats an unstated crew as one person. Inventing a number here would be a
// claim the owner never made.
export function toDayVisit(i: EstimateAppointment): DayVisitLike {
  return {
    duration_minutes: estimateMinutes(i),
    // Passed through, so a cancelled appointment stops occupying the day exactly
    // as a cancelled visit does. A completed or no-show one still occupied it —
    // the trip was made either way.
    status: i.status,
    service_type: null,
  }
}

/** The day's estimate appointments, in the shape the capacity engine reads. */
export function estimateDayVisits(items: ScheduleItem[], dateISO: string): DayVisitLike[] {
  return items
    .filter(isEstimateAppointment)
    .filter(i => i.scheduled_date === dateISO)
    .map(toDayVisit)
}

// ── Routing ──────────────────────────────────────────────────────────────────
// Estimates are the one routable schedule-item type (lib/scheduleItems'
// ITEM_META), so they join the day's existing route rather than getting a
// planner of their own. Only OPEN appointments with a located property are
// stops — a cancelled one is not driven to, and an address we cannot place
// cannot be sequenced.
export function toRouteStop(i: EstimateAppointment): RouteStop | null {
  const lat = i.properties?.lat, lng = i.properties?.lng
  if (!isOpen(i) || lat == null || lng == null) return null
  return {
    // RouteStop calls its identifier `jobId` because jobs were its first
    // caller. It is an opaque key to the sequencer, so an appointment id rides
    // it unchanged — renaming the field across the route engine would be a much
    // larger change than this feature earns, and the engine never dereferences it.
    jobId: i.id,
    title: i.title,
    address: i.properties?.address ?? '',
    propertyId: i.property_id,
    lat,
    lng,
  }
}

export function routableEstimates(items: ScheduleItem[], dateISO: string): EstimateAppointment[] {
  return items
    .filter(isEstimateAppointment)
    .filter(i => i.scheduled_date === dateISO && isOpen(i))
    .filter(i => i.properties?.lat != null && i.properties?.lng != null)
}

// ── Creating one ─────────────────────────────────────────────────────────────

export interface EstimateInput {
  title: string
  customer_id: string | null
  property_id: string | null
  scheduled_date: string
  start_time: string | null
  duration_minutes: number | null
  notes: string | null
  customer_note: string | null
  crew_id: string | null
  technician_id: string | null
  converted_quote_id: string | null
}

/**
 * What the form must not be allowed to send. Mirrors the database's own CHECK
 * constraints so the owner gets a sentence instead of a Postgres error — the
 * constraints remain the enforcement, this is only the courtesy.
 */
export function validateEstimate(input: Partial<EstimateInput>): string | null {
  if (!input.title?.trim()) return 'Give the visit a name so it reads on the calendar.'
  if (!input.scheduled_date) return 'Pick a date.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.scheduled_date)) return 'That date is not a real date.'
  if (input.crew_id && input.technician_id) return 'Assign the visit to a crew or a person, not both.'
  const mins = input.duration_minutes
  if (mins != null && (!Number.isFinite(Number(mins)) || Number(mins) <= 0)) {
    return 'How long it takes has to be more than zero minutes.'
  }
  if (mins != null && Number(mins) > 12 * 60) return 'That is longer than a working day.'
  return null
}

/** A sensible new appointment: named after the customer, 30 minutes, no assignee. */
export function newEstimateDraft(opts: {
  dateISO: string
  customerName?: string | null
  customerId?: string | null
  propertyId?: string | null
  quoteId?: string | null
}): EstimateInput {
  return {
    title: opts.customerName?.trim() ? `Estimate — ${opts.customerName.trim()}` : 'Estimate',
    customer_id: opts.customerId ?? null,
    property_id: opts.propertyId ?? null,
    scheduled_date: opts.dateISO,
    start_time: null,
    duration_minutes: DEFAULT_ESTIMATE_MIN,
    notes: null,
    customer_note: null,
    crew_id: null,
    technician_id: null,
    converted_quote_id: opts.quoteId ?? null,
  }
}

// ── Reading one back ─────────────────────────────────────────────────────────

/** "10:30 · 30 min" — the calendar chip's line. Empty when no time was set. */
export function timeLabel(i: Pick<ScheduleItem, 'start_time' | 'duration_minutes'>): string {
  const mins = estimateMinutes(i)
  if (!i.start_time) return `${mins} min`
  const [h, m] = i.start_time.split(':')
  const hh = Number(h)
  const suffix = hh >= 12 ? 'pm' : 'am'
  const h12 = hh % 12 === 0 ? 12 : hh % 12
  return `${h12}:${m} ${suffix} · ${mins} min`
}

/**
 * Whether the owner still owes this appointment a quote. Deliberately NOT
 * "did the visit happen" — a completed visit with no quote written is the whole
 * reason this concept exists, and it is the one state worth chasing.
 */
export function awaitingQuote(i: EstimateAppointment): boolean {
  return i.status === 'completed' && !i.converted_quote_id
}
