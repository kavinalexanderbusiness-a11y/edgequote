'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Customer, Job, JobFormValues, JobLineItem, Quote, RecurrenceScope, RecurUnit } from '@/types'
import { listLineItemsByJob, addLineItems, deleteLineItem, recordPriceChange, addonsTotal, normalizeServiceKey } from '@/lib/jobPricing'
import { Calendar, CalendarView } from '@/components/schedule/Calendar'
import { DayOpsPanel, QuoteLite, QuickPatch } from '@/components/schedule/DayOpsPanel'
import { Coord, geocodeAddress } from '@/lib/geo'
import { JobForm, Recurrence, SuggestionMeta } from '@/components/schedule/JobForm'
import { ScopeDialog } from '@/components/schedule/ScopeDialog'
import { generateOccurrences, jobsInScope, shiftDate, dayDelta, recurrenceLabel } from '@/lib/recurrence'
import type { JobRecurrence } from '@/types'
import { createDraftInvoiceForCompletedJob, quoteVisitAmount, jobVisitValue, effectiveFreq, syncDraftInvoiceAmounts } from '@/lib/invoicing'
import { queueOrRun } from '@/lib/offline/outbox'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'

// The offline field window (today ± a week), persisted across app kills.
const FIELD_JOBS_KEY = 'schedule-field-jobs'
import { resolveAutomations, Automations } from '@/lib/comms/automations'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { StickyActionBar } from '@/components/ui/StickyActionBar'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton'
import { cn, minutesBetween, localTodayISO } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { format, addMonths, addWeeks, addDays, subMonths, subWeeks, subDays, parseISO, getDay } from 'date-fns'
import { Plus, X, ChevronLeft, ChevronRight, Trash2, Rocket, AlertTriangle, Repeat, Lightbulb, Info, Phone, MessageSquare, Navigation, User as UserIcon, FileText, Receipt, CheckCircle2, Play } from 'lucide-react'
import { OptimizeSchedule } from '@/components/schedule/OptimizeSchedule'
import { RainDelayCenter } from '@/components/schedule/RainDelayCenter'
import { WeatherStrip } from '@/components/weather/WeatherStrip'
import { CloudRain } from 'lucide-react'
import { analyzeSchedule, optimizeSchedule, planRainDelay, MOVE_REASON_LABEL } from '@/lib/optimizer'
import type { PlannedMove, OptimizeScope, OptimizeMode, OptJob, ScheduleSuggestion, CadenceVisit, CadenceRecs } from '@/lib/optimizer'
import { evaluateScheduleMove } from '@/lib/scheduleWarnings'
import { resolvePrefs } from '@/lib/preferences'
import type { PrefSource } from '@/lib/preferences'
import { buildRoutingRoadDistance, RoadDist } from '@/lib/distance'
import { analyzeScheduleHealth } from '@/lib/scheduleHealth'
import type { HealthIssue, HealthJob } from '@/lib/scheduleHealth'
import { ScheduleHealthCard } from '@/components/schedule/ScheduleHealthCard'
import { DayStatusMenu } from '@/components/schedule/DayStatusMenu'
import { buildDayStatusMap, buildCapacityForDate, dayStartTime, isDayBlocked, loadDayStatuses, setDayStatus, setDayCapacity, clearDayStatus, DAY_STATUS_META, DAY_STATUS_SELECT, type DayStatusMap, type DayStatusRow, type DayStatus } from '@/lib/dayStatus'
import { directionsUrl, estimateDayLoad } from '@/lib/route'
import { loadTravelModel, DEFAULT_TRAVEL_MODEL, type TravelModel } from '@/lib/travelLearning'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { DaySettingsBar } from '@/components/schedule/DaySettingsBar'
import { WeatherRainCard, type RainMoveSummary } from '@/components/schedule/WeatherRainCard'
import { loadWeatherImpact, type WeatherImpactReport, type DayImpact } from '@/lib/weatherImpact'

function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type PendingAction =
  | { type: 'edit'; job: Job; values: JobFormValues; recurrence: Recurrence }
  | { type: 'move'; job: Job; newDate: string }
  | { type: 'delete'; job: Job }
  | { type: 'price'; job: Job; price: number | null; reason?: string }

// Map an interval back to the legacy `freq` column where it lines up.
function legacyFreqFor(unit: RecurUnit | null, count: number): string | null {
  if (unit === 'week' && count === 1) return 'weekly'
  if (unit === 'week' && count === 2) return 'biweekly'
  if (unit === 'month' && count === 1) return 'monthly'
  return null
}

// A series row → the form's Recurrence shape (handles legacy freq-only rows).
function recFromRow(r: JobRecurrence): Recurrence {
  if (r.interval_unit) return { unit: r.interval_unit, count: r.interval_count ?? 1, endDate: r.end_date, endCount: r.end_count }
  if (r.freq === 'weekly') return { unit: 'week', count: 1, endDate: r.end_date, endCount: r.end_count }
  if (r.freq === 'biweekly') return { unit: 'week', count: 2, endDate: r.end_date, endCount: r.end_count }
  if (r.freq === 'monthly') return { unit: 'month', count: 1, endDate: r.end_date, endCount: r.end_count }
  return { unit: null, count: 1, endDate: null, endCount: null }
}

export default function SchedulePage() {
  const supabase = createClient()
  // Learned drive speed — feeds the proactive optimizer suggestions below.
  const [travel, setTravel] = useState<TravelModel>(DEFAULT_TRAVEL_MODEL)
  useEffect(() => { loadTravelModel(supabase).then(setTravel) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const router = useRouter()
  const searchParams = useSearchParams()
  const quoteId = searchParams.get('quote')
  const customerParam = searchParams.get('customer')
  const propertyParam = searchParams.get('property')
  const focusRec = searchParams.get('focus')

  const [jobs, setJobs] = useState<Job[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  // Dispatcher-first: land on TODAY's day board everywhere — "where next / when
  // finished / am I behind" lives there, not in a passive month grid.
  const [view, setView] = useState<CalendarView>('day')
  const [cursor, setCursor] = useState(new Date())
  // In-flight guard for the field bar's primary (it shares startJob/completeJob
  // with the cards, which keep their own `acting` guard inside the panel).
  const [fieldActing, setFieldActing] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Job | null>(null)
  const [formDate, setFormDate] = useState<string>('')
  const [formSeq, setFormSeq] = useState(0) // bump to remount a fresh add form
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  // Outcome + undo feedback flows through the ONE toast system (viewport-
  // anchored) — the old inline banner rendered above the page header, invisible
  // from where day-view actions actually happen. Same call shape kept so every
  // callsite reads unchanged.
  function setBanner(msg: string | null) {
    if (!msg) return
    const isError = /could not|please try again|nothing was scheduled|partially applied/i.test(msg)
    if (isError) toast.error(msg)
    else toast.success(msg)
  }
  const [recurrenceLabels, setRecurrenceLabels] = useState<Record<string, string>>({})
  const [recurrences, setRecurrences] = useState<Record<string, JobRecurrence>>({})
  const [quotesById, setQuotesById] = useState<Record<string, QuoteLite>>({})
  // Future jobs that already have an invoice = immutable locks. The proactive
  // cards AND the optimizer modal must read the SAME set, or they disagree about
  // what can move.
  const [invoicedJobIds, setInvoicedJobIds] = useState<Set<string>>(new Set())
  // Extra-service add-ons per visit (Day Ops). Kept in sync with the draft invoice.
  const [addonsByJobId, setAddonsByJobId] = useState<Record<string, JobLineItem[]>>({})
  const [baseCoord, setBaseCoord] = useState<Coord | null>(null)
  const [preferredWorkDays, setPreferredWorkDays] = useState<number[]>([5, 6, 0])
  const [workStartTime, setWorkStartTime] = useState('08:00')
  const [capacityHours, setCapacityHours] = useState(8)
  const [defaultCrew, setDefaultCrew] = useState(1)
  // Defaults come from the resolver, not a hand-copied literal — otherwise every
  // new automation has to be remembered here too (and this is loaded from
  // settings a moment later anyway).
  const [automations, setAutomations] = useState<Automations>(() => resolveAutomations(null))
  const [showOptimize, setShowOptimize] = useState(false)
  const [showRainCenter, setShowRainCenter] = useState(false)
  // Pre-scoped launch from an auto-suggestion (vs. the manual Optimize button).
  const [optimizeLaunch, setOptimizeLaunch] = useState<{ scope: OptimizeScope; mode: OptimizeMode; anchorDate: string; autoRun: boolean } | null>(null)
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set())
  // Soft warning before a hand move that breaks cadence or a customer preference.
  const [moveConfirm, setMoveConfirm] = useState<{ job: Job; newDate: string; warnings: string[] } | null>(null)
  // Dialog focus management for the move-confirm overlay (Escape/trap/restore).
  const moveConfirmRef = useFocusTrap<HTMLDivElement>(!!moveConfirm, () => setMoveConfirm(null))
  // After a job is added, auto-propose optimization — LOCAL first (the new job's
  // week), escalating to month/all-future ONLY for a substantial gain. Carries
  // the new job's date so the proposal is anchored around it.
  const [autoOptimizeQueued, setAutoOptimizeQueued] = useState<{ anchorDate: string } | null>(null)
  // Cached real-road distance lookup for the optimizer + proactive cards (shared
  // so they agree). Built from the located future stops; haversine until ready.
  const [roadDist, setRoadDist] = useState<RoadDist | undefined>(undefined)
  // Schedule Health — intentionally-ignored issue keys (persisted) + which issue
  // is mid-action.
  const [ignoredHealthKeys, setIgnoredHealthKeys] = useState<Set<string>>(new Set())
  const [healthBusyKey, setHealthBusyKey] = useState<string | null>(null)

  // ── Day Status (per-day availability: Rain / Vacation / Holiday …) ──
  const [uid, setUid] = useState<string | null>(null)
  const [dayStatusMap, setDayStatusMap] = useState<DayStatusMap | undefined>(undefined)
  const [selectedDays, setSelectedDays] = useState<Set<string>>(new Set())
  const [dayMenu, setDayMenu] = useState<{ dates: string[]; current: DayStatusRow | null; x: number; y: number } | null>(null)

  // Proactive Weather Ops (rain → block day + auto-optimize, one click).
  const [weatherReport, setWeatherReport] = useState<WeatherImpactReport | null>(null)
  const [dismissedRain, setDismissedRain] = useState<Set<string>>(new Set())
  const [rainBusy, setRainBusy] = useState<string | null>(null)
  const [rainSummary, setRainSummary] = useState<RainMoveSummary | null>(null)

  function launchOptimizer(opts?: { scope: OptimizeScope; mode: OptimizeMode; anchorDate: string }) {
    setOptimizeLaunch(opts ? { ...opts, autoRun: true } : null)
    setShowOptimize(true)
  }

  // Effective per-visit price for every job (manual price > linked quote).
  const valueByJobId = useMemo(() => {
    const m: Record<string, number> = {}
    for (const j of jobs) {
      const q = j.quote_id ? quotesById[j.quote_id] : null
      const rec = j.recurrence_id ? recurrences[j.recurrence_id] : null
      const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
      m[j.id] = jobVisitValue(j.price, q as unknown as Record<string, unknown>, freq, j.is_initial_visit)
    }
    return m
  }, [jobs, quotesById, recurrences])

  // The TOTAL billable value per job = base + add-on services. Shown on the
  // calendar chips (Total Job Value visible everywhere). The optimizer keeps
  // using the BASE valueByJobId — add-ons are billing, not a routing signal.
  const totalByJobId = useMemo(() => {
    const m: Record<string, number> = {}
    for (const j of jobs) m[j.id] = (valueByJobId[j.id] || 0) + addonsTotal(addonsByJobId[j.id])
    return m
  }, [jobs, valueByJobId, addonsByJobId])

  // Add-on count per job → the "+N" chip badge on the calendar.
  const addonCountByJobId = useMemo(() => {
    const m: Record<string, number> = {}
    for (const [id, list] of Object.entries(addonsByJobId)) if (list.length) m[id] = list.length
    return m
  }, [addonsByJobId])

  // ONE OptJob projection of the schedule, shared by the proactive cards, the
  // auto-propose-on-add check and any other engine call — so they never diverge.
  const optJobsAll = useMemo<OptJob[]>(() => jobs.map(j => ({
    id: j.id, scheduled_date: j.scheduled_date, status: j.status,
    recurrence_id: j.recurrence_id, start_time: j.start_time, duration_minutes: j.duration_minutes,
    lat: j.properties?.lat ?? null, lng: j.properties?.lng ?? null,
    value: valueByJobId[j.id] || 0, invoiced: invoicedJobIds.has(j.id),
    title: j.title, customerName: j.customers?.name || j.title, customerId: j.customer_id,
    serviceType: j.service_type, neighborhood: j.properties?.neighborhood ?? null,
    ...(() => { const p = resolvePrefs(j.customers, j.properties); return { preferredDays: p.preferredDays, avoidDays: p.avoidDays } })(),
  })), [jobs, valueByJobId, invoicedJobIds])

  // The optimizer's base options (everything except mode/scope/anchorDate).
  const optBaseOpts = useMemo(() => {
    const recs: Record<string, { freq: string | null; interval_unit: string | null; interval_count: number | null }> = {}
    for (const [id, r] of Object.entries(recurrences)) recs[id] = { freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count }
    const crew = defaultCrew > 0 ? defaultCrew : 1
    const capacityForDate = buildCapacityForDate(dayStatusMap, { crew, hours: (capacityHours > 0 ? capacityHours : 8) / crew })
    return { today: localToday(), base: baseCoord, preferredDays: preferredWorkDays, capacityHours, recurrences: recs, roadDist, dayStatusMap, capacityForDate, minPerKm: travel.minPerKm }
  }, [recurrences, baseCoord, preferredWorkDays, capacityHours, roadDist, dayStatusMap, defaultCrew, travel.minPerKm])

  // ── Effective capacity for the OPEN day (one source: lib/dayStatus) ──────────
  // Feeds the Day Ops panel the day's real start time + labour-hours (after any
  // crew / working-hours / start-end / disable override), reusing the SAME
  // capacityForDate the optimizer uses. Because it derives from dayStatusMap +
  // cursor, changing any of those instantly re-flows every ETA, the estimated
  // finish, utilization, remaining hours and overbooked warnings — no refresh.
  const dayView = useMemo(() => {
    const iso = format(cursor, 'yyyy-MM-dd')
    const row = dayStatusMap?.byDate[iso] ?? null
    return { start: dayStartTime(row, workStartTime), laborHours: optBaseOpts.capacityForDate(iso) }
  }, [cursor, dayStatusMap, workStartTime, optBaseOpts])

  // Proactive auto-suggestions (overloaded days, isolated jobs, recurring-cluster
  // opportunities) — same engines, shown without opening the optimizer.
  const suggestions = useMemo<ScheduleSuggestion[]>(
    () => (optJobsAll.length === 0 ? [] : analyzeSchedule(optJobsAll, optBaseOpts)),
    [optJobsAll, optBaseOpts],
  )

  const visibleSuggestions = suggestions.filter(s => !dismissedSuggestions.has(s.id))

  // Auto-propose optimization after a job is added (review-first — NEVER auto-
  // applies). CONTEXT-AWARE escalation, anchored on the new job's date:
  //   1) LOCAL first — the new job's WEEK. Low bar: any real gain (km / minutes /
  //      a fixed overload / a tightened cluster / better $/h) → propose it.
  //   2) Only if the local week has nothing worthwhile, widen to the MONTH, then
  //      ALL-FUTURE — and propose those ONLY for a SUBSTANTIAL gain, so adding one
  //      customer never reshuffles people months away for a couple of km.
  // The modal it opens already shows the WHY (km/min saved, overloads fixed,
  // clusters strengthened, $/h lift) as chips + reasons.
  useEffect(() => {
    if (!autoOptimizeQueued) return
    if (loading || showForm || editing || showOptimize || pendingAction || moveConfirm || showRainCenter) return
    const anchor = autoOptimizeQueued.anchorDate
    setAutoOptimizeQueued(null)
    if (optJobsAll.length === 0) return

    const run = (scope: OptimizeScope) => optimizeSchedule(optJobsAll, { ...optBaseOpts, mode: 'recommended', scope, anchorDate: anchor })
    const worthIt = (r: ReturnType<typeof run>, bar: 'local' | 'global'): boolean => {
      if (r.moves.length === 0) return false
      const overloadFixed = r.after.overloadedDays < r.before.overloadedDays
      const revUp = r.after.revPerHour > r.before.revPerHour
      return bar === 'global'
        ? overloadFixed || r.kmSaved >= 5 || r.minutesSaved >= 30 || r.groupedIntoCluster >= 2   // substantial only
        : overloadFixed || r.kmSaved >= 1 || r.minutesSaved >= 5 || r.groupedIntoCluster >= 1 || revUp // any real local gain
    }

    if (worthIt(run('week'), 'local')) { launchOptimizer({ scope: 'week', mode: 'recommended', anchorDate: anchor }); return }
    if (worthIt(run('month'), 'global')) { launchOptimizer({ scope: 'month', mode: 'recommended', anchorDate: anchor }); return }
    if (worthIt(run('future'), 'global')) { launchOptimizer({ scope: 'future', mode: 'recommended', anchorDate: anchor }); return }
    // else: the local area is already tight and no broader change is worth it — stay quiet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOptimizeQueued, optJobsAll, optBaseOpts, loading, showForm, editing, showOptimize, pendingAction, moveConfirm, showRainCenter])

  // Shared cadence/preference context for manual-move warnings — every visit as a
  // timeline node plus the recurrence rules. Rebuilds only when jobs/recurrences
  // change, so each drag or date edit is a cheap lookup.
  const cadenceVisits = useMemo<CadenceVisit[]>(() => jobs.map(j => ({
    id: j.id, scheduled_date: j.scheduled_date, status: j.status,
    customerId: j.customer_id, recurrence_id: j.recurrence_id,
    serviceType: j.service_type, customerName: j.customers?.name ?? null,
  })), [jobs])
  const cadenceRecs = useMemo<CadenceRecs>(() => {
    const m: CadenceRecs = {}
    for (const [id, r] of Object.entries(recurrences)) m[id] = { freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count }
    return m
  }, [recurrences])

  // Signature of the located future stops — the effect below rebuilds the road
  // matrix only when this SET changes (not on every status flip / mutation).
  const futureStopSig = useMemo(() => jobs
    .filter(j => j.scheduled_date > localToday() && j.status === 'scheduled' && j.properties?.lat != null && j.properties?.lng != null)
    .map(j => `${j.properties!.lat},${j.properties!.lng}`)
    .sort().join('|'), [jobs])

  // Pre-warm real-road distances for the optimizer + cards (the engine is sync, so
  // the async fetch happens here). Cost-bounded (base legs + K-nearest pairs,
  // capped request budget); the cache persists so coverage grows across loads.
  useEffect(() => {
    if (!baseCoord) { setRoadDist(undefined); return }
    const stops = jobs
      .filter(j => j.scheduled_date > localToday() && j.status === 'scheduled' && j.properties?.lat != null && j.properties?.lng != null)
      .map(j => ({ lat: j.properties!.lat as number, lng: j.properties!.lng as number }))
    if (stops.length < 2) { setRoadDist(undefined); return }
    let active = true
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || !active) return
      const { dist, usedRoad } = await buildRoutingRoadDistance(supabase, user.id, baseCoord, stops)
      if (active && usedRoad) setRoadDist(() => dist)
    })()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseCoord?.lat, baseCoord?.lng, futureStopSig, supabase])

  // Warnings for moving an EXISTING job (drag-drop / Day Ops "Move to") to a date.
  function moveWarnings(job: Job, newDate: string): string[] {
    const customer = customers.find(c => c.id === job.customer_id) ?? null
    return evaluateScheduleMove({
      move: { id: job.id, customerId: job.customer_id, recurrence_id: job.recurrence_id, serviceType: job.service_type },
      toDate: newDate,
      startTime: job.start_time,
      allVisits: cadenceVisits,
      recs: cadenceRecs,
      customerPrefs: customer as PrefSource | null,
      propertyPrefs: (job.properties ?? null) as PrefSource | null,
      customerName: job.customers?.name ?? null,
    }).warnings
  }

  // Warnings for the job FORM's date/time fields. The form supplies the prefs it
  // has loaded (selected customer + property); the page supplies the timeline.
  function formMoveWarnings(input: {
    jobId?: string
    customerId: string
    serviceType: string | null
    date: string
    startTime: string | null
    customerPrefs: PrefSource | null
    propertyPrefs: PrefSource | null
    customerName: string | null
  }): string[] {
    if (!input.date || !input.customerId) return []
    const existing = input.jobId ? jobs.find(j => j.id === input.jobId) : null
    return evaluateScheduleMove({
      move: { id: input.jobId ?? '__new__', customerId: input.customerId, recurrence_id: existing?.recurrence_id ?? null, serviceType: input.serviceType },
      toDate: input.date,
      startTime: input.startTime,
      allVisits: cadenceVisits,
      recs: cadenceRecs,
      customerPrefs: input.customerPrefs,
      propertyPrefs: input.propertyPrefs,
      customerName: input.customerName,
    }).warnings
  }

  // ── Schedule Health ──
  // Catches duplicate / conflicting / overlapping visits before they reach Day
  // Ops, reusing the same cadence grouping the optimizer uses.
  const healthReport = useMemo(() => {
    if (jobs.length === 0) return { issues: [] as HealthIssue[], duplicateStops: 0, minutesSaved: 0, allMow: false }
    const hjobs: HealthJob[] = jobs.map(j => ({
      id: j.id, scheduled_date: j.scheduled_date, status: j.status,
      customerId: j.customer_id, recurrence_id: j.recurrence_id, serviceType: j.service_type,
      customerName: j.customers?.name || j.title,
      duration_minutes: j.duration_minutes, lat: j.properties?.lat ?? null, lng: j.properties?.lng ?? null,
      start_time: j.start_time, invoiced: invoicedJobIds.has(j.id),
    }))
    return analyzeScheduleHealth(hjobs, { today: localToday(), base: baseCoord, roadDist })
  }, [jobs, baseCoord, roadDist, invoicedJobIds])

  const visibleHealthIssues = healthReport.issues.filter(i => !ignoredHealthKeys.has(i.key))
  // Duplicate-stop savings the optimizer can't fix by moving (it reports this).
  const healthDuplicates = useMemo(() => {
    const dup = visibleHealthIssues.filter(i => i.kind === 'duplicate-day')
    return { stops: dup.reduce((s, i) => s + i.removableJobIds.length, 0), minutes: dup.reduce((s, i) => s + i.minutesSaved, 0) }
  }, [visibleHealthIssues])

  function reviewHealth(issue: HealthIssue) {
    if (issue.kind === 'multiple-plans' && issue.customerId) { router.push(`/dashboard/customers/${issue.customerId}`); return }
    if (issue.date) { setCursor(parseISO(issue.date + 'T00:00:00')); setView('day') }
  }

  async function deleteHealth(issue: HealthIssue) {
    if (issue.removableJobIds.length === 0) return
    setHealthBusyKey(issue.key)
    const rows = jobs.filter(j => issue.removableJobIds.includes(j.id)).map(jobInsertRow)
    const addons = addonInsertRows(issue.removableJobIds)
    const { error } = await supabase.from('jobs').delete().in('id', issue.removableJobIds)
    if (error) { setBanner('Could not remove the duplicate: ' + error.message); setHealthBusyKey(null); return }
    await fetchJobs()
    setHealthBusyKey(null)
    offerUndo(`Removed ${rows.length} ${issue.isMow ? 'mowing ' : ''}visit${rows.length !== 1 ? 's' : ''}`, async () => {
      if (rows.length) await supabase.from('jobs').insert(rows)
      if (addons.length) await supabase.from('job_line_items').insert(addons)
    })
  }

  // Merge overlapping recurring plans: keep the dominant series, end the others
  // (delete their future visits, detach their past visits, drop the recurrence row).
  async function mergeHealth(issue: HealthIssue) {
    const keepRec = issue.keepRecurrenceId
    const others = issue.recurrenceIds.filter(r => r !== keepRec)
    if (!keepRec || others.length === 0) return
    setHealthBusyKey(issue.key)
    const today = localToday()
    const otherSet = new Set(others)
    const futureJobs = jobs.filter(j => j.recurrence_id && otherSet.has(j.recurrence_id)
      && j.scheduled_date >= today && (j.status === 'scheduled' || j.status === 'in_progress') && !invoicedJobIds.has(j.id))
    const futureRows = futureJobs.map(jobInsertRow)
    const futureAddons = addonInsertRows(futureJobs.map(j => j.id))
    const futureIds = new Set(futureJobs.map(j => j.id))
    const pastReattach = jobs.filter(j => j.recurrence_id && otherSet.has(j.recurrence_id) && !futureIds.has(j.id))
      .map(j => ({ id: j.id, recurrence_id: j.recurrence_id as string }))
    const recRows = others.map(r => recurrences[r]).filter(Boolean).map(r => ({
      id: r.id, user_id: r.user_id, freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count,
      start_date: r.start_date, end_date: r.end_date, end_count: r.end_count, customer_id: r.customer_id,
    }))
    // The delete is the destructive step — if it fails there is nothing to merge and the
    // toast must not say otherwise (removeHealth, its sibling, already checks this).
    if (futureJobs.length) {
      const { error } = await supabase.from('jobs').delete().in('id', futureJobs.map(j => j.id))
      if (error) { setBanner('Could not merge these plans — nothing was changed.'); setHealthBusyKey(null); return }
    }
    if (pastReattach.length) await supabase.from('jobs').update({ recurrence_id: null }).in('id', pastReattach.map(p => p.id))
    await supabase.from('job_recurrences').delete().in('id', others)
    await fetchJobs()
    setHealthBusyKey(null)
    offerUndo(`Merged ${others.length + 1} ${issue.isMow ? 'mowing ' : ''}plans into one`, async () => {
      const res: { error: unknown }[] = []
      if (recRows.length) res.push(await supabase.from('job_recurrences').insert(recRows))
      if (futureRows.length) res.push(await supabase.from('jobs').insert(futureRows))
      if (futureAddons.length) res.push(await supabase.from('job_line_items').insert(futureAddons))
      for (const p of pastReattach) res.push(await supabase.from('jobs').update({ recurrence_id: p.recurrence_id }).eq('id', p.id))
      await fetchJobs()
      if (res.some(r => r.error)) setBanner('Could not fully unmerge these plans — check the affected visits.')
    })
  }

  async function ignoreHealth(issue: HealthIssue) {
    setIgnoredHealthKeys(prev => new Set(prev).add(issue.key))
    const { data: { user } } = await supabase.auth.getUser()
    if (user) await supabase.from('schedule_health_ignored').upsert({ user_id: user.id, issue_key: issue.key }, { onConflict: 'user_id,issue_key' })
  }

  // When arriving from an accepted quote (?quote=…), open a prefilled new-job form.
  const [quoteCtx, setQuoteCtx] = useState<Quote | null>(null)
  const [quotePrefill, setQuotePrefill] = useState<Partial<JobFormValues> | null>(null)
  // The quote's cadence, inferred from which recurring price it carries, so a
  // recurring quote pre-fills the Repeat controls (instead of silently scheduling
  // one visit). Editable in the form.
  const [quoteRecurrence, setQuoteRecurrence] = useState<Recurrence | undefined>(undefined)
  // When arriving from a customer (?customer=…), open a new-job form for them.
  const [customerPrefill, setCustomerPrefill] = useState<Partial<JobFormValues> | null>(null)

  // Read EVERY job, in pages. PostgREST caps a response at 1000 rows and does not
  // raise an error, so the previous unbounded select silently dropped everything
  // past the cap — and because the order is scheduled_date ASCENDING, what got
  // dropped was the FURTHEST-FUTURE work. Once a season of pre-generated recurring
  // visits passes the cap, upcoming jobs simply vanish from the calendar, the
  // optimizer, cadence validation and Schedule Health, with no error to see: the
  // owner double-books against a timeline that looks empty. `id` is a stable
  // tiebreak — dozens of stops share one date, and without it the row order across
  // pages isn't deterministic, so rows could repeat or be skipped at a boundary.
  const fetchAllJobs = useCallback(async (userId: string): Promise<{ rows: Job[]; error: string | null }> => {
    const PAGE_ROWS = 1000
    const rows: Job[] = []
    for (let from = 0; ; from += PAGE_ROWS) {
      const { data, error } = await supabase
        .from('jobs')
        .select('*, customers(id, name, phone, preferred_days, avoid_days, pref_time_start, pref_time_end), properties(id, address, lat, lng, neighborhood, preferred_days, avoid_days, pref_time_start, pref_time_end)')
        .eq('user_id', userId)
        .order('scheduled_date')
        .order('id')
        .range(from, from + PAGE_ROWS - 1)
      if (error) return { rows, error: error.message }
      const batch = (data as Job[]) || []
      rows.push(...batch)
      if (batch.length < PAGE_ROWS) return { rows, error: null }
    }
  }, [supabase])

  const fetchJobs = useCallback(async () => {
    // Local session read, not getUser(): getUser() is a network round-trip, so with
    // no signal the whole loader used to throw here and the day never painted at
    // all — before any cached rows could be shown.
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) { setLoading(false); return }
    const [jRes, cRes, rRes, qRes, sRes, iRes, hRes, dRes] = await Promise.all([
      fetchAllJobs(user!.id),
      supabase.from('customers').select('*').eq('user_id', user!.id).is('archived_at', null).order('name'), // active only — can't schedule an archived customer without restoring
      supabase.from('job_recurrences').select('*').eq('user_id', user!.id),
      supabase.from('quotes').select('id, total, initial_price, weekly_price, biweekly_price, monthly_price').eq('user_id', user!.id),
      supabase.from('business_settings').select('base_lat, base_lng, base_address, preferred_work_days, work_start_time, daily_capacity_hours, automations').eq('user_id', user!.id).maybeSingle(),
      supabase.from('invoices').select('job_id').eq('user_id', user!.id).not('job_id', 'is', null),
      supabase.from('schedule_health_ignored').select('issue_key').eq('user_id', user!.id),
      supabase.from('day_statuses').select(DAY_STATUS_SELECT).eq('user_id', user!.id),
    ])
    setUid(user!.id)
    setDayStatusMap(buildDayStatusMap((dRes.data as DayStatusRow[]) || []))
    // A failed jobs read must NEVER paint an empty schedule: "no work today" is
    // indistinguishable from a clear day, and that's how a stop gets missed. Keep
    // whatever is already on screen, say so plainly, and let the rest of the page
    // finish refreshing (so loading always resolves).
    if (jRes.error) {
      setBanner('Could not load the schedule — check your connection and refresh. Showing the last data loaded.')
    } else {
      const loadedJobs = jRes.rows
      setJobs(loadedJobs)
      // Field cache — today ± a week, the window a contractor actually works out
      // of. Persisted (localStorage) because the phone kills the app between
      // stops, so a tab-scoped cache would be empty on the driveway cold-start
      // that needs it most. Bounded by date so a 200-job/week book stays well
      // inside quota instead of serializing the whole year.
      const from = shiftDate(localTodayISO(), -1), to = shiftDate(localTodayISO(), 7)
      writeCache(FIELD_JOBS_KEY, loadedJobs.filter(j => j.scheduled_date >= from && j.scheduled_date <= to), { persist: true })
      setAddonsByJobId(await listLineItemsByJob(supabase, user!.id, loadedJobs.map(j => j.id)))
    }
    setInvoicedJobIds(new Set(((iRes.data as { job_id: string }[]) || []).map(r => r.job_id)))
    setIgnoredHealthKeys(new Set(((hRes.data as { issue_key: string }[] | null) || []).map(r => r.issue_key)))
    setCustomers((cRes.data as Customer[]) || [])
    const labels: Record<string, string> = {}
    const recMap: Record<string, JobRecurrence> = {}
    for (const r of (rRes.data as JobRecurrence[]) || []) {
      labels[r.id] = recurrenceLabel(r.interval_unit, r.interval_count, r.freq)
      recMap[r.id] = r
    }
    setRecurrenceLabels(labels)
    setRecurrences(recMap)

    const qMap: Record<string, QuoteLite> = {}
    for (const q of (qRes.data as QuoteLite[]) || []) qMap[q.id] = q
    setQuotesById(qMap)

    // Base coordinate for route optimization (geocode the address once if needed).
    const s = sRes.data as { base_lat: number | null; base_lng: number | null; base_address: string | null; preferred_work_days: number[] | null; work_start_time: string | null; daily_capacity_hours: number | null; automations: unknown } | null
    setAutomations(resolveAutomations(s?.automations))
    setPreferredWorkDays(s?.preferred_work_days?.length ? s.preferred_work_days : [5, 6, 0])
    setWorkStartTime(s?.work_start_time || '08:00')
    setCapacityHours(s?.daily_capacity_hours && s.daily_capacity_hours > 0 ? s.daily_capacity_hours : 8)
    if (s?.base_lat != null && s?.base_lng != null) {
      setBaseCoord({ lat: s.base_lat, lng: s.base_lng })
    } else if (s?.base_address) {
      const c = await geocodeAddress(s.base_address)
      if (c) {
        setBaseCoord(c)
        await supabase.from('business_settings').update({ base_lat: c.lat, base_lng: c.lng }).eq('user_id', user!.id)
      }
    }
    setLoading(false)
  }, [supabase, fetchAllJobs])

  // Paint the cached field window first so the day is on screen instantly — and,
  // with no signal, at all. fetchJobs revalidates right behind it, so this is
  // never stale-stuck; it only ever front-runs the network.
  useEffect(() => {
    const cached = readCache<Job[]>(FIELD_JOBS_KEY, CACHE_TTL.field, { persist: true })
    if (cached?.length) { setJobs(cached); setLoading(false) }
    fetchJobs()
  }, [fetchJobs])

  // ── Day Status: live sync + optimistic set/clear (source of truth = day_statuses) ──
  const reloadDayStatuses = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) setDayStatusMap(buildDayStatusMap(await loadDayStatuses(supabase, user.id)))
  }, [supabase])
  useRealtimeRefresh('day_statuses', uid ? `user_id=eq.${uid}` : null, reloadDayStatuses)
  // Jobs too: any write (this tab's optimistic mutations, another device, the
  // route_order trigger, Weather Ops) reconciles the UI to the DB — debounced —
  // and the hook refetches on reconnect/visibility, so optimistic state can
  // never silently diverge from what was actually persisted.
  useRealtimeRefresh('jobs', uid ? `user_id=eq.${uid}` : null, fetchJobs)

  // Open the day menu — if the day is part of a multi-selection, target them all.
  function openDayMenu(dateISO: string, pos: { x: number; y: number }) {
    const dates = selectedDays.has(dateISO) && selectedDays.size > 1 ? Array.from(selectedDays) : [dateISO]
    setDayMenu({ dates, current: dates.length === 1 ? (dayStatusMap?.byDate[dateISO] ?? null) : null, x: pos.x, y: pos.y })
  }
  function toggleDaySelect(dateISO: string) {
    setSelectedDays(prev => { const n = new Set(prev); if (n.has(dateISO)) n.delete(dateISO); else n.add(dateISO); return n })
  }
  // Apply a status to one or many days — optimistic, then persist + reconcile.
  async function applyDayStatus(dates: string[], status: DayStatus) {
    if (!uid) return
    const blocks = DAY_STATUS_META[status].defaultBlocks
    setDayStatusMap(prev => {
      const byDate = { ...(prev?.byDate || {}) }
      const blockedDates = new Set(prev?.blockedDates || [])
      for (const dt of dates) {
        byDate[dt] = { id: byDate[dt]?.id || `tmp-${dt}`, date: dt, status, blocks, label: null, notes: null, starts_at: null, ends_at: null, crew_size: null, created_by: null }
        if (blocks) blockedDates.add(dt); else blockedDates.delete(dt)
      }
      return { byDate, blockedDates }
    })
    setDayMenu(null); setSelectedDays(new Set())
    const res = await Promise.all(dates.map(dt => setDayStatus(supabase, uid, dt, { status })))
    reloadDayStatuses()
    // Report the outcome: rainDisableAndOptimize goes on to tell the owner the day is
    // blocked and print a "Revenue protected" figure, so it has to know if this failed.
    if (res.some(r => r.error)) { setBanner('Could not save the day status — please try again.'); return { ok: false } }
    return { ok: true }
  }
  async function clearDayStatusFor(dates: string[]) {
    if (!uid) return
    setDayStatusMap(prev => {
      const byDate = { ...(prev?.byDate || {}) }
      const blockedDates = new Set(prev?.blockedDates || [])
      for (const dt of dates) { delete byDate[dt]; blockedDates.delete(dt) }
      return { byDate, blockedDates }
    })
    setDayMenu(null); setSelectedDays(new Set())
    // The optimistic clear above already told the owner the day is open again. Its sibling
    // applyDayStatus checks this; unchecked, a failure let the day flicker available and
    // then silently snap back to blocked with no explanation.
    const res = await Promise.all(dates.map(dt => clearDayStatus(supabase, uid, dt)))
    reloadDayStatuses()
    if (res.some(r => r.error)) setBanner('Could not clear the day status — please try again.')
  }

  // ── Proactive Weather Ops: detect a rainy day with work, offer a one-click fix ──
  useEffect(() => {
    let active = true
    loadWeatherImpact(supabase).then(r => { if (active) setWeatherReport(r) }).catch(() => {})
    return () => { active = false }
  }, [supabase])

  // The next rainy day Weather Ops says to delay that still has work and isn't
  // already blocked or dismissed.
  const rainTarget = useMemo<DayImpact | null>(() => {
    if (!weatherReport) return null
    const today = localToday()
    return weatherReport.atRiskDays.find(d =>
      d.recommendation.action === 'delay' && d.jobs > 0 && d.date >= today &&
      !dismissedRain.has(d.date) && !dayStatusMap?.blockedDates.has(d.date)
    ) ?? null
  }, [weatherReport, dismissedRain, dayStatusMap])

  // Move a rained-out day's work to the best open days (reuses planRainDelay, which
  // already skips blocked days) and summarize what moved.
  function summarizeRain(date: string, blocked: boolean, plan: ReturnType<typeof planRainDelay>): RainMoveSummary {
    const byDay: Record<string, number> = {}
    for (const m of plan.moves) byDay[m.to] = (byDay[m.to] || 0) + 1
    return {
      date, blocked,
      byDay: Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0])).map(([to, count]) => ({ to, count })),
      revenueProtected: Math.round(plan.moves.reduce((s, m) => s + m.value, 0)),
      unmovable: plan.unmovable.length,
    }
  }
  // Returns the plan AND whether the moves actually persisted — "Revenue protected: $X"
  // is derived from plan.moves, so summarizing an unapplied plan invents that number.
  async function applyRainMoves(date: string): Promise<{ plan: ReturnType<typeof planRainDelay>; ok: boolean }> {
    const plan = planRainDelay(optJobsAll, date, optBaseOpts)
    const moves = plan.moves.map(m => ({ jobId: m.jobId, from: m.from, to: m.to }))
    if (!moves.length) return { plan, ok: true }
    const res = await applyOptimization(moves)
    return { plan, ok: res.ok }
  }
  async function rainDisableAndOptimize(date: string) {
    setRainBusy(date)
    // `blocked` must reflect the day_statuses write, not our intent: if it failed the day
    // is still open, the optimizer will keep routing work onto a rained-out day, and the
    // card would say otherwise. Same for the moves behind "Revenue protected".
    const blockRes = await applyDayStatus([date], 'rain')
    const { plan, ok } = await applyRainMoves(date)
    if (!ok) { setBanner('Could not move this day’s visits — they’re still on the rained-out day.'); setRainBusy(null); return }
    setRainSummary(summarizeRain(date, !!blockRes?.ok, plan))
    setDismissedRain(prev => new Set(prev).add(date))
    setRainBusy(null)
  }
  async function rainDisableOnly(date: string) {
    setRainBusy(date)
    const blockRes = await applyDayStatus([date], 'rain')
    if (!blockRes?.ok) { setRainBusy(null); return }   // applyDayStatus already banner'd
    setRainSummary({ date, blocked: true, byDay: [], revenueProtected: 0, unmovable: 0 })
    setDismissedRain(prev => new Set(prev).add(date))
    setRainBusy(null)
  }
  async function rainOptimizeOnly(date: string) {
    setRainBusy(date)
    const { plan, ok } = await applyRainMoves(date)
    if (!ok) { setBanner('Could not move this day’s visits — they’re still on the rained-out day.'); setRainBusy(null); return }
    setRainSummary(summarizeRain(date, false, plan))
    setDismissedRain(prev => new Set(prev).add(date))
    setRainBusy(null)
  }

  // ── Day Settings: per-day crew / working-hours override (Day View) ──
  async function saveDayCapacity(date: string, patch: { crewSize?: number | null; startsAt?: string | null; endsAt?: string | null }) {
    if (!uid) return
    const cur = dayStatusMap?.byDate[date] ?? null
    setDayStatusMap(prev => {
      const byDate = { ...(prev?.byDate || {}) }
      const blockedDates = new Set(prev?.blockedDates || [])
      const base: DayStatusRow = byDate[date] ?? { id: `tmp-${date}`, date, status: 'custom', blocks: false, label: null, notes: null, starts_at: null, ends_at: null, crew_size: null, created_by: null }
      byDate[date] = {
        ...base,
        starts_at: patch.startsAt !== undefined ? patch.startsAt : base.starts_at,
        ends_at: patch.endsAt !== undefined ? patch.endsAt : base.ends_at,
        crew_size: patch.crewSize !== undefined ? patch.crewSize : base.crew_size,
      }
      return { byDate, blockedDates }
    })
    const { error } = await setDayCapacity(supabase, uid, date, cur, patch)
    if (error) setBanner('Could not save day settings — please try again.')
    reloadDayStatuses()
  }
  function resetDayCapacity(date: string) { saveDayCapacity(date, { crewSize: null, startsAt: null, endsAt: null }) }
  async function toggleDisableDay(date: string) {
    if (dayStatusMap?.byDate[date]?.blocks) await clearDayStatusFor([date])
    else await applyDayStatus([date], 'custom')
  }

  useEffect(() => {
    if (!quoteId) return
    let active = true
    async function loadQuote() {
      const { data: { user } } = await supabase.auth.getUser()
      const { data: q } = await supabase.from('quotes').select('*').eq('id', quoteId).eq('user_id', user!.id).single()
      if (!q || !active) return
      let propertyId: string | null = q.property_id
      if (!propertyId && q.customer_id) {
        const { data: props } = await supabase
          .from('properties').select('id').eq('customer_id', q.customer_id)
          .order('is_primary', { ascending: false }).limit(1)
        if (props && props.length > 0) propertyId = props[0].id
      }
      if (!active) return
      setQuoteCtx(q as Quote)
      setQuotePrefill({
        customer_id: q.customer_id || '',
        property_id: propertyId || '',
        title: `${q.service_type} — ${q.customer_name}`,
        service_type: q.service_type,
        scheduled_date: localToday(),
        duration_minutes: Math.round(Number(q.hours) * 60),
        crew_size: q.crew_size,
        status: 'scheduled',
        notes: q.notes || '',
      })
      // Infer the quote's cadence from the recurring price it carries so the
      // Repeat controls pre-fill (weekly > biweekly > monthly when ambiguous).
      const w = Number(q.weekly_price) > 0, b = Number(q.biweekly_price) > 0, m = Number(q.monthly_price) > 0
      setQuoteRecurrence(
        w ? { unit: 'week', count: 1, endDate: null, endCount: null }
        : b ? { unit: 'week', count: 2, endDate: null, endCount: null }
        : m ? { unit: 'month', count: 1, endDate: null, endCount: null }
        : undefined,
      )
      setEditing(null)
      setShowForm(true)
    }
    loadQuote()
    return () => { active = false }
  }, [quoteId, supabase])

  useEffect(() => {
    if (!customerParam || quoteId) return
    setEditing(null)
    setQuotePrefill(null)
    // Property-aware: a per-property "Job" button passes ?property= so the form
    // opens on that exact property, not just the customer.
    setCustomerPrefill({ customer_id: customerParam, ...(propertyParam ? { property_id: propertyParam } : {}), scheduled_date: localToday() })
    setShowForm(true)
  }, [customerParam, propertyParam, quoteId])

  // Edit Schedule deep link (?focus=<recurrenceId>) — open the next upcoming
  // visit of that series for editing, so changes can be applied to the whole
  // series via the existing scope picker. Jumps the calendar to that visit.
  useEffect(() => {
    if (!focusRec || jobs.length === 0) return
    const next = jobs
      .filter(j => j.recurrence_id === focusRec && j.scheduled_date >= localToday() && (j.status === 'scheduled' || j.status === 'in_progress'))
      .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))[0]
    if (next) {
      setCursor(parseISO(next.scheduled_date + 'T00:00:00'))
      setEditing(next)
      setShowForm(false)
    }
  }, [focusRec, jobs])

  function closeForm() {
    setShowForm(false)
    setEditing(null)
    setFormDate('')
    if (quoteCtx || customerPrefill) {
      setQuoteCtx(null)
      setQuotePrefill(null)
      setQuoteRecurrence(undefined)
      setCustomerPrefill(null)
      router.replace('/dashboard/schedule')
    }
  }

  // Editor modal: lock background scroll + close on Escape while it's open.
  useEffect(() => {
    if (!showForm && !editing) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeForm() }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prevOverflow }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showForm, editing])

  async function handleAdd(values: JobFormValues, recurrence: Recurrence, meta?: SuggestionMeta, opts?: { addAnother?: boolean }) {
    const { data: { user } } = await supabase.auth.getUser()
    const base = {
      user_id: user!.id,
      customer_id: values.customer_id || null,
      property_id: values.property_id || null,
      quote_id: quoteCtx?.id ?? null,
      title: values.title,
      service_type: values.service_type || null,
      start_time: values.start_time || null,
      end_time: values.end_time || null,
      duration_minutes: values.duration_minutes ? Number(values.duration_minutes) : null,
      crew_size: Number(values.crew_size) || 1,
      status: values.status,
      notes: values.notes || null,
      price: Number(values.price) > 0 ? Number(values.price) : null,
      actual_minutes: values.actual_minutes ? Number(values.actual_minutes) : null,
      suggested_date: meta?.suggestedDate ?? null,
      suggested_nearby_count: meta?.suggestedNearby ?? null,
    }

    if (!recurrence.unit) {
      const { error } = await supabase.from('jobs').insert({ ...base, scheduled_date: values.scheduled_date, recurrence_id: null })
      if (error) { setBanner('Could not save the job: ' + error.message); return }
    } else {
      // Generate + VALIDATE before writing anything — a recurring service must
      // produce at least one future visit beyond the first, or we refuse rather
      // than silently leave a single-visit "series".
      const dates = generateOccurrences(values.scheduled_date, recurrence.unit, recurrence.count, recurrence.endDate, recurrence.endCount)
      const futureRecurring = dates.slice(1).filter(d => d >= localToday())
      if (futureRecurring.length === 0) {
        setBanner('No recurring visits were generated — this would create only the first visit. Check the cadence and end date, then try again.')
        return
      }
      // Keep legacy `freq` populated where the interval maps to an old value.
      const legacyFreq =
        recurrence.unit === 'week' && recurrence.count === 1 ? 'weekly'
        : recurrence.unit === 'week' && recurrence.count === 2 ? 'biweekly'
        : recurrence.unit === 'month' && recurrence.count === 1 ? 'monthly'
        : null
      const { data: rec, error: recError } = await supabase
        .from('job_recurrences')
        .insert({
          user_id: user!.id,
          freq: legacyFreq,
          interval_unit: recurrence.unit,
          interval_count: recurrence.count,
          start_date: values.scheduled_date,
          end_date: recurrence.endDate,
          end_count: recurrence.endCount,
          customer_id: values.customer_id || null,
        })
        .select()
        .single()
      if (recError || !rec) { setBanner('Could not save the recurrence: ' + (recError?.message ?? 'unknown error')); return }
      // The FIRST visit is the explicit initial visit (is_initial_visit). For a
      // quote-linked series both prices DERIVE from the quote — the initial visit
      // reads the quote's initial price ($150), recurring visits the cadence price
      // ($65) — so neither is a stamped value the other can overwrite. A typed
      // override applies to the initial visit only. Non-quote series carry the
      // typed per-visit price on every visit.
      const typed = Number(values.price) > 0 ? Number(values.price) : null
      const rows = dates.map((d: string, i: number) => ({
        ...base,
        is_initial_visit: i === 0,
        price: quoteCtx ? (i === 0 ? typed : null) : base.price,
        scheduled_date: d,
        recurrence_id: rec.id,
      }))
      const { error } = await supabase.from('jobs').insert(rows)
      if (error) {
        // Never leave an orphan recurrence with no visits.
        await supabase.from('job_recurrences').delete().eq('id', rec.id)
        setBanner('Could not save the recurring visits: ' + error.message)
        return
      }
      // Post-create verification — confirm future visits actually persisted.
      const { count } = await supabase.from('jobs').select('id', { count: 'exact', head: true })
        .eq('recurrence_id', rec.id).gt('scheduled_date', values.scheduled_date)
      if (!count || count < 1) {
        await supabase.from('job_recurrences').delete().eq('id', rec.id)
        await supabase.from('jobs').delete().eq('recurrence_id', rec.id)
        setBanner('The recurring schedule could not be created (no future visits saved) — nothing was scheduled. Please try again.')
        return
      }
    }

    if (quoteCtx && quoteCtx.status === 'accepted') {
      await supabase.from('quotes').update({ status: 'scheduled' }).eq('id', quoteCtx.id)
    }

    await fetchJobs()
    // Save & Add Another: keep the date, open a fresh form immediately.
    if (opts?.addAnother && !quoteCtx && !customerPrefill) {
      setFormDate(values.scheduled_date)
      setEditing(null)
      setShowForm(true)
      setFormSeq(s => s + 1)
      setBanner('Job added — add another.')
    } else {
      closeForm()
      setAutoOptimizeQueued({ anchorDate: values.scheduled_date }) // propose optimization around the new job
    }
  }

  // The propagating field set for a generated occurrence (no per-visit outcome).
  function occurrenceBase(values: JobFormValues, userId: string, recurrenceId: string, quoteId: string | null) {
    return {
      user_id: userId,
      customer_id: values.customer_id || null,
      property_id: values.property_id || null,
      quote_id: quoteId,
      title: values.title,
      service_type: values.service_type || null,
      start_time: values.start_time || null,
      end_time: values.end_time || null,
      duration_minutes: values.duration_minutes ? Number(values.duration_minutes) : null,
      crew_size: Number(values.crew_size) || 1,
      status: 'scheduled' as const,
      notes: values.notes || null,
      price: Number(values.price) > 0 ? Number(values.price) : null,
      recurrence_id: recurrenceId,
      is_initial_visit: false, // generated future visits are never the anchor
    }
  }

  // Apply field edits (+ per-visit outcome on the anchor, + date shift) across a
  // recurrence scope. Writes only — the orchestrator handles refresh.
  async function applyFieldEdits(job: Job, values: JobFormValues, scope: RecurrenceScope) {
    const fields = {
      customer_id: values.customer_id || null,
      property_id: values.property_id || null,
      title: values.title,
      service_type: values.service_type || null,
      start_time: values.start_time || null,
      end_time: values.end_time || null,
      duration_minutes: values.duration_minutes ? Number(values.duration_minutes) : null,
      crew_size: Number(values.crew_size) || 1,
      notes: values.notes || null,
      price: Number(values.price) > 0 ? Number(values.price) : null,
    }
    // Status and actual time belong ONLY to the edited visit, never its siblings.
    const perVisit = {
      status: values.status,
      actual_minutes: values.actual_minutes ? Number(values.actual_minutes) : null,
    }
    const targets = jobsInScope(job, jobs, scope)
    const delta = dayDelta(job.scheduled_date, values.scheduled_date)
    const results = await Promise.all(targets.map(t => supabase.from('jobs').update({
      ...fields,
      ...(t.id === job.id ? perVisit : {}),
      scheduled_date: scope === 'this' ? values.scheduled_date : shiftDate(t.scheduled_date, delta),
    }).eq('id', t.id)))
    const failed = results.find(r => r.error)
    if (failed?.error) setBanner('Could not save the job: ' + failed.error.message)

    if (values.status === 'completed' && job.status !== 'completed') {
      const res = await createDraftInvoiceForCompletedJob(supabase, { ...job, status: 'completed' })
      if (res.created) setBanner(`Draft invoice ${res.invoiceNumber} created from the completed job — review it in Invoices.`)
      else if (res.reason === 'exists') setBanner('That job already has an invoice.')
      else if (res.reason === 'no-amount') setBanner('Done — no invoice drafted because this job has no price. Set a price to bill it.')
    }

    // A price edit here must flow into the SAME linked draft invoice(s) — never a
    // second draft, never a stale amount. Sent/paid/cancelled invoices are locked
    // (the sync engine only touches drafts); scope-wide edits sync every visit.
    if (Number(values.price) !== Number(job.price)) {
      const { changed, failed } = await syncDraftInvoiceAmounts(supabase, targets.map(t => t.id))
      if (failed > 0) setBanner(`Saved the new price, but ${failed} draft invoice${failed !== 1 ? 's' : ''} still show${failed === 1 ? 's' : ''} the old amount — open the invoice to re-price it.`)
      else if (changed > 0) setBanner(`Saved — ${changed} draft invoice${changed !== 1 ? 's' : ''} updated to match the new price.`)
    }
  }

  // Turn a one-time job into a recurring series — the current job stays as the
  // first visit; future visits are generated. No scope prompt (it's one job).
  async function convertToRecurring(job: Job, values: JobFormValues, recurrence: Recurrence) {
    if (!recurrence.unit) return
    const { data: { user } } = await supabase.auth.getUser()
    // Validate BEFORE creating anything — refuse a series with no future visits.
    const dates = generateOccurrences(values.scheduled_date, recurrence.unit, recurrence.count, recurrence.endDate, recurrence.endCount)
    const future = dates.slice(1).filter(d => d >= localToday()) // skip the anchor — it already exists
    if (future.length === 0) {
      setBanner('No recurring visits would be generated — check the cadence and end date. This job stays one-time.')
      return
    }
    const { data: rec, error: recErr } = await supabase.from('job_recurrences').insert({
      user_id: user!.id,
      freq: legacyFreqFor(recurrence.unit, recurrence.count),
      interval_unit: recurrence.unit,
      interval_count: recurrence.count,
      start_date: values.scheduled_date,
      end_date: recurrence.endDate,
      end_count: recurrence.endCount,
      customer_id: values.customer_id || null,
    }).select().single()
    if (recErr || !rec) { setBanner('Could not create the recurring series: ' + (recErr?.message ?? '')); return }

    await applyFieldEdits(job, values, 'this')
    // The existing one-time job becomes the series ANCHOR (initial visit).
    await supabase.from('jobs').update({ recurrence_id: rec.id, is_initial_visit: true }).eq('id', job.id)

    const base = occurrenceBase(values, user!.id, rec.id, job.quote_id)
    // Quote-linked future visits derive the cadence price (price null).
    const { error } = await supabase.from('jobs').insert(future.map(d => ({ ...base, scheduled_date: d, price: job.quote_id ? null : base.price })))
    if (error) {
      // Roll back so we never leave a series with only its anchor.
      await supabase.from('jobs').update({ recurrence_id: null }).eq('id', job.id)
      await supabase.from('job_recurrences').delete().eq('id', rec.id)
      setBanner('Could not add the future visits — kept the job as one-time. ' + error.message)
      return
    }
    setBanner(`Now recurring — ${recurrenceLabel(recurrence.unit, recurrence.count)}. ${future.length} future visit${future.length !== 1 ? 's' : ''} added.`)
  }

  // Detach/delete recurrence per scope, turning the anchor into a one-time job.
  async function removeRecurrence(job: Job, scope: RecurrenceScope) {
    if (!job.recurrence_id) return
    if (scope === 'this') {
      await supabase.from('jobs').update({ recurrence_id: null }).eq('id', job.id)
      setBanner('This visit is now a one-time job.')
      return
    }
    if (scope === 'future') {
      const laterIds = jobs.filter(j => j.recurrence_id === job.recurrence_id && j.scheduled_date > job.scheduled_date).map(j => j.id)
      if (laterIds.length) await supabase.from('jobs').delete().in('id', laterIds)
      await supabase.from('jobs').update({ recurrence_id: null }).eq('id', job.id)
      setBanner(`Recurrence ended — ${laterIds.length} future visit${laterIds.length !== 1 ? 's' : ''} removed.`)
      return
    }
    const siblingIds = jobs.filter(j => j.recurrence_id === job.recurrence_id && j.id !== job.id).map(j => j.id)
    if (siblingIds.length) await supabase.from('jobs').delete().in('id', siblingIds)
    await supabase.from('jobs').update({ recurrence_id: null }).eq('id', job.id)
    await supabase.from('job_recurrences').delete().eq('id', job.recurrence_id)
    setBanner('Recurrence removed — this is now a one-time job.')
  }

  // Change the cadence/end of an existing series: keep past visits, regenerate
  // forward from the anchor with the new rule.
  async function changeRecurrence(job: Job, values: JobFormValues, recurrence: Recurrence) {
    if (!job.recurrence_id || !recurrence.unit) return
    const { data: { user } } = await supabase.auth.getUser()
    // Validate the NEW cadence first — never delete the existing future visits
    // for a rule that wouldn't regenerate any.
    const dates = generateOccurrences(values.scheduled_date, recurrence.unit, recurrence.count, recurrence.endDate, recurrence.endCount)
    const future = dates.slice(1).filter(d => d >= localToday())
    if (future.length === 0) {
      setBanner('That cadence/end date would leave no future visits — the existing schedule was kept unchanged.')
      return
    }
    const futureIds = jobs
      .filter(j => j.recurrence_id === job.recurrence_id && j.id !== job.id && j.scheduled_date > job.scheduled_date)
      .map(j => j.id)
    if (futureIds.length) await supabase.from('jobs').delete().in('id', futureIds)
    await supabase.from('job_recurrences').update({
      freq: legacyFreqFor(recurrence.unit, recurrence.count),
      interval_unit: recurrence.unit,
      interval_count: recurrence.count,
      end_date: recurrence.endDate,
      end_count: recurrence.endCount,
    }).eq('id', job.recurrence_id)
    const base = occurrenceBase(values, user!.id, job.recurrence_id, job.quote_id)
    await supabase.from('jobs').insert(future.map(d => ({ ...base, scheduled_date: d, price: job.quote_id ? null : base.price })))
    setBanner(`Schedule updated to ${recurrenceLabel(recurrence.unit, recurrence.count)}. ${future.length} future visit${future.length !== 1 ? 's' : ''}.`)
  }

  // Orchestrator for an edit on a recurring job (or a one-time → one-time edit):
  // field edits + any add/change/remove of recurrence, scoped Apple-style.
  async function applyEdit(job: Job, values: JobFormValues, recurrence: Recurrence, scope: RecurrenceScope) {
    const was = !!job.recurrence_id
    const will = recurrence.unit !== null
    const existing = was && job.recurrence_id ? recurrences[job.recurrence_id] : undefined
    const existingRec = existing ? recFromRow(existing) : null
    const ruleChanged = !!(will && existingRec && (
      existingRec.unit !== recurrence.unit ||
      existingRec.count !== recurrence.count ||
      (existingRec.endDate || null) !== (recurrence.endDate || null) ||
      (existingRec.endCount || null) !== (recurrence.endCount || null)
    ))

    if (!was || (will && !ruleChanged)) {
      await applyFieldEdits(job, values, scope)
    } else if (!will) {
      await applyFieldEdits(job, values, 'this')
      await removeRecurrence(job, scope)
    } else {
      await applyFieldEdits(job, values, 'this')
      await changeRecurrence(job, values, recurrence)
    }
    await fetchJobs()
    setEditing(null)
  }

  async function applyMove(job: Job, newDate: string, scope: RecurrenceScope) {
    const delta = dayDelta(job.scheduled_date, newDate)
    const targets = jobsInScope(job, jobs, scope)
    const prev = targets.map(t => ({ id: t.id, scheduled_date: t.scheduled_date, route_order: t.route_order ?? null }))
    // fetchJobs() below re-reads from the server, so the CALENDAR self-heals on failure —
    // but the toast doesn't: it claimed "Moved 12 visits" and offered an Undo for a no-op.
    // The single-job path (proceedMoveJobToDate) already checks this; same gesture, so the
    // recurring path must too, or the owner closes the laptop believing the season moved.
    const res = await Promise.all(targets.map(t =>
      supabase.from('jobs').update({ scheduled_date: shiftDate(t.scheduled_date, delta) }).eq('id', t.id)
    ))
    await fetchJobs()
    if (res.some(r => r.error)) { setBanner('Could not move these visits — the schedule is unchanged.'); return }
    offerUndo(`Moved ${targets.length} visit${targets.length !== 1 ? 's' : ''}`, async () => {
      // Restore dates AND manual route positions (the trigger nulled them on the
      // way out; it keeps an explicitly-set route_order in the same update).
      const undoRes = await Promise.all(prev.map(p => supabase.from('jobs').update({ scheduled_date: p.scheduled_date, route_order: p.route_order }).eq('id', p.id)))
      await fetchJobs()
      if (undoRes.some(r => r.error)) setBanner('Could not undo the move — check the affected days.')
    })
  }

  async function applyDelete(job: Job, scope: RecurrenceScope) {
    const targets = jobsInScope(job, jobs, scope)
    const snapshot = targets.map(jobInsertRow)
    const addons = addonInsertRows(targets.map(t => t.id))
    // Snapshot invoice links (FK sets job_id NULL on delete) so undo re-stamps them.
    const invTargets = targets.filter(t => invoicedJobIds.has(t.id)).map(t => t.id)
    const linkedInv = invTargets.length
      ? (((await supabase.from('invoices').select('id, job_id').in('job_id', invTargets)).data as { id: string; job_id: string }[] | null) ?? [])
      : []
    const r = (scope === 'all' && job.recurrence_id) ? recurrences[job.recurrence_id] : null
    const recRow = r ? {
      id: r.id, user_id: r.user_id, freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count,
      start_date: r.start_date, end_date: r.end_date, end_count: r.end_count, customer_id: r.customer_id,
    } : null
    const { error: delErr } = await supabase.from('jobs').delete().in('id', targets.map(t => t.id))
    if (delErr) { setBanner('Could not delete these visits — the schedule is unchanged.'); return }
    if (recRow) await supabase.from('job_recurrences').delete().eq('id', job.recurrence_id)
    await fetchJobs()
    setEditing(null)
    offerUndo(`Deleted ${targets.length} visit${targets.length !== 1 ? 's' : ''}`, async () => {
      // A partial restore is worse than none: jobs without their priced add-ons, or
      // invoices left unlinked, silently under-bill. Report it rather than let the toast
      // dismiss as though the visits came back whole.
      const res: { error: unknown }[] = []
      if (recRow) res.push(await supabase.from('job_recurrences').insert(recRow))
      if (snapshot.length) res.push(await supabase.from('jobs').insert(snapshot))
      if (addons.length) res.push(await supabase.from('job_line_items').insert(addons))
      for (const inv of linkedInv) res.push(await supabase.from('invoices').update({ job_id: inv.job_id }).eq('id', inv.id))
      await fetchJobs()
      if (res.some(r => r.error)) setBanner('Could not fully restore these visits — check the day and re-add anything missing.')
    })
  }

  async function handleEdit(values: JobFormValues, recurrence: Recurrence) {
    if (!editing) return
    const was = !!editing.recurrence_id
    const will = recurrence.unit !== null
    if (!was && !will) {
      // One-time edit, stays one-time — no scope prompt.
      await applyEdit(editing, values, recurrence, 'this')
      return
    }
    if (!was && will) {
      // One-time → recurring — no scope prompt (it's a single job).
      await convertToRecurring(editing, values, recurrence)
      await fetchJobs()
      setEditing(null)
      return
    }
    // Editing an existing recurring job → choose which visits this affects.
    setPendingAction({ type: 'edit', job: editing, values, recurrence })
  }

  // Shared delete — used by the form's trash button AND the Day panel's Delete
  // button. One-time jobs delete in one tap (with Undo); recurring jobs open the
  // Apple-style scope dialog (this / future / all), which routes to applyDelete.
  async function deleteJob(job: Job) {
    if (job.recurrence_id) {
      setPendingAction({ type: 'delete', job })
      return
    }
    const row = jobInsertRow(job)
    const addons = addonInsertRows([job.id])
    // Deleting sets invoices.job_id NULL (FK) — snapshot the links so undo can
    // re-stamp them, or the visit stops counting as invoiced (double-invoice risk).
    const linkedInvoices = invoicedJobIds.has(job.id)
      ? (((await supabase.from('invoices').select('id').eq('job_id', job.id)).data as { id: string }[] | null) ?? [])
      : []
    await supabase.from('jobs').delete().eq('id', job.id)
    await fetchJobs()
    setEditing(prev => (prev?.id === job.id ? null : prev))
    offerUndo('Job deleted', async () => {
      await supabase.from('jobs').insert(row) // job first — FKs point at it
      if (addons.length) await supabase.from('job_line_items').insert(addons)
      if (linkedInvoices.length) await supabase.from('invoices').update({ job_id: job.id }).in('id', linkedInvoices.map(i => i.id))
    })
  }

  async function handleDelete() {
    if (editing) await deleteJob(editing)
  }

  // ▶ Check in: stamps arrival/start, status becomes In Progress.
  // Queued when there's no signal — checking in is the single most common field
  // tap and it happens in exactly the places with the worst coverage. The row
  // flips locally either way, so the contractor is never blocked by a bar of LTE.
  async function startJob(job: Job) {
    const prev = { status: job.status, started_at: job.started_at }
    const now = new Date().toISOString()
    const patch = { status: 'in_progress' as const, started_at: now }
    let outcome: 'ran' | 'queued'
    try {
      outcome = await queueOrRun(
        { kind: 'job.update', payload: { id: job.id, patch }, label: `Start ${job.title || 'job'}` },
        async () => {
          const { error } = await supabase.from('jobs').update(patch).eq('id', job.id)
          if (error) throw new Error(error.message)
        },
      )
    } catch (e) {
      setBanner('Could not start the job: ' + (e instanceof Error ? e.message : 'please try again.'))
      return
    }
    // Paint the new state immediately; a refetch would stall (or wipe it) offline.
    setJobs(prev2 => prev2.map(j => (j.id === job.id ? { ...j, ...patch } : j)))
    if (outcome === 'ran') await fetchJobs()
    offerUndo(outcome === 'queued' ? 'Job started — will sync' : 'Job started', async () => {
      setJobs(prev2 => prev2.map(j => (j.id === job.id ? { ...j, ...prev } : j)))
      await queueOrRun(
        { kind: 'job.update', payload: { id: job.id, patch: prev }, label: `Undo start ${job.title || 'job'}` },
        async () => { await supabase.from('jobs').update(prev).eq('id', job.id) },
      )
    })
  }

  // ✓ Check out: stamps completion, derives actual_minutes from check-in →
  // check-out (the ONE timing value every engine reads), drafts the invoice.
  // Also the calendar's one-tap Done (works without a check-in — no actual then).
  async function completeJob(job: Job) {
    const prev = { status: job.status, completed_at: job.completed_at, actual_minutes: job.actual_minutes }
    const now = new Date().toISOString()
    const actual = job.started_at ? minutesBetween(job.started_at, now) : job.actual_minutes
    const patch = { status: 'completed' as const, completed_at: now, actual_minutes: actual }
    const completed = { ...job, ...patch }
    const notify = !!(automations.job_complete && job.customer_id)
    let invoiceCreated = false

    // Completing is patch + draft invoice + courtesy text. Offline, all three
    // queue together as ONE op (kind 'job.complete') so reconnecting can never
    // leave a finished job un-billed. Online this runs exactly as it always did.
    let outcome: 'ran' | 'queued'
    try {
      outcome = await queueOrRun(
        { kind: 'job.complete', payload: { id: job.id, patch, job: completed, notify }, label: `Complete ${job.title || 'job'}` },
        async () => {
          const { error } = await supabase.from('jobs').update(patch).eq('id', job.id)
          if (error) throw new Error(error.message)
          const res = await createDraftInvoiceForCompletedJob(supabase, completed)
          if (res.created) { invoiceCreated = true; setBanner(`Draft invoice ${res.invoiceNumber} created. Review in Invoices.`) }
          else if (res.reason === 'no-amount') setBanner('Done — no invoice drafted because this job has no price. Set a price to bill it.')
          // A failed draft used to say NOTHING, which is indistinguishable from the success
          // banner you scrolled past — the visit leaves the un-invoiced queue and the money
          // is never billed, with no trace pointing at it. ('exists' stays quiet: an invoice
          // does exist, so nothing is misclaimed.)
          else if (res.reason === 'error') setBanner('Job completed, but the draft invoice could not be created — invoice it manually from the job.')
          // Automated job-complete message (opt-in + dedupe are enforced by the route).
          if (notify) {
            fetch('/api/comms/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId: job.customer_id, template: 'job_complete', jobId: job.id, dedupe: true }) }).catch(() => {})
          }
        },
      )
    } catch (e) {
      setBanner('Could not complete the job: ' + (e instanceof Error ? e.message : 'please try again.'))
      return
    }
    setJobs(prev2 => prev2.map(j => (j.id === job.id ? { ...j, ...patch } : j)))
    if (outcome === 'queued') setBanner('Completed offline — it’ll sync and draft the invoice when you’re back in signal.')
    if (outcome === 'ran') await fetchJobs()
    offerUndo(outcome === 'queued' ? 'Job completed — will sync' : 'Job completed', async () => {
      setJobs(prev2 => prev2.map(j => (j.id === job.id ? { ...j, ...prev } : j)))
      await queueOrRun(
        { kind: 'job.update', payload: { id: job.id, patch: prev }, label: `Undo complete ${job.title || 'job'}` },
        async () => {
          await supabase.from('jobs').update(prev).eq('id', job.id)
          if (invoiceCreated) await supabase.from('invoices').delete().eq('job_id', job.id).eq('status', 'draft')
        },
      )
    })
  }

  // Inline quick-edit from the day panel — small per-visit changes, no full form.
  async function quickSaveJob(job: Job, patch: QuickPatch) {
    const { error } = await supabase.from('jobs').update({
      start_time: patch.start_time,
      crew_size: patch.crew_size,
      duration_minutes: patch.duration_minutes,
      status: patch.status,
      notes: patch.notes,
      price: patch.price,
    }).eq('id', job.id)
    if (error) { setBanner('Could not save the job: ' + error.message); return }
    if (patch.status === 'completed' && job.status !== 'completed') {
      const res = await createDraftInvoiceForCompletedJob(supabase, { ...job, status: 'completed' })
      if (res.created) setBanner(`Saved — draft invoice ${res.invoiceNumber} created.`)
      else if (res.reason === 'no-amount') setBanner('Done — no invoice drafted because this job has no price. Set a price to bill it.')
      // The quick-edit dropdown completes a job through the same transition as the Complete
      // button, which DOES report this (completeJob below). Without it a failed draft leaves
      // the visit out of the un-invoiced queue and it is never billed, with no trace.
      else if (res.reason === 'error') setBanner('Job completed, but the draft invoice could not be created — invoice it manually from the job.')
    }
    // If the inline edit changed the price, keep its draft invoice in sync.
    if (Number(patch.price) !== Number(job.price)) {
      const { failed } = await syncDraftInvoiceAmounts(supabase, [job.id])
      if (failed > 0) setBanner('Saved, but its draft invoice still shows the old amount — open the invoice to re-price it.')
    }
    await fetchJobs()
  }

  // First-class price edit from the Day panel.
  //  • One-time job → update its price directly.
  //  • Recurring job → choose scope (This / This & Future / All), then apply with
  //    the quote cadence price as the single source of truth (see applyPriceChange).
  async function setJobPrice(job: Job, price: number | null, reason?: string) {
    if (job.recurrence_id) {
      setPendingAction({ type: 'price', job, price, reason })
      return
    }
    const oldAmount = valueByJobId[job.id] ?? null
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('jobs').update({ price }).eq('id', job.id)
    if (error) { setBanner('Could not update price: ' + error.message); return }
    // Audit trail (old → new, reason on raises) for upsell analytics later.
    await recordPriceChange(supabase, { userId: user!.id, jobId: job.id, scope: null, oldAmount, newAmount: price, reason, changedByEmail: user?.email })
    // The job is the source of truth — re-price its draft invoice automatically.
    const { changed, failed } = await syncDraftInvoiceAmounts(supabase, [job.id], { reason })
    await fetchJobs()
    if (failed > 0) setBanner('Price updated, but its draft invoice still shows the old amount — open the invoice to re-price it.')
    else if (changed > 0) setBanner('Price updated — its draft invoice was re-priced to match.')
  }

  // The quote cadence column a recurring job's price maps to (interval-aware).
  function cadenceField(job: Job): 'weekly_price' | 'biweekly_price' | 'monthly_price' | null {
    const rec = job.recurrence_id ? recurrences[job.recurrence_id] : null
    const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
    return freq === 'weekly' ? 'weekly_price' : freq === 'biweekly' ? 'biweekly_price' : freq === 'monthly' ? 'monthly_price' : null
  }

  // Apply a recurring price change with the quote as the SINGLE SOURCE OF TRUTH.
  // When the series is linked to a quote, the recurring price is written to the
  // quote's cadence column and the affected visits are cleared so they DERIVE it
  // (never a divergent jobs.price). Already-billed/past visits are frozen at their
  // current value so history and issued invoices are preserved.
  async function applyPriceChange(job: Job, newPrice: number | null, scope: RecurrenceScope, reason?: string) {
    const rec = job.recurrence_id ? recurrences[job.recurrence_id] : null
    const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
    const field = cadenceField(job)
    const quote = job.quote_id ? quotesById[job.quote_id] : null
    const writesQuote = !!(job.quote_id && field && newPrice != null && (scope === 'future' || scope === 'all'))
    const series = jobs.filter(j => j.recurrence_id === job.recurrence_id)
    const affectedIds = jobsInScope(job, jobs, scope).map(t => t.id)

    // Undo snapshot — every series job's price + the quote cadence value.
    const jobSnap = series.map(j => ({ id: j.id, price: j.price }))
    let quoteSnap: { id: string; field: string; value: number | null } | null = null

    if (newPrice == null) {
      // Revert: clear overrides on the scoped visits → they derive the quote again.
      const ids = jobsInScope(job, jobs, scope).map(t => t.id)
      if (ids.length) await supabase.from('jobs').update({ price: null }).in('id', ids)
    } else if (writesQuote) {
      const q = quote as unknown as Record<string, unknown>
      quoteSnap = { id: job.quote_id!, field: field!, value: Number(q[field!]) || null }
      const oldVal = Math.round(quoteVisitAmount(q, freq))
      // The initial (anchor) visit is NEVER touched by a recurring-price change —
      // it derives the quote's initial price independently of the cadence price.
      const freezeIds = scope === 'all'
        ? series.filter(j => !j.is_initial_visit && j.status === 'completed' && j.price == null).map(j => j.id)        // protect billed history
        : series.filter(j => !j.is_initial_visit && j.scheduled_date < job.scheduled_date && j.price == null).map(j => j.id) // past stays put
      const clearIds = scope === 'all'
        ? series.filter(j => !j.is_initial_visit && j.status !== 'completed').map(j => j.id)
        : series.filter(j => !j.is_initial_visit && j.scheduled_date >= job.scheduled_date).map(j => j.id)
      if (freezeIds.length && oldVal > 0) await supabase.from('jobs').update({ price: oldVal }).in('id', freezeIds)
      await supabase.from('quotes').update({ [field!]: newPrice }).eq('id', job.quote_id)
      if (clearIds.length) await supabase.from('jobs').update({ price: null }).in('id', clearIds)
    } else {
      // No quote (or "This visit only") → the price lives on the scoped job(s).
      const ids = jobsInScope(job, jobs, scope).map(t => t.id)
      if (ids.length) await supabase.from('jobs').update({ price: newPrice }).in('id', ids)
    }

    // Audit trail for the recurring change (old → new, reason on raises).
    const oldAmount = Math.round(jobVisitValue(job.price, quote as unknown as Record<string, unknown>, freq, job.is_initial_visit))
    const { data: { user: cu } } = await supabase.auth.getUser()
    await recordPriceChange(supabase, { userId: cu!.id, jobId: job.id, quoteId: writesQuote ? job.quote_id : null, scope, oldAmount, newAmount: newPrice, reason, changedByEmail: cu?.email })

    // Job = source of truth → re-price the affected visits' draft invoices.
    const { changed, failed } = await syncDraftInvoiceAmounts(supabase, affectedIds, { reason })
    await fetchJobs()
    const dest = writesQuote ? `the quote's ${freq} price` : scope === 'this' ? 'this visit' : 'the series visits'
    // Only claim the re-price we verified; a failed one is called out, not rounded into the count.
    const invNote = failed > 0
      ? ` · ${failed} draft invoice${failed !== 1 ? 's' : ''} still show${failed === 1 ? 's' : ''} the old amount`
      : changed > 0 ? ` · ${changed} draft invoice${changed !== 1 ? 's' : ''} re-priced` : ''
    offerUndo(`Price saved to ${dest}${invNote}`, async () => {
      // Undo restores MONEY. Unchecked, a failed restore dismissed the toast and left the
      // new price in place with no error — the owner believes they reverted and they didn't.
      const restores: { error: unknown }[] = []
      if (quoteSnap) restores.push(await supabase.from('quotes').update({ [quoteSnap.field]: quoteSnap.value }).eq('id', quoteSnap.id))
      const nullIds = jobSnap.filter(s => s.price == null).map(s => s.id)
      if (nullIds.length) restores.push(await supabase.from('jobs').update({ price: null }).in('id', nullIds))
      for (const s of jobSnap.filter(s => s.price != null)) restores.push(await supabase.from('jobs').update({ price: s.price }).eq('id', s.id))
      const restore = await syncDraftInvoiceAmounts(supabase, affectedIds) // restore invoice amounts to match
      await fetchJobs()
      if (restores.some(r => r.error)) setBanner('Could not undo the price change — please set the price back manually.')
      else if (restore.failed > 0) setBanner('Price restored, but a draft invoice still shows the changed amount — open it to re-price.')
    })
  }

  // ── Visit add-ons (extra services) ──
  // Add an extra service to this visit / future / the whole plan, then keep the
  // affected draft invoices in sync (the JOB — base + add-ons — is the truth).
  async function addLineItemToJob(job: Job, input: { description: string; amount: number; serviceKey: string; scope: RecurrenceScope }) {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const targets = input.scope === 'this'
      ? [job.id]
      : jobsInScope(job, jobs, input.scope).filter(j => j.status !== 'completed' && j.status !== 'cancelled').map(j => j.id)
    const ids = targets.length ? targets : [job.id]
    await addLineItems(supabase, {
      userId: user.id, targetJobIds: ids,
      description: input.description, amount: input.amount, serviceKey: input.serviceKey,
      serviceType: job.service_type, recurring: input.scope !== 'this',
    })
    await syncDraftInvoiceAmounts(supabase, ids)
    await fetchJobs()
  }
  async function removeLineItem(item: JobLineItem) {
    // Snapshot BEFORE deleting: a grouped (plan-wide) add-on removes rows across
    // many visits, so Undo must restore the whole group, not just this row.
    let snapshot: JobLineItem[] = [item]
    if (item.group_id) {
      const { data } = await supabase.from('job_line_items').select('*').eq('group_id', item.group_id)
      if (data?.length) snapshot = data as JobLineItem[]
    }
    await deleteLineItem(supabase, item)
    const affectedJobs = [...new Set(snapshot.map(r => r.job_id))]
    await syncDraftInvoiceAmounts(supabase, affectedJobs)
    await fetchJobs()
    const scope = snapshot.length > 1 ? ` from ${snapshot.length} visits` : ''
    toast.undo(`Removed “${item.description}” ($${Number(item.amount).toFixed(2)})${scope}`, async () => {
      await supabase.from('job_line_items').insert(snapshot)
      await syncDraftInvoiceAmounts(supabase, affectedJobs)
      await fetchJobs()
    })
  }
  // The previous visit's add-ons (most recent earlier visit of the same series, or
  // same customer for one-offs, that had any). Drives the one-tap "copy previous".
  function getPreviousAddons(job: Job): { description: string; amount: number; serviceKey: string }[] {
    const prior = jobs
      .filter(j => j.id !== job.id && j.scheduled_date < job.scheduled_date && (addonsByJobId[j.id]?.length)
        && (job.recurrence_id ? j.recurrence_id === job.recurrence_id : !!job.customer_id && j.customer_id === job.customer_id))
      .sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date))
    const prev = prior[0]
    if (!prev) return []
    return (addonsByJobId[prev.id] || []).map(a => ({ description: a.description, amount: Number(a.amount), serviceKey: a.service_key || normalizeServiceKey(a.description) }))
  }
  // Copy the previous visit's add-ons onto THIS visit only (respects scope rules,
  // never auto-recurs); skips any the visit already has.
  async function copyPreviousAddons(job: Job) {
    const prev = getPreviousAddons(job)
    if (!prev.length) return
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const existing = new Set((addonsByJobId[job.id] || []).map(i => (i.service_key || i.description).toLowerCase()))
    for (const a of prev) {
      if (existing.has((a.serviceKey || a.description).toLowerCase())) continue
      await addLineItems(supabase, { userId: user.id, targetJobIds: [job.id], description: a.description, amount: a.amount, serviceKey: a.serviceKey, serviceType: job.service_type, recurring: false })
    }
    await syncDraftInvoiceAmounts(supabase, [job.id])
    await fetchJobs()
  }

  // ── Undo ────────────────────────────────────────────────────────────────────
  // THE shared undo toast — fixed to the viewport, so it's reachable no matter
  // how far down the day list the action happened.
  function offerUndo(label: string, run: () => Promise<void>) {
    toast.undo(label, async () => { await run(); await fetchJobs() })
  }
  // Insertable job row for delete-undo: the FULL row minus the two joined
  // relations. A hand-maintained column allowlist here silently amputated
  // resurrected jobs (lost started_at/completed_at/on_my_way_at/route_order and
  // would lose every future column); rest-spread can never drift because
  // fetchJobs selects '*' plus exactly these two joins.
  function jobInsertRow(j: Job) {
    const { customers, properties, ...row } = j
    void customers; void properties
    return row
  }

  // Insertable add-on rows for these visits, snapshotted from the already-loaded
  // cache (the ONE listLineItemsByJob engine) — job deletion CASCADE-deletes
  // job_line_items, so delete-undo must restore them or priced extras vanish.
  function addonInsertRows(ids: string[]): JobLineItem[] {
    return ids.flatMap(id => addonsByJobId[id] || [])
  }

  // Apply a batch of date moves (optimizer or rain delay): grouped by target
  // day, with one Undo that restores every original date.
  //
  // Returns an outcome — callers must be able to SEE a failure, not just have it
  // banner'd behind them. RainDelayCenter renders over this page and then texts every
  // affected customer their new date; if it can't observe the write failing it tells
  // customers about a reschedule that never persisted, which is unrecallable.
  async function applyOptimization(moves: Pick<PlannedMove, 'jobId' | 'from' | 'to'>[]): Promise<{ ok: boolean; error?: string }> {
    if (!moves.length) return { ok: true }
    const byTo: Record<string, string[]> = {}
    for (const m of moves) (byTo[m.to] ||= []).push(m.jobId)
    let failure: string | undefined
    for (const [to, ids] of Object.entries(byTo)) {
      const { error } = await supabase.from('jobs').update({ scheduled_date: to }).in('id', ids)
      if (error) { setBanner('Optimization partially applied — ' + error.message); failure = error.message; break }
    }
    await fetchJobs()
    if (failure) return { ok: false, error: failure }
    // Capture each moved job's manual route position so undo restores it (the
    // date-move trigger nulls route_order on the way out).
    const prevOrder = new Map(moves.map(m => [m.jobId, jobs.find(j => j.id === m.jobId)?.route_order ?? null]))
    const byFrom: Record<string, string[]> = {}
    for (const m of moves) (byFrom[m.from] ||= []).push(m.jobId)
    offerUndo(`${moves.length} job${moves.length !== 1 ? 's' : ''} moved`, async () => {
      const res: { error: unknown }[] = []
      for (const [from, ids] of Object.entries(byFrom)) {
        res.push(...await Promise.all(ids.map(id => supabase.from('jobs').update({ scheduled_date: from, route_order: prevOrder.get(id) ?? null }).eq('id', id))))
      }
      await fetchJobs()
      if (res.some(r => r.error)) setBanner('Could not undo every move — check the affected days.')
    })
    return { ok: true }
  }

  // Next date on/after `fromISO`+1 whose weekday is a preferred work day AND
  // that isn't blocked (rain/holiday/vacation…) — a rain delay must never bump
  // the day's jobs onto another day that's already marked unavailable.
  function nextWorkday(fromISO: string): string {
    const pref = preferredWorkDays.length ? new Set(preferredWorkDays) : null
    let d = addDays(parseISO(fromISO), 1)
    for (let i = 0; i < 21; i++) {
      const iso = format(d, 'yyyy-MM-dd')
      if ((!pref || pref.has(getDay(d))) && !isDayBlocked(dayStatusMap, iso)) return iso
      d = addDays(d, 1)
    }
    return format(addDays(parseISO(fromISO), 1), 'yyyy-MM-dd')
  }

  // Rain delay: bump every remaining (not done/cancelled) job on a day to the next
  // work day, in one tap, with Undo. Reuses the move primitive over the day's set.
  async function rainDelayDay(dateISO: string) {
    const dayJobs = jobs.filter(j => j.scheduled_date === dateISO && j.status !== 'cancelled' && j.status !== 'completed')
    if (!dayJobs.length) { setBanner('No jobs to bump on this day.'); return }
    const to = nextWorkday(dateISO)
    const ids = dayJobs.map(j => j.id)
    const prevOrders = dayJobs.map(j => ({ id: j.id, route_order: j.route_order ?? null }))
    // What the target day will look like AFTER the bump. nextWorkday already skips
    // blocked days, but it can't know the day is already full — landing 6 stops on a
    // booked day silently creates an overloaded day. Same shared engine as the
    // calendar bar + day board, so the hours quoted here match what you'll see there.
    const landing = estimateDayLoad(
      [...jobs.filter(j => j.scheduled_date === to && j.status !== 'cancelled'), ...dayJobs],
      optBaseOpts.capacityForDate(to),
    )
    const { error } = await supabase.from('jobs').update({ scheduled_date: to }).in('id', ids)
    if (error) { setBanner('Could not bump the day: ' + error.message); return }
    await fetchJobs()
    setCursor(parseISO(to + 'T00:00:00'))
    if (landing.state === 'overloaded') {
      toast(`${format(parseISO(to + 'T00:00:00'), 'EEE, MMM d')} is now overbooked by ~${Math.round(-landing.spareMin / 6) / 10}h — optimize or move a stop.`)
    }
    offerUndo(`Rain delay — bumped ${ids.length} job${ids.length !== 1 ? 's' : ''} to ${format(parseISO(to + 'T00:00:00'), 'EEE, MMM d')}`,
      async () => {
        // Per-job so each visit gets back its own manual route position.
        await Promise.all(prevOrders.map(p => supabase.from('jobs').update({ scheduled_date: dateISO, route_order: p.route_order }).eq('id', p.id)))
      })
  }

  async function moveJobToDate(job: Job, date: Date) {
    const newDate = format(date, 'yyyy-MM-dd')
    if (newDate === job.scheduled_date) return
    // Soft guard: warn (don't block) when a hand move breaks the customer's
    // cadence or a stated scheduling preference. Confirm, then proceed.
    const warnings = moveWarnings(job, newDate)
    if (warnings.length) { setMoveConfirm({ job, newDate, warnings }); return }
    await proceedMoveJobToDate(job, newDate)
  }

  async function proceedMoveJobToDate(job: Job, newDate: string) {
    if (job.recurrence_id) {
      setPendingAction({ type: 'move', job, newDate })
      return
    }
    const prevDate = job.scheduled_date
    const prevOrder = job.route_order ?? null
    // Optimistic patch mirrors the DB trigger: a date move clears the manual
    // route position, so the target day's order is correct without a refetch.
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, scheduled_date: newDate, route_order: null } : j))
    const { error } = await supabase.from('jobs').update({ scheduled_date: newDate }).eq('id', job.id)
    if (error) {
      setJobs(prev => prev.map(j => j.id === job.id ? { ...j, scheduled_date: prevDate, route_order: prevOrder } : j))
      setBanner('Could not move the job: ' + error.message)
      return
    }
    offerUndo('Job moved', async () => {
      // Restore the date AND the manual route position (the trigger keeps an
      // explicitly-set route_order when it changes in the same update).
      await supabase.from('jobs').update({ scheduled_date: prevDate, route_order: prevOrder }).eq('id', job.id)
    })
  }

  async function handleScopeChoice(scope: RecurrenceScope) {
    const action = pendingAction
    setPendingAction(null)
    if (!action) return
    if (action.type === 'edit') await applyEdit(action.job, action.values, action.recurrence, scope)
    else if (action.type === 'move') await applyMove(action.job, action.newDate, scope)
    else if (action.type === 'delete') await applyDelete(action.job, scope)
    else if (action.type === 'price') await applyPriceChange(action.job, action.price, scope, action.reason)
  }

  function handleDayTap(day: Date) {
    // In month/week, tapping a day EXPANDS it (shows all its jobs) instead of
    // jumping straight to a new-job form. In day view, tapping adds a job.
    if (view === 'day') {
      openNewJob(day)
    } else {
      setCursor(day)
      setView('day')
    }
  }

  function handleJobTap(job: Job) {
    setEditing(job)
    setShowForm(false)
  }

  function navigate(dir: 1 | -1) {
    if (view === 'month') setCursor(c => dir === 1 ? addMonths(c, 1) : subMonths(c, 1))
    else if (view === 'week') setCursor(c => dir === 1 ? addWeeks(c, 1) : subWeeks(c, 1))
    else setCursor(c => dir === 1 ? addDays(c, 1) : subDays(c, 1))
  }

  function openNewJob(date: Date) {
    setEditing(null)
    setFormDate(format(date, 'yyyy-MM-dd'))
    setShowForm(true)
  }

  // Day view leads with the WEEKDAY — it's the datum you're paging by.
  const headingLabel =
    view === 'month' ? format(cursor, 'MMMM yyyy')
    : view === 'week' ? `Week of ${format(cursor, 'MMM d, yyyy')}`
    : format(cursor, 'EEEE, MMM d, yyyy')

  const viewButtons: CalendarView[] = ['month', 'week', 'day']

  const pendingVerb = pendingAction?.type === 'delete' ? 'Delete'
    : pendingAction?.type === 'move' ? 'Move'
    : pendingAction?.type === 'price' ? 'Update price for' : 'Save changes to'

  // THE next stop for the field bar: whatever you're on now, else the first one
  // still to do — in the same route order the cards are listed in, so the bar and
  // the board can never disagree about what's next. Undefined once the day's done,
  // which is what hides the bar.
  const fieldNext = useMemo(() => {
    const dayISO = format(cursor, 'yyyy-MM-dd')
    const open = jobs
      .filter(j => j.scheduled_date === dayISO && (j.status === 'in_progress' || j.status === 'scheduled'))
      .sort((a, b) => {
        const oa = a.route_order ?? 999, ob = b.route_order ?? 999
        if (oa !== ob) return oa - ob
        return (a.start_time || '').localeCompare(b.start_time || '')
      })
    return open.find(j => j.status === 'in_progress') ?? open[0]
  }, [jobs, cursor])

  return (
    // Reserve the field bar's height on phones so the last job card can still be
    // scrolled clear of it — a fixed bar is out of flow and would sit on top of it.
    <div className={cn('max-w-6xl mx-auto space-y-6', view === 'day' && fieldNext && 'pb-24 lg:pb-0')}>
      <PageHeader
        title="Schedule"
        description={`${jobs.length} job${jobs.length !== 1 ? 's' : ''} on the calendar`}
        action={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setShowRainCenter(true)} title="Weather Operations — move jobs (rain, equipment, absence, holiday, emergency) and notify customers">
              <CloudRain className="w-4 h-4" /> Weather Ops
            </Button>
            <Button variant="secondary" onClick={() => launchOptimizer()} title="Optimize your schedule — pick scope and goal">
              <Rocket className="w-4 h-4" /> Optimize
            </Button>
            <Button onClick={() => openNewJob(cursor)}>
              <Plus className="w-4 h-4" /> Add Job
            </Button>
          </div>
        }
      />

      {/* Weather + rain-risk strip — taps through to Weather Ops; hides on a clear week */}
      <WeatherStrip />

      {quoteCtx && (
        <div className="text-sm text-accent-text bg-accent/10 border border-accent/20 rounded-xl px-4 py-2.5">
          Scheduling from accepted quote <span className="font-semibold">{quoteCtx.quote_number}</span> — pick a date and set recurrence below.
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="secondary" size="sm" aria-label="Previous period" onClick={() => navigate(-1)}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setCursor(new Date())}>Today</Button>
          <Button variant="secondary" size="sm" aria-label="Next period" onClick={() => navigate(1)}>
            <ChevronRight className="w-4 h-4" />
          </Button>
          <span className="text-base font-bold tracking-tight text-ink ml-2">{headingLabel}</span>
        </div>
        <div className="flex items-center gap-1 bg-bg-secondary border border-border rounded-xl p-1">
          {viewButtons.map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={cn(
                'px-3 py-1.5 rounded-lg text-sm font-medium capitalize transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                view === v ? 'bg-accent text-black' : 'text-ink-muted hover:text-ink'
              )}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Schedule Health — catches mistakes before they reach Day Ops */}
      {!loading && (
        <ScheduleHealthCard
          issues={visibleHealthIssues}
          busyKey={healthBusyKey}
          onReview={reviewHealth}
          onDelete={deleteHealth}
          onMerge={mergeHealth}
          onIgnore={ignoreHealth}
        />
      )}

      {/* Proactive optimization suggestions — appear automatically */}
      {visibleSuggestions.length > 0 && (
        <div className="space-y-2">
          {visibleSuggestions.map(s => (
            <div key={s.id}
              className={cn('rounded-xl border p-3 flex items-start gap-3',
                s.kind === 'stuck' ? 'border-border bg-bg-tertiary'
                  : s.severity === 'high' ? 'border-amber-500/40 bg-amber-500/10'
                  : 'border-accent/25 bg-accent/5')}>
              {s.kind === 'overload'
                ? <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                : s.kind === 'stuck'
                  ? <Info className="w-4 h-4 text-ink-muted shrink-0 mt-0.5" />
                  : s.kind === 'recurring'
                    ? <Repeat className="w-4 h-4 text-accent-text shrink-0 mt-0.5" />
                    : <Lightbulb className="w-4 h-4 text-accent-text shrink-0 mt-0.5" />}
              <div className="min-w-0 flex-1">
                <p className={cn('text-sm font-semibold', s.kind === 'stuck' ? 'text-ink' : s.severity === 'high' ? 'text-amber-300' : 'text-ink')}>{s.title}</p>
                <p className="text-xs text-ink-muted mt-0.5">{s.detail}</p>

                {/* Per-job dispatcher breakdown + closest legal moves (stuck days) */}
                {s.kind === 'stuck' && s.diagnosis && (
                  <div className="mt-2 space-y-2">
                    {s.diagnosis.jobs.length > 0 && (
                      <ul className="space-y-1">
                        {s.diagnosis.jobs.map(j => (
                          <li key={j.jobId} className="text-xs text-ink-muted flex items-start gap-1.5">
                            <span className={cn('mt-1 w-1.5 h-1.5 rounded-full shrink-0', j.recurring ? 'bg-accent' : 'bg-ink-faint')} />
                            <span>{j.reason}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {s.diagnosis.alternatives.length > 0 && (
                      <div className="rounded-lg border border-border bg-bg-secondary px-2.5 py-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mb-1">Closest legal moves</p>
                        <ul className="space-y-0.5">
                          {s.diagnosis.alternatives.map(a => (
                            <li key={a.jobId} className="text-xs text-ink-muted">
                              Move <span className="text-ink font-medium">{a.customerName}</span> to {format(parseISO(a.date + 'T00:00:00'), 'EEE, MMM d')}
                              <span className="text-ink-faint"> — blocked by {MOVE_REASON_LABEL[a.reason]}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {s.actionable && (
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    {/* The CTA runs the EXACT scope/mode/anchor that was simulated to
                        produce the moves, so it can never come back "already optimized". */}
                    <Button size="sm" variant="secondary" onClick={() => launchOptimizer({ scope: s.scope, mode: s.mode, anchorDate: s.anchorDate })}>
                      <Rocket className="w-3.5 h-3.5" /> {s.kind === 'overload' ? (s.scope === 'month' ? 'Rebalance nearby weeks' : `Rebalance ${format(parseISO(s.anchorDate + 'T00:00:00'), 'EEE')}’s week`) : s.kind === 'underutil' ? 'Consolidate' : 'Optimize'}
                    </Button>
                  </div>
                )}
              </div>
              <button onClick={() => setDismissedSuggestions(prev => new Set(prev).add(s.id))}
                className="text-ink-faint hover:text-ink shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" title="Dismiss" aria-label="Dismiss suggestion">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Edit/New job — modal overlay so Open always brings the correct job into view */}
      {(showForm || editing) && (
        <div className="fixed inset-0 z-overlay overflow-y-auto bg-black/50" onClick={closeForm}>
          <div className="min-h-full flex items-start justify-center p-4 sm:p-6">
            <Card role="dialog" aria-modal="true" aria-labelledby="job-form-title" className="w-full max-w-2xl my-2 shadow-2xl" onClick={e => e.stopPropagation()}>
          <CardHeader className="flex items-center justify-between">
            <h2 id="job-form-title" className="text-sm font-semibold text-ink">{editing ? 'Edit Job' : 'New Job'}</h2>
            <div className="flex items-center gap-2">
              {editing && (
                <button onClick={handleDelete} className="text-red-400/70 hover:text-red-400 transition-colors" title="Delete job" aria-label="Delete job">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
              <button onClick={closeForm} className="text-ink-faint hover:text-ink transition-colors" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
          </CardHeader>
          <CardBody>
            {/* Every customer action in ONE row — no hunting through the form.
                Same link patterns as the day board (tel:/sms:/directionsUrl). */}
            {editing && (
              <div className="flex flex-wrap items-center gap-1.5 mb-4 pb-3 border-b border-border">
                {editing.customers?.phone && <QuickAction href={`tel:${editing.customers.phone}`} icon={Phone} label="Call" />}
                {editing.customers?.phone && <QuickAction href={`sms:${editing.customers.phone}`} icon={MessageSquare} label="Text" />}
                {(editing.properties?.address || editing.properties?.lat != null) && (
                  <QuickAction external icon={Navigation} label="Navigate"
                    href={directionsUrl({ lat: editing.properties?.lat ?? null, lng: editing.properties?.lng ?? null, address: editing.properties?.address }, baseCoord)} />
                )}
                {editing.customer_id && <QuickAction href={`/dashboard/customers/${editing.customer_id}`} icon={UserIcon} label="Customer" />}
                {editing.quote_id && <QuickAction href={`/dashboard/quotes/${editing.quote_id}`} icon={FileText} label="Quote" />}
                {editing.status === 'completed' && <QuickAction href="/dashboard/invoices" icon={Receipt} label="Invoice" />}
              </div>
            )}
            <JobForm
              key={editing?.id ?? `new-${formSeq}`}
              customers={customers}
              excludeJobId={editing?.id}
              allowAddAnother={!editing && !quoteCtx && !customerPrefill}
              initialRecurrence={editing?.recurrence_id && recurrences[editing.recurrence_id]
                ? recFromRow(recurrences[editing.recurrence_id])
                : (!editing ? quoteRecurrence : undefined)}
              defaultValues={editing ? {
                customer_id: editing.customer_id || '',
                property_id: editing.property_id || '',
                title: editing.title,
                service_type: editing.service_type || '',
                scheduled_date: editing.scheduled_date,
                start_time: editing.start_time || '',
                end_time: editing.end_time || '',
                duration_minutes: editing.duration_minutes || 60,
                crew_size: editing.crew_size,
                status: editing.status,
                notes: editing.notes || '',
                actual_minutes: editing.actual_minutes || 0,
                price: editing.price ?? 0,
              } : (quotePrefill ?? customerPrefill ?? { scheduled_date: formDate })}
              suggestedPrice={editing?.quote_id
                ? quoteVisitAmount(
                    quotesById[editing.quote_id] as unknown as Record<string, unknown>,
                    editing.recurrence_id && recurrences[editing.recurrence_id]
                      ? effectiveFreq(recurrences[editing.recurrence_id].freq, recurrences[editing.recurrence_id].interval_unit, recurrences[editing.recurrence_id].interval_count)
                      : null,
                  ) || undefined
                : undefined}
              onSubmit={editing ? handleEdit : handleAdd}
              onCancel={closeForm}
              isEdit={!!editing}
              warnFor={formMoveWarnings}
            />
          </CardBody>
            </Card>
          </div>
        </div>
      )}

      {(rainTarget || rainSummary) && (
        <WeatherRainCard
          date={rainSummary?.date ?? rainTarget!.date}
          jobsAffected={rainTarget?.jobs ?? 0}
          rainLabel={rainTarget?.recommendation.text ?? ''}
          revenue={rainTarget?.revenue ?? 0}
          busy={rainBusy === (rainSummary?.date ?? rainTarget?.date)}
          summary={rainSummary}
          onDisableAndOptimize={() => { if (rainTarget) rainDisableAndOptimize(rainTarget.date) }}
          onDisableOnly={() => { if (rainTarget) rainDisableOnly(rainTarget.date) }}
          onOptimizeOnly={() => { if (rainTarget) rainOptimizeOnly(rainTarget.date) }}
          onLater={() => { if (rainTarget) setDismissedRain(prev => new Set(prev).add(rainTarget.date)) }}
          onDismissSummary={() => setRainSummary(null)}
        />
      )}

      {loading ? (
        // Shimmer in the shape of the day view (settings bar + job rows) — the
        // shared skeleton language instead of a bare "Loading…" line.
        <div className="space-y-3">
          <Skeleton className="h-12 w-full rounded-card" />
          <SkeletonRows count={5} />
        </div>
      ) : view === 'day' ? (
        <>
        <DaySettingsBar
          date={format(cursor, 'yyyy-MM-dd')}
          jobs={jobs.filter(j => j.scheduled_date === format(cursor, 'yyyy-MM-dd'))}
          row={dayStatusMap?.byDate[format(cursor, 'yyyy-MM-dd')] ?? null}
          defaultCrew={defaultCrew}
          capacityHours={capacityHours}
          workStartTime={workStartTime}
          busy={rainBusy === format(cursor, 'yyyy-MM-dd')}
          onSetCapacity={(patch) => saveDayCapacity(format(cursor, 'yyyy-MM-dd'), patch)}
          onResetCapacity={() => resetDayCapacity(format(cursor, 'yyyy-MM-dd'))}
          onToggleDisable={() => toggleDisableDay(format(cursor, 'yyyy-MM-dd'))}
        />
        <DayOpsPanel
          date={format(cursor, 'yyyy-MM-dd')}
          dateLabel={format(cursor, 'EEEE, MMMM d, yyyy')}
          jobs={jobs.filter(j => j.scheduled_date === format(cursor, 'yyyy-MM-dd'))}
          quotesById={quotesById}
          recurrences={recurrences}
          baseCoord={baseCoord}
          onOpenJob={(job) => { setEditing(job); setShowForm(false) }}
          onStartJob={startJob}
          onMarkDone={completeJob}
          onMove={(job, iso) => moveJobToDate(job, new Date(iso + 'T00:00:00'))}
          onDeleteJob={deleteJob}
          onSetPrice={setJobPrice}
          addonsByJobId={addonsByJobId}
          onAddLineItem={addLineItemToJob}
          onDeleteLineItem={removeLineItem}
          getPreviousAddons={getPreviousAddons}
          onCopyPreviousAddons={copyPreviousAddons}
          workStartTime={dayView.start}
          capacityHours={dayView.laborHours}
          onRainDelay={() => rainDelayDay(format(cursor, 'yyyy-MM-dd'))}
          onAddJob={() => openNewJob(cursor)}
          onQuickSave={quickSaveJob}
        />
        </>
      ) : (
        <Calendar
          view={view}
          cursor={cursor}
          jobs={jobs}
          onSelectDay={handleDayTap}
          onSelectJob={handleJobTap}
          onMarkDone={completeJob}
          onMoveJob={(job, iso) => moveJobToDate(job, new Date(iso + 'T00:00:00'))}
          recurrenceLabels={recurrenceLabels}
          valueByJobId={totalByJobId}
          addonCountByJobId={addonCountByJobId}
          dayStatusMap={dayStatusMap}
          onDayMenu={openDayMenu}
          selectedDays={selectedDays}
          onToggleDaySelect={toggleDaySelect}
          capacityForDate={optBaseOpts.capacityForDate}
        />
      )}

      {pendingAction && (
        <ScopeDialog
          title={pendingAction.job.title}
          verb={pendingVerb}
          destructive={pendingAction.type === 'delete'}
          onChoose={handleScopeChoice}
          onCancel={() => setPendingAction(null)}
        />
      )}

      {/* Soft cadence / preference warning before a hand move */}
      {moveConfirm && (
        <div ref={moveConfirmRef} className="fixed inset-0 z-overlay-top flex items-center justify-center bg-black/50 p-4" onClick={() => setMoveConfirm(null)}>
          <Card role="dialog" aria-modal="true" aria-labelledby="move-confirm-title" tabIndex={-1} className="w-full max-w-md shadow-2xl focus:outline-none" onClick={e => e.stopPropagation()}>
            <CardHeader className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" aria-hidden="true" />
              <h2 id="move-confirm-title" className="text-sm font-semibold text-ink">Move to {format(parseISO(moveConfirm.newDate + 'T00:00:00'), 'EEE, MMM d')}?</h2>
            </CardHeader>
            <CardBody className="space-y-3">
              <ul className="space-y-1.5">
                {moveConfirm.warnings.map((w, i) => (
                  <li key={i} className="text-sm text-amber-300 flex items-start gap-2">
                    <span className="text-amber-400 mt-px">•</span> {w}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-ink-faint">You can still make this move — these are just reminders.</p>
              <div className="flex items-center gap-2 pt-1">
                <Button onClick={async () => { const mc = moveConfirm; setMoveConfirm(null); await proceedMoveJobToDate(mc.job, mc.newDate) }}>
                  Move anyway
                </Button>
                <Button variant="ghost" onClick={() => setMoveConfirm(null)}>Keep current date</Button>
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {showOptimize && (
        <OptimizeSchedule
          jobs={jobs}
          recurrences={recurrences}
          valueByJobId={valueByJobId}
          baseCoord={baseCoord}
          preferredWorkDays={preferredWorkDays}
          capacityHours={capacityHours}
          anchorDate={optimizeLaunch?.anchorDate ?? format(cursor, 'yyyy-MM-dd')}
          initialScope={optimizeLaunch?.scope}
          initialMode={optimizeLaunch?.mode}
          autoRun={optimizeLaunch?.autoRun}
          invoicedIds={invoicedJobIds}
          roadDist={roadDist}
          dayStatusMap={dayStatusMap}
          capacityForDate={optBaseOpts.capacityForDate}
          duplicateNote={healthDuplicates.stops > 0 ? healthDuplicates : undefined}
          onApply={applyOptimization}
          onClose={() => { setShowOptimize(false); setOptimizeLaunch(null) }}
        />
      )}

      {showRainCenter && (
        <RainDelayCenter
          jobs={jobs}
          recurrences={recurrences}
          valueByJobId={valueByJobId}
          baseCoord={baseCoord}
          preferredWorkDays={preferredWorkDays}
          capacityHours={capacityHours}
          dayStatusMap={dayStatusMap}
          capacityForDate={optBaseOpts.capacityForDate}
          onApply={applyOptimization}
          onClose={() => setShowRainCenter(false)}
        />
      )}

      {dayMenu && (
        <DayStatusMenu
          dates={dayMenu.dates}
          current={dayMenu.current}
          pos={{ x: dayMenu.x, y: dayMenu.y }}
          onPick={(status) => applyDayStatus(dayMenu.dates, status)}
          onClear={() => clearDayStatusFor(dayMenu.dates)}
          onClose={() => setDayMenu(null)}
        />
      )}

      {selectedDays.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[55] flex items-center gap-2 rounded-2xl border border-border bg-bg-secondary/95 backdrop-blur px-4 py-2.5 shadow-2xl">
          <span className="text-sm font-semibold text-ink">{selectedDays.size} day{selectedDays.size !== 1 ? 's' : ''} selected</span>
          <Button size="sm"
            onClick={() => setDayMenu({ dates: Array.from(selectedDays), current: null, x: window.innerWidth / 2 - 124, y: Math.max(60, window.innerHeight / 2 - 200) })}>
            Set status
          </Button>
          <Button size="sm" variant="secondary" onClick={() => clearDayStatusFor(Array.from(selectedDays))}>Clear status</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelectedDays(new Set())}>Cancel</Button>
        </div>
      )}

      {/* ── Field bar ────────────────────────────────────────────────────────────
          The day's ONE next action, pinned in thumb reach. Every primary action on
          this page lives in the job card or the header — i.e. the top half of a
          scrolling page — so a contractor holding a trimmer had to two-hand the
          phone and hunt for the card they were standing in front of. This restates
          the SAME stage-primary the card shows (On my way → Start → Complete) and
          calls the SAME engines; it adds reach, not a second way to do things.
          Phone-only, day-view-only, and it hides itself once the day is done. */}
      {view === 'day' && fieldNext && (
        <StickyActionBar fixed className="lg:hidden">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                {fieldNext.status === 'in_progress' ? 'In progress' : 'Next stop'}
              </p>
              <p className="text-sm font-semibold text-ink truncate">{fieldNext.customers?.name || fieldNext.title}</p>
            </div>
            <Button
              size="lg"
              className="shrink-0 tap-target"
              loading={fieldActing}
              onClick={async () => {
                if (fieldActing) return
                setFieldActing(true)
                try {
                  if (fieldNext.status === 'in_progress') await completeJob(fieldNext)
                  else await startJob(fieldNext)
                } finally { setFieldActing(false) }
              }}
            >
              {fieldNext.status === 'in_progress'
                ? <><CheckCircle2 className="w-4 h-4" /> Complete</>
                : <><Play className="w-4 h-4" /> Start</>}
            </Button>
          </div>
        </StickyActionBar>
      )}
    </div>
  )
}

// One customer/job quick-action chip — the SAME link patterns as the day board
// (tel:, sms:, Google Maps directions, app routes), grouped in one row.
function QuickAction({ href, icon: Icon, label, external }: { href: string; icon: typeof Phone; label: string; external?: boolean }) {
  return (
    <a href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className="h-10 sm:h-8 px-3 rounded-lg border border-border bg-bg-tertiary text-xs font-medium text-ink-muted hover:text-ink hover:border-border-strong flex items-center gap-1.5 transition-colors">
      <Icon className="w-3.5 h-3.5" /> {label}
    </a>
  )
}
