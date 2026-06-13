// ── Schedule Health ───────────────────────────────────────────────────────────
// Catches scheduling MISTAKES before they reach Day Ops — duplicate visits,
// cadence conflicts and overlapping recurring plans — using the SAME cadence
// grouping the optimizer and manual guards use (customer + service category, with
// mowing collapsed to one bucket). Pure/sync: the page feeds it jobs + base; it
// returns issues with stable keys (so "Ignore intentionally" can persist) and the
// removable-stop math the optimizer reports ("…would remove 2 stops, save ~18m").

import { parseISO, format } from 'date-fns'
import { Coord } from '@/lib/geo'
import { routeKmEstimate, clusterKmEstimate, AVG_SPEED_KM_PER_MIN, DEFAULT_JOB_MIN, DistFn } from '@/lib/route'
import { cadenceGroupKey, cadenceServiceKey, cadenceFloorFor } from '@/lib/optimizer'

export interface HealthJob {
  id: string
  scheduled_date: string
  status: string
  customerId: string | null
  recurrence_id: string | null
  serviceType: string | null
  customerName: string
  duration_minutes: number | null
  lat: number | null
  lng: number | null
  start_time: string | null
  invoiced?: boolean
}

export type HealthKind = 'duplicate-day' | 'cadence-conflict' | 'multiple-plans'
export type HealthAction = 'review' | 'delete' | 'merge' | 'ignore'

export interface HealthIssue {
  key: string                 // stable across reloads — used for ignore persistence
  kind: HealthKind
  severity: 'high' | 'medium'
  isMow: boolean
  customerId: string | null
  customerName: string
  title: string
  detail: string
  date: string | null         // focal date — Review jumps here
  jobIds: string[]            // every visit involved
  keepJobId?: string          // the visit to KEEP (delete removes the rest)
  removableJobIds: string[]   // redundant, deletable stops (never billed ones)
  recurrenceIds: string[]     // series involved (for multiple-plans / merge)
  keepRecurrenceId?: string   // series to keep when merging
  minutesSaved: number        // est. time freed by removing removableJobIds
  actions: HealthAction[]
}

export interface ScheduleHealthReport {
  issues: HealthIssue[]
  duplicateStops: number      // total removable duplicate visits across the schedule
  minutesSaved: number        // aggregate est. savings from removing those stops
  allMow: boolean             // every duplicate is a mowing visit (for the report wording)
}

const fmtD = (iso: string) => format(parseISO(iso + 'T00:00:00'), 'MMM d')
const diffDays = (a: string, b: string) => Math.round((parseISO(b + 'T00:00:00').getTime() - parseISO(a + 'T00:00:00').getTime()) / 86400000)
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function analyzeScheduleHealth(
  jobs: HealthJob[],
  opts: { today: string; base: Coord | null; roadDist?: DistFn },
): ScheduleHealthReport {
  // Only upcoming, live work can be "fixed" — past/completed/cancelled is history.
  const active = jobs.filter(j => j.scheduled_date >= opts.today && j.status !== 'cancelled' && j.status !== 'completed')

  // Same-category timeline per customer (mowing↔mowing; other services separate).
  const groups = new Map<string, HealthJob[]>()
  for (const j of active) {
    const k = cadenceGroupKey({ id: j.id, customerId: j.customerId, recurrence_id: j.recurrence_id, serviceType: j.serviceType })
    const g = groups.get(k); if (g) g.push(j); else groups.set(k, [j])
  }

  // A day's drive minutes over its located stops (real-road when available),
  // optionally excluding some — so we can price the drive a duplicate adds.
  const byDate = new Map<string, HealthJob[]>()
  for (const j of active) { const g = byDate.get(j.scheduled_date); if (g) g.push(j); else byDate.set(j.scheduled_date, [j]) }
  const driveMin = (date: string, exclude?: Set<string>): number => {
    const located = (byDate.get(date) ?? [])
      .filter(j => (!exclude || !exclude.has(j.id)) && j.lat != null && j.lng != null)
      .map(j => ({ lat: j.lat as number, lng: j.lng as number }))
    if (located.length === 0) return 0
    const km = opts.base ? routeKmEstimate(opts.base, located, opts.roadDist) : clusterKmEstimate(located, opts.roadDist)
    return Math.round(km / AVG_SPEED_KM_PER_MIN)
  }

  const floor = cadenceFloorFor()
  const issues: HealthIssue[] = []

  for (const [gkey, gjobs] of groups) {
    const first = gjobs[0]
    const isMow = cadenceServiceKey(first.serviceType) === 'mow'
    const svcWord = isMow ? 'mowing' : (first.serviceType?.toLowerCase() || 'service')
    const visitWord = isMow ? 'mowing visit' : 'visit'
    const pluralVisits = isMow ? 'mowing visits' : 'visits'
    const customerId = first.customerId
    const customerName = first.customerName

    // 1) Duplicate on the SAME day (same customer + same category).
    const onDate = new Map<string, HealthJob[]>()
    for (const j of gjobs) { const g = onDate.get(j.scheduled_date); if (g) g.push(j); else onDate.set(j.scheduled_date, [j]) }
    for (const [date, list] of onDate) {
      if (list.length < 2) continue
      // Keep a billed visit if present (never delete those), else the earliest.
      const sorted = [...list].sort((a, b) => (a.start_time || '99').localeCompare(b.start_time || '99') || a.id.localeCompare(b.id))
      const keep = sorted.find(j => j.invoiced) ?? sorted[0]
      const removable = sorted.filter(j => j.id !== keep.id && !j.invoiced)
      const exclude = new Set(removable.map(r => r.id))
      const labor = removable.reduce((s, r) => s + (r.duration_minutes || DEFAULT_JOB_MIN), 0)
      const drive = Math.max(0, driveMin(date) - driveMin(date, exclude))
      issues.push({
        key: `dup|${gkey}|${date}`, kind: 'duplicate-day', severity: 'high', isMow, customerId, customerName,
        title: `Possible duplicate ${svcWord} visit${list.length > 2 ? 's' : ''} detected`,
        detail: `${customerName} appears ${list.length} times on ${fmtD(date)}.`,
        date, jobIds: list.map(j => j.id), keepJobId: keep.id, removableJobIds: removable.map(r => r.id),
        recurrenceIds: [...new Set(list.map(j => j.recurrence_id).filter((x): x is string => !!x))],
        minutesSaved: labor + drive,
        actions: removable.length ? ['review', 'delete', 'ignore'] : ['review', 'ignore'],
      })
    }

    // 2) Cadence conflict — two same-category visits closer than the floor (and not
    //    the same day, which #1 covers).
    const dates = [...onDate.keys()].sort()
    for (let i = 1; i < dates.length; i++) {
      const gap = diffDays(dates[i - 1], dates[i])
      if (gap <= 0 || gap >= floor) continue
      if ((onDate.get(dates[i]) ?? []).length > 1) continue // same-day dup already flagged here
      const laterJobs = onDate.get(dates[i])!
      const removable = laterJobs.filter(j => !j.invoiced)
      issues.push({
        key: `cad|${gkey}|${dates[i]}`, kind: 'cadence-conflict', severity: gap <= 2 ? 'high' : 'medium', isMow, customerId, customerName,
        title: `${cap(svcWord)} cadence conflict`,
        detail: `${customerName}'s ${fmtD(dates[i])} ${visitWord} is only ${gap} day${gap !== 1 ? 's' : ''} after the previous ${visitWord} — keep ${pluralVisits} at least ${floor} days apart.`,
        date: dates[i], jobIds: laterJobs.map(j => j.id), removableJobIds: removable.map(r => r.id),
        recurrenceIds: [...new Set(gjobs.map(j => j.recurrence_id).filter((x): x is string => !!x))],
        minutesSaved: 0, // a spacing problem, not a removable-stop saving
        actions: removable.length ? ['review', 'delete', 'ignore'] : ['review', 'ignore'],
      })
    }

    // 3) Multiple active recurring plans in the same category.
    const recCount = new Map<string, number>()
    for (const j of gjobs) if (j.recurrence_id) recCount.set(j.recurrence_id, (recCount.get(j.recurrence_id) ?? 0) + 1)
    const activeRecs = [...recCount.keys()]
    if (activeRecs.length >= 2) {
      const keepRec = [...activeRecs].sort((a, b) => (recCount.get(b)! - recCount.get(a)!) || a.localeCompare(b))[0]
      issues.push({
        key: `plans|${gkey}`, kind: 'multiple-plans', severity: 'medium', isMow, customerId, customerName,
        title: `Multiple recurring ${svcWord} schedules detected`,
        detail: `${customerName} has ${activeRecs.length} active ${svcWord} plans — they likely overlap.`,
        date: [...new Set(gjobs.map(j => j.scheduled_date))].sort()[0] ?? null,
        jobIds: gjobs.map(j => j.id), removableJobIds: [],
        recurrenceIds: activeRecs, keepRecurrenceId: keepRec,
        minutesSaved: 0,
        actions: ['review', 'merge', 'ignore'],
      })
    }
  }

  // High first, then soonest.
  const sevRank = (s: HealthIssue['severity']) => (s === 'high' ? 0 : 1)
  issues.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || (a.date || '').localeCompare(b.date || ''))

  const dup = issues.filter(i => i.kind === 'duplicate-day')
  const duplicateStops = dup.reduce((s, i) => s + i.removableJobIds.length, 0)
  const minutesSaved = dup.reduce((s, i) => s + i.minutesSaved, 0)
  const allMow = dup.length > 0 && dup.every(i => i.isMow)
  return { issues, duplicateStops, minutesSaved, allMow }
}
