import {
  RENEWAL_LEAD_FRACTION, RENEWAL_LEAD_MAX_DAYS, RENEWAL_LEAD_MIN_DAYS,
  RENEWAL_SEASON_CYCLE_DAYS,
} from './constants'
import { cadenceDays, type CadenceRecLike } from './cadence'
import { daysBetween } from './lifecycle'
import {
  nextSeasonStartISO, seasonEndDateFor, seasonForService,
  type ServiceSeason, type ServiceSeasons,
} from '@/lib/seasons'

// ── Renewal — THE "this plan is ending, offer them the next one" engine ──────
//
// The counterpart to `ranOut`, and deliberately its OPPOSITE NUMBER:
//
//   RAN OUT  — a plan stopped WITHOUT an ending. Nobody decided; the visits just
//              stopped appearing. Urgent, red, "re-book them now".
//   RENEWAL  — a plan reached the ending it was GIVEN (its end date, its visit
//              count, or the close of its season) and the next cycle is coming
//              up. Calm, "offer them the next one".
//
// ⭐⭐ THE TWO ARE SEPARATED BY CAUSE, NOT BY DATE. `ranOut` takes a `plannedEnd`
// input and returns `plan_completed` whenever it is true, so a plan that finished
// as agreed can never enter the urgent queue no matter how the calendar falls.
// That is what makes "a customer is in at most one of these queues" a property of
// the code rather than a coincidence of two windows that happen not to overlap —
// and windows that merely happen not to overlap are how this codebase ended up
// telling one owner "3 at risk" and "8 at risk" on two screens.
//
// Before this pair existed, a plan that finished exactly as agreed was
// indistinguishable from one that fell over — both are "a recurring customer
// with nothing booked" — so a contract that ran its full term and stopped on the
// agreed date was reported as an emergency the following morning, every year.
//
// UNIVERSAL BY CONSTRUCTION. Nothing here knows what the work is. A cycle is
// however long the plan's own cycle is: a lawn season, a snow season, a pool
// season, a twelve-month service agreement, a quarterly inspection round, a
// four-week cleaning block. `planRenewal` measures the cycle from the plan's own
// dates and the owner's own season definitions; the rule below is then the same
// for every trade on the planet.
//
// Same house rules as the rest of signals: pure, server-runnable, primitive
// inputs, the clock passed in.

export type RenewalReason =
  /** The plan ended (or is about to) and the next cycle is close enough to ask. */
  | 'renewal_due'
  /** Nothing was ever delivered under this plan — there is no service to repeat. */
  | 'never_served'
  /** They already have work booked. Renewing is a question they have answered. */
  | 'already_booked'
  /** The remaining visits were CANCELLED. Somebody stopped this on purpose. */
  | 'ended_deliberately'
  /** The plan was never given an ending — it is still running, or it ran dry,
   *  which is `ranOut`'s question and not this one's. */
  | 'no_planned_end'
  /** It ended as agreed, but the next cycle is still far off. Dormant, and
   *  deliberately invisible: asking now would be noise. */
  | 'too_early'
  /** The next cycle came and went without them. They are a lapsed customer now,
   *  and the lapse buckets say that better than a renewal offer would. */
  | 'too_late'

export interface RenewalInput {
  /** Visits actually delivered under this plan. 0 ⇒ nothing to renew. */
  servedVisits: number
  /** Last date this plan is booked to run, cancelled visits excluded. The plan's
   *  real ending, whether it has passed or is still ahead. */
  planEndDate: string | null
  /** The plan was GIVEN an ending — an end date, a visit count, or a season
   *  boundary. False = it simply stopped, which is `ranOut`'s business. */
  hasPlannedEnd: boolean
  /** The CUSTOMER has any future visit at all. They may already have been
   *  re-booked by another route — a renewal offer would be asking twice. */
  customerHasFutureVisit: boolean
  /** Every remaining visit of the plan was cancelled. Evidence of a decision:
   *  this is not a lost customer, it is a closed plan. */
  endedByCancellation: boolean
  /** The day the next cycle would begin — next season's opening, or the day the
   *  plan's own term rolls over. null ⇒ unknowable, so we never guess. */
  nextCycleStart: string | null
  /** How long this plan's cycle is, in days. A season and a twelve-month
   *  agreement are both ~365; a four-week block is 28. Sets how wide the asking
   *  window is: you raise a season two months out, a short block a few days out. */
  cycleDays: number
  today: string
}

export interface RenewalSignal {
  /** Surface an "offer renewal" for this plan. */
  isDue: boolean
  /** `ending` — still running, its end in sight. `ended` — its last visit has
   *  been. Both are renewal-due; they change what the owner is TOLD and never
   *  what the app does. */
  stage: 'ending' | 'ended' | null
  /** Days until the next cycle starts. Negative = it has already started. */
  daysToNextCycle: number | null
  /** Half-width of the asking window for a cycle this long. Quoted in the UI so
   *  "why am I seeing this now" always has an answer. */
  leadDays: number
  reason: RenewalReason
}

/** How far either side of the next cycle a renewal is asked about, for a cycle
 *  this long. A fraction of the cycle, held between a week and two months so
 *  neither a four-week block nags for a month nor a yearly plan is raised on the
 *  day. Symmetric: the same number before the rollover and after it, because
 *  "you have not re-booked them yet" stays the same question either side. */
export function renewalLeadDays(cycleDays: number): number {
  const raw = Math.round(Math.max(0, cycleDays) * RENEWAL_LEAD_FRACTION)
  return Math.min(RENEWAL_LEAD_MAX_DAYS, Math.max(RENEWAL_LEAD_MIN_DAYS, raw))
}

export function renewalDue(input: RenewalInput): RenewalSignal {
  const {
    servedVisits, planEndDate, hasPlannedEnd, customerHasFutureVisit,
    endedByCancellation, nextCycleStart, cycleDays, today,
  } = input

  const leadDays = renewalLeadDays(cycleDays)
  const no = (reason: RenewalReason, daysToNextCycle: number | null = null): RenewalSignal =>
    ({ isDue: false, stage: null, daysToNextCycle, leadDays, reason })

  // A plan that never delivered anything is not a renewal — it is a plan that
  // was created and abandoned. Renewing implies there was something to repeat.
  if (servedVisits < 1) return no('never_served')

  // ⭐ INTENTIONALLY ENDED IS NOT A LEAD. Cancelled visits are somebody's
  // decision, written down. The queue must not hand that decision back as an
  // opportunity every time it runs; the owner can still renew this plan by hand
  // from the customer, which is the right amount of friction for reversing a
  // choice you made on purpose.
  if (endedByCancellation) return no('ended_deliberately')

  // No ending means nothing ended. Either it is still running, or it ran dry —
  // and "ran dry" is `ranOut`'s verdict to give. Two engines answering one
  // question is the failure mode this whole directory exists to prevent.
  if (!hasPlannedEnd || !planEndDate) return no('no_planned_end')

  // Booked again, by any route. Not a question worth asking twice.
  if (customerHasFutureVisit) return no('already_booked')

  if (!nextCycleStart) return no('too_early')
  const daysToNextCycle = daysBetween(today, nextCycleStart)

  // Still far out. Their plan ended as agreed and the next one is not yet a
  // conversation — dormant, and correctly invisible. They come back on their own
  // as the date approaches.
  if (daysToNextCycle > leadDays) return no('too_early', daysToNextCycle)

  // The cycle came and went. A renewal offer is no longer the honest description
  // of this customer; "we have not served them in a long time" is, and the lapse
  // buckets already say it — with the right amount of urgency, which is little.
  if (daysToNextCycle < -leadDays) return no('too_late', daysToNextCycle)

  return {
    isDue: true,
    stage: today > planEndDate ? 'ended' : 'ending',
    daysToNextCycle,
    leadDays,
    reason: 'renewal_due',
  }
}

// ── The plan-level resolver ──────────────────────────────────────────────────
// Turns one plan's rows into the answer, and it is the ONLY place the four
// judgement calls below are made:
//
//   • did this plan get an ending, and which kind?
//   • when would its next cycle start?
//   • how long is its cycle?
//   • when would the renewed plan end?
//
// It is exported because TWO engines need those answers and must not each have
// an opinion: lib/renewals builds the queue from it, and lib/reactivation uses it
// to keep a plan that ended as agreed out of the urgent queue AND out of the
// lapse buckets while its renewal is live. One customer, one description.

export interface PlanFacts {
  /** The recurrence's own start, or the first visit if it has none. */
  planStart: string
  /** Non-cancelled visit dates in this plan (any order). */
  liveDates: string[]
  /** Cancelled visit dates in this plan (any order). */
  cancelledDates: string[]
  /** Completed visits in this plan. */
  completedCount: number
  /** The owner's stated end date for the series, if they set one. */
  endDate: string | null
  /** The owner's stated visit count for the series, if they set one. */
  endCount: number | null
  /** What the plan's visits are for — resolves the season, and nothing else. */
  serviceType: string | null
  /** Resolved cadence name (weekly|biweekly|monthly) when known. */
  cadence: string | null
  /** The raw recurrence interval, for cadences with no standard name. */
  interval: CadenceRecLike | null
  /** Does the CUSTOMER have any visit booked today or later, anywhere? */
  customerHasFutureVisit: boolean
}

export interface PlanRenewal {
  signal: RenewalSignal
  season: ServiceSeason | null
  /** Last non-cancelled visit — the plan's real ending. */
  planEnd: string
  hasPlannedEnd: boolean
  endedBySeason: boolean
  endedByCount: boolean
  endedByCancellation: boolean
  nextCycleStart: string
  cycleDays: number
  cadenceDays: number
  /** Where the RENEWED plan would end. null = open-ended. */
  renewedEndDate: string | null
}

export function planRenewal(f: PlanFacts, seasons: ServiceSeasons, today: string): PlanRenewal | null {
  if (f.liveDates.length === 0) return null // wholly cancelled: there was never a plan here
  const dates = [...f.liveDates].sort()
  const planEnd = dates[dates.length - 1]
  const planStart = f.planStart || dates[0]

  const season = seasonForService(f.serviceType, seasons)
  // A season gives a plan its ending only if the plan actually respects it. An
  // open-ended series pre-creates a rolling horizon that can run PAST the season
  // close, and a plan whose visits ignore the season was not ended by it.
  const seasonEnd = season ? seasonEndDateFor(planStart, season) : null
  const endedBySeason = !!seasonEnd && planEnd <= seasonEnd
  const endedByCount = !!f.endCount && f.endCount > 0 && f.liveDates.length >= f.endCount
  const hasPlannedEnd = !!f.endDate || endedByCount || endedBySeason

  // ⭐ Evidence of a DECISION: visits cancelled AFTER the plan's last live one.
  // Somebody stopped this deliberately, and a decision must not be handed back
  // as an opportunity on a timer.
  const endedByCancellation = f.cancelledDates.some(d => d > planEnd)

  // A season repeats once a year whatever the visit spacing inside it; a term
  // plan rolls over the day after it ends. Asking a weekly customer about next
  // spring seven days out is asking far too late, which is why the cycle is the
  // SEASON here and never the gap between two visits.
  const nextCycleStart = season ? nextSeasonStartISO(season, today) : addDaysISO(planEnd, 1)
  const cycleDays = season
    ? RENEWAL_SEASON_CYCLE_DAYS
    : Math.max(1, daysBetween(planStart, planEnd) + 1)

  const signal = renewalDue({
    servedVisits: f.completedCount,
    planEndDate: planEnd,
    hasPlannedEnd,
    customerHasFutureVisit: f.customerHasFutureVisit,
    endedByCancellation,
    nextCycleStart,
    cycleDays,
    today,
  })

  return {
    signal,
    season,
    planEnd,
    hasPlannedEnd,
    endedBySeason,
    endedByCount,
    endedByCancellation,
    nextCycleStart,
    cycleDays,
    cadenceDays: cadenceDays(f.cadence, f.interval),
    // The next cycle is the same SHAPE as the one that just finished: a season
    // ends when that season ends, a term runs the same length again. Proposed to
    // the owner, never applied on its own.
    renewedEndDate: season
      ? seasonEndDateFor(nextCycleStart, season)
      : (hasPlannedEnd ? addDaysISO(nextCycleStart, cycleDays - 1) : null),
  }
}

// Calendar arithmetic via setDate — `+ n * 86_400_000` silently loses or gains an
// hour across a DST boundary and lands on the wrong day.
function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
