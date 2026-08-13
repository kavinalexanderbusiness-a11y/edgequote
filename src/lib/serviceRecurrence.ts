// ── Service recurrence eligibility — THE "is this repeatable?" answer ────────
// Session 46. "Could we repeat this job?" is always technically yes; the real
// question is "is this TYPE of service legitimately repeatable?", and that has
// exactly two honest sources:
//
//   1. THE OWNER SAID SO — service_templates.recurrence:
//        'one_time'          never suggest recurring for this service
//        'recurring_ok'      recurrence suggestions allowed
//        'usually_recurring' this service normally runs as a plan
//        NULL                the owner hasn't said (→ 'unconfigured')
//
//   2. THE CUSTOMER'S OWN BEHAVIOUR — completed visits landing at a real
//      cadence. Two patio installs 90 days apart are not a cadence; before this
//      module the advisor read exactly that pattern as "they visit ~every 90
//      days → biweekly fits" (measured on the live engine) and offered a
//      biweekly plan.
//
// ⛔ UNIVERSAL-CRM RULE: nothing here reads a service NAME. There is no keyword
// table, no industry list, no "mow → recurring / mulch → one-time". A cleaning
// company, an HVAC shop and a pool service configure the same column and are
// judged by the same arithmetic. The template lookup below matches the owner's
// OWN catalogue rows by exact (case/space-insensitive) name — a declared
// relationship to the owner's configuration, not an inference from the words.

export type RecurrenceEligibility =
  | 'one_time'
  | 'recurring_ok'
  | 'usually_recurring'
  | 'unconfigured'

/** The template slice this module reads. */
export interface RecurrenceTemplate {
  name: string
  recurrence?: string | null
}

const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase()

/**
 * Resolve a service's eligibility from the owner's catalogue. Exact normalized
 * name match — the same convention every template consumer uses (the quote
 * builder resolves `templates.find(t => t.name === n)`); no fuzzy matching, so
 * a template can never speak for a service the owner didn't name.
 */
export function recurrenceEligibilityFor(
  serviceType: string | null | undefined,
  templates: RecurrenceTemplate[] | null | undefined,
): RecurrenceEligibility {
  const key = norm(serviceType)
  if (!key || !templates?.length) return 'unconfigured'
  const t = templates.find(x => norm(x.name) === key)
  const r = t?.recurrence
  return r === 'one_time' || r === 'recurring_ok' || r === 'usually_recurring' ? r : 'unconfigured'
}

/**
 * The widest gap between completed visits that still counts as evidence of a
 * weekly/biweekly cadence — the only two cadences a one-click plan can create
 * (RecurringPlanPayload.intervalCount is 1 | 2). ≤ 10 days reads as weekly,
 * 11–21 as biweekly; beyond 21 the observed pattern is not a cadence those
 * plans can honestly express, so no plan is suggested.
 */
export const MAX_CADENCE_GAP_DAYS = 21

/**
 * What the observed median gap between completed visits supports, if anything.
 * Null = the visits do not demonstrate a plan-shaped cadence. Never guesses.
 */
export function cadenceFromGap(medianGapDays: number | null | undefined): 'weekly' | 'biweekly' | null {
  const g = Number(medianGapDays)
  if (!Number.isFinite(g) || g <= 0) return null
  if (g <= 10) return 'weekly'
  if (g <= MAX_CADENCE_GAP_DAYS) return 'biweekly'
  return null
}

/**
 * THE gate a recurring suggestion must pass:
 *   'one_time'  → never, whatever the behaviour looks like. The owner said so.
 *   otherwise   → only with real cadence evidence (cadenceFromGap non-null).
 *                 Explicit 'recurring_ok'/'usually_recurring' states the service
 *                 CAN repeat — it does not invent a cadence for a plan the
 *                 evidence doesn't show, so even a configured service needs the
 *                 visits to demonstrate the rhythm the plan would encode.
 */
export function mayRecommendRecurring(
  eligibility: RecurrenceEligibility,
  observedCadence: 'weekly' | 'biweekly' | null,
): boolean {
  if (eligibility === 'one_time') return false
  return observedCadence != null
}
