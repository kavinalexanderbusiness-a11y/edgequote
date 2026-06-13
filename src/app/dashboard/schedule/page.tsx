'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Customer, Job, JobFormValues, Quote, RecurrenceScope, RecurUnit } from '@/types'
import { Calendar, CalendarView } from '@/components/schedule/Calendar'
import { DayOpsPanel, QuoteLite, QuickPatch } from '@/components/schedule/DayOpsPanel'
import { Coord, geocodeAddress } from '@/lib/geo'
import { JobForm, Recurrence, SuggestionMeta } from '@/components/schedule/JobForm'
import { ScopeDialog } from '@/components/schedule/ScopeDialog'
import { generateOccurrences, jobsInScope, shiftDate, dayDelta, recurrenceLabel } from '@/lib/recurrence'
import type { JobRecurrence } from '@/types'
import { createDraftInvoiceForCompletedJob, quoteVisitAmount, jobVisitValue, effectiveFreq } from '@/lib/invoicing'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { cn, minutesBetween } from '@/lib/utils'
import { format, addMonths, addWeeks, addDays, subMonths, subWeeks, subDays, parseISO, getDay } from 'date-fns'
import { Plus, X, ChevronLeft, ChevronRight, Trash2, Rocket, AlertTriangle, Repeat, Lightbulb, Info } from 'lucide-react'
import { OptimizeSchedule } from '@/components/schedule/OptimizeSchedule'
import { RainDelayCenter } from '@/components/schedule/RainDelayCenter'
import { CloudRain } from 'lucide-react'
import { analyzeSchedule, MOVE_REASON_LABEL } from '@/lib/optimizer'
import type { PlannedMove, OptimizeScope, OptimizeMode, OptJob, ScheduleSuggestion, CadenceVisit, CadenceRecs } from '@/lib/optimizer'
import { evaluateScheduleMove } from '@/lib/scheduleWarnings'
import { resolvePrefs } from '@/lib/preferences'
import type { PrefSource } from '@/lib/preferences'
import { buildRoutingRoadDistance, RoadDist } from '@/lib/distance'
import { analyzeScheduleHealth } from '@/lib/scheduleHealth'
import type { HealthIssue, HealthJob } from '@/lib/scheduleHealth'
import { ScheduleHealthCard } from '@/components/schedule/ScheduleHealthCard'

function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type PendingAction =
  | { type: 'edit'; job: Job; values: JobFormValues; recurrence: Recurrence }
  | { type: 'move'; job: Job; newDate: string }
  | { type: 'delete'; job: Job }
  | { type: 'price'; job: Job; price: number | null }

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
  const router = useRouter()
  const searchParams = useSearchParams()
  const quoteId = searchParams.get('quote')
  const customerParam = searchParams.get('customer')
  const focusRec = searchParams.get('focus')

  const [jobs, setJobs] = useState<Job[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<CalendarView>(() =>
    typeof window !== 'undefined' && window.innerWidth < 1024 ? 'day' : 'month'
  )
  const [cursor, setCursor] = useState(new Date())
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Job | null>(null)
  const [formDate, setFormDate] = useState<string>('')
  const [formSeq, setFormSeq] = useState(0) // bump to remount a fresh add form
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  // One-click undo for the last move/delete/done.
  const [undoAction, setUndoAction] = useState<{ label: string; run: () => Promise<void> } | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [recurrenceLabels, setRecurrenceLabels] = useState<Record<string, string>>({})
  const [recurrences, setRecurrences] = useState<Record<string, JobRecurrence>>({})
  const [quotesById, setQuotesById] = useState<Record<string, QuoteLite>>({})
  // Future jobs that already have an invoice = immutable locks. The proactive
  // cards AND the optimizer modal must read the SAME set, or they disagree about
  // what can move.
  const [invoicedJobIds, setInvoicedJobIds] = useState<Set<string>>(new Set())
  const [baseCoord, setBaseCoord] = useState<Coord | null>(null)
  const [preferredWorkDays, setPreferredWorkDays] = useState<number[]>([5, 6, 0])
  const [workStartTime, setWorkStartTime] = useState('08:00')
  const [capacityHours, setCapacityHours] = useState(8)
  const [showOptimize, setShowOptimize] = useState(false)
  const [showRainCenter, setShowRainCenter] = useState(false)
  // Pre-scoped launch from an auto-suggestion (vs. the manual Optimize button).
  const [optimizeLaunch, setOptimizeLaunch] = useState<{ scope: OptimizeScope; mode: OptimizeMode; anchorDate: string; autoRun: boolean } | null>(null)
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set())
  // Soft warning before a hand move that breaks cadence or a customer preference.
  const [moveConfirm, setMoveConfirm] = useState<{ job: Job; newDate: string; warnings: string[] } | null>(null)
  // Cached real-road distance lookup for the optimizer + proactive cards (shared
  // so they agree). Built from the located future stops; haversine until ready.
  const [roadDist, setRoadDist] = useState<RoadDist | undefined>(undefined)
  // Schedule Health — intentionally-ignored issue keys (persisted) + which issue
  // is mid-action.
  const [ignoredHealthKeys, setIgnoredHealthKeys] = useState<Set<string>>(new Set())
  const [healthBusyKey, setHealthBusyKey] = useState<string | null>(null)

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

  // Proactive auto-suggestions (overloaded days, isolated jobs, recurring-cluster
  // opportunities) — computed from the same engines, shown without opening the
  // optimizer. Recomputes when jobs/settings change.
  const suggestions = useMemo<ScheduleSuggestion[]>(() => {
    if (jobs.length === 0) return []
    const optJobs: OptJob[] = jobs.map(j => ({
      id: j.id, scheduled_date: j.scheduled_date, status: j.status,
      recurrence_id: j.recurrence_id, start_time: j.start_time, duration_minutes: j.duration_minutes,
      lat: j.properties?.lat ?? null, lng: j.properties?.lng ?? null,
      value: valueByJobId[j.id] || 0, invoiced: invoicedJobIds.has(j.id),
      title: j.title, customerName: j.customers?.name || j.title, customerId: j.customer_id,
      serviceType: j.service_type, neighborhood: j.properties?.neighborhood ?? null,
      ...(() => { const p = resolvePrefs(j.customers, j.properties); return { preferredDays: p.preferredDays, avoidDays: p.avoidDays } })(),
    }))
    const recs: Record<string, { freq: string | null; interval_unit: string | null; interval_count: number | null }> = {}
    for (const [id, r] of Object.entries(recurrences)) recs[id] = { freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count }
    return analyzeSchedule(optJobs, {
      today: localToday(), base: baseCoord, preferredDays: preferredWorkDays, capacityHours, recurrences: recs, roadDist,
    })
  }, [jobs, valueByJobId, recurrences, baseCoord, preferredWorkDays, capacityHours, invoicedJobIds, roadDist])

  const visibleSuggestions = suggestions.filter(s => !dismissedSuggestions.has(s.id))

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
    const { error } = await supabase.from('jobs').delete().in('id', issue.removableJobIds)
    if (error) { setBanner('Could not remove the duplicate: ' + error.message); setHealthBusyKey(null); return }
    await fetchJobs()
    setHealthBusyKey(null)
    offerUndo(`Removed ${rows.length} ${issue.isMow ? 'mowing ' : ''}visit${rows.length !== 1 ? 's' : ''}`, async () => {
      if (rows.length) await supabase.from('jobs').insert(rows)
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
    const futureIds = new Set(futureJobs.map(j => j.id))
    const pastReattach = jobs.filter(j => j.recurrence_id && otherSet.has(j.recurrence_id) && !futureIds.has(j.id))
      .map(j => ({ id: j.id, recurrence_id: j.recurrence_id as string }))
    const recRows = others.map(r => recurrences[r]).filter(Boolean).map(r => ({
      id: r.id, user_id: r.user_id, freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count,
      start_date: r.start_date, end_date: r.end_date, end_count: r.end_count, customer_id: r.customer_id,
    }))
    if (futureJobs.length) await supabase.from('jobs').delete().in('id', futureJobs.map(j => j.id))
    if (pastReattach.length) await supabase.from('jobs').update({ recurrence_id: null }).in('id', pastReattach.map(p => p.id))
    await supabase.from('job_recurrences').delete().in('id', others)
    await fetchJobs()
    setHealthBusyKey(null)
    offerUndo(`Merged ${others.length + 1} ${issue.isMow ? 'mowing ' : ''}plans into one`, async () => {
      if (recRows.length) await supabase.from('job_recurrences').insert(recRows)
      if (futureRows.length) await supabase.from('jobs').insert(futureRows)
      for (const p of pastReattach) await supabase.from('jobs').update({ recurrence_id: p.recurrence_id }).eq('id', p.id)
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

  const fetchJobs = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    const [jRes, cRes, rRes, qRes, sRes, iRes, hRes] = await Promise.all([
      supabase
        .from('jobs')
        .select('*, customers(id, name, phone, preferred_days, avoid_days, pref_time_start, pref_time_end), properties(id, address, lat, lng, neighborhood, preferred_days, avoid_days, pref_time_start, pref_time_end)')
        .eq('user_id', user!.id)
        .order('scheduled_date'),
      supabase.from('customers').select('*').eq('user_id', user!.id).order('name'),
      supabase.from('job_recurrences').select('*').eq('user_id', user!.id),
      supabase.from('quotes').select('id, total, initial_price, weekly_price, biweekly_price, monthly_price').eq('user_id', user!.id),
      supabase.from('business_settings').select('base_lat, base_lng, base_address, preferred_work_days, work_start_time, daily_capacity_hours').eq('user_id', user!.id).maybeSingle(),
      supabase.from('invoices').select('job_id').eq('user_id', user!.id).not('job_id', 'is', null),
      supabase.from('schedule_health_ignored').select('issue_key').eq('user_id', user!.id),
    ])
    setJobs((jRes.data as Job[]) || [])
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
    const s = sRes.data as { base_lat: number | null; base_lng: number | null; base_address: string | null; preferred_work_days: number[] | null; work_start_time: string | null; daily_capacity_hours: number | null } | null
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
  }, [supabase])

  useEffect(() => { fetchJobs() }, [fetchJobs])

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
    setCustomerPrefill({ customer_id: customerParam, scheduled_date: localToday() })
    setShowForm(true)
  }, [customerParam, quoteId])

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

    if (values.status === 'completed' && job.recurrence_id) {
      const res = await createDraftInvoiceForCompletedJob(supabase, { ...job, status: 'completed' })
      if (res.created) setBanner(`Draft invoice ${res.invoiceNumber} created from the completed visit — review it in Invoices.`)
      else if (res.reason === 'exists') setBanner('That visit already has an invoice.')
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
    const prev = targets.map(t => ({ id: t.id, scheduled_date: t.scheduled_date }))
    await Promise.all(targets.map(t =>
      supabase.from('jobs').update({ scheduled_date: shiftDate(t.scheduled_date, delta) }).eq('id', t.id)
    ))
    await fetchJobs()
    offerUndo(`Moved ${targets.length} visit${targets.length !== 1 ? 's' : ''}`, async () => {
      await Promise.all(prev.map(p => supabase.from('jobs').update({ scheduled_date: p.scheduled_date }).eq('id', p.id)))
    })
  }

  async function applyDelete(job: Job, scope: RecurrenceScope) {
    const targets = jobsInScope(job, jobs, scope)
    const snapshot = targets.map(jobInsertRow)
    const r = (scope === 'all' && job.recurrence_id) ? recurrences[job.recurrence_id] : null
    const recRow = r ? {
      id: r.id, user_id: r.user_id, freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count,
      start_date: r.start_date, end_date: r.end_date, end_count: r.end_count, customer_id: r.customer_id,
    } : null
    await supabase.from('jobs').delete().in('id', targets.map(t => t.id))
    if (recRow) await supabase.from('job_recurrences').delete().eq('id', job.recurrence_id)
    await fetchJobs()
    setEditing(null)
    offerUndo(`Deleted ${targets.length} visit${targets.length !== 1 ? 's' : ''}`, async () => {
      if (recRow) await supabase.from('job_recurrences').insert(recRow)
      if (snapshot.length) await supabase.from('jobs').insert(snapshot)
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
    await supabase.from('jobs').delete().eq('id', job.id)
    await fetchJobs()
    setEditing(prev => (prev?.id === job.id ? null : prev))
    offerUndo('Job deleted', async () => { await supabase.from('jobs').insert(row) })
  }

  async function handleDelete() {
    if (editing) await deleteJob(editing)
  }

  // ▶ Check in: stamps arrival/start, status becomes In Progress.
  async function startJob(job: Job) {
    const prev = { status: job.status, started_at: job.started_at }
    const now = new Date().toISOString()
    const { error } = await supabase.from('jobs').update({ status: 'in_progress', started_at: now }).eq('id', job.id)
    if (error) { setBanner('Could not start the job: ' + error.message); return }
    await fetchJobs()
    offerUndo('Job started', async () => {
      await supabase.from('jobs').update(prev).eq('id', job.id)
    })
  }

  // ✓ Check out: stamps completion, derives actual_minutes from check-in →
  // check-out (the ONE timing value every engine reads), drafts the invoice.
  // Also the calendar's one-tap Done (works without a check-in — no actual then).
  async function completeJob(job: Job) {
    const prev = { status: job.status, completed_at: job.completed_at, actual_minutes: job.actual_minutes }
    const now = new Date().toISOString()
    const actual = job.started_at ? minutesBetween(job.started_at, now) : job.actual_minutes
    const { error } = await supabase.from('jobs').update({ status: 'completed', completed_at: now, actual_minutes: actual }).eq('id', job.id)
    if (error) { setBanner('Could not complete the job: ' + error.message); return }
    let invoiceCreated = false
    if (job.recurrence_id) {
      const res = await createDraftInvoiceForCompletedJob(supabase, { ...job, status: 'completed', actual_minutes: actual })
      if (res.created) { invoiceCreated = true; setBanner(`Draft invoice ${res.invoiceNumber} created. Review in Invoices.`) }
      else if (res.reason === 'no-amount') setBanner('Done — no invoice drafted because this visit has no price. Set a price to bill it.')
    }
    await fetchJobs()
    offerUndo('Job completed', async () => {
      await supabase.from('jobs').update(prev).eq('id', job.id)
      if (invoiceCreated) await supabase.from('invoices').delete().eq('job_id', job.id).eq('status', 'draft')
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
    if (patch.status === 'completed' && job.status !== 'completed' && job.recurrence_id) {
      const res = await createDraftInvoiceForCompletedJob(supabase, { ...job, status: 'completed' })
      if (res.created) setBanner(`Saved — draft invoice ${res.invoiceNumber} created.`)
    }
    await fetchJobs()
  }

  // First-class price edit from the Day panel.
  //  • One-time job → update its price directly.
  //  • Recurring job → choose scope (This / This & Future / All), then apply with
  //    the quote cadence price as the single source of truth (see applyPriceChange).
  async function setJobPrice(job: Job, price: number | null) {
    if (job.recurrence_id) {
      setPendingAction({ type: 'price', job, price })
      return
    }
    const { error } = await supabase.from('jobs').update({ price }).eq('id', job.id)
    if (error) { setBanner('Could not update price: ' + error.message); return }
    await fetchJobs()
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
  async function applyPriceChange(job: Job, newPrice: number | null, scope: RecurrenceScope) {
    const rec = job.recurrence_id ? recurrences[job.recurrence_id] : null
    const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
    const field = cadenceField(job)
    const quote = job.quote_id ? quotesById[job.quote_id] : null
    const writesQuote = !!(job.quote_id && field && newPrice != null && (scope === 'future' || scope === 'all'))
    const series = jobs.filter(j => j.recurrence_id === job.recurrence_id)

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

    await fetchJobs()
    const dest = writesQuote ? `the quote's ${freq} price` : scope === 'this' ? 'this visit' : 'the series visits'
    offerUndo(`Price saved to ${dest}`, async () => {
      if (quoteSnap) await supabase.from('quotes').update({ [quoteSnap.field]: quoteSnap.value }).eq('id', quoteSnap.id)
      const nullIds = jobSnap.filter(s => s.price == null).map(s => s.id)
      if (nullIds.length) await supabase.from('jobs').update({ price: null }).in('id', nullIds)
      for (const s of jobSnap.filter(s => s.price != null)) await supabase.from('jobs').update({ price: s.price }).eq('id', s.id)
    })
  }

  // ── Undo ────────────────────────────────────────────────────────────────────
  function offerUndo(label: string, run: () => Promise<void>) {
    setUndoAction({ label, run })
    if (undoTimer.current) clearTimeout(undoTimer.current)
    undoTimer.current = setTimeout(() => setUndoAction(null), 8000)
  }
  async function runUndo() {
    const a = undoAction
    if (undoTimer.current) clearTimeout(undoTimer.current)
    setUndoAction(null)
    if (a) { await a.run(); await fetchJobs() }
  }
  // Insertable job row (strips joined customers/properties) for delete-undo.
  function jobInsertRow(j: Job) {
    return {
      id: j.id, user_id: j.user_id, customer_id: j.customer_id, property_id: j.property_id,
      quote_id: j.quote_id, recurrence_id: j.recurrence_id, title: j.title, service_type: j.service_type,
      scheduled_date: j.scheduled_date, start_time: j.start_time, end_time: j.end_time,
      duration_minutes: j.duration_minutes, crew_size: j.crew_size, status: j.status, notes: j.notes,
      price: j.price, actual_minutes: j.actual_minutes, suggested_date: j.suggested_date, suggested_nearby_count: j.suggested_nearby_count,
      is_initial_visit: j.is_initial_visit,
    }
  }

  // Apply a batch of date moves (optimizer or rain delay): grouped by target
  // day, with one Undo that restores every original date.
  async function applyOptimization(moves: Pick<PlannedMove, 'jobId' | 'from' | 'to'>[]) {
    if (!moves.length) return
    const byTo: Record<string, string[]> = {}
    for (const m of moves) (byTo[m.to] ||= []).push(m.jobId)
    for (const [to, ids] of Object.entries(byTo)) {
      const { error } = await supabase.from('jobs').update({ scheduled_date: to }).in('id', ids)
      if (error) { setBanner('Optimization partially applied — ' + error.message); break }
    }
    await fetchJobs()
    const byFrom: Record<string, string[]> = {}
    for (const m of moves) (byFrom[m.from] ||= []).push(m.jobId)
    offerUndo(`${moves.length} job${moves.length !== 1 ? 's' : ''} moved`, async () => {
      for (const [from, ids] of Object.entries(byFrom)) {
        await supabase.from('jobs').update({ scheduled_date: from }).in('id', ids)
      }
    })
  }

  // Next date on/after `fromISO`+1 whose weekday is a preferred work day.
  function nextWorkday(fromISO: string): string {
    const pref = preferredWorkDays.length ? new Set(preferredWorkDays) : null
    let d = addDays(parseISO(fromISO), 1)
    for (let i = 0; i < 21; i++) {
      if (!pref || pref.has(getDay(d))) return format(d, 'yyyy-MM-dd')
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
    const { error } = await supabase.from('jobs').update({ scheduled_date: to }).in('id', ids)
    if (error) { setBanner('Could not bump the day: ' + error.message); return }
    await fetchJobs()
    setCursor(parseISO(to + 'T00:00:00'))
    offerUndo(`Rain delay — bumped ${ids.length} job${ids.length !== 1 ? 's' : ''} to ${format(parseISO(to + 'T00:00:00'), 'EEE, MMM d')}`,
      async () => { await supabase.from('jobs').update({ scheduled_date: dateISO }).in('id', ids) })
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
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, scheduled_date: newDate } : j))
    await supabase.from('jobs').update({ scheduled_date: newDate }).eq('id', job.id)
    offerUndo('Job moved', async () => {
      await supabase.from('jobs').update({ scheduled_date: prevDate }).eq('id', job.id)
    })
  }

  async function handleScopeChoice(scope: RecurrenceScope) {
    const action = pendingAction
    setPendingAction(null)
    if (!action) return
    if (action.type === 'edit') await applyEdit(action.job, action.values, action.recurrence, scope)
    else if (action.type === 'move') await applyMove(action.job, action.newDate, scope)
    else if (action.type === 'delete') await applyDelete(action.job, scope)
    else if (action.type === 'price') await applyPriceChange(action.job, action.price, scope)
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

  const headingLabel =
    view === 'month' ? format(cursor, 'MMMM yyyy')
    : view === 'week' ? `Week of ${format(cursor, 'MMM d, yyyy')}`
    : format(cursor, 'MMMM d, yyyy')

  const viewButtons: CalendarView[] = ['month', 'week', 'day']

  const pendingVerb = pendingAction?.type === 'delete' ? 'Delete'
    : pendingAction?.type === 'move' ? 'Move'
    : pendingAction?.type === 'price' ? 'Update price for' : 'Save changes to'

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        title="Schedule"
        description={`${jobs.length} job${jobs.length !== 1 ? 's' : ''} on the calendar`}
        action={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setShowRainCenter(true)} title="Rained out? Bump a whole day to the next work days">
              <CloudRain className="w-4 h-4" /> Rain
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

      {quoteCtx && (
        <div className="text-sm text-accent bg-accent/10 border border-accent/20 rounded-xl px-4 py-2.5">
          Scheduling from accepted quote <span className="font-semibold">{quoteCtx.quote_number}</span> — pick a date and set recurrence below.
        </div>
      )}

      {banner && (
        <div className="flex items-center justify-between gap-3 text-sm text-accent bg-accent/10 border border-accent/20 rounded-xl px-4 py-2.5">
          <span>{banner}</span>
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={() => router.push('/dashboard/invoices')} className="underline font-medium">Invoices</button>
            <button onClick={() => setBanner(null)} className="text-ink-faint hover:text-ink">✕</button>
          </div>
        </div>
      )}

      {/* Undo toast — restore the last move / delete / done */}
      {undoAction && (
        <div className="flex items-center justify-between gap-3 text-sm bg-ink text-bg border border-border-strong rounded-xl px-4 py-2.5 shadow-lg">
          <span className="font-medium">{undoAction.label}</span>
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={runUndo} className="font-bold underline">Undo</button>
            <button onClick={() => setUndoAction(null)} className="opacity-60 hover:opacity-100">✕</button>
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="secondary" size="sm" onClick={() => navigate(-1)}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setCursor(new Date())}>Today</Button>
          <Button variant="secondary" size="sm" onClick={() => navigate(1)}>
            <ChevronRight className="w-4 h-4" />
          </Button>
          <span className="text-sm font-semibold text-ink ml-2">{headingLabel}</span>
        </div>
        <div className="flex items-center gap-1 bg-bg-secondary border border-border rounded-xl p-1">
          {viewButtons.map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-sm font-medium capitalize transition-all',
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
                    ? <Repeat className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                    : <Lightbulb className="w-4 h-4 text-accent shrink-0 mt-0.5" />}
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
                className="text-ink-faint hover:text-ink shrink-0" title="Dismiss">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Edit/New job — modal overlay so Open always brings the correct job into view */}
      {(showForm || editing) && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm" onClick={closeForm}>
          <div className="min-h-full flex items-start justify-center p-4 sm:p-6">
            <Card className="w-full max-w-2xl my-2 shadow-2xl" onClick={e => e.stopPropagation()}>
          <CardHeader className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">{editing ? 'Edit Job' : 'New Job'}</h2>
            <div className="flex items-center gap-2">
              {editing && (
                <button onClick={handleDelete} className="text-ink-faint hover:text-red-400 transition-colors" title="Delete job">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
              <button onClick={closeForm} className="text-ink-faint hover:text-ink transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
          </CardHeader>
          <CardBody>
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

      {loading ? (
        <div className="text-center py-16 text-sm text-ink-muted">Loading schedule...</div>
      ) : view === 'day' ? (
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
          workStartTime={workStartTime}
          capacityHours={capacityHours}
          onRainDelay={() => rainDelayDay(format(cursor, 'yyyy-MM-dd'))}
          onAddJob={() => openNewJob(cursor)}
          onQuickSave={quickSaveJob}
        />
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
          valueByJobId={valueByJobId}
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
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setMoveConfirm(null)}>
          <Card className="w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
            <CardHeader className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              <h2 className="text-sm font-semibold text-ink">Move to {format(parseISO(moveConfirm.newDate + 'T00:00:00'), 'EEE, MMM d')}?</h2>
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
          onApply={applyOptimization}
          onClose={() => setShowRainCenter(false)}
        />
      )}
    </div>
  )
}
