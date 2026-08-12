// ── Service location intelligence — what an address remembers ────────────────
// A field-service business is dispatched to a PLACE. The customer is who pays;
// the property is where the work happens, and it is the property that holds the
// gate, the dog, the slope, and the fact that this lawn always takes longer than
// the plan says. This module turns the rows already keyed by property_id into
// the smallest summary that is useful while standing on the driveway.
//
// Pure and I/O-free, like lib/estimateVsActual — so the property page, a future
// crew stop card and any later surface read the SAME answer instead of each
// re-deriving "last service" with its own idea of what counts.
//
// ══ WHY EVERY FIELD HERE CARRIES AN "UNKNOWN" ════════════════════════════════
// The failure this module exists to prevent is a read that FAILED rendering as
// a fact about the property. "No service history" and "I couldn't reach the
// server" are different sentences, and only one of them is safe to believe while
// standing at a stranger's gate. lib/timelineData deliberately degrades a failed
// source to `[]` — correct for a timeline, where a missing row is a missing row
// — but a SUMMARY that does the same thing states an absence it never verified.
// So the visit read arrives here as a discriminated `SourceRead`, and a failure
// propagates as `visitsUnknown`, never as zero.
//
// ══ WHAT THIS DELIBERATELY DOES NOT DO ═══════════════════════════════════════
// It does not re-list the history. lib/timeline already renders every event at
// this address and the property page already mounts it; a summary that repeats
// it is a second, drifting copy of the same truth. This answers only the
// questions you cannot answer by scrolling: what is the NEXT thing, what was the
// LAST thing, what do we DO here, and how long does it actually take.
//
// ══ MEASURED AGAINST PRODUCTION BEFORE A LINE WAS WRITTEN ════════════════════
//   * jobs.property_id      — 220 of 221 rows set. The property→visit link is
//                             real, so visit-derived memory is worth building.
//   * job_photos.property_id— 61 of 61 set. Photo history is reliably per-place.
//   * jobs.service_type     — 221 of 221 set, but 20 distinct free-text spellings
//                             ("Lawn Mowing", "Lawn mowing", "Xanthe mow + prune").
//                             Grouped ONLY through lib/serviceKey — see below.
//   * jobs.actual_minutes   — 35 of 77 completed visits timed (45%), spread over
//                             17 properties; 5 properties reach 3 timed visits and
//                             exactly ONE reaches 5. So a typical duration is a
//                             real answer for a handful of addresses and an
//                             invention for the rest. It is gated accordingly.
//   * measurements.property_id — 2 rows in the entire table. Nothing is built on
//                             it here; the property page already shows lawn_sqft.

import { serviceKey, serviceLabel } from '@/lib/serviceKey'
import { MIN_PLAUSIBLE_MINUTES, MAX_PLAUSIBLE_MINUTES } from '@/lib/estimateVsActual'

/**
 * A read that can fail. The whole point of this type is that `{ ok: false }` and
 * `{ ok: true, rows: [] }` cannot be confused by a caller, because they are not
 * the same shape — an empty array is no longer able to mean "the query broke".
 */
export type SourceRead<T> = { ok: true; rows: T[] } | { ok: false }

/** The slice of a visit (a `jobs` row) this engine needs. Callers select narrowly. */
export interface LocationVisit {
  id: string
  status: string | null | undefined
  title?: string | null
  service_type?: string | null
  scheduled_date?: string | null
  completed_at?: string | null
  actual_minutes?: number | null
}

/**
 * How many plausibly-timed visits before this address may claim a typical
 * duration.
 *
 * WHY 3, matching lib/duration's MIN_SAMPLES rather than estimateVsActual's 5:
 * those two thresholds gate different kinds of claim. estimateVsActual's 5 gates
 * a JUDGEMENT about the owner's estimating ("mowing runs 18% long"), which is
 * acted on and where a bad row flipping the sign is the risk. This gates a
 * DESCRIPTION of one address ("about 45 minutes here"), where the failure mode is
 * not a wrong direction but a wrong central value — and the median of 3 already
 * cannot be moved by a single outlier, which is the specific protection needed.
 *
 * Below the threshold nothing is shown. A typical duration inferred from one
 * visit is the exact fake-precision the brief for this module ruled out, and
 * showing it greyed-out or hedged does not help: the number still gets read.
 */
export const MIN_TYPICAL_SAMPLE = 3

/** A visit named well enough to open it and say what it was. */
export interface LocationVisitRef {
  id: string
  /** The visit's own title — jobs.title is NOT NULL, so this is always sayable. */
  title: string
  /** Canonical service identity, for grouping and for an icon later. */
  serviceKey: string
  serviceLabel: string
  /** ISO date. For a completed visit this is when it FINISHED. */
  date: string | null
}

/**
 * The typical on-site time at this address. `sampleSize` is not decoration and
 * is never optional — it is the only thing that lets a reader tell "45 minutes,
 * every time, for a year" from "45 minutes, once". Any surface rendering
 * `minutes` MUST render `sampleSize` beside it.
 */
export interface TypicalDuration {
  /** MEDIAN plausible actual minutes — immune to one long day. */
  minutes: number
  /** Plausibly-timed completed visits behind that median. Always ≥ MIN_TYPICAL_SAMPLE. */
  sampleSize: number
}

/** What gets done at this address, by canonical service. */
export interface ServiceTally {
  key: string
  label: string
  /** Completed visits of this service at this property. */
  completed: number
}

export interface LocationSummary {
  /**
   * TRUE when the visit read failed. Every visit-derived field below is then
   * null/empty because it is UNKNOWN, not because it is absent — a surface must
   * say so rather than render "no service history".
   */
  visitsUnknown: boolean
  /** Most recently COMPLETED visit. Null when there are none (or unknown). */
  lastVisit: LocationVisitRef | null
  /** Soonest visit still ahead. Null when nothing is booked (or unknown). */
  nextVisit: LocationVisitRef | null
  /** Completed visits at this address. NULL means unknown — never 0 on a failure. */
  completedCount: number | null
  /** Services performed here, most-visited first. Empty when unknown. */
  services: ServiceTally[]
  /** Null unless MIN_TYPICAL_SAMPLE plausible timings exist. */
  typicalDuration: TypicalDuration | null
  /**
   * Plausibly-timed completed visits. NULL when unknown. This is reported even
   * when it is below the threshold so a surface can say "not enough timed visits
   * yet" — a genuine, fixable state — instead of silently omitting the row.
   */
  timedVisits: number | null
  /** Photos at this address. NULL means the photo read failed. */
  photoCount: number | null
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

/**
 * A visit's own actual minutes, or null when they cannot be believed.
 *
 * The bounds are IMPORTED from lib/estimateVsActual rather than restated: they
 * describe the same physical claim (what a stopwatch reading can plausibly mean)
 * and production contains a real 1-minute "General Landscaping" visit that would
 * otherwise drag an address's typical time toward nothing. Two copies of a bound
 * is two bounds, and they drift.
 */
function plausibleActual(v: Pick<LocationVisit, 'actual_minutes'>): number | null {
  const a = Number(v.actual_minutes)
  if (!Number.isFinite(a) || a <= 0) return null
  if (a < MIN_PLAUSIBLE_MINUTES || a > MAX_PLAUSIBLE_MINUTES) return null
  return a
}

/**
 * THE typical-duration answer, for any surface holding this property's visits.
 *
 * Exported because the Properties LIST asks the same question about the same
 * rows, and it used to answer it differently: an unbounded MEAN (so the one
 * 1-minute mis-tap in production pulled an address's figure down), presented
 * with the count of ALL completed visits rather than the count of TIMED ones —
 * so a property with 8 visits and 2 timings read "avg of 8", overstating the
 * evidence four-fold on the one number an owner would actually schedule around.
 * Two engines for one question is how those drift, so there is now one.
 *
 * Returns null below MIN_TYPICAL_SAMPLE — the caller renders nothing, not a
 * hedged number.
 */
export function typicalDurationFrom(
  visits: Pick<LocationVisit, 'status' | 'actual_minutes'>[],
): TypicalDuration | null {
  const timings: number[] = []
  for (const v of visits) {
    if (v.status !== 'completed') continue
    const t = plausibleActual(v)
    if (t != null) timings.push(t)
  }
  return typicalFromTimings(timings)
}

/** The threshold + the median in ONE place, so the two callers cannot disagree. */
function typicalFromTimings(timings: number[]): TypicalDuration | null {
  return timings.length >= MIN_TYPICAL_SAMPLE
    ? { minutes: median(timings), sampleSize: timings.length }
    : null
}

function toRef(v: LocationVisit, date: string | null): LocationVisitRef {
  const key = serviceKey(v.service_type)
  return {
    id: v.id,
    title: (v.title || '').trim() || serviceLabel(key),
    serviceKey: key,
    serviceLabel: serviceLabel(key),
    date,
  }
}

/** The date a completed visit actually finished, preferring the completion stamp. */
function completedOn(v: LocationVisit): string | null {
  // completed_at is the canonical stamp (lib/jobStatus.completionPatch writes it),
  // but 7 of 72 completed visits carried a NULL one before that seam existed, so
  // the scheduled date is the documented fallback — the same order lib/timeline uses.
  const stamp = v.completed_at ? v.completed_at.slice(0, 10) : null
  return stamp || v.scheduled_date || null
}

/**
 * THE entry point: this address's rows in, its memory out.
 *
 * `todayISO` is passed in rather than read from a clock so the engine stays pure
 * and a test can stand at any date. Callers use lib/utils localTodayISO — the
 * OWNER's day, not UTC, or a visit booked for this afternoon reads as past.
 *
 * TENANCY: this function holds no idea of who the owner is; it summarises exactly
 * the rows it is handed. The caller MUST scope the read server-side. `jobs`,
 * `job_photos` and `properties` are all RLS own-row, so a normal client read is
 * already scoped — but never feed this rows from a service-role query that has
 * no user_id filter.
 */
export function buildLocationSummary(input: {
  visits: SourceRead<LocationVisit>
  photoCount: number | null
  todayISO: string
}): LocationSummary {
  const { visits, photoCount, todayISO } = input

  // A failed visit read is the whole reason this shape exists. Everything visit-
  // derived collapses to unknown TOGETHER, so no surface can render half a
  // summary and imply the other half is empty.
  if (!visits.ok) {
    return {
      visitsUnknown: true,
      lastVisit: null,
      nextVisit: null,
      completedCount: null,
      services: [],
      typicalDuration: null,
      timedVisits: null,
      photoCount,
    }
  }

  // One row per visit. A join fan-out or a merged page must not let one visit
  // vote twice — which would inflate both the service tallies and the sample
  // size the typical duration is presented on.
  const seen = new Set<string>()
  const rows: LocationVisit[] = []
  for (const v of visits.rows) {
    if (!v?.id || seen.has(v.id)) continue
    seen.add(v.id)
    rows.push(v)
  }

  let lastVisit: LocationVisitRef | null = null
  let lastDate = ''
  let nextVisit: LocationVisitRef | null = null
  let nextDate = ''
  let completedCount = 0
  const timings: number[] = []
  const byService = new Map<string, number>()

  for (const v of rows) {
    if (v.status === 'completed') {
      completedCount++
      const key = serviceKey(v.service_type)
      byService.set(key, (byService.get(key) || 0) + 1)

      const on = completedOn(v)
      // `>=` so that among same-day visits the last one encountered wins; with no
      // finer stamp than a date there is no better answer, and a stable one beats
      // an arbitrary one.
      if (on && on >= lastDate) { lastDate = on; lastVisit = toRef(v, on) }

      const t = plausibleActual(v)
      if (t != null) timings.push(t)
      continue
    }

    // Ahead of us: booked but not done. A cancelled visit is not upcoming, and an
    // in_progress one is happening NOW, which is still the next thing you'd want
    // named. Statuses are checked explicitly rather than "not completed" so a new
    // status added later cannot silently become "upcoming".
    if (v.status === 'scheduled' || v.status === 'in_progress') {
      const on = v.scheduled_date || null
      if (!on || on < todayISO) continue
      if (!nextDate || on < nextDate) { nextDate = on; nextVisit = toRef(v, on) }
    }
  }

  const services: ServiceTally[] = Array.from(byService.entries())
    .map(([key, completed]) => ({ key, label: serviceLabel(key), completed }))
    // Most-done first — what this address IS, in one glance. Ties break
    // alphabetically so the order never shuffles between renders.
    .sort((a, b) => b.completed - a.completed || a.label.localeCompare(b.label))

  return {
    visitsUnknown: false,
    lastVisit,
    nextVisit,
    completedCount,
    services,
    typicalDuration: typicalFromTimings(timings),
    timedVisits: timings.length,
    photoCount,
  }
}

/**
 * "about 45 min · 4 timed visits" — the ONE wording for a typical duration, so
 * the sample size can never be dropped by a call site that thought the number
 * spoke for itself.
 *
 * "about" is doing real work: this is a median of a handful of visits, and
 * "45 min" alone reads as a specification the crew can be held to.
 */
export function describeTypicalDuration(t: TypicalDuration): string {
  const visits = t.sampleSize === 1 ? '1 timed visit' : `${t.sampleSize} timed visits`
  return `about ${t.minutes} min · ${visits}`
}
