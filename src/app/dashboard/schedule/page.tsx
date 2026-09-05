'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { AddonTemplate, Customer, Job, JobFormValues, JobLineItem, Quote, RecurrenceScope, RecurUnit } from '@/types'
// UI defaults only (add-on quick-chips) — engines never import lib/trades; this
// page is on verify:trades' reviewed allowlist for exactly this consumption.
import { tradePack, NEUTRAL_PACK } from '@/lib/trades'
import { listLineItemsByJob, addLineItems, deleteLineItem, recordPriceChange, addonsTotal, normalizeServiceKey } from '@/lib/jobPricing'
import {
  ChangeOrder, listChangeOrders, createChangeOrder, sendChangeOrder, cancelChangeOrder,
  recordOwnerDecision, changeOrderSendRequest,
} from '@/lib/changeOrders'
import { changeOrderMessageBody, renderMessage, toDisplayBody, fromDisplayBody, type MsgType } from '@/lib/comms/templates'
// The day board's action doors + the completion-message plan (Session 80).
// The plan predicts the job-complete text with THE reach predicate so the
// dialog never promises a send that consent or a missing grant would block.
import { completionMessagePlan, type CompletionCaps } from '@/lib/dayActions'
import { tenantCapabilities } from '@/lib/capabilities'
import { newClientMessageId } from '@/lib/comms/idempotency'
import { CompleteConfirm } from '@/components/schedule/CompleteConfirm'
import { Calendar, CalendarView } from '@/components/schedule/Calendar'
import { DayOpsPanel, QuoteLite, QuickPatch } from '@/components/schedule/DayOpsPanel'
// Estimate visits (Session 79) — scheduled calls to LOOK at work and price it.
// They share the calendar with jobs and nothing else: they are rows in
// schedule_items, so no engine on this page that reads `jobs` can see them.
import { EstimateDayBoard } from '@/components/schedule/EstimateDayBoard'
import { EstimateAppointmentDialog } from '@/components/schedule/EstimateAppointmentDialog'
import { useEstimateAppointments } from '@/hooks/useEstimateAppointments'
import { isOpen as estimateIsOpen, type EstimateAppointment } from '@/lib/estimateAppointments'
import type { ScheduleItem } from '@/lib/scheduleItems'
import { Coord, geocodeAddress } from '@/lib/geo'
import { JobForm, Recurrence, SuggestionMeta } from '@/components/schedule/JobForm'
import { ScopeDialog } from '@/components/schedule/ScopeDialog'
import { generateOccurrences, jobsInScope, shiftDate, dayDelta, recurrenceLabel, visitsBeyondEnd, planSeriesChange, planRecurrenceRemoval, partitionSeriesVisits, scopeImpacts, type SeriesVisitLite } from '@/lib/recurrence'
import { loadVisitEncumbrances } from '@/lib/seriesHistory'
import type { JobRecurrence, Crew, Technician } from '@/types'
import { loadCrews, loadTechnicians } from '@/lib/crews'
import { assigneeOf, sameAssignee } from '@/lib/crewAssignment'
import { createDraftInvoiceForCompletedJob, quoteVisitAmount, jobVisitValue, effectiveFreq, syncDraftInvoiceAmounts, uncompleteJob } from '@/lib/invoicing'
import { BLANK_NUMERIC_FIELD } from '@/lib/pricingState'
import { queueOrRun, isNetworkError } from '@/lib/offline/outbox'
// THE completion stamp. Every door on this page that moves a visit to
// "completed" writes the same three fields through it — see lib/jobStatus.
import { completionPatch } from '@/lib/jobStatus'
import { checklistBlockMessage } from '@/lib/jobForms'
import { stopForToday, resumeWork, deleteWorkSession, type StopForTodayInput } from '@/lib/workSession'
import { formatWorked } from '@/lib/workDuration'
import { loadDayFitContext, type DayFitContext } from '@/lib/dayFitLoad'
import StopForTodaySheet from '@/components/jobs/StopForTodaySheet'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
// THE words for the work (lib/vocabulary): a `jobs` row is one VISIT, and this
// page is where every job's visits live — the subtitle has to say both.
import { scheduleSubtitle } from '@/lib/vocabulary'

// ── The offline field bundle ──────────────────────────────────────────────────
// Everything the day board needs to be TRUE with no signal, for the window a
// contractor works out of (today ± a week), persisted across app kills.
const FIELD_BUNDLE_KEY = 'schedule-field-bundle'

// The settings the board actually reads. Narrow on purpose: caching the whole
// settings row would drag pricing/branding/API config onto disk for no benefit.
interface FieldSettings {
  base_lat: number | null; base_lng: number | null; base_address: string | null
  preferred_work_days: number[] | null; work_start_time: string | null
  daily_capacity_hours: number | null; automations: unknown
  // Session 80: the completion dialog composes the job-complete text with the
  // SAME engine + owner overrides the composer uses, and the Review door needs
  // the link — cached so both stay honest in a driveway with no signal.
  company_name?: string | null; review_url?: string | null
  message_templates?: Partial<Record<MsgType, string>> | null
}

interface FieldBundle {
  jobs: Job[]
  addons: Record<string, JobLineItem[]>
  // Cached for the same reason add-ons are: offline, an EMPTY change-order panel
  // is not "no changes", it is "we couldn't ask" — and a visit whose customer is
  // waiting on an approval must still say so in a driveway with no signal.
  changeOrders: Record<string, ChangeOrder[]>
  quotes: QuoteLite[]          // prices for recurring visits derive from these
  recurrences: JobRecurrence[] // cadence labels
  dayStatuses: DayStatusRow[]
  settings: FieldSettings | null
}
import { resolveAutomations, Automations } from '@/lib/comms/automations'
import { PageHeader } from '@/components/layout/PageHeader'
import { usePublishQuickAddContext } from '@/components/layout/QuickAddProvider'
import { readJobPanel, jobPanelAnchorId } from '@/lib/quickAdd'
import { scrollBehavior } from '@/lib/motion'
import { Button } from '@/components/ui/Button'
import { FieldStopBar } from '@/components/schedule/FieldStopBar'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton'
import { cn, minutesBetween, formatCurrency, formatDate } from '@/lib/utils'
import { useTenantTime } from '@/components/layout/TenantTimeProvider'
// THE scheduling gate — this door must agree with the quote page's Schedule
// button about whether a deposit-gated booking may book (lib/payments/depositGate).
import { gateBlocksScheduling, loadQuoteDepositRows, schedulingGate, stampDepositOverride } from '@/lib/payments/depositGate'
import { orderDayStops, nextFieldStop } from '@/lib/fieldStops'
import { toast } from '@/lib/toast'
import { confirm } from '@/lib/confirm'
import { format, addMonths, addWeeks, addDays, subMonths, subWeeks, subDays, parseISO, getDay } from 'date-fns'
import { Plus, X, ChevronLeft, ChevronRight, Trash2, Rocket, AlertTriangle, Repeat, Lightbulb, Info, Phone, MessageSquare, Navigation, User as UserIcon, FileText, Receipt, MapPin } from 'lucide-react'
import { OptimizeSchedule } from '@/components/schedule/OptimizeSchedule'
import { RainDelayCenter } from '@/components/schedule/RainDelayCenter'
import { WeatherStrip } from '@/components/weather/WeatherStrip'
import { CalendarClock, Ruler } from 'lucide-react'
import { analyzeSchedule, optimizeSchedule, planRainDelay, MOVE_REASON_LABEL } from '@/lib/optimizer'
import type { PlannedMove, OptimizeScope, OptimizeMode, OptJob, ScheduleSuggestion, CadenceVisit, CadenceRecs } from '@/lib/optimizer'
import { evaluateScheduleMove } from '@/lib/scheduleWarnings'
import { resolvePrefs } from '@/lib/preferences'
import type { PrefSource } from '@/lib/preferences'
import { buildRoutingRoadDistance, RoadDist } from '@/lib/distance'
import { analyzeScheduleHealth } from '@/lib/scheduleHealth'
import type { HealthIssue, HealthJob } from '@/lib/scheduleHealth'
import { ScheduleHealthCard } from '@/components/schedule/ScheduleHealthCard'
import { MissedJobsCard } from '@/components/schedule/MissedJobsCard'
import { isMissed } from '@/lib/dashboard/priorities'
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
  // ── ⭐⭐ THE BUSINESS'S DAY (Session 121) ──────────────────────────────────
  // This page called `localTodayISO()`, which on the CLIENT reads the DEVICE's
  // zone — an owner's phone still set to another province, or a laptop that
  // travelled. The Dashboard renders on the SERVER, where the same helper is
  // UTC. So "today" here and "today" there were routinely different days, and
  // the board's missed-jobs cut-off moved with whichever machine was looking.
  // One clock now, the tenant's, shared by every dashboard surface.
  const { todayISO: tenantToday } = useTenantTime()
  // Learned drive speed — feeds the proactive optimizer suggestions below.
  const [travel, setTravel] = useState<TravelModel>(DEFAULT_TRAVEL_MODEL)
  useEffect(() => { loadTravelModel(supabase).then(setTravel) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const router = useRouter()
  const searchParams = useSearchParams()
  const quoteId = searchParams.get('quote')
  const customerParam = searchParams.get('customer')
  const propertyParam = searchParams.get('property')
  const focusRec = searchParams.get('focus')
  const jobParam = searchParams.get('job')
  const dayParam = searchParams.get('d')
  // `?estimate=new` opens the estimate dialog prefilled from wherever the owner
  // came from (a customer, a property, a draft quote). One door on this page
  // rather than the same dialog mounted on four others, so the scheduling rules
  // cannot drift apart per surface.
  const estimateParam = searchParams.get('estimate')

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
  // The visit whose "Stop for today" sheet is open. One sheet, opened from the
  // phone bar and from the day board, so the two doors ask the same questions.
  const [stopping, setStopping] = useState<Job | null>(null)
  const [stopBusy, setStopBusy] = useState(false)
  // The stop order the day board actually rendered, reported by DayOpsPanel.
  // The field bar reads THIS rather than re-deriving an order of its own — see
  // fieldNext below and lib/fieldStops.
  const [boardStopOrder, setBoardStopOrder] = useState<{ date: string; ids: string[] } | null>(null)
  // Crew-message unread per visit, reported UP by the day board rather than
  // queried again here — the field bar and the card must never disagree about
  // whether a message is waiting. See DayOpsPanel's onChatUnread.
  const [boardChatUnread, setBoardChatUnread] = useState<Record<string, number>>({})
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
  // Completing a visit drafts an invoice on a page the owner isn't looking at. The
  // three callsites that do it each announced it as an instruction — "review it in
  // Invoices" — naming a document and leaving the owner to go find it, on the
  // surface where money quietly waits to be sent. Quote conversion already
  // announces the SAME event with a link (quotes/[id] → "View invoice"), and the
  // invoices page already deep-links on ?invoice=. Same event, same shape, once.
  function draftInvoiceToast(invoiceNumber: string | undefined, msg: string) {
    if (!invoiceNumber) { toast.success(msg); return }   // nothing to link to
    toast(msg, {
      tone: 'success',
      action: { label: 'Review it', run: () => router.push(`/dashboard/invoices?invoice=${encodeURIComponent(invoiceNumber)}`) },
    })
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
  // Change orders per visit — the AUTHORIZATION for scope added after approval.
  // The money they become lives in addonsByJobId (the approval trigger mints it).
  const [changeOrdersByJobId, setChangeOrdersByJobId] = useState<Record<string, ChangeOrder[]>>({})
  const [baseCoord, setBaseCoord] = useState<Coord | null>(null)
  const [preferredWorkDays, setPreferredWorkDays] = useState<number[]>([5, 6, 0])
  const [workStartTime, setWorkStartTime] = useState('08:00')
  const [capacityHours, setCapacityHours] = useState(8)
  // Neutral until the settings read lands — never a trade's chips by default.
  const [addonTemplates, setAddonTemplates] = useState<AddonTemplate[]>(NEUTRAL_PACK.addons)
  const [defaultCrew, setDefaultCrew] = useState(1)
  // ⭐ Who can work each day + what history says a service takes — Session 46's
  // loader, ALREADY the source for the best-day suggesters. Loaded once for the
  // horizon and handed to the day board so "is tomorrow realistic?" and "which
  // day should this land on?" are answered from one roster read, not two.
  // null while loading, or when the read was unavailable — which lib/dayPlan
  // reports as a caveat rather than as a fully-staffed day.
  const [dayFitCtx, setDayFitCtx] = useState<DayFitContext | null>(null)
  // Who work can be assigned to, and whether that list is trustworthy. null-ish
  // state is deliberate: `rosterKnown` false means the assignment checks stay
  // quiet rather than reporting an unstaffed day.
  const [crews, setCrews] = useState<Crew[]>([])
  const [technicians, setTechnicians] = useState<Technician[]>([])
  const [rosterKnown, setRosterKnown] = useState(false)
  // Defaults come from the resolver, not a hand-copied literal — otherwise every
  // new automation has to be remembered here too (and this is loaded from
  // settings a moment later anyway).
  const [automations, setAutomations] = useState<Automations>(() => resolveAutomations(null))
  // What the completion dialog + Review door need from settings: the owner's
  // template overrides, business name and review link — loaded with the same
  // settings read, cached in the field bundle.
  const [msgCtx, setMsgCtx] = useState<{ company: string; reviewUrl: string; templates: Partial<Record<MsgType, string>> | null }>({ company: '', reviewUrl: '', templates: null })
  // Tenant platform grants (lib/capabilities), read once per session for the
  // completion-message plan. null = not read yet → the plan predicts the
  // attempt and lets the route's authoritative read decide.
  const [caps, setCaps] = useState<CompletionCaps | null>(null)
  // The completion dialog: which visit is waiting on the message decision.
  // Present ONLY when the plan says a message would actually go out.
  const [completeAsk, setCompleteAsk] = useState<{ job: Job; channels: ('sms' | 'email')[]; contactKnown: boolean; text: string; defaultText: string } | null>(null)
  const [completeBusy, setCompleteBusy] = useState(false)
  const [showOptimize, setShowOptimize] = useState(false)
  const [showRainCenter, setShowRainCenter] = useState(false)
  // The day the Weather hub should open on (e.g. a known rain day). null → its own
  // default (tomorrow). Set when launching from the weather card or a live rain target.
  const [rainCenterDay, setRainCenterDay] = useState<string | null>(null)
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

  // `undefined` = day availability was never read successfully (the initial read
  // failed, and every refresh since has too). It is NOT "no days are blocked" —
  // that is `{ byDate: {}, blockedDates: new Set() }`. Anything that PLACES work
  // on a date has to tell those two apart, because the optimizer's target-date
  // list and Weather Ops' move targets are both built by asking `isDayBlocked`,
  // which answers false for both.
  const dayStatusUnknown = dayStatusMap === undefined
  const DAY_STATUS_UNKNOWN_MSG =
    'Your day availability (closed days, vacations, rain blocks) could not be loaded, so this could move work onto a day you closed. Refresh and try again.'

  function launchOptimizer(opts?: { scope: OptimizeScope; mode: OptimizeMode; anchorDate: string }) {
    // Refuse rather than optimize against availability we could not read.
    if (dayStatusUnknown) { setBanner(DAY_STATUS_UNKNOWN_MSG); return }
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

  // The roster + learning context for the day board. One load for the horizon;
  // a failure leaves it null, which the plan reports honestly.
  //
  // Crews and named people ride along because the board now answers a second
  // question — whether the people this day was ASSIGNED to can staff it — and
  // that needs their names, not just a headcount. A failed read leaves both
  // empty, and the staffing check then claims nothing.
  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const res = await loadDayFitContext(supabase, user.id, { fromISO: localToday() })
      if (alive && res.outcome === 'ok') setDayFitCtx(res.ctx)
      try {
        const [cs, ts] = await Promise.all([
          loadCrews(supabase, user.id),
          loadTechnicians(supabase, user.id),
        ])
        if (alive) { setCrews(cs); setTechnicians(ts); setRosterKnown(true) }
      } catch {
        // Same contract as everywhere else: couldn't ask ≠ nobody works here.
        if (alive) setRosterKnown(false)
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Workers available on the OPEN day. ⚠️ Only inside the loaded horizon: time
  // off was read for that window alone, so a date outside it would look fully
  // staffed simply because nobody's booked-off rows were fetched. Outside the
  // window the honest answer is "not known", and the plan says so.
  const workersOnOpenDay = useMemo(() => {
    if (!dayFitCtx) return null
    const iso = format(cursor, 'yyyy-MM-dd')
    return dayFitCtx.horizonDates.includes(iso) ? dayFitCtx.workersByDate(iso) : null
  }, [dayFitCtx, cursor])

  // …and the same answer per person, for the staffing warnings. Same horizon
  // rule, from the same context, so the count and the names always agree.
  const staffingOnOpenDay = useMemo(() => {
    if (!dayFitCtx) return null
    const iso = format(cursor, 'yyyy-MM-dd')
    return dayFitCtx.horizonDates.includes(iso) ? dayFitCtx.staffingByDate(iso) : null
  }, [dayFitCtx, cursor])

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
  // Past-due visits still open — the same derivation the dashboard's "Resolve missed
  // jobs" count uses (isMissed), so the board's card and that count can't disagree.
  // The Day Ops board only renders the viewed day, so these were otherwise invisible.
  const missedJobs = useMemo(() => jobs.filter(j => isMissed(j, tenantToday)), [jobs, tenantToday])

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
    // Proposing unprompted is worse than staying quiet: without day availability
    // the plan can route work onto a closed day, and the owner never asked for
    // it. The manual Optimize button explains the refusal; this one just stops.
    if (dayStatusUnknown) return

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
    const cos = changeOrderInsertRows(issue.removableJobIds)
    const { error } = await supabase.from('jobs').delete().in('id', issue.removableJobIds)
    if (error) { setBanner('Could not remove the duplicate: ' + error.message); setHealthBusyKey(null); return }
    await fetchJobs()
    setHealthBusyKey(null)
    offerUndo(`Removed ${rows.length} ${issue.isMow ? 'mowing ' : ''}visit${rows.length !== 1 ? 's' : ''}`, async () => {
      if (rows.length) await supabase.from('jobs').insert(rows)
      await restoreVisitExtras(cos, addons)
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
    const futureChangeOrders = changeOrderInsertRows(futureJobs.map(j => j.id))
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
      if (futureChangeOrders.length) res.push(await supabase.from('change_orders').insert(futureChangeOrders))
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
        .select('*, customers(id, name, phone, email, preferred_days, avoid_days, pref_time_start, pref_time_end, sms_opt_in, email_opt_in, message_prefs, reviewed_at, review_requested_at, review_declined_at), properties(id, address, lat, lng, neighborhood, preferred_days, avoid_days, pref_time_start, pref_time_end)')
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
      supabase.from('customers').select('*, properties(address, city, is_primary)').eq('user_id', user!.id).is('archived_at', null).order('name'), // active only — can't schedule an archived customer without restoring
      supabase.from('job_recurrences').select('*').eq('user_id', user!.id),
      supabase.from('quotes').select('id, total, initial_price, weekly_price, biweekly_price, monthly_price').eq('user_id', user!.id),
      supabase.from('business_settings').select('base_lat, base_lng, base_address, preferred_work_days, work_start_time, daily_capacity_hours, automations, business_type, company_name, review_url, message_templates').eq('user_id', user!.id).maybeSingle(),
      supabase.from('invoices').select('job_id').eq('user_id', user!.id).not('job_id', 'is', null),
      supabase.from('schedule_health_ignored').select('issue_key').eq('user_id', user!.id),
      supabase.from('day_statuses').select(DAY_STATUS_SELECT).eq('user_id', user!.id),
    ])
    setUid(user!.id)
    // Every setter below is guarded on its own error. They used to write `|| []`
    // unconditionally, so ONE offline load flattened the whole board: prices
    // vanished (they derive from quotes), cadence labels vanished, and the day's
    // capacity/work-start silently reverted to the 8h Fri–Sun defaults that the ETA
    // chain and the day-load signal read. The schedule looked authoritative and was
    // wrong. A read that failed now changes nothing.
    if (!dRes.error) setDayStatusMap(buildDayStatusMap((dRes.data as DayStatusRow[]) || []))
    // A failed jobs read must NEVER paint an empty schedule: "no work today" is
    // indistinguishable from a clear day, and that's how a stop gets missed. Keep
    // whatever is already on screen, say so plainly, and let the rest of the page
    // finish refreshing (so loading always resolves).
    let fieldJobs: Job[] | null = null
    let fieldAddons: Record<string, JobLineItem[]> | null = null
    let fieldChangeOrders: Record<string, ChangeOrder[]> | null = null
    if (jRes.error) {
      setBanner('Could not load the schedule — check your connection and refresh. Showing the last data loaded.')
    } else {
      const loadedJobs = jRes.rows
      setJobs(loadedJobs)
      // Field window — today ± a week, what a contractor actually works out of.
      // Bounded by date so a 200-job/week book stays well inside quota instead of
      // serializing the whole year.
      const from = shiftDate(tenantToday, -1), to = shiftDate(tenantToday, 7)
      fieldJobs = loadedJobs.filter(j => j.scheduled_date >= from && j.scheduled_date <= to)
      const addons = await listLineItemsByJob(supabase, user!.id, loadedJobs.map(j => j.id))
      setAddonsByJobId(addons)
      // Change orders are a small table by nature (an exception, not a per-visit
      // row), so this is ONE request for the whole book rather than a chunked
      // by-job sweep. A failed read must not read as "nothing is waiting on the
      // customer" — it leaves the last known map standing and says so.
      try {
        const cos = await listChangeOrders(supabase, user!.id)
        setChangeOrdersByJobId(cos)
        fieldChangeOrders = Object.fromEntries(fieldJobs.map(j => [j.id, cos[j.id]]).filter(([, v]) => v)) as Record<string, ChangeOrder[]>
      } catch { setBanner('Could not load change orders — what you see may be out of date.') }
      // Only the field window's add-ons — the map is keyed by every job id in the book.
      fieldAddons = Object.fromEntries(fieldJobs.map(j => [j.id, addons[j.id]]).filter(([, v]) => v)) as Record<string, JobLineItem[]>
    }
    if (!iRes.error) setInvoicedJobIds(new Set(((iRes.data as { job_id: string }[]) || []).map(r => r.job_id)))
    if (!hRes.error) setIgnoredHealthKeys(new Set(((hRes.data as { issue_key: string }[] | null) || []).map(r => r.issue_key)))
    if (!cRes.error) setCustomers((cRes.data as Customer[]) || [])
    if (!rRes.error) {
      const labels: Record<string, string> = {}
      const recMap: Record<string, JobRecurrence> = {}
      for (const r of (rRes.data as JobRecurrence[]) || []) {
        labels[r.id] = recurrenceLabel(r.interval_unit, r.interval_count, r.freq)
        recMap[r.id] = r
      }
      setRecurrenceLabels(labels)
      setRecurrences(recMap)
    }

    const qMap: Record<string, QuoteLite> = {}
    if (!qRes.error) {
      for (const q of (qRes.data as QuoteLite[]) || []) qMap[q.id] = q
      setQuotesById(qMap)
    }

    // ONE persisted bundle, written only from reads that actually succeeded. Jobs
    // alone weren't enough: the board derives a recurring visit's price from its
    // quote, so a cached day without quotes shows real work at "$0 · Set price".
    // dRes is in this gate now. It used to write `dayStatuses: dRes.error ? [] : …`,
    // which bypassed the very guard the live path applies two dozen lines up: a failed
    // day-status read persisted an EMPTY list, so offline buildDayStatusMap([]) painted
    // every blocked and rained-out day as available — confidently bookable. That is
    // precisely the class of failure this bundle exists to prevent.
    if (fieldJobs && !qRes.error && !rRes.error && !sRes.error && !dRes.error) {
      const quoteIds = new Set(fieldJobs.map(j => j.quote_id).filter(Boolean))
      const recIds = new Set(fieldJobs.map(j => j.recurrence_id).filter(Boolean))
      writeCache<FieldBundle>(FIELD_BUNDLE_KEY, {
        jobs: fieldJobs,
        addons: fieldAddons ?? {},
        changeOrders: fieldChangeOrders ?? {},
        // Only what this window references — the whole quote book would blow quota.
        quotes: ((qRes.data as QuoteLite[]) || []).filter(q => quoteIds.has(q.id)),
        recurrences: ((rRes.data as JobRecurrence[]) || []).filter(r => recIds.has(r.id)),
        dayStatuses: (dRes.data as DayStatusRow[]) || [],
        settings: (sRes.data as FieldSettings | null) ?? null,
      }, { persist: true })
    }

    // Base coordinate for route optimization (geocode the address once if needed).
    const s = sRes.data as (FieldSettings & { business_type: string | null }) | null
    // Add-on quick-chips come from the trade pack (UI defaults only — same
    // contract as the campaign preset menu). A pack with no list falls back to
    // the neutral chips; a failed read resolves to the neutral pack too.
    const packForChips = tradePack(s?.business_type)
    setAddonTemplates(packForChips.addons.length ? packForChips.addons : NEUTRAL_PACK.addons)
    setAutomations(resolveAutomations(s?.automations))
    setMsgCtx({ company: s?.company_name || '', reviewUrl: s?.review_url || '', templates: s?.message_templates || null })
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

  // Paint the cached field bundle first so the day is on screen instantly — and,
  // with no signal, at all. fetchJobs revalidates right behind it, so this is never
  // stale-stuck; it only ever front-runs the network. Restores the DERIVED inputs
  // too (quotes/recurrences/settings), because a day board with jobs but no quotes
  // is worse than no board: it shows real work priced at $0.
  useEffect(() => {
    const b = readCache<FieldBundle>(FIELD_BUNDLE_KEY, CACHE_TTL.field, { persist: true })
    if (b?.jobs?.length) {
      setJobs(b.jobs)
      setAddonsByJobId(b.addons || {})
      setChangeOrdersByJobId(b.changeOrders || {})
      const qMap: Record<string, QuoteLite> = {}
      for (const q of b.quotes || []) qMap[q.id] = q
      setQuotesById(qMap)
      const labels: Record<string, string> = {}
      const recMap: Record<string, JobRecurrence> = {}
      for (const r of b.recurrences || []) {
        labels[r.id] = recurrenceLabel(r.interval_unit, r.interval_count, r.freq)
        recMap[r.id] = r
      }
      setRecurrenceLabels(labels)
      setRecurrences(recMap)
      setDayStatusMap(buildDayStatusMap(b.dayStatuses || []))
      const s = b.settings
      if (s) {
        setAutomations(resolveAutomations(s.automations))
        setMsgCtx({ company: s.company_name || '', reviewUrl: s.review_url || '', templates: s.message_templates || null })
        setPreferredWorkDays(s.preferred_work_days?.length ? s.preferred_work_days : [5, 6, 0])
        setWorkStartTime(s.work_start_time || '08:00')
        setCapacityHours(s.daily_capacity_hours && s.daily_capacity_hours > 0 ? s.daily_capacity_hours : 8)
        if (s.base_lat != null && s.base_lng != null) setBaseCoord({ lat: s.base_lat, lng: s.base_lng })
      }
      setLoading(false)
    }
    fetchJobs()
  }, [fetchJobs])

  // The tenant's platform grants, once per session — feeds the completion-
  // message plan so the dialog doesn't promise an SMS on a channel this
  // business has no grant for. tenantCapabilities never throws (it fails
  // closed), so a failed read here reads as "no grants" and the dialog simply
  // doesn't show — the route's own authoritative read still governs the send.
  useEffect(() => {
    if (!uid) return
    let alive = true
    tenantCapabilities(supabase, uid).then(c => {
      if (alive) setCaps({ outboundSms: c.outboundSms, outboundEmail: c.outboundEmail })
    })
    return () => { alive = false }
  }, [supabase, uid])

  // ── Day Status: live sync + optimistic set/clear (source of truth = day_statuses) ──
  // A failed REFRESH must not erase a good map. This runs on every realtime
  // event and after every day-status write, so `buildDayStatusMap([])` here
  // silently un-blocked every closed day the moment one refetch dropped —
  // including, immediately after the owner blocked a day, the block they had
  // just made. null = "couldn't read"; keep what the database still holds.
  const reloadDayStatuses = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const rows = await loadDayStatuses(supabase, user.id)
    if (rows) setDayStatusMap(buildDayStatusMap(rows))
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
      // The customer's PREFERRED date seeds the form when it's still ahead —
      // honouring the request they typed into their portal without a copy step.
      // Only a seed: the owner picks the real date, and a preference already in
      // the past falls back to today rather than booking backwards.
      const preferred = (q as Quote).preferred_date
      setQuotePrefill({
        customer_id: q.customer_id || '',
        property_id: propertyId || '',
        title: `${q.service_type} — ${q.customer_name}`,
        service_type: q.service_type,
        scheduled_date: preferred && preferred >= localToday() ? preferred : localToday(),
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

  // Visit deep link (?job=<id>) — THE focused destination for one visit, used by
  // global search. Jumps the board to the day that visit lands on and opens that
  // exact row, the same two moves ?focus= makes for a series.
  //
  // Why this had to exist: a visit is the one record type with no page of its own,
  // so a search result for it used to land on the bare board — which opens on
  // TODAY. Finding a visit scheduled three weeks out and being shown today's work
  // is losing it again. ?customer= could not be reused: it is a CREATE door that
  // opens a blank new-visit form, so it would answer "here is the job you found"
  // with an empty form.
  useEffect(() => {
    if (!jobParam || jobs.length === 0) return
    const target = jobs.find(j => j.id === jobParam)
    if (target) {
      setCursor(parseISO(target.scheduled_date + 'T00:00:00'))
      setEditing(target)
      setShowForm(false)
    }
  }, [jobParam, jobs])

  // Day deep link (?d=YYYY-MM-DD) — THE focused destination for one DAY, used by
  // the Owner Inbox's "Fix Thursday's schedule" rows. Only moves the cursor: a
  // day-level door opens the board ON that day and touches nothing, so a stale
  // link can never open, edit or create a visit. Format-checked because this
  // arrives from a URL — parseISO on garbage would set an Invalid Date cursor.
  useEffect(() => {
    if (!dayParam || !/^\d{4}-\d{2}-\d{2}$/.test(dayParam)) return
    setCursor(parseISO(dayParam + 'T00:00:00'))
  }, [dayParam])

  // ?panel=time|cost — land ON the panel, not merely on the form that contains
  // it. The + offers "Work time" and "Cost" as one-tap doors; a door that opens
  // a long form scrolled to the top and leaves you to find the panel has not
  // saved anyone a tap. Both panels live inside the edit form's advanced block,
  // which `isEdit` opens on its own, so all that is missing is the scroll.
  //
  // Runs on a frame AFTER the form paints (the panel does not exist during the
  // render that opens it), and only ever scrolls — it never opens, submits or
  // changes anything, so a stale link cannot act on a visit.
  const panelParam = searchParams.get('panel')
  useEffect(() => {
    const panel = readJobPanel(panelParam)
    if (!panel || !editing) return
    let tries = 0
    const id = window.setInterval(() => {
      const el = document.getElementById(jobPanelAnchorId(panel))
      if (el) {
        window.clearInterval(id)
        el.scrollIntoView({ behavior: scrollBehavior(), block: 'center' })
      } else if (++tries > 20) window.clearInterval(id)   // give up quietly after ~2s
    }, 100)
    return () => window.clearInterval(id)
  }, [panelParam, editing])

  function closeForm() {
    setShowForm(false)
    setEditing(null)
    setFormDate('')
    formDirty.current = false
    if (quoteCtx || customerPrefill) {
      setQuoteCtx(null)
      setQuotePrefill(null)
      setQuoteRecurrence(undefined)
      setCustomerPrefill(null)
      router.replace('/dashboard/schedule')
    }
  }

  // ── Dismissing the editor must not eat what was typed ───────────────────────
  // This overlay closes on a backdrop tap, on Escape and on the X — and it used
  // to do so unconditionally, with no autosave behind it. A half-entered job
  // (customer, property, price, times, a whole recurrence) vanished to a brushed
  // thumb, and on a phone the backdrop is most of the screen.
  //
  // The app's other two create forms already protect this: QuoteBuilder and
  // CustomerForm both run useAutosave. JobForm does not, and adopting autosave
  // here is a redesign of a frozen surface. So this is the small, honest half —
  // ASK before discarding, and only when there is something to lose. Nothing
  // about saving, scheduling or recurrence changes.
  //
  // A successful save calls closeForm() DIRECTLY, not this: the row is already
  // written, react-hook-form still reads dirty, and asking there would be
  // nonsense. Only the three dismissal paths route through the question.
  const formDirty = useRef(false)
  async function requestCloseForm() {
    if (!formDirty.current) { closeForm(); return }
    const ok = await confirm({
      title: 'Discard this job?',
      message: 'You’ve started filling this in. Closing now throws it away — nothing is saved until you tap Save.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      destructive: true,
      icon: Trash2,
    })
    if (ok) closeForm()
  }

  // Editor modal: lock background scroll + close on Escape while it's open.
  useEffect(() => {
    if (!showForm && !editing) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') requestCloseForm() }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prevOverflow }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showForm, editing])

  // A dirty editor also survives an accidental tab close — same protection the
  // settings page carries. The ref is read at event time, so this registers
  // once per open rather than on every keystroke.
  useEffect(() => {
    if (!showForm && !editing) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => { if (formDirty.current) e.preventDefault() }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [showForm, editing])

  async function handleAdd(values: JobFormValues, recurrence: Recurrence, meta?: SuggestionMeta, opts?: { addAnother?: boolean }) {
    const { data: { user } } = await supabase.auth.getUser()
    // ── The scheduling guard (the ?quote= door) ───────────────────────────────
    // Same contract as the quote page's Schedule button: a deposit-gated booking
    // whose money hasn't arrived books only through an explicit, stamped
    // override. Derived from the ledger AT SUBMIT TIME (the customer may have
    // paid while the form was open); an unreadable ledger refuses rather than
    // schedules — "couldn't check" must never behave as "paid".
    if (quoteCtx?.deposit_type && quoteCtx.status === 'accepted') {
      const { rows, error: depErr } = await loadQuoteDepositRows(supabase, quoteCtx.id)
      if (depErr) {
        setBanner('Couldn’t check this quote’s deposit ledger — nothing was scheduled. Try again.')
        return
      }
      const gate = schedulingGate(quoteCtx, rows)
      if (gateBlocksScheduling(quoteCtx, gate)) {
        const ok = await confirm({
          title: 'Schedule without the required deposit?',
          message: `This quote requires a ${formatCurrency(gate.required)} deposit before scheduling is confirmed, and ${gate.collected > 0 ? `only ${formatCurrency(gate.collected)} has been received` : 'none of it has been received yet'}. Scheduling anyway books the visit with ${formatCurrency(gate.outstanding)} still owed — the customer's portal will keep asking for it.`,
          confirmLabel: 'Schedule without deposit',
          destructive: true,
        })
        if (!ok) return
        await stampDepositOverride(supabase, quoteCtx.id)
      }
    }
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
      // Who is coming. Both columns always, so the pair can never disagree —
      // the database refuses a row carrying a crew AND a person.
      crew_id: values.crew_id ?? null,
      technician_id: values.technician_id ?? null,
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
    // Assignment joins the patch ONLY when it changed this session — silence is
    // not consent. The fixed set above is safe to overwrite on every save
    // because the form seeds each of those fields from the loaded anchor row;
    // assignment is set per-visit on the dispatch board, so a scope-wide save
    // blasting the ANCHOR's assignee onto every sibling would silently undo
    // dispatch's lane assignments. When it does apply, BOTH columns move
    // together (lib/crewAssignment — jobs_one_assignee refuses half a write)
    // with the same route_order reset as lib/crews.assignJob: a visit landing
    // in a new lane must not inherit a foreign sequence slot.
    const crewChanged = !sameAssignee(
      assigneeOf({ crew_id: values.crew_id ?? null, technician_id: values.technician_id ?? null }),
      assigneeOf(job),
    )
    const crewPatch = crewChanged
      ? { crew_id: values.crew_id ?? null, technician_id: values.technician_id ?? null, route_order: null }
      : {}
    // Status and actual time belong ONLY to the edited visit, never its siblings.
    // The third door onto COMPLETING (Complete button, quick-edit dropdown, this
    // form) — and the one that used to write the status with no completed_at at
    // all, leaving a finished visit the dispatch feed, the portal and the
    // job.completed webhook all read as un-timed. Same stamp as the other two;
    // a figure typed into the form's "actual" field still wins over the derived
    // one. Only on the TRANSITION, so re-saving a finished job months later
    // never re-dates its completion.
    const completing = values.status === 'completed' && job.status !== 'completed'
    const stated = values.actual_minutes ? Number(values.actual_minutes) : null
    const perVisit = completing
      ? completionPatch(job, { actualMinutes: stated })
      : { status: values.status, actual_minutes: stated }
    // The third door onto un-completing (undo toast, quick-edit dropdown, and this
    // full form). It runs BEFORE the status write for the same reason uncomplete()
    // deletes first: a reopened visit carrying a live invoice bills for work the
    // schedule says didn't happen. Status is per-visit, so only this job is affected.
    if (job.status === 'completed' && values.status !== 'completed') {
      const res = await uncompleteJob(supabase, { jobId: job.id, patch: { completed_at: null } })
      if (res.error) { setBanner('Could not reopen the visit: ' + res.error); return }
      if (res.invoiceLocked) setBanner(`Visit reopened, but invoice ${res.invoiceNumber} had already been sent — cancel or credit it if the work wasn’t done.`)
    }

    const targets = jobsInScope(job, jobs, scope)
    const delta = dayDelta(job.scheduled_date, values.scheduled_date)
    const results = await Promise.all(targets.map(t => supabase.from('jobs').update({
      ...fields,
      ...crewPatch,
      ...(t.id === job.id ? perVisit : {}),
      scheduled_date: scope === 'this' ? values.scheduled_date : shiftDate(t.scheduled_date, delta),
    }).eq('id', t.id)))
    const failed = results.find(r => r.error)
    if (failed?.error) setBanner('Could not save the job: ' + failed.error.message)

    if (completing) {
      // Draft from the job AS EDITED (fields + the completion stamp), not the
      // pre-edit row — a save that prices the visit and completes it in one go
      // would otherwise bill the old amount and lean on the re-price below.
      const res = await createDraftInvoiceForCompletedJob(supabase, { ...job, ...fields, ...perVisit })
      if (res.created) draftInvoiceToast(res.invoiceNumber, `Draft invoice ${res.invoiceNumber} created from the completed job.`)
      else if (res.reason === 'exists') setBanner('That job already has an invoice.')
      else if (res.reason === 'no-charge') setBanner('Done — marked No charge, so no invoice was drafted. Nothing to bill.')
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

  // ── The pre-flight every destructive recurrence edit shares ─────────────────
  // Two questions, always asked of the DATABASE and never of the page's
  // in-memory `jobs`: what does this series actually look like right now, and
  // which of its visits carry history a delete would take with them? An editor
  // can sit open for an hour while a visit is completed on a phone, invoiced, or
  // photographed — deciding from the snapshot the page loaded is how a save
  // destroys work that already happened. A failed read returns an error string,
  // never an empty series: unknown is not the same as nothing.
  type SeriesRead = { series: SeriesVisitLite[]; protectedIds: Set<string> }
  async function readSeriesForEdit(recurrenceId: string, anchorId: string): Promise<SeriesRead | { error: string }> {
    const { data, error } = await supabase.from('jobs')
      .select('id, scheduled_date, status, actual_minutes').eq('recurrence_id', recurrenceId)
    if (error || !data) return { error: error?.message || 'the repeating schedule could not be read' }
    const series = data as SeriesVisitLite[]
    const enc = await loadVisitEncumbrances(supabase, series.filter(j => j.id !== anchorId).map(j => j.id))
    if (!enc.complete) return { error: `the ${enc.failed.join(', ')} record${enc.failed.length !== 1 ? 's' : ''} of the other visits could not be checked` }
    // The page already tracks invoiced future visits for the optimizer; union
    // rather than replace, so the two can never disagree about what is locked.
    const protectedIds = new Set(enc.ids)
    for (const id of invoicedJobIds) protectedIds.add(id)
    return { series, protectedIds }
  }

  // End a series per scope, turning the anchor into a one-time job.
  //
  // Ending a schedule removes the visits it would still have PRODUCED. It never
  // removes the record of the ones it already did: completed, in-progress and
  // cancelled visits, anything carrying logged time, an invoice, photos, crew
  // media, expenses or a change order, and everything in the past all keep their
  // rows and simply stop belonging to a series. This is the path that deleted 67
  // of one customer's visits — four of them completed or cancelled — so it
  // deletes only what partitionSeriesVisits calls replaceable, and proves every
  // write landed before it claims anything.
  async function removeRecurrence(job: Job, scope: RecurrenceScope) {
    if (!job.recurrence_id) return
    const recId = job.recurrence_id

    // Detaching the one visit under the editor costs no sibling anything.
    if (scope === 'this') {
      const { data, error } = await supabase.from('jobs').update({ recurrence_id: null }).eq('id', job.id).select('id')
      if (error || !data || data.length === 0) {
        setBanner('Could not take this visit out of its repeating schedule — nothing was changed. ' + (error?.message ?? ''))
        return
      }
      setBanner('This visit is now a one-time job.')
      return
    }

    const read = await readSeriesForEdit(recId, job.id)
    if ('error' in read) {
      setBanner(`Could not safely end this repeating schedule, so nothing was changed — ${read.error}. Reopen the visit and try again.`)
      return
    }
    const { replaceable, preserved, untouched } = partitionSeriesVisits(read.series, {
      anchorId: job.id,
      protectedIds: read.protectedIds,
      todayISO: localToday(),
      ...(scope === 'future' ? { afterDate: job.scheduled_date } : {}),
    })
    const removeIds = replaceable.map(j => j.id)
    if (removeIds.length) {
      const { data: gone, error: delErr } = await supabase.from('jobs').delete().in('id', removeIds).select('id')
      if (delErr) {
        setBanner('Could not remove the upcoming visits — the schedule is unchanged. ' + delErr.message)
        return
      }
      if ((gone?.length ?? 0) !== removeIds.length) {
        setBanner(`Only ${gone?.length ?? 0} of ${removeIds.length} upcoming visits could be removed — the schedule is part-way changed. Reopen it to see where it stands.`)
        return
      }
    }
    const removedNote = removeIds.length ? ` ${removeIds.length} upcoming visit${removeIds.length !== 1 ? 's' : ''} removed.` : ''

    if (scope === 'future') {
      const { data, error } = await supabase.from('jobs').update({ recurrence_id: null }).eq('id', job.id).select('id')
      if (error || !data || data.length === 0) {
        setBanner(`Removed the later visits, but this one is still attached to the repeating schedule. ${error?.message ?? 'Reopen it and try again.'}`)
        return
      }
      setBanner(`Repeat schedule ended after this visit.${removedNote}${preserved.length ? ` ${preserved.length} later visit${preserved.length !== 1 ? 's' : ''} with work or an invoice kept.` : ''}`)
      return
    }

    // Scope "all": everything that survives is detached explicitly. The foreign
    // key would null these anyway (ON DELETE SET NULL), but doing it as its own
    // write is what lets the row count prove it happened.
    const detachIds = [job.id, ...preserved.map(j => j.id), ...untouched.map(j => j.id)]
    const { data: detached, error: detErr } = await supabase.from('jobs')
      .update({ recurrence_id: null }).in('id', detachIds).select('id')
    if (detErr || (detached?.length ?? 0) !== detachIds.length) {
      setBanner(`Could not fully unlink this schedule's visits, so the repeat rule was kept. ${detErr?.message ?? 'Reopen the visit and try again.'}`)
      return
    }
    const { data: recGone, error: recErr } = await supabase.from('job_recurrences').delete().eq('id', recId).select('id')
    if (recErr || !recGone || recGone.length === 0) {
      setBanner(`The visits were unlinked, but the repeat rule itself could not be removed. ${recErr?.message ?? 'Reopen the visit and try again.'}`)
      return
    }
    const kept = preserved.length + untouched.length
    setBanner(`Repeat schedule removed — this is now a one-time job.${removedNote}${kept ? ` ${kept} past or already-worked visit${kept !== 1 ? 's' : ''} kept as history.` : ''}`)
  }

  // Remove the future visits that contradict a series' end date — the owner just
  // (re-)asserted the end rule, so a stray visit past it is a ghost the schedule
  // would keep honouring. Only merely-scheduled, uninvoiced siblings qualify
  // (visitsBeyondEnd); completed/in-progress/cancelled history and invoice-linked
  // visits stay, and are named in the banner rather than silently kept.
  async function reconcileSeriesEnd(job: Job, endDate: string) {
    if (!job.recurrence_id) return
    const read = await readSeriesForEdit(job.recurrence_id, job.id)
    if ('error' in read) {
      setBanner(`Saved, but the visits after ${formatDate(endDate)} were left exactly as they are — ${read.error}.`)
      return
    }
    const series = read.series
    const ghostIds = visitsBeyondEnd(series, endDate, { anchorId: job.id, protectedIds: read.protectedIds })
    const kept = series.filter(j => j.scheduled_date > endDate && j.id !== job.id && !ghostIds.includes(j.id)).length
    if (ghostIds.length) {
      const { error } = await supabase.from('jobs').delete().in('id', ghostIds)
      if (error) {
        setBanner(`Saved, but ${ghostIds.length} visit${ghostIds.length !== 1 ? 's' : ''} after ${formatDate(endDate)} could not be removed: ` + error.message)
        return
      }
      setBanner(`Removed ${ghostIds.length} visit${ghostIds.length !== 1 ? 's' : ''} scheduled after the series end (${formatDate(endDate)}).${kept ? ` ${kept} visit${kept !== 1 ? 's' : ''} with work, an invoice or a record after that date kept.` : ''}`)
    } else if (kept) {
      setBanner(`${kept} visit${kept !== 1 ? 's' : ''} with work, an invoice or a record after ${formatDate(endDate)} kept — history is never removed by an end-date change.`)
    }
  }

  // Change the cadence/end of an existing series: keep past visits, regenerate
  // forward from the anchor with the new rule.
  async function changeRecurrence(job: Job, values: JobFormValues, recurrence: Recurrence) {
    if (!job.recurrence_id || !recurrence.unit) return
    const { data: { user } } = await supabase.auth.getUser()
    // What does this rule change actually mean? (lib/recurrence.planSeriesChange)
    // Validate before touching anything — never delete a working schedule for a
    // rule that materialises none.
    const plan = planSeriesChange(values.scheduled_date, recurrence.unit, recurrence.count, recurrence.endDate, recurrence.endCount, localToday())
    if (plan.kind === 'reject') {
      setBanner(plan.reason === 'no-occurrences'
        ? `That end date (${formatDate(recurrence.endDate!)}) is before this visit — the existing schedule was kept unchanged.`
        : 'That cadence would leave no future visits — the existing schedule was kept unchanged.')
      return
    }
    // Stale-editor guard: this form hydrated from `recurrences[id]`. If the row
    // in the database no longer matches that snapshot (another device or tab
    // changed the rule while this editor sat open), overwriting it would silently
    // undo a save the owner already watched succeed elsewhere. Refuse and reload.
    const snap = recurrences[job.recurrence_id]
    const { data: fresh, error: freshErr } = await supabase.from('job_recurrences')
      .select('interval_unit, interval_count, end_date, end_count')
      .eq('id', job.recurrence_id).maybeSingle()
    if (freshErr || !fresh) {
      setBanner('Could not read this recurring schedule — nothing was changed. ' + (freshErr?.message ?? ''))
      return
    }
    if (snap && (
      fresh.interval_unit !== snap.interval_unit || fresh.interval_count !== snap.interval_count ||
      (fresh.end_date || null) !== (snap.end_date || null) || (fresh.end_count || null) !== (snap.end_count || null)
    )) {
      setBanner('This recurring schedule was changed elsewhere since you opened it — showing the current schedule. Review it and save again.')
      return
    }
    // The visits, read fresh and with their history weighed, BEFORE the rule is
    // written: a rule change that cannot be reconciled safely should change
    // nothing at all, rather than leave a new rule over an old schedule.
    const read = await readSeriesForEdit(job.recurrence_id, job.id)
    if ('error' in read) {
      setBanner(`Could not safely change this repeating schedule, so nothing was changed — ${read.error}. Reopen the visit and try again.`)
      return
    }
    // Persist the rule FIRST and prove it landed — zero rows updated is a
    // failure, not a success (RLS or a deleted row returns no error at all).
    // Rule-then-visits ordering means a failure here leaves the series intact,
    // and a failure below leaves a correct rule plus old visits the next
    // reconcile/regenerate can still fix — never deleted visits under a stale rule.
    const { data: updated, error: updErr } = await supabase.from('job_recurrences').update({
      freq: legacyFreqFor(recurrence.unit, recurrence.count),
      interval_unit: recurrence.unit,
      interval_count: recurrence.count,
      end_date: recurrence.endDate,
      end_count: recurrence.endCount,
    }).eq('id', job.recurrence_id).select('id')
    if (updErr || !updated || updated.length === 0) {
      setBanner('Could not save the new schedule rule — the series is unchanged. ' + (updErr?.message ?? ''))
      return
    }
    // The rule ends the series at or before the visit being edited: there is no
    // forward grid to regenerate, only visits that now contradict the end. Use
    // the reconcile predicate rather than the regenerate path below — a stop
    // that sits BEFORE the end but off the new grid (an Oct 31 visit under a
    // rule anchored Oct 28) is still legitimate, and regeneration would delete
    // it without re-creating it. The cutoff is the owner's own end date, or for
    // a count-limited rule the last occurrence it allows.
    if (plan.kind === 'end') {
      const cutoff = plan.cutoff
      const series = read.series
      const ghostIds = visitsBeyondEnd(series, cutoff, { anchorId: job.id, protectedIds: read.protectedIds })
      const kept = series.filter(j => j.scheduled_date > cutoff && j.id !== job.id && !ghostIds.includes(j.id)).length
      if (ghostIds.length) {
        const { error: delErr } = await supabase.from('jobs').delete().in('id', ghostIds)
        if (delErr) {
          setBanner(`The new rule was saved, but the ${ghostIds.length} visit${ghostIds.length !== 1 ? 's' : ''} after ${formatDate(cutoff)} could not be removed: ` + delErr.message)
          return
        }
      }
      setBanner(`This series now ends ${formatDate(cutoff)}.${ghostIds.length ? ` ${ghostIds.length} later visit${ghostIds.length !== 1 ? 's' : ''} removed.` : ''}${kept ? ` ${kept} completed or invoiced visit${kept !== 1 ? 's' : ''} after that date kept.` : ''}`)
      return
    }
    // Regenerate forward. Only bare future placeholders are replaceable; work
    // that happened, anything carrying a record, and every past visit are
    // business history and survive a rule change (their dates are skipped on
    // re-insert so the grid never doubles them up).
    const forward = partitionSeriesVisits(read.series, {
      anchorId: job.id,
      protectedIds: read.protectedIds,
      afterDate: job.scheduled_date,
      todayISO: localToday(),
    })
    const replaceable = forward.replaceable.map(j => j.id)
    const preserved = [...forward.preserved, ...forward.untouched.filter(j => j.scheduled_date > job.scheduled_date)]
    if (replaceable.length) {
      const { error: delErr } = await supabase.from('jobs').delete().in('id', replaceable)
      if (delErr) {
        setBanner('The new rule was saved, but the old visits could not be replaced: ' + delErr.message)
        return
      }
    }
    const preservedDates = new Set(preserved.map(j => j.scheduled_date))
    const toInsert = plan.future.filter(d => !preservedDates.has(d))
    const base = occurrenceBase(values, user!.id, job.recurrence_id, job.quote_id)
    if (toInsert.length) {
      const { error: insErr } = await supabase.from('jobs').insert(toInsert.map(d => ({ ...base, scheduled_date: d, price: job.quote_id ? null : base.price })))
      if (insErr) {
        setBanner('The new rule was saved, but its future visits could not be created: ' + insErr.message)
        return
      }
    }
    setBanner(`Schedule updated to ${recurrenceLabel(recurrence.unit, recurrence.count)}. ${plan.future.length} future visit${plan.future.length !== 1 ? 's' : ''}.${preserved.length ? ` ${preserved.length} visit${preserved.length !== 1 ? 's' : ''} with work or a record kept.` : ''}`)
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
      // The owner explicitly set the Ends control to a value the series already
      // stores. That is not a no-op: "ends Oct 31" saved onto a schedule still
      // showing November visits (rain-delay moves can walk a series past its
      // own end) means those visits contradict the rule the owner just
      // confirmed. Re-asserting the end reconciles the series against it.
      // Untouched saves (recurrence.endAsserted absent/false) never do this —
      // a crew-size edit must not silently delete deliberately-moved visits.
      if (was && will && !ruleChanged && recurrence.endAsserted && recurrence.endDate) {
        await reconcileSeriesEnd(job, recurrence.endDate)
      }
    } else if (!will) {
      // "Does not repeat" on a job that HAS a series ends the schedule. Two
      // things must be true before a save is allowed to mean that, and
      // planRecurrenceRemoval refuses unless both are:
      //
      //   • the series had actually loaded. The ?focus= deep link opens this
      //     modal as soon as `jobs` arrives, which can beat the `recurrences`
      //     read; the form then shows "Does not repeat" because it knows
      //     nothing. Acting on that silence destroyed a customer's schedule.
      //   • the owner touched the Repeat controls this session. An untouched
      //     control is showing its default, not an instruction — and unlike the
      //     first check, this one holds no matter WHY the form is wrong.
      //
      // Refusing costs an owner who really did mean it one deliberate click.
      const decision = planRecurrenceRemoval(job.recurrence_id, recurrences, recurrence.repeatAsserted)
      if (decision.kind === 'refuse') {
        if (decision.reason === 'series-not-loaded') {
          setBanner('This job\'s repeat schedule had not finished loading — nothing was changed. Reopen the visit and try again.')
          await fetchJobs()
          setEditing(null)
          return
        }
        // The rest of the save is a normal edit and still applies; only the
        // schedule is left alone, and the owner is told exactly that.
        await applyFieldEdits(job, values, scope)
        setBanner('Saved — the repeat schedule was left as it is. Nothing in this save asked to end it: change the Repeats control yourself, then save again.')
        await fetchJobs()
        setEditing(null)
        return
      }
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
    const cos = changeOrderInsertRows(targets.map(t => t.id))
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
      if (cos.length) res.push(await supabase.from('change_orders').insert(cos))
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
    const cos = changeOrderInsertRows([job.id])
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
      await restoreVisitExtras(cos, addons)
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
        { kind: 'job.update', payload: { id: job.id, patch, baseUpdatedAt: job.updated_at }, label: `Start ${job.title || 'job'}` },
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
        { kind: 'job.update', payload: { id: job.id, patch: prev, baseUpdatedAt: job.updated_at }, label: `Undo start ${job.title || 'job'}` },
        async () => { await supabase.from('jobs').update(prev).eq('id', job.id) },
      )
    })
  }

  // ✓ Check out: stamps completion, derives actual_minutes from check-in →
  // check-out (the ONE timing value every engine reads), drafts the invoice.
  // Also the calendar's one-tap Done (works without a check-in — no actual then).
  //
  // Session 80: JOB STATE CHANGED and CUSTOMER MESSAGE SENT are separate
  // decisions now. When the configured automation would actually reach someone
  // (lib/dayActions.completionMessagePlan — THE reach predicate + the tenant
  // grants), the dialog shows the exact text FIRST and the owner chooses
  // "Complete & send" or "Complete without sending". When nothing would go out
  // (automation off, no customer, opted out, no grant) completion behaves
  // exactly as before — no dialog for a message that was never going to exist,
  // and the route still records its honest skip rows.
  async function completeJob(job: Job) {
    const plan = completionMessagePlan(
      { kind: 'visit', status: job.status, customer: job.customers ?? null },
      { automationOn: !!automations.job_complete, caps },
    )
    if (plan.wouldSend && job.customer_id) {
      // The SAME engine + owner overrides the composers use, so the preview is
      // exactly what the route would send (the route re-renders identically).
      const text = toDisplayBody(renderMessage('job_complete', msgCtx.templates, {
        firstName: job.customers?.name || 'there',
        businessName: msgCtx.company,
        address: job.properties?.address,
      }).sms)
      setCompleteAsk({ job, channels: plan.channels, contactKnown: plan.contactKnown, text, defaultText: text })
      return
    }
    await performComplete(job, !!(automations.job_complete && job.customer_id))
  }

  // The completion itself — state change + invoice draft (+ the message when
  // the dialog said yes). `notify` is the DECISION now, not a re-derivation.
  async function performComplete(job: Job, notify: boolean, bodyOverride?: string) {
    const prev = { status: job.status, completed_at: job.completed_at, actual_minutes: job.actual_minutes }
    // THE completion stamp (lib/jobStatus) — status + completed_at + accumulated
    // actual_minutes. Shared with the quick-edit dropdown, the job form and the
    // dispatch board so "completed" can't mean four slightly different rows.
    const patch = completionPatch(job)
    const completed = { ...job, ...patch }

    // Completing is patch + draft invoice + courtesy text. Offline, all three
    // queue together as ONE op (kind 'job.complete') so reconnecting can never
    // leave a finished job un-billed. Online this runs exactly as it always did.
    let outcome: 'ran' | 'queued'
    try {
      outcome = await queueOrRun(
        { kind: 'job.complete', payload: { id: job.id, patch, job: completed, notify, bodyOverride, baseUpdatedAt: job.updated_at }, label: `Complete ${job.title || 'job'}` },
        async () => {
          const { error } = await supabase.from('jobs').update(patch).eq('id', job.id)
          if (error) throw new Error(error.message)
          const res = await createDraftInvoiceForCompletedJob(supabase, completed)
          if (res.created) draftInvoiceToast(res.invoiceNumber, `Draft invoice ${res.invoiceNumber} created.`)
          else if (res.reason === 'no-charge') setBanner('Done — marked No charge, so no invoice was drafted. Nothing to bill.')
      else if (res.reason === 'no-amount') setBanner('Done — no invoice drafted because this job has no price. Set a price to bill it.')
          // A failed draft used to say NOTHING, which is indistinguishable from the success
          // banner you scrolled past — the visit leaves the un-invoiced queue and the money
          // is never billed, with no trace pointing at it. ('exists' stays quiet: an invoice
          // does exist, so nothing is misclaimed.)
          else if (res.reason === 'error') setBanner('Job completed, but the draft invoice could not be created — invoice it manually from the job.')
          // The job-complete message (opt-in + dedupe are enforced by the route;
          // clientMessageId guards a retry against a double text).
          if (notify) {
            fetch('/api/comms/send', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                customerId: job.customer_id, template: 'job_complete', jobId: job.id, dedupe: true,
                clientMessageId: newClientMessageId(),
                ...(bodyOverride ? { bodyOverride } : {}),
              }),
            }).catch(() => {})
          }
        },
      )
    } catch (e) {
      // The checklist gate's refusal (a DB trigger on the completed transition)
      // is instructions, not a failure — surface its sentence as-is.
      const gate = checklistBlockMessage(e instanceof Error ? e.message : null)
      setBanner(gate
        ? `${gate} Open the visit’s Checklist panel to finish or waive it.`
        : 'Could not complete the job: ' + (e instanceof Error ? e.message : 'please try again.'))
      return
    }
    setJobs(prev2 => prev2.map(j => (j.id === job.id ? { ...j, ...patch } : j)))
    if (outcome === 'queued') setBanner('Completed offline — it’ll sync and draft the invoice when you’re back in signal.')
    if (outcome === 'ran') await fetchJobs()
    offerUndo(outcome === 'queued' ? 'Job completed — will sync' : 'Job completed', () => uncomplete(job, prev))
  }

  // ── THE un-complete ─────────────────────────────────────────────────────────
  // Every way of un-doing a completion comes through here: the undo toast above,
  // and the quick-edit dropdown moving a visit back off "completed". There used
  // to be two paths and only one of them removed the draft invoice — and that
  // one only online, from inside the closure, so the offline queue reverted the
  // status and left the invoice (and its AutoPay charge) standing.
  //
  // `invoiceCreated` is deliberately NOT a parameter. The old undo gated the
  // delete on a closure flag set by the online run, which is false for exactly
  // the case that matters: a completion that was QUEUED, whose invoice gets
  // drafted later by the replay. uncompleteJob asks the database instead.
  async function uncomplete(job: Job, prev: Partial<Job>) {
    setJobs(prev2 => prev2.map(j => (j.id === job.id ? { ...j, ...prev } : j)))
    try {
      await queueOrRun(
        // `job.uncomplete`, not `job.update`: the revert has to carry the draft
        // deletion with it. `baseUpdatedAt` is the concurrency guard every other
        // queued patch now uses — it applies here too, so a replay can't quietly
        // reopen a visit the office already touched while we were offline.
        { kind: 'job.uncomplete', payload: { id: job.id, patch: prev, baseUpdatedAt: job.updated_at }, label: `Undo complete ${job.title || 'job'}` },
        async () => {
          const res = await uncompleteJob(supabase, { jobId: job.id, patch: prev })
          if (res.error || !res.reverted) throw new Error(res.error || 'could not revert the visit')
          // An invoice that already went out is not something to fix silently:
          // the visit is now un-done and the customer still owes for it.
          if (res.invoiceLocked) {
            setBanner(`Visit reopened, but invoice ${res.invoiceNumber} had already been sent — cancel or credit it if the work wasn’t done.`)
          }
        },
      )
    } catch (e) {
      // The revert did NOT happen — the visit is still completed server-side. Ask
      // the server rather than guessing locally: this function is reached from two
      // doors whose "previous" states differ (the undo toast holds the pre-complete
      // row; the dropdown holds the completed one), and restoring the wrong one
      // shows "scheduled" over a still-completed job — how it gets completed twice.
      // Reaching here means we were online (offline queues instead of throwing),
      // so the re-fetch reflects the true state.
      await fetchJobs()
      setBanner('Could not undo the completion: ' + (e instanceof Error ? e.message : 'please try again.'))
    }
  }

  // Inline quick-edit from the day panel — small per-visit changes, no full form.
  // Queues offline like the rest of the day. The kind is chosen by what the edit
  // actually DOES, so replay reuses the same engines the online path just ran:
  // completing the job → 'job.complete' (patch + draft invoice); a plain edit →
  // 'job.update', carrying a price change through to an existing draft.
  async function quickSaveJob(job: Job, patch: QuickPatch) {
    // ── The partial-patch contract (see QuickPatch): apply ONLY the keys the
    // quick editor actually sent. The sheet renders a SUBSET of the row, so a
    // fixed field list here would turn every column it doesn't render into a
    // silent null on save — the exact bulk-save trap the full form avoids by
    // seeding every patched field from the loaded row. Price is deliberately
    // not a key: the board's Price door (setJobPrice) is the audited path
    // (job_price_changes + draft-invoice re-sync), and a quick save must not
    // be a second, unaudited way to move money.
    const base: Record<string, unknown> = {}
    if ('start_time' in patch) base.start_time = patch.start_time ?? null
    if ('crew_size' in patch) base.crew_size = patch.crew_size ?? 1
    if ('duration_minutes' in patch) base.duration_minutes = patch.duration_minutes ?? null
    if ('status' in patch) base.status = patch.status
    if ('notes' in patch) base.notes = patch.notes ?? null
    if ('service_type' in patch) base.service_type = patch.service_type ?? null
    // Reassignment: BOTH columns move together (lib/crewAssignment — the sheet
    // always sends the pair, and jobs_one_assignee refuses half a write) with
    // the same route_order reset as lib/crews.assignJob — the visit leaves its
    // old lane's hand-set route position. ONE semantic, however many doors.
    if ('crew_id' in patch || 'technician_id' in patch) {
      base.crew_id = patch.crew_id ?? null
      base.technician_id = patch.technician_id ?? null
      base.route_order = null
    }
    if (Object.keys(base).length === 0) return

    const completing = patch.status === 'completed' && job.status !== 'completed'
    const fields = {
      ...base,
      // Moving the dropdown to Done is the SAME transition as tapping Complete,
      // so it has to write the same row. It used to write the status alone: no
      // completed_at, no time on site. The visit then never appeared as a
      // completion on the dispatch activity feed (which keys on completed_at),
      // the portal showed no worked time, and the job.completed webhook shipped
      // a null timestamp. Same stamp, one definition.
      ...(completing ? completionPatch(job) : {}),
    }
    // The other door onto un-completing: the dropdown moving a finished visit back
    // to scheduled/in-progress. Same money consequence as the undo toast, so it
    // takes the same path rather than a plain patch that would strand the invoice.
    const uncompleting = job.status === 'completed' && !!patch.status && patch.status !== 'completed'
    const completed = { ...job, ...fields }

    // Un-completing carries an invoice with it, so it goes through the one engine
    // that removes the draft too — never the plain patch below. `completed_at` is
    // cleared explicitly (this branch never sets it, and it may already be on the
    // row): a visit that reads "scheduled" while still stamped complete is
    // invisible to the un-invoiced queue — un-billable and un-findable at once.
    if (uncompleting) { await uncomplete(job, { ...fields, completed_at: null }); return }

    let outcome: 'ran' | 'queued'
    try {
      outcome = await queueOrRun(
        completing
          ? { kind: 'job.complete', payload: { id: job.id, patch: fields, job: completed, notify: false, baseUpdatedAt: job.updated_at }, label: `Complete ${job.title || 'job'}` }
          : { kind: 'job.update', payload: { id: job.id, patch: fields, syncPrice: false, baseUpdatedAt: job.updated_at }, label: `Edit ${job.title || 'job'}` },
        async () => {
          const { error } = await supabase.from('jobs').update(fields).eq('id', job.id)
          if (error) throw new Error(error.message)
          if (completing) {
            // `completed` (job + this edit), not the pre-edit row: the offline
            // replay already drafts from it, so both doors bill the same amount.
            const res = await createDraftInvoiceForCompletedJob(supabase, completed)
            if (res.created) draftInvoiceToast(res.invoiceNumber, `Saved — draft invoice ${res.invoiceNumber} created.`)
            else if (res.reason === 'no-charge') setBanner('Done — marked No charge, so no invoice was drafted. Nothing to bill.')
      else if (res.reason === 'no-amount') setBanner('Done — no invoice drafted because this job has no price. Set a price to bill it.')
            // The quick-edit sheet completes a job through the same transition as the Complete
            // button, which DOES report this (completeJob below). Without it a failed draft leaves
            // the visit out of the un-invoiced queue and it is never billed, with no trace.
            else if (res.reason === 'error') setBanner('Job completed, but the draft invoice could not be created — invoice it manually from the job.')
          }
        },
      )
    } catch (e) {
      setBanner('Could not save the job: ' + (e instanceof Error ? e.message : 'please try again.'))
      return
    }
    setJobs(prev => prev.map(j => (j.id === job.id ? { ...j, ...fields } : j)))
    if (outcome === 'queued') setBanner('Saved offline — it’ll sync when you’re back in signal.')
    if (outcome === 'ran') await fetchJobs()
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
    // Local session read: getUser() is a network call, so pricing a job in a driveway
    // used to die here — before the price, the audit row or the draft sync happened.
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) { setBanner('Session expired — sign in again.'); return }
    const audit = { userId: user.id, jobId: job.id, scope: null, oldAmount, newAmount: price, reason, changedByEmail: user.email }

    let outcome: 'ran' | 'queued'
    try {
      outcome = await queueOrRun(
        { kind: 'job.update', payload: { id: job.id, patch: { price }, syncPrice: true, syncReason: reason, priceAudit: audit, baseUpdatedAt: job.updated_at }, label: `Price ${job.title || 'job'}` },
        async () => {
          const { error } = await supabase.from('jobs').update({ price }).eq('id', job.id)
          if (error) throw new Error(error.message)
          // Audit trail (old → new, reason on raises) for upsell analytics later.
          await recordPriceChange(supabase, audit)
          // The job is the source of truth — re-price its draft invoice automatically.
          const { changed, failed } = await syncDraftInvoiceAmounts(supabase, [job.id], { reason })
          if (failed > 0) setBanner('Price updated, but its draft invoice still shows the old amount — open the invoice to re-price it.')
          else if (changed > 0) setBanner('Price updated — its draft invoice was re-priced to match.')
        },
      )
    } catch (e) {
      setBanner('Could not update price: ' + (e instanceof Error ? e.message : 'please try again.'))
      return
    }
    setJobs(prev => prev.map(j => (j.id === job.id ? { ...j, price } : j)))
    if (outcome === 'queued') setBanner('Price saved offline — it’ll sync when you’re back in signal.')
    if (outcome === 'ran') await fetchJobs()
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
    // Local session read: getUser() is a network call, so selling an add-on in a
    // driveway used to fall straight through the `!user` guard and do nothing at
    // all — no row, no error, no clue. Billable work just evaporated.
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) { setBanner('Session expired — sign in again.'); return }
    const targets = input.scope === 'this'
      ? [job.id]
      : jobsInScope(job, jobs, input.scope).filter(j => j.status !== 'completed' && j.status !== 'cancelled').map(j => j.id)
    const ids = targets.length ? targets : [job.id]
    const opts = {
      userId: user.id, targetJobIds: ids,
      description: input.description, amount: input.amount, serviceKey: input.serviceKey,
      serviceType: job.service_type, recurring: input.scope !== 'this',
      // Minted ONCE, here, and carried in the payload — so this add has the same
      // identity however many times it replays. Without it a retry mints a fresh
      // group_id, looks like a second add-on, and bills the customer twice; with it
      // addLineItems sees the rows already landed and re-prices instead of re-adding.
      // This is what lets the handler safely retry a failed draft re-price.
      // Same generator the engine already writes into this uuid column.
      groupId: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : null,
    }
    let outcome: 'ran' | 'queued'
    try {
      outcome = await queueOrRun(
        { kind: 'job.addons.add', payload: { opts, syncJobIds: ids }, label: `Add “${input.description}” to ${job.title || 'job'}` },
        async () => {
          await addLineItems(supabase, opts)
          const { failed } = await syncDraftInvoiceAmounts(supabase, ids)
          if (failed > 0) setBanner('Service added, but its draft invoice still shows the old total — open the invoice to re-price it.')
        },
        // Queue only when we're definitively offline (so nothing was sent). A request
        // that failed mid-flight with the network still up is rethrown for the
        // contractor to retry deliberately, exactly like an SMS send — the groupId
        // above makes a replay safe, but it can't tell us whether the server committed.
        { queueOnRunError: false },
      )
    } catch (e) {
      setBanner('Could not add that service: ' + (e instanceof Error ? e.message : 'please try again.'))
      return
    }
    if (outcome === 'queued') setBanner('Service added offline — it’ll sync and bill when you’re back in signal.')
    if (outcome === 'ran') await fetchJobs()
  }
  async function removeLineItem(item: JobLineItem) {
    // Snapshot BEFORE deleting: a grouped (plan-wide) add-on removes rows across
    // many visits, so Undo must restore the whole group, not just this row.
    let snapshot: JobLineItem[] = [item]
    if (item.group_id) {
      const { data } = await supabase.from('job_line_items').select('*').eq('group_id', item.group_id)
      if (data?.length) snapshot = data as JobLineItem[]
    }
    // deleteLineItem throws now. Previously it read no error and returned void, so a
    // failed delete still fired "Removed …" WITH an Undo — and that Undo re-inserted
    // rows that had never been deleted, duplicating the charge. Bail before the toast:
    // never claim work is undone when the row is still there.
    try {
      await deleteLineItem(supabase, item)
    } catch (e) {
      setBanner('Could not remove that service: ' + (e instanceof Error ? e.message : 'please try again.'))
      return
    }
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
    // addLineItems throws now, so a failed copy says so instead of quietly adding
    // nothing. Not queued: this is a convenience that reads the previous visit's
    // extras, and it already returned early above when there's no session.
    try {
      for (const a of prev) {
        if (existing.has((a.serviceKey || a.description).toLowerCase())) continue
        await addLineItems(supabase, { userId: user.id, targetJobIds: [job.id], description: a.description, amount: a.amount, serviceKey: a.serviceKey, serviceType: job.service_type, recurring: false })
      }
    } catch (e) {
      setBanner('Could not copy the previous visit’s services: ' + (e instanceof Error ? e.message : 'please try again.'))
      return
    }
    await syncDraftInvoiceAmounts(supabase, [job.id])
    await fetchJobs()
  }

  // ── Change orders ───────────────────────────────────────────────────────────
  // Scope priced AFTER the original approval. This page owns the OWNER's doors;
  // lib/changeOrders owns the writes and the database owns the lifecycle, so
  // nothing below can invent a state or mint money on its own.

  // The ask, over the ONE comms pipeline. Returns null on success, else a
  // sentence to show — a send that silently fails is a customer who is never
  // asked and a job that never gets approved.
  async function askApproval(co: ChangeOrder, attempt: number): Promise<string | null> {
    const original = valueByJobId[co.job_id] ?? null
    const req = changeOrderSendRequest({
      co, originalTotal: original, attempt, body: changeOrderMessageBody, money: formatCurrency,
    })
    try {
      const res = await fetch('/api/comms/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req),
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) return 'the message could not be sent'
      // The route answers per channel. "Nothing was delivered" must not read as sent.
      const results = (out.results || {}) as Record<string, { ok?: boolean }>
      const anySent = Object.values(results).some(r => r?.ok)
      return anySent ? null : 'no channel was available to reach this customer'
    } catch {
      return 'the message could not be sent'
    }
  }

  async function createChangeOrderForJob(job: Job, input: { description: string; amount: number; send: boolean }) {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) throw new Error('Session expired — sign in again.')
    if (!job.customer_id) throw new Error('Link a customer to this visit first — somebody has to approve the change.')
    // Created as a DRAFT first, then sent: the row must exist (and have its
    // CO number) before anything is said about it to a customer. `send` moves it
    // to pending inside createChangeOrder, so a failed SEND still leaves an
    // asked-for change on record rather than losing the owner's typing.
    const co = await createChangeOrder(supabase, {
      userId: user.id, jobId: job.id, customerId: job.customer_id, quoteId: job.quote_id,
      description: input.description, amount: input.amount, serviceType: job.service_type,
      send: input.send,
    })
    setChangeOrdersByJobId(prev => ({ ...prev, [job.id]: [...(prev[job.id] || []), co] }))
    if (input.send) {
      const failed = await askApproval(co, 0)
      setBanner(failed
        ? `${co.co_number} is saved and waiting on the customer, but ${failed} — reach them another way.`
        : `${co.co_number} sent — ${formatCurrency(co.amount)} awaiting the customer's approval. It isn't counted or billed until they say yes.`)
    } else {
      setBanner(`${co.co_number} saved. It isn't sent, counted or billed until you send it and the customer approves.`)
    }
    await fetchJobs()
  }

  async function sendChange(co: ChangeOrder) {
    const sent = await sendChangeOrder(supabase, co.id)
    setChangeOrdersByJobId(prev => ({ ...prev, [co.job_id]: (prev[co.job_id] || []).map(c => c.id === sent.id ? sent : c) }))
    const failed = await askApproval(sent, 0)
    setBanner(failed
      ? `${co.co_number} is waiting on the customer, but ${failed} — reach them another way.`
      : `${co.co_number} sent — awaiting the customer's approval.`)
    await fetchJobs()
  }

  async function remindChange(co: ChangeOrder) {
    // A reminder is a NEW send, not a retry — the attempt counter keeps the
    // idempotency key distinct so the pipeline doesn't dedupe it away.
    const failed = await askApproval(co, Date.now())
    setBanner(failed ? `Could not ask again — ${failed}.` : `Asked again about ${co.co_number}.`)
  }

  async function cancelChange(co: ChangeOrder) {
    const done = await cancelChangeOrder(supabase, co.id)
    setChangeOrdersByJobId(prev => ({ ...prev, [co.job_id]: (prev[co.job_id] || []).map(c => c.id === done.id ? done : c) }))
    setBanner(`${co.co_number} withdrawn. Nothing was added or billed.`)
    await fetchJobs()
  }

  // The owner recording the customer's answer. On approval the DATABASE mints the
  // line item — so all this has to do afterwards is re-read, and re-price a draft
  // invoice if this visit already has one.
  async function ownerChangeDecision(co: ChangeOrder, decision: 'approve' | 'decline') {
    const done = await recordOwnerDecision(supabase, co.id, decision)
    setChangeOrdersByJobId(prev => ({ ...prev, [co.job_id]: (prev[co.job_id] || []).map(c => c.id === done.id ? done : c) }))
    if (decision === 'decline') {
      setBanner(`${co.co_number} recorded as declined. It won't be added or billed.`)
    } else {
      const { changed, failed } = await syncDraftInvoiceAmounts(supabase, [co.job_id], { reason: `approved change ${co.co_number}` })
      setBanner(
        failed > 0 ? `${co.co_number} approved, but its draft invoice still shows the old amount — open the invoice to re-price it.`
          : changed > 0 ? `${co.co_number} approved — ${formatCurrency(co.amount)} added, and this visit's draft invoice was re-priced to match.`
            : invoicedJobIds.has(co.job_id)
              ? `${co.co_number} approved — ${formatCurrency(co.amount)} added. This visit is already invoiced, so check that bill covers it.`
              : `${co.co_number} approved — ${formatCurrency(co.amount)} added to this visit and it will be on its invoice.`)
    }
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
  //
  // ⭐ CHANGE-ORDER-BACKED ROWS ARE EXCLUDED, and restored by
  // changeOrderInsertRows below instead. A CO-backed line item's FK points at its
  // change order, which the same job deletion also cascaded away — so re-inserting
  // it alongside the plain add-ons would violate that FK and, because PostgREST
  // sends one bulk insert, take EVERY add-on down with it. The change orders are
  // re-inserted first (see the undo sites), which is what makes these rows legal.
  function addonInsertRows(ids: string[]): JobLineItem[] {
    return ids.flatMap(id => (addonsByJobId[id] || []).filter(a => !a.change_order_id))
  }
  // The approved-change half of the same snapshot. Restored BEFORE the add-ons:
  // job → change orders → line items is the FK order, and undoing a delete has to
  // put back the customer's approvals, not just the money they authorised.
  function changeOrderInsertRows(ids: string[]): ChangeOrder[] {
    return ids.flatMap(id => changeOrdersByJobId[id] || [])
  }
  // Re-insert a deleted visit's change orders and add-ons, in FK order. One
  // helper, because four undo paths delete visits and every one of them owes the
  // customer the same restoration.
  async function restoreVisitExtras(changeOrders: ChangeOrder[], addons: JobLineItem[]) {
    if (changeOrders.length) await supabase.from('change_orders').insert(changeOrders)
    if (addons.length) await supabase.from('job_line_items').insert(addons)
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

  // ⭐ STOP FOR TODAY — the day ends, the job does not. For work that runs past
  // one visit for any reason a trade recognises: a part didn't arrive, the light
  // went, the scope grew, or it was simply always a four-day job.
  //
  // ⛔ IT MUST NOT COMPLETE THE JOB, and it doesn't: nothing is invoiced, no
  // "we're finished" message goes out, and the accepted quote value, invoices
  // and payments already attached to this job are not touched. The status stays
  // `in_progress` — the job IS underway, it just has nobody on the clock — so
  // every board, filter, report and portal mapping that already understands
  // in_progress keeps being right. No new status was invented for this.
  //
  // The time worked is banked by the DATABASE as the check-in is cleared, into a
  // dated work session, so this page, the dispatch board and a crew phone can
  // never disagree about the day's total. See lib/workSession.
  //
  // The next work day is OPTIONAL: "not scheduled yet" leaves the visit where it
  // is, reading as unfinished. Inventing "tomorrow" would put work on a day
  // nobody agreed to. This-occurrence only — a recurring series is not touched.
  async function stopJobForToday(job: Job, input: StopForTodayInput) {
    const optimistic: Partial<Job> = {
      status: 'in_progress',
      started_at: null,
      ...(input.nextDate && input.nextDate !== job.scheduled_date
        ? { scheduled_date: input.nextDate, route_order: null }
        : {}),
    }
    setJobs(prevJobs => prevJobs.map(j => j.id === job.id ? { ...j, ...optimistic } : j))
    const res = await stopForToday(supabase, job, input)
    if (!res.ok) {
      setJobs(prevJobs => prevJobs.map(j => j.id === job.id ? { ...j, ...res.prev } : j))
      // ⛔ Stopping is NOT queued. It banks a work session and patches the visit
      // as one intent, and replaying that offline is a piece of engineering this
      // session did not do — so the write is rolled back and the job stays
      // exactly as it was, on the clock. What it must not do is blame the owner
      // for their signal in the machine's words: "Load failed" told a contractor
      // in a field nothing they could act on. Same question the outbox asks
      // before queuing anything, so the two can never disagree about what
      // "no signal" means.
      setBanner(isNetworkError(res.error)
        ? 'No signal — today’s time was not recorded, and the job is still on the clock. Try again once you’re back in range.'
        : 'Could not stop for today: ' + (res.error ?? 'please try again.'))
      return
    }
    await fetchJobs()
    const worked = res.session ? formatWorked(res.session.minutes) : ''
    const back = input.nextDate
      ? ` — back ${format(parseISO(input.nextDate + 'T00:00:00'), 'EEE, MMM d')}`
      : ' — no day set yet'
    offerUndo(`${worked ? `${worked} recorded` : 'Stopped'}${back}`, async () => {
      // Undo restores the job fields AND removes the session this stop banked —
      // a stop that never happened must not leave time on the record.
      const { error: undoErr } = await supabase.from('jobs').update(res.prev).eq('id', job.id)
      if (res.session) await deleteWorkSession(supabase, res.session)
      await fetchJobs()
      if (undoErr) setBanner('Could not undo — check the job’s day and status.')
    })
  }

  // ▶ Resume — the clock starts again on a job already underway. Distinct from
  // Start only in what it must NOT do: the sessions already banked and the
  // total they add up to stay exactly as they are.
  async function resumeJob(job: Job) {
    const patch = { status: 'in_progress' as const, started_at: new Date().toISOString() }
    setJobs(prevJobs => prevJobs.map(j => j.id === job.id ? { ...j, ...patch } : j))
    const res = await resumeWork(supabase, job)
    if (!res.ok) {
      setJobs(prevJobs => prevJobs.map(j => j.id === job.id ? { ...j, ...res.prev } : j))
      // Same contract as stopping: rolled back, and named as signal when that is
      // what it was. The clock genuinely did not start, so saying so is the
      // whole job — a "resumed" that never reached the server would put a
      // started_at on the record that no other device will ever see.
      setBanner(isNetworkError(res.error)
        ? 'No signal — the clock did not start. Try again once you’re back in range.'
        : 'Could not resume the job: ' + (res.error ?? 'please try again.'))
      return
    }
    await fetchJobs()
    offerUndo('Back on the clock', async () => {
      await supabase.from('jobs').update(res.prev).eq('id', job.id)
      await fetchJobs()
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

  // The displayed day and its visits, memoised. Both the settings bar and the
  // day board took `jobs.filter(...)` inline, so every unrelated re-render (a
  // toast, the live minute tick) handed the board a brand-new array — which the
  // board counts as "props refreshed" when deciding it may drop an optimistic
  // stop order. One stable array per day, changing only when the jobs actually do.
  const dayISO = format(cursor, 'yyyy-MM-dd')
  const dayJobs = useMemo(() => jobs.filter(j => j.scheduled_date === dayISO), [jobs, dayISO])

  // ── Estimate visits ─────────────────────────────────────────────────────────
  // Loaded unbounded (the table holds one row per estimate visit, not per
  // recurring occurrence, so there is no jobs-sized volume here) and filtered per
  // day / per month in the render. The hook is the only writer.
  const estimates = useEstimateAppointments()
  const [estimateDialog, setEstimateDialog] = useState<{ date: string; existing: EstimateAppointment | null } | null>(null)
  const dayEstimates = useMemo(
    () => estimates.items.filter(i => i.scheduled_date === dayISO),
    [estimates.items, dayISO])
  // Only the OPEN ones hold time the day still has to spend — a cancelled or
  // completed appointment is not a trip left to plan.
  const openDayEstimates = useMemo(() => dayEstimates.filter(estimateIsOpen), [dayEstimates])

  // Open the dialog once, when arrived at with ?estimate=new. Guarded by a ref
  // rather than the param so that closing the dialog does not immediately
  // reopen it on the next render.
  const estimateDeepLinkUsed = useRef(false)
  useEffect(() => {
    if (estimateParam !== 'new' || estimateDeepLinkUsed.current) return
    estimateDeepLinkUsed.current = true
    setEstimateDialog({ date: dayISO, existing: null })
  }, [estimateParam, dayISO])

  const setEstimateStatus = useCallback(async (item: EstimateAppointment, to: ScheduleItem['status']) => {
    const err = await estimates.setStatus(item.id, to)
    if (err) { toast.error(err); return }
    // The wording is the contract. "Visit done" and never "job complete" — the
    // customer's work has not been performed, and this is the surface where the
    // old $0-job workaround used to say otherwise.
    toast.success(
      to === 'completed' ? 'Estimate visit marked done — write the quote when you’re ready.'
      : to === 'cancelled' ? 'Estimate visit cancelled.'
      : to === 'no_show' ? 'Marked as a no-show.'
      : 'Estimate visit is back on the schedule.',
    )
  }, [estimates])

  const pendingVerb = pendingAction?.type === 'delete' ? 'Delete'
    : pendingAction?.type === 'move' ? 'Move'
    : pendingAction?.type === 'price' ? 'Update price for' : 'Save changes to'

  // THE next stop for the field bar: whatever you're on now, else the first one
  // still to do — in the same route order the cards are listed in, so the bar and
  // the board can never disagree about what's next. Undefined once the day's done,
  // which is what hides the bar.
  //
  // That last claim used to be false. This sorted by jobs.route_order, which is
  // written ONLY by a manual drag and is null on virtually every day, while the
  // board lists stops in the RESOLVED route order (optimizer output when no
  // manual sequence exists). With route_order and start_time both null the sort
  // did nothing at all, so "next stop" was just the first row of the fetch —
  // UUID order — and its one big button started that job. Now the board reports
  // the order it actually rendered (onStopOrder) and both read lib/fieldStops.
  // The rank falls back to the same rule the board uses before the route
  // resolves, so they agree during loading too.
  const fieldNext = useMemo(() => {
    const rank = boardStopOrder?.date === dayISO
      ? new Map(boardStopOrder.ids.map((id, i) => [id, i]))
      : null
    return nextFieldStop(orderDayStops(dayJobs, rank))
  }, [dayJobs, dayISO, boardStopOrder])

  // What the mobile + is standing on. The visit being EDITED when a form is
  // open, else the day's next stop — the same visit the field bar names, so the
  // + and the bar can never mean different jobs. Its status decides which
  // visit-scoped doors exist at all (lib/quickAdd).
  const quickAddJob = editing ?? (view === 'day' ? fieldNext : undefined)
  usePublishQuickAddContext(useMemo(() => (quickAddJob ? {
    kind: 'job' as const,
    jobId: quickAddJob.id,
    status: quickAddJob.status,
    customerId: quickAddJob.customer_id ?? null,
    customerName: quickAddJob.customers?.name ?? null,
    propertyId: quickAddJob.property_id ?? null,
  } : null), [quickAddJob]))

  return (
    // Reserve the field bar's height on phones so the last job card can still be
    // scrolled clear of it — a fixed bar is out of flow and would sit on top of it.
    // The reserve carries the home-indicator inset explicitly: the bar pays that
    // inset itself (it is positioned against the viewport, not <body>), so a flat
    // rem reserve fell short by exactly the inset on notched phones — and the
    // address line now in the bar spends the slack a flat 6rem used to have.
    <div className={cn('max-w-6xl mx-auto space-y-6',
      view === 'day' && fieldNext && 'pb-[calc(7rem+env(safe-area-inset-bottom))] lg:pb-0')}>
      <PageHeader
        title="Schedule"
        description={scheduleSubtitle(jobs.length)}
        action={
          // ⚠️ WRAPS. Four actions do not fit a phone: measured at 375px,
          // "Add estimate" ended at 400 and "Add job" at 491 — both off-screen,
          // so the primary create door on the schedule was unreachable there.
          // Pre-dates Session 82 (the fourth button arrived with estimate
          // appointments); found by scripts/dayseq-cdp.mjs and fixed here
          // because an unreachable "Add job" is not a cosmetic issue.
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Reschedule picks destination days the same way the optimizer does
                (planRainDelay skips blocked dates), so it carries the same risk
                when availability is unknown — refuse for the same reason. */}
            <Button variant="secondary" onClick={() => { if (dayStatusUnknown) { setBanner(DAY_STATUS_UNKNOWN_MSG); return } setRainCenterDay(rainTarget?.date ?? null); setShowRainCenter(true) }} title="Reschedule — move visits (weather, equipment, absence, holiday, emergency) and notify customers">
              <CalendarClock className="w-4 h-4" /> Reschedule
            </Button>
            <Button variant="secondary" onClick={() => launchOptimizer()} title="Optimize your schedule — pick scope and goal">
              <Rocket className="w-4 h-4" /> Optimize
            </Button>
            {/* Its OWN door, never folded into "Add job". These create different
                things — one is work, one is a visit to price work — and merging
                creation doors by label is how the $0-job workaround started. */}
            <Button variant="secondary" onClick={() => setEstimateDialog({ date: dayISO, existing: null })} title="Schedule an estimate visit — no job, no $0 quote">
              <Ruler className="w-4 h-4" /> Add estimate
            </Button>
            <Button onClick={() => openNewJob(cursor)}>
              <Plus className="w-4 h-4" /> Add job
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
          {/* The named "Tomorrow" shortcut that used to sit here was removed on
              the owner's direction (Session 112) — the header stays simpler, and
              tomorrow remains one tap away on the next-period chevron (and
              reachable by ?d=, the date heading's calendar, and month/week
              taps). Navigation capability is unchanged; only the extra button
              is gone. */}
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

      {/* Past-due visits — stranded open jobs from days already gone. Above Schedule
          Health because unbilled work + a customer a cycle behind is money at risk now. */}
      {!loading && missedJobs.length > 0 && (
        <MissedJobsCard
          jobs={missedJobs}
          today={tenantToday}
          onBringToToday={(job) => moveJobToDate(job, new Date())}
          onComplete={(job) => { void completeJob(job) }}
          onOpen={(job) => setEditing(job)}
        />
      )}

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
              {/* Measured at 14×14 on a phone — the bare icon WAS the hit area, and it
                  sits beside the "Rebalance …" CTA, so a thumb aiming at the action
                  dismissed the suggestion instead. `.tap-target` is the app's own 44×44
                  minimum and is gated on `pointer: coarse`, so desktop density is
                  unchanged; only the touch hit area grows. */}
              <button onClick={() => setDismissedSuggestions(prev => new Set(prev).add(s.id))}
                className="tap-target inline-flex items-center justify-center text-ink-faint hover:text-ink shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" title="Dismiss" aria-label="Dismiss suggestion">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Schedule / edit an estimate visit. Its own dialog, not JobForm: JobForm
          collects price, recurrence and service — every one of which is a claim
          an estimate visit must not be able to make. */}
      <EstimateAppointmentDialog
        open={estimateDialog !== null}
        onClose={() => setEstimateDialog(null)}
        customers={customers}
        crews={crews}
        technicians={technicians}
        existing={estimateDialog?.existing ?? null}
        defaultDateISO={estimateDialog?.date}
        defaultCustomerId={customerParam}
        defaultPropertyId={propertyParam}
        quoteId={quoteId}
        onSave={async (input) => {
          if (estimateDialog?.existing) return estimates.update(estimateDialog.existing.id, input)
          const { error } = await estimates.create(input)
          if (!error) toast.success('Estimate visit scheduled.')
          return error
        }}
      />

      {/* Edit/New job — modal overlay so Open always brings the correct job into view */}
      {(showForm || editing) && (
        <div className="fixed inset-0 z-overlay overflow-y-auto bg-black/50" onClick={requestCloseForm}>
          <div className="min-h-full flex items-start justify-center p-4 sm:p-6">
            <Card role="dialog" aria-modal="true" aria-labelledby="job-form-title" className="w-full max-w-2xl my-2 shadow-2xl" onClick={e => e.stopPropagation()}>
          <CardHeader className="flex items-center justify-between">
            <h2 id="job-form-title" className="text-sm font-semibold text-ink">{editing ? 'Edit Job' : 'New Job'}</h2>
            <div className="flex items-center gap-2">
              {/* Both measured at 16×16 with only gap-2 between them — and one of them
                  DELETES THE JOB. Two 16px targets 8px apart put an irreversible action
                  a thumb-width from "close the dialog". `.tap-target` gives each the
                  app's 44×44 minimum on touch (desktop is untouched), which also pushes
                  their centres ~52px apart instead of 24px. Confirmation on delete is
                  unchanged — this only makes the two hard to confuse for each other. */}
              {editing && (
                <button onClick={handleDelete} className="tap-target inline-flex items-center justify-center text-red-400/70 hover:text-red-400 transition-colors" title="Delete job" aria-label="Delete job">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
              <button onClick={requestCloseForm} className="tap-target inline-flex items-center justify-center text-ink-faint hover:text-ink transition-colors" aria-label="Close">
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
                {/* The visit's LOCATION page — its history, access notes and siblings.
                    Distinct from Navigate (directions to it) and Customer (who it's
                    for): a customer with several addresses needs the door to THIS one. */}
                {editing.property_id && <QuickAction href={`/dashboard/properties/${editing.property_id}`} icon={MapPin} label="Location" />}
                {editing.quote_id && <QuickAction href={`/dashboard/quotes/${editing.quote_id}`} icon={FileText} label="Quote" />}
                {editing.status === 'completed' && <QuickAction href="/dashboard/invoices" icon={Receipt} label="Invoice" />}
              </div>
            )}
            <JobForm
              key={editing?.id ?? `new-${formSeq}`}
              customers={customers}
              crews={crews}
              technicians={technicians}
              excludeJobId={editing?.id}
              allowAddAnother={!editing && !quoteCtx && !customerPrefill}
              initialRecurrence={editing?.recurrence_id && recurrences[editing.recurrence_id]
                ? recFromRow(recurrences[editing.recurrence_id])
                : (!editing ? quoteRecurrence : undefined)}
              seriesStartDate={editing?.recurrence_id ? recurrences[editing.recurrence_id]?.start_date : undefined}
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
                // ⛔ WAS `editing.price ?? 0`. A visit whose price is NULL — the
                // normal state of every visit in a quote-linked series — opened
                // its editor showing "0", so the owner read "this visit is worth
                // nothing" where the row actually says "follow the quote". Blank
                // is what NULL means here, and the save turns blank back into
                // NULL, so the round-trip is now lossless.
                price: editing.price ?? BLANK_NUMERIC_FIELD,
                crew_id: editing.crew_id ?? null,
                technician_id: editing.technician_id ?? null,
              } : (quotePrefill ?? customerPrefill ?? { scheduled_date: formDate })}
              quoteLinked={!!editing?.quote_id}
              // ?panel=time|cost lands on anchors inside the editor's More
              // options section — open it so the scroll has somewhere to go.
              initialMoreOpen={!!readJobPanel(panelParam)}
              suggestedPrice={editing?.quote_id
                ? quoteVisitAmount(
                    quotesById[editing.quote_id] as unknown as Record<string, unknown>,
                    editing.recurrence_id && recurrences[editing.recurrence_id]
                      ? effectiveFreq(recurrences[editing.recurrence_id].freq, recurrences[editing.recurrence_id].interval_unit, recurrences[editing.recurrence_id].interval_count)
                      : null,
                  ) || undefined
                : undefined}
              onSubmit={editing ? handleEdit : handleAdd}
              onDirtyChange={d => { formDirty.current = d }}
              onCancel={requestCloseForm}
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
          onMoveAndNotify={rainTarget ? () => { setRainCenterDay(rainTarget.date); setShowRainCenter(true) } : undefined}
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
          date={dayISO}
          jobs={dayJobs}
          row={dayStatusMap?.byDate[dayISO] ?? null}
          defaultCrew={defaultCrew}
          capacityHours={capacityHours}
          workStartTime={workStartTime}
          busy={rainBusy === dayISO}
          onSetCapacity={(patch) => saveDayCapacity(dayISO, patch)}
          onResetCapacity={() => resetDayCapacity(dayISO)}
          onToggleDisable={() => toggleDisableDay(dayISO)}
        />
        {/* Above the work board, in the same language: the owner reads one day —
            what I'm quoting, and what I'm doing. Renders nothing when there are
            no estimate visits, so a normal day is unchanged. */}
        <EstimateDayBoard
          items={dayEstimates}
          error={estimates.error}
          onEdit={(item) => setEstimateDialog({ date: item.scheduled_date, existing: item })}
          onSetStatus={setEstimateStatus}
          onAdd={() => setEstimateDialog({ date: dayISO, existing: null })}
        />
        <DayOpsPanel
          date={dayISO}
          dateLabel={format(cursor, 'EEEE, MMMM d, yyyy')}
          jobs={dayJobs}
          onStopOrder={setBoardStopOrder}
          onChatUnread={setBoardChatUnread}
          quotesById={quotesById}
          recurrences={recurrences}
          baseCoord={baseCoord}
          onOpenJob={(job) => { setEditing(job); setShowForm(false) }}
          onStartJob={startJob}
          onMarkDone={completeJob}
          onMove={(job, iso) => moveJobToDate(job, new Date(iso + 'T00:00:00'))}
          onStopForToday={stopJobForToday}
          onResume={resumeJob}
          onDeleteJob={deleteJob}
          onSetPrice={setJobPrice}
          addonsByJobId={addonsByJobId}
          onAddLineItem={addLineItemToJob}
          onDeleteLineItem={removeLineItem}
          getPreviousAddons={getPreviousAddons}
          onCopyPreviousAddons={copyPreviousAddons}
          addonTemplates={addonTemplates}
          changeOrdersByJobId={changeOrdersByJobId}
          onCreateChangeOrder={createChangeOrderForJob}
          onSendChangeOrder={sendChange}
          onCancelChangeOrder={cancelChange}
          onOwnerChangeDecision={ownerChangeDecision}
          onRemindChangeOrder={remindChange}
          workStartTime={dayView.start}
          capacityHours={dayView.laborHours}
          workersOnDay={workersOnOpenDay}
          staffingOnDay={staffingOnOpenDay}
          crewNames={dayFitCtx?.crewNames}
          crews={crews}
          technicians={technicians}
          availabilityRecorded={dayFitCtx?.availabilityRecorded}
          // Session 82: the day's OPEN estimate appointments, so "Optimize day"
          // plans around the trips this day genuinely has to make. They anchor
          // the order; they are never re-sequenced (no route_order column).
          estimates={openDayEstimates}
          // A billed visit is immutable — the optimizer must not move one.
          invoicedJobIds={invoicedJobIds}
          learnedDurationFor={dayFitCtx?.learnedFor}
          onRainDelay={() => rainDelayDay(dayISO)}
          onAddJob={() => openNewJob(cursor)}
          onQuickSave={quickSaveJob}
          reviewUrl={msgCtx.reviewUrl}
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
          // The prop Calendar has always accepted and nothing ever passed —
          // which is exactly why the table sat empty. Estimates now sit beside
          // the work in month and week view, in their own colour.
          scheduleItems={estimates.items}
          onSelectItem={(item) => setEstimateDialog({ date: item.scheduled_date, existing: item as EstimateAppointment })}
          onMoveItem={async (item, iso) => {
            const err = await estimates.update(item.id, { scheduled_date: iso })
            if (err) toast.error(err)
          }}
        />
      )}

      {/* The completion message, shown BEFORE it goes out (Session 80). Cancel
          (X/Escape/backdrop) completes nothing — the visit stays as it was. */}
      <CompleteConfirm
        open={!!completeAsk}
        customerName={completeAsk?.job.customers?.name || 'the customer'}
        channels={completeAsk?.channels ?? []}
        contactKnown={completeAsk?.contactKnown ?? true}
        text={completeAsk?.text ?? ''}
        onText={t => setCompleteAsk(a => (a ? { ...a, text: t } : a))}
        busy={completeBusy}
        onConfirm={async send => {
          if (!completeAsk || completeBusy) return
          setCompleteBusy(true)
          try {
            // Only an EDITED text rides as bodyOverride — an untouched preview
            // lets the route render from the owner's template as it always has.
            const edited = completeAsk.text.trim() !== completeAsk.defaultText.trim()
            await performComplete(completeAsk.job, send, send && edited ? fromDisplayBody(completeAsk.text) : undefined)
            setCompleteAsk(null)
          } finally {
            setCompleteBusy(false)
          }
        }}
        onCancel={() => { if (!completeBusy) setCompleteAsk(null) }}
      />

      {pendingAction && (
        <ScopeDialog
          title={pendingAction.job.title}
          verb={pendingVerb}
          destructive={pendingAction.type === 'delete'}
          /* Reach per scope, from the same jobsInScope the mutation runs. */
          impacts={scopeImpacts(pendingAction.job, jobs)}
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
          initialDay={rainCenterDay ?? undefined}
          onApply={applyOptimization}
          onClose={() => { setShowRainCenter(false); setRainCenterDay(null) }}
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
        <FieldStopBar
          job={fieldNext}
          baseCoord={baseCoord}
          unread={boardChatUnread[fieldNext.id] ?? 0}
          busy={fieldActing}
          onStop={() => setStopping(fieldNext)}
          onPrimary={async () => {
            if (fieldActing) return
            setFieldActing(true)
            try {
              if (fieldNext.status === 'in_progress') {
                // Paused: the useful next tap is picking the clock back up,
                // not finishing. Completing is still one tap away in the card.
                if (fieldNext.started_at) await completeJob(fieldNext)
                else await resumeJob(fieldNext)
              } else await startJob(fieldNext)
            } finally { setFieldActing(false) }
          }}
        />
      )}

      {/* ONE stop sheet for the whole page — the phone bar and the day board
          both open it, so "Stop for today" asks the same three questions
          wherever it is reached. */}
      {stopping && (
        <StopForTodaySheet
          open
          onClose={() => setStopping(null)}
          jobTitle={stopping.customers?.name || stopping.title}
          crewSize={stopping.crew_size ?? 1}
          runningSince={stopping.started_at}
          busy={stopBusy}
          onStop={async input => {
            setStopBusy(true)
            try { await stopJobForToday(stopping, input) } finally { setStopBusy(false); setStopping(null) }
          }} />
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
