'use client'

import { useEffect, useState, useRef } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { PropertySelect } from '@/components/ui/PropertySelect'
import { Textarea } from '@/components/ui/Textarea'
import { Button } from '@/components/ui/Button'
import { Customer, Property, JobFormValues, JobStatus, RecurUnit, Crew, Technician } from '@/types'
import { AssigneeSelect } from '@/components/schedule/AssigneeSelect'
import { assigneeOf, assigneeColumns } from '@/lib/crewAssignment'
import { formatCurrency, formatDate } from '@/lib/utils'
import { recurrenceLabel, recurrenceToUi, reseedRepeatUi, OPEN_ENDED_HORIZON, type RepeatPreset, type EndMode } from '@/lib/recurrence'
import { latestSavedRecommendation, savedPriceFor, recommendationIsStale, CadenceKey } from '@/lib/pricing'
import { servicePricingKind } from '@/lib/servicePricing'
// ⚠️ BOTH SIDES SURVIVE. S114 (main) added the pricingState imports; S110 (this
// branch) split the season imports in two — `seasonForService` no longer exists
// in lib/seasons at all, because resolving a season from a service NAME is the
// defect this branch removes. `serviceCategory` moved with the keyword lists to
// lib/legacySeasonInference, where it stays reachable for duplicate detection
// (grouping by trade) but can never resolve a season.
import { BLANK_NUMERIC_FIELD as BLANK, UNKNOWN_AMOUNT_TEXT } from '@/lib/pricingState'
import {
  ServiceSeasons, DEFAULT_SEASONS, settingsToSeasons,
  seasonEndDateFor, estimateSeasonVisits, seasonLabel,
  resolveSeriesSeason, seasonKeys, SEASON_NONE,
} from '@/lib/seasons'
import { serviceCategory } from '@/lib/legacySeasonInference'
import { WeeklyScheduler } from '@/components/schedule/WeeklyScheduler'
import { SmartEstimateCard } from '@/components/labor/SmartEstimateCard'
import { EstimatedVsActual } from '@/components/labor/EstimatedVsActual'
import { ServiceEstimateLearning } from '@/components/labor/ServiceEstimateLearning'
import { JobCostPanel } from '@/components/jobs/JobCostPanel'
import DurationField from '@/components/jobs/DurationField'
import WorkSessionsPanel from '@/components/jobs/WorkSessionsPanel'
import { formatDuration, workdayMinutes } from '@/lib/workDuration'
import { JobReferenceMedia } from '@/components/schedule/JobReferenceMedia'
import { CustomFieldsSection } from '@/components/customFields/CustomFieldsSection'
import { AUDIENCE_COPY } from '@/lib/noteScope'
import { loadCompletedVisitLearning, type LearningLoad } from '@/lib/estimateVsActualData'

import { resolvePrefs, type PrefSource } from '@/lib/preferences'
import { findJobMatch, type JobLiteForMatch } from '@/lib/dedup'
import { Collapsible } from '@/components/ui/Collapsible'
import { AssistButton, AiStop, AiUndo, AiError, AiNote } from '@/components/ai/ui'
import { toast } from '@/lib/toast'
import { useAiAssist } from '@/hooks/useAiAssist'
import { Repeat, Sparkles, Snowflake, Sun, AlertTriangle, CalendarRange, Clock } from 'lucide-react'

// Flexible recurrence: any interval (count + unit), three end modes.
export interface Recurrence {
  unit: RecurUnit | null // null = does not repeat
  count: number
  endDate: string | null
  endCount: number | null
  // True when the owner explicitly set the Ends control this session. Lets the
  // save distinguish "re-asserted the same end rule" (reconcile the series
  // against it — remove stray visits past the end) from "didn't touch it"
  // (leave deliberately-moved visits alone). Absent on rows hydrated from the
  // database (recFromRow), so an untouched save never reconciles by surprise.
  endAsserted?: boolean
  // True when the owner touched the Repeat controls this session. `unit: null`
  // means "does not repeat", and on a job that HAS a series that instruction
  // deletes sibling visits and the series row — so the save needs to know
  // whether a human chose it or whether it is simply what the control says when
  // nobody has spoken. Absent on rows hydrated from the database (recFromRow),
  // so an untouched save can never end a schedule. See planRecurrenceRemoval.
  repeatAsserted?: boolean
  /**
   * ⭐ WHICH SEASON governs this series — the owner's declaration, read from the
   * Season control. `null` means "not declared", which is a real, visible state
   * ("Needs selection") and is deliberately NOT the same as year-round
   * (`SEASON_NONE`).
   *
   * ⚠️ A caller may READ this today but must not WRITE it: the column
   * `job_recurrences.season_key` is proposed, not applied (supabase/proposals/).
   * It travels here so the save path is ready the moment the column lands.
   */
  seasonKey?: string | null
}

export interface SuggestionMeta {
  suggestedDate: string | null
  suggestedNearby: number | null
}

interface JobFormProps {
  customers: Customer[]
  /** Who work can be assigned to. Omit both and the form shows no "Assigned to"
   *  control and leaves assignment exactly as it found it. */
  crews?: Crew[]
  technicians?: Technician[]
  defaultValues?: Partial<JobFormValues>
  excludeJobId?: string
  // Existing series for the job being edited, so the Repeat controls pre-fill.
  initialRecurrence?: Recurrence
  /** `job_recurrences.start_date` of the series being edited. Season End is a
   *  property of the series, not of the visit under the editor, so it resolves
   *  from here — every visit in a series then agrees on one season end. */
  seriesStartDate?: string
  /** ⭐ The season this SERIES declares (job_recurrences.season_key). Absent
   *  until that column lands — see supabase/proposals/. When present it is
   *  authoritative and the service name is never consulted. */
  seriesSeasonKey?: string | null
  allowAddAnother?: boolean
  suggestedPrice?: number // quote-derived per-visit price, shown as the price hint
  /** True when the visit under the editor is linked to a quote. Drives the
   *  service-change disclosure: renaming the service NEVER re-prices the visit
   *  (price is the manual override or the quote-derived value — see
   *  lib/visitValue), and that fact is said out loud instead of assumed. */
  quoteLinked?: boolean
  /** Open the "More options" section immediately (edit mode) — the ?panel=time|cost
   *  deep links land on anchors that live inside it, and a door that opens onto a
   *  section that then has to be found and expanded has not saved anyone a tap. */
  initialMoreOpen?: boolean
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
  /** Whether anything has been typed that would be LOST on dismissal. The page
   *  owning this modal closes on a backdrop tap, on Escape and on the X; it asks
   *  first when this is true. Reported rather than inferred, because only the
   *  form knows — and unlike QuoteBuilder/CustomerForm there is no autosave here
   *  to fall back on. Covers BOTH react-hook-form fields AND the recurrence
   *  controls, which live outside RHF — a touched Repeat used to be discardable
   *  in silence. */
  onDirtyChange?: (dirty: boolean) => void
  isEdit?: boolean
}

const STATUS_OPTIONS: { value: JobStatus; label: string }[] = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
]


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


export function JobForm({ customers, crews, technicians, defaultValues, excludeJobId, initialRecurrence, seriesStartDate, seriesSeasonKey, allowAddAnother, suggestedPrice, quoteLinked, initialMoreOpen, warnFor, onSubmit, onCancel, onDirtyChange, isEdit }: JobFormProps) {
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
  const [seasonsLoaded, setSeasonsLoaded] = useState(false)
  // Minutes in ONE workday for this business. Seeded with the same 8h fallback
  // every other daily_capacity_hours reader uses, so the duration control is
  // never blank or wrong while settings are in flight.
  const [workdayMin, setWorkdayMin] = useState<number>(workdayMinutes(null))
  const [ownerId, setOwnerId] = useState<string | null>(null)
  // Existing recurring series on the selected property — for duplicate detection.
  const [propSeries, setPropSeries] = useState<{ id: string; service_type: string | null; unit: string | null; count: number | null }[]>([])
  const [dupAck, setDupAck] = useState(false) // owner chose "create anyway"

  const { register, handleSubmit, watch, setValue, control, formState: { errors, isSubmitting, isDirty, dirtyFields } } =
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
        // ⛔ WAS `price: 0`. Add Job opened with "$0" already typed into the
        // money field — so the fastest path through the form (accept the
        // defaults) produced a visit asserting it is worth nothing, and the
        // owner had no way to tell that apart from one they had actually priced
        // at zero. BLANK renders empty and the save path already turns a blank
        // into NULL, which on `jobs` correctly means "no job-level price".
        // Same constant and the same reasoning as QuoteBuilder's money fields.
        price: BLANK,
        crew_id: null,
        technician_id: null,
        ...defaultValues,
      },
    })

  // The recurrence controls live OUTSIDE react-hook-form, so isDirty alone
  // cannot see them: an owner who only touched Repeat and then brushed the
  // backdrop was silently discarded. State (not just the refs below) so the
  // dirty report and the Unsaved-changes indicator re-render when it flips.
  const [recDirty, setRecDirty] = useState(false)

  // Tell the owner of this modal whether there is anything to lose. react-hook-form's
  // isDirty is the honest signal for the fields: false for a freshly-opened form and
  // for one whose values were only PREFILLED, true the moment a human types.
  // recDirty covers the Repeat/Ends controls, which RHF cannot see.
  useEffect(() => { onDirtyChange?.(isDirty || recDirty) }, [isDirty, recDirty, onDirtyChange])

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
  // Edit mode: the primary section IS the whole common path (customer, location,
  // service, date, time window, duration, assignee, status, note). Everything
  // else waits behind one disclosure. Opens immediately when a ?panel= deep link
  // is landing on an anchor inside it.
  const [showMoreEdit, setShowMoreEdit] = useState(!!initialMoreOpen)

  const customerId = watch('customer_id')
  const status = watch('status')
  const selectedPropertyId = watch('property_id')
  // AI notes cleanup — tidies the owner's jottings; every fact stays theirs.
  const aiNotes = useAiAssist()
  const [aiNotesPrior, setAiNotesPrior] = useState<string | null>(null)
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
  // The service's season (lawn/snow), if any, and the season-end date for the
  // series this visit belongs to.
  // ⭐ THE DECLARATION WINS. resolveSeriesSeason reads the series' own
  // season_key first and only falls back to the legacy name guess when no
  // declaration exists — so renaming a service can never change when it runs.
  // Until job_recurrences.season_key lands (see supabase/proposals/) there is no
  // key to pass, so this resolves exactly as before for every live series; what
  // changes is that the seam now exists and the guard pins declaration-wins.
  // ⭐ THE DECLARATION IS A CONTROL, not a hidden column. The owner picks the
  // season here; nothing infers it from the service name. Seeded from the
  // series' stored key, empty when the series has never declared one.
  const [seasonKeyChoice, setSeasonKeyChoice] = useState<string>(seriesSeasonKey ?? '')
  useEffect(() => { setSeasonKeyChoice(seriesSeasonKey ?? '') }, [seriesSeasonKey])
  const seasonResolution = resolveSeriesSeason({ seasonKey: seasonKeyChoice || null }, seasons)
  const serviceSeason = seasonResolution.season
  // ⚠️ UNKNOWN IS NOT YEAR-ROUND. An undeclared series must say so out loud —
  // rendering it as "no season" is exactly how a series ran through winter
  // without anybody choosing that.
  const seasonNeedsSelection = seasonResolution.source === 'unknown'
  const category = serviceCategory(serviceType)
  // Season End is a property of the SERIES, so it resolves from the series'
  // start date — not from whichever visit happens to be open. An open-ended
  // series pre-creates a rolling horizon of visits, so visits PAST the season
  // end already exist on the calendar; picking "Season end" while standing on
  // one of those resolved seasonEndDateFor's "you must mean next season" branch
  // and stored NEXT year's end, which is no cutoff at all — the November visits
  // the owner was looking at stayed exactly where they were. Falls back to the
  // job's own date for a new series, where that date IS the start.
  const seasonAnchorDate = seriesStartDate || scheduledDate
  const seasonEndDate = serviceSeason && seasonAnchorDate ? seasonEndDateFor(seasonAnchorDate, serviceSeason) : null
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

  // The Repeat controls are seeded from `initialRecurrence` in useState
  // initializers, which read it ONCE. The schedule page opens this modal from a
  // ?focus= deep link the moment `jobs` arrives — which can be BEFORE the
  // `recurrences` map it looks the series up in. A recurring job then rendered
  // as "Does not repeat" and STAYED that way, because nothing re-read the prop;
  // saving took the form at its word and removed the series, deleting every
  // sibling visit. Re-seed once the series actually arrives, and only while the
  // owner has not touched the controls, so a deliberate "Does not repeat" is
  // never overwritten by a late-arriving prop.
  // What to re-seed is lib/recurrence.reseedRepeatUi's call, not this effect's —
  // the rule ("only while untouched") is the load-bearing half and belongs where
  // a guard can exercise it.
  const repeatTouched = useRef(false)
  // ONE way to say "a human touched Repeat/Ends": the intent refs the save
  // reads (repeatAsserted/endAsserted) and the dirty state the discard guard
  // reads flip together, so they can never disagree.
  function markRepeatTouched() { repeatTouched.current = true; setRecDirty(true) }
  function markEndTouched() { endTouched.current = true; setRecDirty(true) }
  useEffect(() => {
    const next = reseedRepeatUi(initialRecurrence, { repeat: repeatTouched.current, end: endTouched.current })
    if (next.repeat) {
      setPreset(next.repeat.preset)
      setCustomUnit(next.repeat.customUnit)
      setCustomCount(next.repeat.customCount)
    }
    if (next.end) {
      setEndMode(next.end.endMode)
      setEndDate(next.end.endDate)
      setEndCount(next.end.endCount)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRecurrence?.unit, initialRecurrence?.count, initialRecurrence?.endDate, initialRecurrence?.endCount])

  useEffect(() => {
    if (isEdit || endTouched.current) return
    setEndMode(serviceSeason ? 'season' : 'never')
  }, [serviceSeason, isEdit])

  // Editing: RECOGNISE a stored end date that IS this service's season end, and
  // show it as "Season end" rather than a bare "Specific date". Season End is
  // stored as a plain end_date (the engine needs no season awareness), so
  // without this the mode could never survive a reload — the owner picked
  // "Season end", reopened the job, saw "Specific date", and reasonably
  // concluded the save was lost. Derived, not stored: the season config +
  // end_date remain the only truth, so the two can never disagree. Only while
  // the control is untouched, and only an EXACT match against the owner's
  // LOADED season config — matching against the pre-load Calgary defaults
  // could claim "Season end" for a hand-picked date, and season mode re-derives
  // its date on save, so that claim would silently rewrite the stored end.
  useEffect(() => {
    if (!isEdit || !seasonsLoaded || endTouched.current) return
    if (endMode === 'on' && endDate && seasonEndDate && endDate === seasonEndDate) setEndMode('season')
  }, [isEdit, seasonsLoaded, endMode, endDate, seasonEndDate])

  // Saved measurement recommendation for the selected property — the pricing
  // source of truth. Maps the chosen cadence to its measured price (same custom-
  // cadence mapping as effectiveFreq: 3wk≈biweekly, 4wk+≈monthly).
  const savedRec = latestSavedRecommendation(selProp?.measurement_history)
  const cadenceForInterval: CadenceKey = !interval ? 'one_time'
    : interval.unit === 'month' || (interval.unit === 'week' && interval.count >= 4) ? 'monthly'
    : interval.unit === 'week' && interval.count === 1 ? 'weekly'
    : 'biweekly'
  // A SavedRecommendation is a GRASS cadence price list — buildSavedRecommendation
  // wraps pricingPackage — and carries no record of the service it was computed
  // for. So on a property whose lawn was measured once, scheduling ANY recurring
  // job (snow, an HVAC service plan, a window clean) offered "Use measured price"
  // and silently auto-filled the MOWING price for that cadence. Gate on the same
  // ONE seam the quote builder uses. There is no template object here — service_type
  // is free text — so servicePricingKind falls back to its name normalizer, which
  // is precisely what that fallback exists for.
  const lawnService = servicePricingKind(watch('service_type'), null) === 'lawn_recurring'
  const measuredPrice = savedRec && lawnService ? savedPriceFor(savedRec.rec, cadenceForInterval) : null

  function buildRecurrence(): Recurrence {
    // The `!interval` branch is the destructive one — it is what the page reads
    // as "remove this series" — so it carries the intent flag too.
    if (!interval) return { unit: null, count: 1, endDate: null, endCount: null, repeatAsserted: repeatTouched.current }
    return {
      unit: interval.unit,
      count: interval.count,
      repeatAsserted: repeatTouched.current,
      // Season End resolves to the season's end DATE (stored as a normal end_date,
      // so the recurrence engine needs no season awareness).
      endDate: endMode === 'season' ? seasonEndDate : (endMode === 'on' && endDate ? endDate : null),
      endCount: endMode === 'after' ? Math.max(1, endCount) : null,
      // ⭐ The declaration travels with the series. Persisting it waits on
      // job_recurrences.season_key (supabase/proposals/); until then a caller
      // may read it but must not write a column that does not exist.
      seasonKey: seasonKeyChoice || null,
      endAsserted: endTouched.current,
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
    markRepeatTouched()
    setPreset(kind === 'weekly' ? 'w1' : kind === 'biweekly' ? 'w2' : 'm1')
    const svc = (watch('service_type') || '').trim() || learnedService || ''
    if (svc) {
      setValue('service_type', svc)
      if (!watch('title')) {
        setValue('title', svc + (selProp?.address ? ` — ${selProp.address}` : ''))
      }
    }
    // Selecting Weekly/Bi-Weekly/Monthly auto-suggests the measured price for
    // that cadence (only when the price hasn't been typed yet, and only for a
    // lawn-cadence service — see `lawnService`; the saved rec is a mowing price
    // list, and this fill is silent, so an ungated one put grass prices on a snow
    // route with nothing on screen to explain where the number came from).
    const rec = latestSavedRecommendation(selProp?.measurement_history)
    if (rec && lawnService && !(Number(watch('price')) > 0)) {
      setValue('price', savedPriceFor(rec.rec, kind))
    }
  }

  // What past visits of this service taught. Read ONCE when the form opens.
  //
  // It used to be gated on `status === 'completed'`, which was right when the
  // only reader was the estimate-vs-actual block on a finished visit. The smart
  // estimate reads the same history while the visit is still being PLANNED —
  // that is the whole point of an estimate — so the gate silently starved it and
  // the card rendered nothing at all on every new job. (Caught by driving the
  // real form, not by any source check: both halves were individually correct.)
  //
  // `null` means still loading and renders nothing. Every FAILURE, including a
  // thrown auth call, resolves to an explicit `unavailable` rather than being
  // left as null: silence would let a broken read look identical to a business
  // that simply has no history.
  const [learningLoad, setLearningLoad] = useState<LearningLoad | null>(null)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        const load = await loadCompletedVisitLearning(supabase, user?.id ?? '')
        if (!cancelled) setLearningLoad(load)
      } catch (e) {
        if (!cancelled) setLearningLoad({ outcome: 'unavailable', reason: String(e) })
      }
    })()
    return () => { cancelled = true }
    // `supabase` is the cached browser singleton, so this runs once per form.
    // Status is deliberately NOT a dependency: marking a visit done must not
    // re-read the history it is about to become part of.
  }, [supabase])

  // Load configured service seasons once (falls back to Calgary defaults), plus
  // the length of this business's WORKDAY — the same daily_capacity_hours the
  // calendar's capacity bar and every scheduling engine read. It is what makes
  // "2 workdays" mean 12 hours to a cleaning business on 6-hour days and 20 to a
  // crew on 10-hour ones. ⛔ Never 24, and never hard-coded here.
  useEffect(() => {
    async function loadSeasons() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      setOwnerId(user.id)
      const { data } = await supabase.from('business_settings')
        .select('service_seasons, daily_capacity_hours').eq('user_id', user.id).maybeSingle()
      const s = data as { service_seasons: unknown; daily_capacity_hours: number | null } | null
      setSeasons(settingsToSeasons(s?.service_seasons))
      setWorkdayMin(workdayMinutes(s?.daily_capacity_hours))
      setSeasonsLoaded(true)
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

  const endSummary =
    endMode === 'season' && seasonEndDate ? `ends at season end (${formatDate(seasonEndDate)})`
    : endMode === 'after' ? `ends after ${Math.max(1, endCount)} visit${endCount !== 1 ? 's' : ''}`
    : endMode === 'on' && endDate ? `until ${endDate}`
    // Nothing tops a series up, so "no end date" is a fixed horizon, not a
    // rolling one. Says the number the engine will actually create.
    : `no end date — ${OPEN_ENDED_HORIZON} visits scheduled ahead`

  // ── Composable blocks ────────────────────────────────────────────────────────
  // The SAME controls serve two layouts: the quick-add/create flow (unchanged)
  // and the compact edit flow (common path up front, everything else behind ONE
  // "More options" disclosure). One definition per control, composed per mode —
  // never two implementations of the same field.

  // WHO is coming — a different question from how MANY (crew size), and the
  // one that decides whose phone this visit lands on. THE chooser is
  // AssigneeSelect (lib/crewAssignment): crew XOR person, both columns moving
  // together so a visit can never carry two answers. Only rendered when the
  // caller supplied the roster; a form without it saves assignment unchanged
  // rather than silently unassigning.
  const assigneeField = (crews?.length || technicians?.length) ? (
    <Controller name="crew_id" control={control}
      render={({ field: crewField }) => (
        <Controller name="technician_id" control={control}
          render={({ field: techField }) => (
            <AssigneeSelect
              crews={crews ?? []}
              technicians={technicians ?? []}
              value={assigneeOf({ crew_id: crewField.value ?? null, technician_id: techField.value ?? null })}
              onChange={next => {
                // Both columns move together — that is what keeps one
                // visit from carrying two answers.
                const cols = assigneeColumns(next)
                crewField.onChange(cols.crew_id)
                techField.onChange(cols.technician_id)
              }}
            />
          )} />
      )} />
  ) : null

  const priceBlock = (
    <div>
      {/* ⛔ The hint used to say "leave 0", which taught the owner that zero was
          the way to say "I haven't decided" — and the save then wrote NULL
          anyway. Two different sentences for one action, one of which was
          untrue. It now says LEAVE IT BLANK, which is what the field does and
          what the row records. */}
      <Input label="Price ($/visit)" type="number" step="5" min="0"
        placeholder={UNKNOWN_AMOUNT_TEXT}
        hint={measuredPrice && measuredPrice > 0
          ? `Measured property: ${formatCurrency(measuredPrice)} ${cadenceForInterval === 'one_time' ? 'one-time' : cadenceForInterval} recommended.`
          : suggestedPrice ? `Leave blank to use the linked quote (${formatCurrency(suggestedPrice)}). Type to override.` : 'Per-visit price — leave blank if a linked quote sets it, or if it is not priced yet.'}
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
  )

  const dupWarnBlock = dupJob ? (
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
  ) : null

  const schedWarnBlock = scheduleWarnings.length > 0 ? (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 space-y-1">
      {scheduleWarnings.map((w, i) => (
        <p key={i} className="text-xs text-amber-300 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" /> {w}
        </p>
      ))}
    </div>
  ) : null

  const weeklyPlannerCard = (propCoord || selProp?.address) ? (
    <div className="bg-bg-tertiary border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2 text-xs font-semibold text-ink-muted uppercase tracking-wide">
        <Sparkles className="w-3.5 h-3.5 text-accent-text" /> Plan this job into your week
      </div>
      <WeeklyScheduler
        coord={propCoord}
        address={selProp?.address ?? null}
        excludeJobId={excludeJobId}
        // NULL when the owner hasn't sized the job — the scheduler resolves
        // it against learned service history, or says "duration unknown".
        // (This used to coerce unknown to 45 minutes, which is how an
        // unsized job got a confident day recommendation.)
        durationMinutes={Number(watch('duration_minutes')) > 0 ? Number(watch('duration_minutes')) : null}
        crewSize={Number(watch('crew_size')) > 0 ? Number(watch('crew_size')) : null}
        serviceType={watch('service_type') || null}
        targetValue={Number(watch('price')) || suggestedPrice || 0}
        customerPreferredDays={effectivePrefs.preferredDays}
        customerAvoidDays={effectivePrefs.avoidDays}
        onPick={(date) => setValue('scheduled_date', date, { shouldValidate: true })}
      />
    </div>
  ) : null

  /* WHERE the work happens. Hidden under "+ More options" on a new job, while
     the loader silently pre-selected the customer's primary — so a customer with
     two addresses got one chosen for them, out of sight, and the only symptom is
     a crew at the wrong house. Whenever there's an actual choice to make
     (2+ addresses) it's shown up front; a one-property customer has nothing to
     decide, so it stays collapsed exactly as before. On EDIT the location is
     part of the common path and always shows. */
  const propertyField = (
    <Controller name="property_id" control={control}
      render={({ field }) => (
        <PropertySelect
          label={properties.length > 1 ? 'Property *' : 'Property'}
          properties={properties}
          value={field.value || ''}
          onChange={field.onChange}
          customerId={customerId || null}
          onCreated={(p: Property) => setProperties(prev => [...prev, p])}
          hint={properties.length > 1 ? 'This customer has more than one address — pick the one this visit is for.' : undefined}
        />
      )} />
  )

  const statusField = (
    <Controller name="status" control={control}
      render={({ field }) => (
        <Select label="Status" options={STATUS_OPTIONS} {...field} />
      )} />
  )

  const titleField = (
    <Input label="Job Title" placeholder="Auto-named from service + customer if blank"
      error={errors.title?.message}
      {...register('title')} />
  )

  const durationField = (
    /* Duration is a VALUE + a UNIT — 45 minutes, 2 hours, 3 workdays — and
       still one stored integer of minutes. The unit is how it is spoken,
       not a second fact: see lib/workDuration. Stacked rather than in the
       old 2-up grid because the control is itself two fields, and three
       boxes on one line is unusable at 375px. */
    <Controller name="duration_minutes" control={control}
      render={({ field }) => (
        <DurationField
          label="Duration"
          workdayMin={workdayMin}
          value={Number(field.value) > 0 ? Number(field.value) : null}
          onChange={m => field.onChange(m ?? '')}
        />
      )} />
  )

  const crewSizeField = (
    <Input label="Crew Size" type="number" min="1"
      hint="How many people are on site at once. Duration stays the time on site — two people for an hour is one hour, not two."
      {...register('crew_size', { min: { value: 1, message: 'Min 1' } })} />
  )

  const smartEstimate = (
    /* What this kind of work has actually taken. Built on the SAME learning
       engine the estimate-vs-actual comparison uses and the SAME duration rule
       Day Suggestions fits a candidate with, so the card, the history and
       "fits Tuesday" can never quote different numbers.

       It replaces the sqft-per-1000 labour widget on this form, which could
       not describe the work this session is about: its output was clamped
       to 240 minutes (a two-day project was unrepresentable), it rendered
       nothing at all without a lawn measurement, it reported a percentage
       confidence, and its buckets were keyword tables. That engine still
       serves the quote builder's pricing help, which is frozen — this form
       is scheduling, and scheduling asks a different question.

       ⭐ It only ever SUGGESTS. Applying is a button; nothing here writes
       duration_minutes on its own, so a saved visit's duration is never
       silently re-estimated when the learner moves. */
    <SmartEstimateCard
      load={learningLoad}
      serviceType={serviceType}
      excludeJobId={excludeJobId || undefined}
      value={Number(watch('duration_minutes')) || null}
      onApply={(min) => setValue('duration_minutes', min, { shouldValidate: true })}
    />
  )

  const timeWindowGrid = (
    <div className="grid grid-cols-2 gap-4">
      <Input label="Start Time" type="time" {...register('start_time')} />
      <Input label="End Time" type="time" {...register('end_time')} />
    </div>
  )

  const workPanels = (
    <>
      {/* ⭐ WORK HISTORY — every day this job was worked, and the door to add one
          by hand. Shown for a job that is UNDERWAY as well as one that is
          finished: recording "worked 3h today" is the whole point of the feature
          and must not require pretending the job is done first.

          Only on a SAVED visit — a work session needs a job id to point at, and
          there is none until the visit exists. */}
      {/* id: the landing target for the + sheet's "Work time" door
          (?job=<id>&panel=time — lib/quickAdd owns the vocabulary). It lives on
          the wrapper rather than inside the panel so the anchor belongs to the
          form that decides whether the panel exists at all. */}
      {isEdit && excludeJobId && ownerId && (status === 'in_progress' || status === 'completed') && (
        <div id="job-work-sessions" className="scroll-mt-4">
        <WorkSessionsPanel
          job={{ id: excludeJobId, user_id: ownerId, crew_size: Number(watch('crew_size')) || 1 }}
          // The total the DATABASE computed, not one this form worked out. Kept
          // in the form so the estimate-vs-actual comparison below re-reads
          // against the same number every other surface shows.
          onTotalChange={m => setValue('actual_minutes', m ?? 0, { shouldValidate: false })} />
        </div>
      )}

      {status === 'completed' && (
        <div className="space-y-2.5">
          {/* The raw total is typed by hand ONLY where no session can exist yet:
              a visit being CREATED as already-completed. On a saved job the
              database holds this equal to the sum of its work sessions, so an
              editable box here would be a control whose value is overruled the
              moment it is saved — the panel above is the honest door. */}
          {!isEdit && (
            <Input label="Actual time on site (minutes)" type="number" min="0" step="5"
              hint="Captured for future pricing intelligence — planned vs. actual time."
              {...register('actual_minutes', { min: 0 })} />
          )}
          {/* The comparison sits directly under the field that feeds it, so the
              answer to "was I close?" appears as the number is typed rather than
              on some report the owner has to go looking for. All arithmetic and
              every honesty rule live in lib/estimateVsActual. */}
          <EstimatedVsActual
            visit={{
              id: excludeJobId || 'current',
              status,
              service_type: serviceType || null,
              duration_minutes: Number(watch('duration_minutes')) || null,
              actual_minutes: Number(watch('actual_minutes')) || null,
            }} />
          {/* …and directly under it, what this service usually does. The visit
              being edited is excluded from its own history so the "typical" it
              is measured against is genuinely other work. */}
          {learningLoad && (
            <ServiceEstimateLearning
              load={learningLoad}
              serviceType={serviceType || null}
              excludeJobId={excludeJobId || undefined} />
          )}
          {/* …and finally what it COST. Time sits above it because time is what
              this visit already knows; cost is what somebody has to record.
              Only on a SAVED visit: an expense needs a job id to point at, and
              there is none until the visit exists. Creating one is not the
              moment to think about receipts anyway. */}
          {/* id: the landing target for the + sheet's "Cost" door
              (?job=<id>&panel=cost). Offered only on a completed visit, which is
              exactly the condition this block already carries — lib/quickAdd
              refuses to list the door on any other status rather than sending a
              tap to a panel that isn't mounted. */}
          {isEdit && excludeJobId && (
            <div id="job-cost" className="scroll-mt-4">
            <JobCostPanel
              job={{
                id: excludeJobId,
                status,
                service_type: serviceType || null,
                actual_minutes: Number(watch('actual_minutes')) || null,
                crew_size: Number(watch('crew_size')) || null,
              }} />
            </div>
          )}
        </div>
      )}
    </>
  )

  const notesBlock = (
    <>
      {/* ⭐ THE AUDIENCE, SAID OUT LOUD. This field goes to the phone of whoever
          works the visit (crew_day ships it as stops[].notes) and to nobody
          else — it was removed from get_portal_data on 2026-08-11 after 49 of
          78 completed visits rendered their gate codes in the customer's
          history. The label used to be a bare "Notes", which is the same word
          the quote form used for a field that PRINTS. Two opposite audiences
          cannot share one word. */}
      <Textarea label={AUDIENCE_COPY.crew.label} hint={AUDIENCE_COPY.crew.help}
        placeholder="Use the east gate · park on the street · don't prune the lilac"
        {...register('notes')} />
      {aiNotes.enabled === true && String(watch('notes') || '').trim() !== '' && (
        <div className="-mt-2 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <AssistButton
              label="Tidy up"
              busyLabel="Tidying…"
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
                if (full === null) { setValue('notes', prior); return }
                setAiNotesPrior(prior)
                toast.undo('Tidied your notes.', () => { setValue('notes', prior); setAiNotesPrior(null) })
              }} />
            {aiNotes.running && <AiStop onClick={aiNotes.cancel} />}
            {!aiNotes.running && aiNotesPrior !== null && (
              <AiUndo onClick={() => { setValue('notes', aiNotesPrior); setAiNotesPrior(null) }} />
            )}
          </div>
          <AiError message={aiNotes.error} />
          {/* No check-it-first note: these notes are for whoever does the work,
              not for the customer. The explanation still matters — this is the
              one tool whose whole job is to change nothing factual. */}
          {!aiNotes.running && aiNotesPrior !== null && (
            <AiNote explain="Tidied your own words — every gate code, digit and instruction is kept exactly as you wrote it." />
          )}
        </div>
      )}
    </>
  )

  const referenceMedia = (
    /* The same instruction, shown rather than described. Sits directly under
       the note because "use the east gate" and a photo of the east gate are
       one thought, not two features. On CREATE there is no visit to attach a
       file to yet, and the component says so instead of offering a control
       that would fail. */
    <JobReferenceMedia jobId={isEdit ? (excludeJobId || null) : null} />
  )

  /* Whatever this business records per visit — a permit number, a PO. EDIT ONLY:
     an answer is stored against a visit's id, and on create there is no visit yet
     to answer about. Same rule as the reference media above.
     ⚠️ A `jobs` row is one VISIT, so a recurring series' visits each carry their
     own answer — there is no series-level custom field in V1. */
  const customFields = isEdit && excludeJobId ? (
    <CustomFieldsSection entity="job" recordId={excludeJobId} bare className="pt-1" />
  ) : null

  const repeatSection = (
    /* Repeat — available for new AND existing jobs; collapses to its cadence
       summary when editing so it stops dominating the form. */
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
                <button type="button" onClick={() => { markRepeatTouched(); setPreset('none'); setDupAck(true) }}
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
              { kind: 'weekly', label: 'Weekly' },
              { kind: 'biweekly', label: 'Every 2 weeks' },
              { kind: 'monthly', label: 'Monthly' },
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
            onChange={(e) => { markRepeatTouched(); setPreset(e.target.value as RepeatPreset) }}
            options={PRESET_OPTIONS.map(o => ({ value: o.value, label: o.label }))} />

          {preset === 'custom' && (
            <div className="grid grid-cols-2 gap-4">
              <Input label="Every" type="number" min="1" value={customCount}
                onChange={(e) => { markRepeatTouched(); setCustomCount(Math.max(1, Number(e.target.value) || 1)) }} />
              <Select label="Unit" value={customUnit}
                onChange={(e) => { markRepeatTouched(); setCustomUnit(e.target.value as RecurUnit) }}
                options={[{ value: 'day', label: 'Days' }, { value: 'week', label: 'Weeks' }, { value: 'month', label: 'Months' }]} />
            </div>
          )}

          {preset !== 'none' && (
            <>
              {/* ⭐ WHICH SEASON GOVERNS THIS SERIES — declared, never guessed.
                  Shown whenever a series is being configured, because a season
                  that only exists in a column is a season the owner cannot
                  check. "Needs selection" is a real state and is never silently
                  treated as year-round. */}
              <Select label="Season" value={seasonKeyChoice}
                onChange={(e) => { setRecDirty(true); setSeasonKeyChoice(e.target.value) }}
                options={[
                  { value: '', label: 'Needs selection' },
                  ...seasonKeys(seasons).map(k => ({
                    value: k,
                    label: `${seasons[k].label ?? k} · ${seasonLabel(seasons[k])}`,
                  })),
                  { value: SEASON_NONE, label: 'Year-round (no season)' },
                ]} />
              {seasonNeedsSelection && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 flex items-start gap-2">
                  <CalendarRange className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-200">
                    No season is set for this series, so nothing stops it from repeating out of
                    season. Choose the season it runs in, or <span className="font-semibold">Year-round</span> if
                    it genuinely runs all year.
                  </p>
                </div>
              )}
              <Select label="Ends" value={endMode}
                onChange={(e) => { markEndTouched(); setEndMode(e.target.value as EndMode) }}
                options={[
                  ...(serviceSeason ? [{ value: 'season', label: 'Season end (recommended)' }] : []),
                  { value: 'on', label: 'Specific date' },
                  { value: 'after', label: 'Number of visits' },
                  { value: 'never', label: 'No end date' },
                ]} />
              {/* "Never ends" promised something no engine delivers: there is no
                  top-up, so the series is exactly this many visits long. */}
              {endMode === 'never' && (
                <div className="rounded-xl border border-border bg-bg-tertiary px-3 py-2 flex items-center gap-2">
                  <CalendarRange className="w-4 h-4 text-ink-muted shrink-0" />
                  <p className="text-xs text-ink-muted">
                    {OPEN_ENDED_HORIZON} visits are scheduled ahead. Add more when they run low.
                  </p>
                </div>
              )}
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
                <Input label="End date" type="date" value={endDate} onChange={(e) => { setRecDirty(true); setEndDate(e.target.value) }} />
              )}
              {endMode === 'after' && (
                <Input label="Number of visits" type="number" min="1" value={endCount}
                  onChange={(e) => { setRecDirty(true); setEndCount(Math.max(1, Number(e.target.value) || 1)) }} />
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
  )

  // The quick-add/create flow's ONE disclosure state (unchanged behaviour).
  const adv = showMore

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

      {/* Location is part of the common path when EDITING — moving a visit to the
          customer's other address should not require opening anything. */}
      {isEdit && propertyField}

      <Input label="Service Type" placeholder="Your most common service"
        {...register('service_type')} />

      {/* ── Financial truth, said where the edit happens ──────────────────────
          Renaming the service NEVER re-prices the visit: the price is either the
          manual override or the value derived from the linked quote
          (lib/visitValue), and neither follows the service name. Without this
          line the owner reasonably assumes "new service = new price" — and the
          silence would let a mislabelled amount reach an invoice. */}
      {isEdit && quoteLinked && dirtyFields.service_type && (
        <p className="text-xs text-sky-300 -mt-2.5 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span>The linked quote still sets the price{suggestedPrice ? ` (${formatCurrency(suggestedPrice)}/visit)` : ''} — changing the service changes the label, never the amount. Use the Price field under More options to re-price.</span>
        </p>
      )}

      {/* Create keeps price in the fast path (quick-add is customer/service/
          price/date); editing moves it behind More options — price edits are
          rare, financially coupled, and have their own doors on the day board. */}
      {!isEdit && priceBlock}

      <Input label="Date" type="date"
        error={errors.scheduled_date?.message}
        {...register('scheduled_date', { required: 'Required' })} />

      {/* Duplicate-visit check (unified dedup engine) — one clear question, never blocks */}
      {dupWarnBlock}

      {/* Soft cadence / customer-preference warnings — informational, never blocking */}
      {schedWarnBlock}

      {isEdit ? (
        <>
          {/* ── The compact common path: time window, duration, assignee, status,
                 note. Everything an owner changes constantly, no disclosure in
                 the way, no card borders around single fields. */}
          {timeWindowGrid}
          {durationField}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {assigneeField}
            {statusField}
          </div>
          {notesBlock}

          <button type="button" onClick={() => setShowMoreEdit(v => !v)}
            aria-expanded={showMoreEdit}
            className="text-xs font-medium text-accent-text hover:underline">
            {showMoreEdit ? '− Fewer options' : '+ More options (price, title, crew size, repeat, work history, photos)'}
          </button>

          {showMoreEdit && (
            <div className="space-y-4 animate-fade">
              {titleField}
              {priceBlock}
              {crewSizeField}
              {smartEstimate}
              {weeklyPlannerCard}
              {workPanels}
              {referenceMedia}
              {customFields}
              {repeatSection}
            </div>
          )}
        </>
      ) : (
        <>
          {weeklyPlannerCard}

          <button type="button" onClick={() => setShowMore(v => !v)}
            className="text-xs font-medium text-accent-text hover:underline">
            {showMore ? '− Fewer options' : '+ More options (property, time, crew, repeat, notes)'}
          </button>

          {(adv || properties.length > 1) && propertyField}

          {adv && (
          <div className="space-y-4">
          {statusField}

          {workPanels}

          {notesBlock}

          {referenceMedia}

          {/* Time & crew — expanded while creating (the smart duration suggestion
              matters then). */}
          <Collapsible title="Time & crew" icon={Clock} defaultOpen
            summary={`${formatDuration(Number(watch('duration_minutes')), workdayMin) || 'Not sized'} · ${Number(watch('crew_size')) || 1} crew${watch('start_time') ? ` · ${watch('start_time')}` : ''}`}>
            {titleField}
            {durationField}
            {crewSizeField}
            {assigneeField}
            {smartEstimate}
            {timeWindowGrid}
          </Collapsible>

          {repeatSection}
          </div>
          )}
        </>
      )}

      {/* Sticky save — reachable one-handed without scrolling past the form.
          The save state is SAID, not implied: while anything differs from the
          loaded row the bar says so; nothing is written until Update is tapped. */}
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
        {isEdit && (isDirty || recDirty) && !isSubmitting && (
          <span role="status" className="ml-auto text-xs text-amber-400 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" aria-hidden="true" />
            Unsaved changes
          </span>
        )}
      </div>
    </form>
  )
}
