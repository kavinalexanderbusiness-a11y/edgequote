'use client'

import { useEffect, useState, useRef } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Button } from '@/components/ui/Button'
import { Customer, Property, JobFormValues, JobStatus, RecurUnit } from '@/types'
import { formatCurrency, formatDate } from '@/lib/utils'
import { recurrenceLabel } from '@/lib/recurrence'
import { latestSavedRecommendation, savedPriceFor, recommendationIsStale, CadenceKey } from '@/lib/pricing'
import {
  ServiceSeasons, DEFAULT_SEASONS, settingsToSeasons, serviceCategory, seasonForService,
  seasonEndDateFor, estimateSeasonVisits, seasonLabel,
} from '@/lib/seasons'
import { WeeklyScheduler } from '@/components/schedule/WeeklyScheduler'
import { SmartLaborField } from '@/components/labor/SmartLaborField'
import type { Cadence } from '@/lib/labor'
import { resolvePrefs, type PrefSource } from '@/lib/preferences'
import { findJobMatch, type JobLiteForMatch } from '@/lib/dedup'
import { Collapsible } from '@/components/ui/Collapsible'
import { AssistButton } from '@/components/ai/AssistButton'
import { useAiAssist } from '@/hooks/useAiAssist'
import { Repeat, Sparkles, Snowflake, Sun, AlertTriangle, CalendarRange, Clock } from 'lucide-react'

// Flexible recurrence: any interval (count + unit), three end modes.
export interface Recurrence {
  unit: RecurUnit | null // null = does not repeat
  count: number
  endDate: string | null
  endCount: number | null
}

export interface SuggestionMeta {
  suggestedDate: string | null
  suggestedNearby: number | null
}

interface JobFormProps {
  customers: Customer[]
  defaultValues?: Partial<JobFormValues>
  excludeJobId?: string
  // Existing series for the job being edited, so the Repeat controls pre-fill.
  initialRecurrence?: Recurrence
  allowAddAnother?: boolean
  suggestedPrice?: number // quote-derived per-visit price, shown as the price hint
  // Soft cadence/preference warnings for the chosen date+time (page-supplied, so
  // the timeline + recurrence rules stay in one place). Returns owner-facing notes.
  warnFor?: (input: {
    jobId?: string
    customerId: string
    serviceType: string | null
    date: string
    startTime: string | null
    customerPrefs: PrefSource | null
    propertyPrefs: PrefSource | null
    customerName: string | null
  }) => string[]
  onSubmit: (values: JobFormValues, recurrence: Recurrence, meta?: SuggestionMeta, opts?: { addAnother?: boolean }) => Promise<void>
  onCancel: () => void
  isEdit?: boolean
}

const STATUS_OPTIONS: { value: JobStatus; label: string }[] = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
]

type RepeatPreset = 'none' | 'w1' | 'w2' | 'w3' | 'w4' | 'm1' | 'custom'

const PRESET_OPTIONS: { value: RepeatPreset; label: string }[] = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'w1', label: 'Every week' },
  { value: 'w2', label: 'Every 2 weeks' },
  { value: 'w3', label: 'Every 3 weeks' },
  { value: 'w4', label: 'Every 4 weeks' },
  { value: 'm1', label: 'Monthly' },
  { value: 'custom', label: 'Custom…' },
]

function presetToInterval(preset: RepeatPreset, customUnit: RecurUnit, customCount: number): { unit: RecurUnit; count: number } | null {
  switch (preset) {
    case 'none': return null
    case 'w1': return { unit: 'week', count: 1 }
    case 'w2': return { unit: 'week', count: 2 }
    case 'w3': return { unit: 'week', count: 3 }
    case 'w4': return { unit: 'week', count: 4 }
    case 'm1': return { unit: 'month', count: 1 }
    case 'custom': return { unit: customUnit, count: Math.max(1, customCount) }
  }
}

// Map a recurrence interval to the labor engine's cadence bucket, so the Smart
// Labor estimate learns "weekly mow from weekly mow" (not all mows pooled).
function intervalToCadence(iv: { unit: RecurUnit; count: number } | null): Cadence {
  if (!iv) return 'one_time'
  if (iv.unit === 'month') return 'monthly'
  if (iv.unit === 'week') return iv.count <= 1 ? 'weekly' : iv.count === 2 ? 'biweekly' : 'monthly'
  if (iv.unit === 'day') return iv.count <= 10 ? 'weekly' : iv.count <= 18 ? 'biweekly' : 'monthly'
  return 'one_time'
}

type EndMode = 'season' | 'on' | 'after' | 'never'

// Map an existing series back onto the Repeat UI controls so editing pre-fills.
function recurrenceToUi(r?: Recurrence) {
  if (!r || !r.unit) {
    return { preset: 'none' as RepeatPreset, customUnit: 'week' as RecurUnit, customCount: 3, endMode: 'never' as EndMode, endDate: '', endCount: 10 }
  }
  let preset: RepeatPreset = 'custom'
  if (r.unit === 'week' && r.count === 1) preset = 'w1'
  else if (r.unit === 'week' && r.count === 2) preset = 'w2'
  else if (r.unit === 'week' && r.count === 3) preset = 'w3'
  else if (r.unit === 'week' && r.count === 4) preset = 'w4'
  else if (r.unit === 'month' && r.count === 1) preset = 'm1'
  // An existing end_date pre-fills as a specific date (we can't know post-hoc
  // whether it was originally a season pick — treat as 'on' for safe editing).
  const endMode: EndMode = r.endDate ? 'on' : r.endCount ? 'after' : 'never'
  return {
    preset,
    customUnit: r.unit,
    customCount: Math.max(1, r.count),
    endMode,
    endDate: r.endDate || '',
    endCount: r.endCount || 10,
  }
}

export function JobForm({ customers, defaultValues, excludeJobId, initialRecurrence, allowAddAnother, suggestedPrice, warnFor, onSubmit, onCancel, isEdit }: JobFormProps) {
  const supabase = createClient()
  const [properties, setProperties] = useState<Property[]>([])
  const addAnotherRef = useRef(false)

  // Recurrence state — pre-filled from an existing series when editing.
  const ui0 = recurrenceToUi(initialRecurrence)
  const [preset, setPreset] = useState<RepeatPreset>(ui0.preset)
  const [customUnit, setCustomUnit] = useState<RecurUnit>(ui0.customUnit)
  const [customCount, setCustomCount] = useState(ui0.customCount)
  const [endMode, setEndMode] = useState<EndMode>(ui0.endMode)
  const [endDate, setEndDate] = useState(ui0.endDate)
  const [endCount, setEndCount] = useState(ui0.endCount)
  const [seasons, setSeasons] = useState<ServiceSeasons>(DEFAULT_SEASONS)
  // Existing recurring series on the selected property — for duplicate detection.
  const [propSeries, setPropSeries] = useState<{ id: string; service_type: string | null; unit: string | null; count: number | null }[]>([])
  const [dupAck, setDupAck] = useState(false) // owner chose "create anyway"

  const { register, handleSubmit, watch, setValue, control, formState: { errors, isSubmitting } } =
    useForm<JobFormValues>({
      defaultValues: {
        customer_id: '',
        property_id: '',
        title: '',
        service_type: '', // prefilled with the owner's most common service (learned, not assumed — see effect below)
        scheduled_date: '',
        start_time: '',
        end_time: '',
        duration_minutes: 60,
        crew_size: 1,
        status: 'scheduled',
        notes: '',
        actual_minutes: 0,
        price: 0,
        ...defaultValues,
      },
    })

  // Quick-add default service is LEARNED, not assumed: the owner's most frequent
  // recent service, else their first service template. A lawn company keeps its
  // instant "Lawn Mowing" quick-add; every other trade gets THEIR default — the
  // platform itself has no home industry. Never overwrites a caller default or
  // anything the owner has already typed.
  // What this business actually does, learned once and reused by the cadence chips.
  const [learnedService, setLearnedService] = useState<string | null>(null)
  useEffect(() => {
    if (isEdit || defaultValues?.service_type) return
    let alive = true
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid) return
      const { data } = await supabase.from('jobs').select('service_type')
        .eq('user_id', uid).not('service_type', 'is', null)
        .order('created_at', { ascending: false }).limit(30)
      const counts = new Map<string, number>()
      let top: string | null = null
      for (const r of (data as { service_type: string | null }[] | null) || []) {
        const s = (r.service_type || '').trim()
        if (!s) continue
        counts.set(s, (counts.get(s) || 0) + 1)
        if (!top || counts.get(s)! > (counts.get(top) || 0)) top = s
      }
      if (!top) {
        const { data: t } = await supabase.from('service_templates').select('name')
          .eq('user_id', uid).order('sort_order').limit(1)
        top = ((t as { name: string | null }[] | null)?.[0]?.name || '').trim() || null
      }
      // Keep it: the cadence chips need the same answer, and recomputing it there
      // would be a second definition of "this business's default service".
      if (!alive || !top) return
      setLearnedService(top)
      if (!watch('service_type')) setValue('service_type', top)
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Quick-add: only Customer / Service / Date show; everything else is collapsed.
  // BUT if a recurrence is pre-filled on a new job (e.g. scheduling a recurring
  // quote), start expanded so the carried cadence is visible and editable.
  const [showMore, setShowMore] = useState(!isEdit && !!initialRecurrence?.unit)
  const adv = isEdit || showMore

  const customerId = watch('customer_id')
  const status = watch('status')
  const selectedPropertyId = watch('property_id')
  // AI notes cleanup — tidies the owner's jottings; every fact stays theirs.
  const aiNotes = useAiAssist()
  const serviceType = watch('service_type')
  const scheduledDate = watch('scheduled_date')
  const startTime = watch('start_time')
  const selProp = properties.find(p => p.id === selectedPropertyId)
  const propCoord = selProp && selProp.lat != null && selProp.lng != null
    ? { lat: selProp.lat, lng: selProp.lng } : null

  // Soft cadence/preference warnings for the chosen date+time (Feature 1 & 2).
  const selectedCustomer = customers.find(c => c.id === customerId)
  // Effective scheduling prefs (customer default + property override) for the
  // best-day picker — boosts the customer's preferred days, hides avoided ones.
  const effectivePrefs = resolvePrefs((selectedCustomer ?? null) as PrefSource | null, (selProp ?? null) as PrefSource | null)
  const scheduleWarnings = warnFor && customerId && scheduledDate
    ? warnFor({
        jobId: excludeJobId,
        customerId,
        serviceType: serviceType || null,
        date: scheduledDate,
        startTime: startTime || null,
        customerPrefs: (selectedCustomer ?? null) as PrefSource | null,
        propertyPrefs: (selProp ?? null) as PrefSource | null,
        customerName: selectedCustomer?.name ?? null,
      })
    : []

  const interval = presetToInterval(preset, customUnit, customCount)

  // ── Seasonal recurrence ──
  // The service's season (lawn/snow), if any, and the season-end date for a
  // series starting on the job's scheduled date.
  const serviceSeason = seasonForService(serviceType, seasons)
  const category = serviceCategory(serviceType)
  const seasonEndDate = serviceSeason && scheduledDate ? seasonEndDateFor(scheduledDate, serviceSeason) : null
  // The effective end date the series will use, given the chosen end mode.
  const effectiveEndDate =
    endMode === 'season' ? seasonEndDate
    : endMode === 'on' && endDate ? endDate
    : null
  // Live visit-count estimate for the chosen cadence + end.
  const visitEstimate = interval && scheduledDate && effectiveEndDate
    ? estimateSeasonVisits(scheduledDate, effectiveEndDate, interval.unit, interval.count)
    : null

  // Duplicate detection: does this property ALREADY have an active recurring
  // series in the same category (lawn vs snow) as the one being created?
  const duplicateSeries = interval && category !== 'year_round'
    ? propSeries.find(s => serviceCategory(s.service_type) === category)
    : null
  const showDuplicateWarning = !!duplicateSeries && !dupAck

  // When the service is seasonal, default the end mode to Season End — but only
  // until the user touches the control, and never when editing an existing job.
  const endTouched = useRef(false)
  useEffect(() => {
    if (isEdit || endTouched.current) return
    setEndMode(serviceSeason ? 'season' : 'never')
  }, [serviceSeason, isEdit])

  // Saved measurement recommendation for the selected property — the pricing
  // source of truth. Maps the chosen cadence to its measured price (same custom-
  // cadence mapping as effectiveFreq: 3wk≈biweekly, 4wk+≈monthly).
  const savedRec = latestSavedRecommendation(selProp?.measurement_history)
  const cadenceForInterval: CadenceKey = !interval ? 'one_time'
    : interval.unit === 'month' || (interval.unit === 'week' && interval.count >= 4) ? 'monthly'
    : interval.unit === 'week' && interval.count === 1 ? 'weekly'
    : 'biweekly'
  const measuredPrice = savedRec ? savedPriceFor(savedRec.rec, cadenceForInterval) : null

  function buildRecurrence(): Recurrence {
    if (!interval) return { unit: null, count: 1, endDate: null, endCount: null }
    return {
      unit: interval.unit,
      count: interval.count,
      // Season End resolves to the season's end DATE (stored as a normal end_date,
      // so the recurrence engine needs no season awareness).
      endDate: endMode === 'season' ? seasonEndDate : (endMode === 'on' && endDate ? endDate : null),
      endCount: endMode === 'after' ? Math.max(1, endCount) : null,
    }
  }

  // A cadence chip picks the CADENCE. It used to also rename the service to
  // "Lawn Mowing" (or "Monthly Service"), which threw away both the learned
  // default above and anything the owner had already typed — tapping Weekly on a
  // snow job renamed it to mowing. Now it fills the service only when there isn't
  // one, from what this business actually does. A lawn company whose learned
  // default is "Lawn Mowing" gets exactly the old behaviour; every other trade
  // gets theirs.
  function applyCadencePreset(kind: 'weekly' | 'biweekly' | 'monthly') {
    setPreset(kind === 'weekly' ? 'w1' : kind === 'biweekly' ? 'w2' : 'm1')
    const svc = (watch('service_type') || '').trim() || learnedService || ''
    if (svc) {
      setValue('service_type', svc)
      if (!watch('title')) {
        setValue('title', svc + (selProp?.address ? ` — ${selProp.address}` : ''))
      }
    }
    // Selecting Weekly/Bi-Weekly/Monthly auto-suggests the measured price for
    // that cadence (only when the price hasn't been typed yet).
    const rec = latestSavedRecommendation(selProp?.measurement_history)
    if (rec && !(Number(watch('price')) > 0)) {
      setValue('price', savedPriceFor(rec.rec, kind))
    }
  }

  // Load configured service seasons once (falls back to Calgary defaults).
  useEffect(() => {
    async function loadSeasons() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase.from('business_settings').select('service_seasons').eq('user_id', user.id).maybeSingle()
      setSeasons(settingsToSeasons((data as { service_seasons: unknown } | null)?.service_seasons))
    }
    loadSeasons()
  }, [supabase])

  // Load properties for the selected customer
  useEffect(() => {
    if (!customerId) { setProperties([]); return }
    async function loadProps() {
      const { data } = await supabase
        .from('properties')
        .select('*')
        .eq('customer_id', customerId)
        .order('is_primary', { ascending: false })
      const props = (data as Property[]) || []
      setProperties(props)
      if (props.length > 0 && !watch('property_id')) {
        setValue('property_id', props[0].id)
      }
    }
    loadProps()
  }, [customerId, supabase, setValue, watch])

  // Existing recurring series on the selected property — for duplicate detection.
  // A series is "active" if it has any future or undated visit on the calendar.
  useEffect(() => {
    if (!selectedPropertyId || isEdit) { setPropSeries([]); return }
    let active = true
    async function loadSeries() {
      const { data: jobs } = await supabase
        .from('jobs')
        .select('recurrence_id, service_type, scheduled_date, status')
        .eq('property_id', selectedPropertyId)
        .not('recurrence_id', 'is', null)
      const rows = (jobs as { recurrence_id: string; service_type: string | null; scheduled_date: string; status: string }[]) || []
      const today = new Date().toISOString().slice(0, 10)
      // recurrence_ids that still have a future, non-cancelled visit booked.
      const activeRecIds = new Set<string>()
      const stByRec: Record<string, string | null> = {}
      for (const j of rows) {
        if (j.status !== 'cancelled' && j.scheduled_date >= today) activeRecIds.add(j.recurrence_id)
        if (!(j.recurrence_id in stByRec)) stByRec[j.recurrence_id] = j.service_type
      }
      if (activeRecIds.size === 0) { if (active) setPropSeries([]); return }
      const { data: recs } = await supabase
        .from('job_recurrences')
        .select('id, interval_unit, interval_count')
        .in('id', Array.from(activeRecIds))
      const recRows = (recs as { id: string; interval_unit: string | null; interval_count: number | null }[]) || []
      if (active) setPropSeries(recRows.map(r => ({ id: r.id, service_type: stByRec[r.id] ?? null, unit: r.interval_unit, count: r.interval_count })))
    }
    loadSeries()
    return () => { active = false }
  }, [selectedPropertyId, isEdit, supabase])

  // Same-day duplicate visit — THE unified dedup engine (lib/dedup): same property +
  // same day + same service (or the same recurring series already has that visit).
  // Never blocks saving; asks the one question so a double-booking is deliberate.
  const [dupJob, setDupJob] = useState<{ title: string; time: string | null; reason: string } | null>(null)
  useEffect(() => {
    if (!selectedPropertyId || !scheduledDate || !serviceType) { setDupJob(null); return }
    let active = true
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('jobs')
        .select('id, property_id, scheduled_date, service_type, recurrence_id, status, title, start_time')
        .eq('property_id', selectedPropertyId)
        .eq('scheduled_date', scheduledDate)
      if (!active) return
      const match = findJobMatch((data as JobLiteForMatch[]) || [], {
        propertyId: selectedPropertyId, date: scheduledDate, serviceType, excludeJobId,
      })
      setDupJob(match ? {
        title: match.job.title || match.job.service_type || 'a visit',
        time: match.job.start_time ?? null,
        reason: match.reason === 'recurrence-visit' ? 'this recurring series already has that visit' : 'same property, same day, same service',
      } : null)
    }, 300)
    return () => { active = false; clearTimeout(t) }
  }, [selectedPropertyId, scheduledDate, serviceType, excludeJobId, supabase])

  const customerOptions = [
    { value: '', label: 'Select a customer...' },
    ...customers.map(c => ({ value: c.id, label: c.name })),
  ]

  const propertyOptions = [
    { value: '', label: properties.length ? 'Select a property...' : 'No properties found' },
    ...properties.map(p => ({ value: p.id, label: p.address + (p.is_primary ? ' (primary)' : '') })),
  ]

  const endSummary =
    endMode === 'season' && seasonEndDate ? `ends at season end (${formatDate(seasonEndDate)})`
    : endMode === 'after' ? `ends after ${Math.max(1, endCount)} visit${endCount !== 1 ? 's' : ''}`
    : endMode === 'on' && endDate ? `until ${endDate}`
    : 'no end date (kept rolling on your calendar)'

  // Cadence for the Smart Labor estimate: this job's own repeat, else the
  // property's existing series cadence, else one-time. So a weekly mow's duration
  // learns from weekly mows.
  const laborCadence: Cadence = (() => {
    const iv = presetToInterval(preset, customUnit, customCount)
    if (iv) return intervalToCadence(iv)
    const s = propSeries[0]
    return s?.unit ? intervalToCadence({ unit: s.unit as RecurUnit, count: s.count || 1 }) : 'one_time'
  })()

  return (
    <form
      onSubmit={handleSubmit((values) => {
        // Quick-add never types a title — derive it from service + customer.
        if (!values.title?.trim()) {
          const cust = customers.find(c => c.id === values.customer_id)?.name
          values.title = `${values.service_type || 'Job'}${cust ? ` — ${cust}` : ''}`
        }
        const addAnother = addAnotherRef.current
        addAnotherRef.current = false
        return onSubmit(
          values,
          buildRecurrence(),
          { suggestedDate: null, suggestedNearby: null },
          { addAnother },
        )
      })}
      className="space-y-4"
    >
      <Controller name="customer_id" control={control}
        render={({ field }) => (
          <Select label="Customer" autoFocus options={customerOptions} {...field} />
        )} />

      <Input label="Service Type" placeholder="Your most common service"
        {...register('service_type')} />

      <div>
        <Input label="Price ($/visit)" type="number" step="5" min="0"
          hint={measuredPrice && measuredPrice > 0
            ? `Measured property: ${formatCurrency(measuredPrice)} ${cadenceForInterval === 'one_time' ? 'one-time' : cadenceForInterval} recommended.`
            : suggestedPrice ? `Leave 0 to use the linked quote (${formatCurrency(suggestedPrice)}). Type to override.` : 'Per-visit price — leave 0 if a linked quote sets it.'}
          {...register('price', { min: 0 })} />
        {measuredPrice != null && measuredPrice > 0 && (
          <button type="button" onClick={() => setValue('price', measuredPrice)}
            className="text-xs text-accent-text hover:underline mt-1.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            Use measured price ({formatCurrency(measuredPrice)})
          </button>
        )}
        {savedRec && measuredPrice != null && measuredPrice > 0 && (
          <p className="text-[11px] text-ink-faint mt-1">
            Calculated {formatDate(savedRec.date)}
            {recommendationIsStale(savedRec.date, Date.now()) && <span className="text-amber-400"> · ⚠ may be outdated, consider recalculating</span>}
          </p>
        )}
      </div>

      <Input label="Date" type="date"
        error={errors.scheduled_date?.message}
        {...register('scheduled_date', { required: 'Required' })} />

      {/* Duplicate-visit check (unified dedup engine) — one clear question, never blocks */}
      {dupJob && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
          <p className="text-xs text-amber-300 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>
              Existing match found — <span className="font-semibold">{dupJob.title}</span>
              {dupJob.time ? ` at ${dupJob.time}` : ''} is already booked ({dupJob.reason}).
              Save anyway only if this is deliberately a second visit.
            </span>
          </p>
        </div>
      )}

      {/* Soft cadence / customer-preference warnings — informational, never blocking */}
      {scheduleWarnings.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 space-y-1">
          {scheduleWarnings.map((w, i) => (
            <p key={i} className="text-xs text-amber-300 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" /> {w}
            </p>
          ))}
        </div>
      )}

      {(propCoord || selProp?.address) && (
        <div className="bg-bg-tertiary border border-border rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-ink-muted uppercase tracking-wide">
            <Sparkles className="w-3.5 h-3.5 text-accent-text" /> Plan this job into your week
          </div>
          <WeeklyScheduler
            coord={propCoord}
            address={selProp?.address ?? null}
            excludeJobId={excludeJobId}
            targetHours={(Number(watch('duration_minutes')) || 45) / 60}
            targetValue={Number(watch('price')) || suggestedPrice || 0}
            customerPreferredDays={effectivePrefs.preferredDays}
            customerAvoidDays={effectivePrefs.avoidDays}
            onPick={(date) => setValue('scheduled_date', date, { shouldValidate: true })}
          />
        </div>
      )}

      {!isEdit && (
        <button type="button" onClick={() => setShowMore(v => !v)}
          className="text-xs font-medium text-accent-text hover:underline">
          {showMore ? '− Fewer options' : '+ More options (property, time, crew, repeat, notes)'}
        </button>
      )}

      {adv && (
      <div className="space-y-4">
      {/* The real edit workflow: WHERE (property) → what STATE it's in → NOTES.
          Time/crew details and recurrence are rarer — they collapse below. */}
      <Controller name="property_id" control={control}
        render={({ field }) => (
          <Select label="Property" options={propertyOptions} {...field} />
        )} />

      <Controller name="status" control={control}
        render={({ field }) => (
          <Select label="Status" options={STATUS_OPTIONS} {...field} />
        )} />

      {status === 'completed' && (
        <Input label="Actual time on site (minutes)" type="number" min="0" step="5"
          hint="Captured for future pricing intelligence — planned vs. actual time."
          {...register('actual_minutes', { min: 0 })} />
      )}

      <Textarea label="Notes" placeholder="Access instructions, gate codes, special requests..."
        {...register('notes')} />
      {aiNotes.enabled === true && String(watch('notes') || '').trim() !== '' && (
        <div className="flex items-center gap-2 -mt-2">
          <AssistButton
            label={aiNotes.running ? 'Cleaning up…' : 'Clean up notes'}
            busy={aiNotes.running}
            title="Rewrites rough jottings into clear notes — keeps every gate code, instruction and detail exactly as written"
            onClick={async () => {
              const prior = String(watch('notes') || '')
              aiNotes.clearError()
              setValue('notes', '')
              const full = await aiNotes.run(
                { task: 'job_notes', draft: prior, serviceType: serviceType || undefined },
                { onDelta: d => setValue('notes', String(watch('notes') || '') + d) },
              )
              if (full === null) setValue('notes', prior)
            }} />
          {aiNotes.error && <p className="text-xs text-amber-400" role="alert">{aiNotes.error}</p>}
        </div>
      )}

      {/* Time & crew — expanded while creating (the smart duration suggestion
          matters then), a one-line summary when editing. */}
      <Collapsible title="Time & crew" icon={Clock} defaultOpen={!isEdit}
        summary={`${Number(watch('duration_minutes')) || 0}m · ${Number(watch('crew_size')) || 1} crew${watch('start_time') ? ` · ${watch('start_time')}` : ''}`}>
        <Input label="Job Title" placeholder="Auto-named from service + customer if blank"
          error={errors.title?.message}
          {...register('title')} />

        <div className="grid grid-cols-2 gap-4">
          <Input label="Duration (minutes)" type="number" step="1" min="0"
            {...register('duration_minutes', { min: 0 })} />
          <Input label="Crew Size" type="number" min="1"
            {...register('crew_size', { min: { value: 1, message: 'Min 1' } })} />
        </div>

        {/* Smart Labor Calculator V2 — learns duration from history; fills the field
            above (never overwrites a typed value, never affects price). */}
        <SmartLaborField
          sqft={Number(selProp?.lawn_sqft) || 0}
          serviceType={serviceType}
          crewSize={Number(watch('crew_size')) || 1}
          propertyId={selectedPropertyId || null}
          cadence={laborCadence}
          price={Number(watch('price')) || (measuredPrice ?? 0)}
          value={Number(watch('duration_minutes')) || null}
          onApply={(min) => setValue('duration_minutes', min, { shouldValidate: true })}
        />

        <div className="grid grid-cols-2 gap-4">
          <Input label="Start Time" type="time" {...register('start_time')} />
          <Input label="End Time" type="time" {...register('end_time')} />
        </div>
      </Collapsible>

      {/* Repeat — available for new AND existing jobs; collapses to its cadence
          summary when editing so it stops dominating the form. */}
      <Collapsible title="Repeat" icon={Repeat} defaultOpen={!isEdit}
        summary={interval ? `${recurrenceLabel(interval.unit, interval.count)} · ${endSummary}` : 'Does not repeat'}>
          <div className="space-y-3">
            {isEdit && (
              <p className="text-xs text-ink-faint">
                {initialRecurrence?.unit
                  ? 'This job repeats. Change the cadence, or pick “Does not repeat” to make it one-time — you’ll choose which visits it affects.'
                  : 'Turn this one-time job into a recurring schedule. The current job becomes the first visit.'}
              </p>
            )}

            {/* Duplicate recurring schedule warning */}
            {interval && showDuplicateWarning && duplicateSeries && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
                <p className="text-xs font-semibold text-amber-300 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  This property already has a recurring {category === 'snow' ? 'snow' : 'mowing'} schedule
                  {duplicateSeries.unit && <span className="font-normal text-ink-muted"> ({recurrenceLabel(duplicateSeries.unit as RecurUnit, duplicateSeries.count)})</span>}.
                </p>
                <div className="flex flex-wrap gap-2">
                  <a href={`/dashboard/customers/${customerId}`} target="_blank" rel="noopener noreferrer"
                    className="text-xs font-medium px-2.5 py-1 rounded-lg border border-border bg-surface text-ink hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                    View existing schedule
                  </a>
                  <button type="button" onClick={() => { setPreset('none'); setDupAck(true) }}
                    className="text-xs font-medium px-2.5 py-1 rounded-lg border border-border bg-surface text-ink hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                    Add one-time visit instead
                  </button>
                  <button type="button" onClick={() => setDupAck(true)}
                    className="text-xs font-medium px-2.5 py-1 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                    Create another schedule anyway
                  </button>
                </div>
              </div>
            )}

            {/* Season chip — what season this service belongs to. An owner-defined
                season resolves here too (category stays 'year_round' for those, so
                the old snow?/lawn binary called a Pool Opening a "Lawn service") —
                its own label wins, falling back to the binary only for the built-ins. */}
            {serviceSeason && (
              <p className="text-xs text-ink-muted flex items-center gap-1.5">
                {category === 'snow' ? <Snowflake className="w-3.5 h-3.5 text-sky-400" />
                  : category === 'lawn' ? <Sun className="w-3.5 h-3.5 text-amber-400" />
                  : <CalendarRange className="w-3.5 h-3.5 text-accent-text" />}
                {serviceSeason.label || (category === 'snow' ? 'Snow' : 'Lawn')} service · season {seasonLabel(serviceSeason)}
              </p>
            )}

            {/* One-click lawn-care presets (new jobs only) */}
            {!isEdit && (
            <div className="flex flex-wrap gap-2">
              {([
                { kind: 'weekly', label: 'Weekly Lawn Care' },
                { kind: 'biweekly', label: 'Bi-Weekly Lawn Care' },
                { kind: 'monthly', label: 'Monthly Service' },
              ] as const).map(p => (
                <button key={p.kind} type="button" onClick={() => applyCadencePreset(p.kind)}
                  className="text-xs font-medium px-3 py-1.5 rounded-lg border border-accent/30 bg-accent/10 text-accent-text hover:bg-accent/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                  {p.label}
                </button>
              ))}
            </div>
            )}

            {/* THE shared Select — same chevron/field tokens as every other dropdown. */}
            <Select label="Repeats" value={preset}
              onChange={(e) => setPreset(e.target.value as RepeatPreset)}
              options={PRESET_OPTIONS.map(o => ({ value: o.value, label: o.label }))} />

            {preset === 'custom' && (
              <div className="grid grid-cols-2 gap-4">
                <Input label="Every" type="number" min="1" value={customCount}
                  onChange={(e) => setCustomCount(Math.max(1, Number(e.target.value) || 1))} />
                <Select label="Unit" value={customUnit}
                  onChange={(e) => setCustomUnit(e.target.value as RecurUnit)}
                  options={[{ value: 'day', label: 'Days' }, { value: 'week', label: 'Weeks' }, { value: 'month', label: 'Months' }]} />
              </div>
            )}

            {preset !== 'none' && (
              <>
                <Select label="Ends" value={endMode}
                  onChange={(e) => { endTouched.current = true; setEndMode(e.target.value as EndMode) }}
                  options={[
                    ...(serviceSeason ? [{ value: 'season', label: 'Season end (recommended)' }] : []),
                    { value: 'on', label: 'Specific date' },
                    { value: 'after', label: 'Number of visits' },
                    { value: 'never', label: 'Never ends' },
                  ]} />
                {endMode === 'season' && (
                  <div className="rounded-xl border border-accent/20 bg-accent/5 px-3 py-2 flex items-center gap-2">
                    <CalendarRange className="w-4 h-4 text-accent-text shrink-0" />
                    <p className="text-xs text-ink">
                      Ends at season end{serviceSeason ? ` (${seasonLabel(serviceSeason)})` : ''}
                      {seasonEndDate ? <span className="text-ink-muted"> · {formatDate(seasonEndDate)}</span> : <span className="text-amber-400"> · set a start date to compute</span>}
                    </p>
                  </div>
                )}
                {endMode === 'on' && (
                  <Input label="End date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                )}
                {endMode === 'after' && (
                  <Input label="Number of visits" type="number" min="1" value={endCount}
                    onChange={(e) => setEndCount(Math.max(1, Number(e.target.value) || 1))} />
                )}
                {/* Live visit-count estimate — the ONE cadence restatement. */}
                {visitEstimate != null && visitEstimate > 0 && (
                  <p className="text-xs font-semibold text-accent-text">
                    {recurrenceLabel(interval!.unit, interval!.count)} · {scheduledDate ? formatDate(scheduledDate) : '?'} → {effectiveEndDate ? formatDate(effectiveEndDate) : '?'} · ≈ {visitEstimate} visit{visitEstimate !== 1 ? 's' : ''}
                  </p>
                )}
              </>
            )}
          </div>
      </Collapsible>
      </div>
      )}

      {/* Sticky save — reachable one-handed without scrolling past the form. */}
      <div className="sticky bottom-0 -mx-1 px-1 pt-2 pb-1 bg-bg-secondary/95 backdrop-blur border-t border-border flex items-center gap-2 flex-wrap">
        <Button type="submit" loading={isSubmitting} onClick={() => { addAnotherRef.current = false }}>
          {isEdit ? 'Update job' : 'Add job'}
        </Button>
        {allowAddAnother && (
          <Button type="submit" variant="secondary" onClick={() => { addAnotherRef.current = true }}>
            Save &amp; add another
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}
