'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import { confirm } from '@/lib/confirm'
import { createClient } from '@/lib/supabase/client'
import { Crew, Job, JobStatus, JobRecurrence, JobLineItem, RecurrenceScope, AddonTemplate, PRICE_REASONS, JOB_STATUS_LABELS, JOB_STATUS_COLORS } from '@/types'
import { Coord } from '@/lib/geo'
import { RouteStop, OrderedRouteStop, geocodeMissingStops, optimizeRoute, nearestNeighborRoute, sequenceRoute, roundTripMapsUrl, MAX_MAPS_WAYPOINTS, directionsUrl, dayLoad, minutesToTime12, timeToMinutes, DEFAULT_JOB_MIN } from '@/lib/route'
import { planDay, type DayPlanStopInput } from '@/lib/dayPlan'
import type { WorkerDayDetail } from '@/lib/workerAvailability'
import { loadTravelModel, DEFAULT_TRAVEL_MODEL, type TravelModel } from '@/lib/travelLearning'
import { buildRoadDistance, type RoadDist, type RoadSeconds, type RoadHas } from '@/lib/distance'
import { jobVisitValue, effectiveFreq, quoteVisitAmount } from '@/lib/invoicing'
import { addonsTotal } from '@/lib/jobPricing'
import { formatCurrency, cn, localTodayISO } from '@/lib/utils'
import { orderDayStops, crewOrderStatus } from '@/lib/fieldStops'
import { DayPlanPanel } from '@/components/schedule/DayPlanPanel'
import { scrollBehavior } from '@/lib/motion'
import { Button } from '@/components/ui/Button'
import { Menu } from '@/components/ui/Menu'
import { EmptyState } from '@/components/ui/EmptyState'
import { JobPhotos } from '@/components/photos/JobPhotos'
import { JobFormsPanel } from '@/components/forms/JobFormsPanel'
import { RouteTimeline, type TimelineStop } from '@/components/schedule/RouteTimeline'
import { VisitAddress } from '@/components/schedule/VisitAddress'
import { JobAddons } from '@/components/schedule/JobAddons'
import { JobChangeOrders, type ChangeOrderCreateInput } from '@/components/schedule/JobChangeOrders'
import { authorizedValue, type ChangeOrder } from '@/lib/changeOrders'
import { JobMessages } from '@/components/schedule/JobMessages'
import { VisitConversation } from '@/components/schedule/VisitConversation'
import { loadOwnerUnread } from '@/lib/crewMessages'
import { SendMessageDialog, type MessageRecipient } from '@/components/comms/SendMessageDialog'
import {
  DollarSign, CheckCircle2, Check, Repeat, Navigation, ExternalLink,
  Plus, Pencil, Move, ListChecks, Wallet, Hourglass, SlidersHorizontal, AlertTriangle, CloudRain, Play, Timer, Camera, PlusCircle, MessageSquare, Send, Receipt,
  ChevronUp, ChevronDown, Wand2, MoreHorizontal, CalendarDays, StickyNote, MessagesSquare, PauseCircle,
  FileSignature, ClipboardCheck,
} from 'lucide-react'
import StopForTodaySheet from '@/components/jobs/StopForTodaySheet'
import type { StopForTodayInput } from '@/lib/workSession'
import { VisitQuickEdit, type QuickPatch } from '@/components/schedule/VisitQuickEdit'

// The quick-edit patch contract now lives with the sheet that produces it; the
// page keeps importing it from here.
export type { QuickPatch } from '@/components/schedule/VisitQuickEdit'

export interface QuoteLite {
  id: string
  total: number | null
  initial_price: number | null
  weekly_price: number | null
  biweekly_price: number | null
  monthly_price: number | null
}

interface Props {
  date: string
  dateLabel: string
  jobs: Job[] // the day's jobs (all statuses)
  quotesById: Record<string, QuoteLite>
  recurrences: Record<string, JobRecurrence>
  baseCoord: Coord | null
  onOpenJob: (job: Job) => void
  onStartJob: (job: Job) => void | Promise<void>
  onMarkDone: (job: Job) => void | Promise<void>
  onMove: (job: Job, newDateISO: string) => void
  // ⭐ Stop for the day WITHOUT completing the visit: banks the time worked so
  // far as a dated work session, stops the clock, keeps photos/notes/price, and
  // optionally lands the job on the day it will be picked up again. The job
  // stays IN PROGRESS. ⛔ Nothing is billed and the customer is told nothing —
  // that is the whole distinction from onMarkDone.
  onStopForToday: (job: Job, input: StopForTodayInput) => void | Promise<void>
  // ▶ Pick the clock back up on a job already underway. The sessions already
  // banked are untouched.
  onResume: (job: Job) => void | Promise<void>
  onDeleteJob: (job: Job) => void
  onSetPrice: (job: Job, price: number | null, reason?: string) => Promise<void>
  workStartTime: string
  capacityHours: number
  // ⭐ Who can actually work this day, and what history says a service takes —
  // Session 46's loader (lib/dayFitLoad), loaded once by the page for its
  // horizon rather than per day board. `undefined`/null means NOT KNOWN, which
  // lib/dayPlan reports as a caveat; it never reads as a fully-staffed day.
  workersOnDay?: number | null
  // ⭐ Session 67: the same read, per person — who is off, who does not work
  // this weekday, who is only ASSUMED available. Feeds the day plan's staffing
  // warnings so a short crew is named rather than merely counted. Null = not
  // known (outside the loaded horizon, or the roster read failed).
  staffingOnDay?: WorkerDayDetail[] | null
  /** Crew id → name, for naming a crew in a staffing warning. */
  crewNames?: Record<string, string>
  /** The crew roster, for the quick-edit sheet's Assignee control. Empty =
   *  the business has no crews and the control simply never renders. */
  crews?: Crew[]
  /** False when nobody has a recorded weekly pattern — availability is assumed. */
  availabilityRecorded?: boolean
  learnedDurationFor?: (serviceType: string | null | undefined) => number | null
  onRainDelay: () => void
  onAddJob: () => void
  onQuickSave: (job: Job, patch: QuickPatch) => Promise<void>
  // Add-on services per visit + handlers (the JOB is the source of truth; these
  // are additive and flow into the draft invoice automatically).
  addonsByJobId: Record<string, JobLineItem[]>
  onAddLineItem: (job: Job, input: { description: string; amount: number; serviceKey: string; scope: RecurrenceScope }) => Promise<void>
  onDeleteLineItem: (item: JobLineItem) => Promise<void>
  // The previous visit's add-ons (for the one-tap "copy previous" action).
  getPreviousAddons: (job: Job) => { description: string; amount: number; serviceKey: string }[]
  onCopyPreviousAddons: (job: Job) => Promise<void>
  // Quick-add chips for the add-on editor, resolved from the business's trade
  // pack by the page — passed through untouched.
  addonTemplates: AddonTemplate[]
  // ── Change orders: scope priced AFTER the original approval ────────────────
  // The authorization only. Approving one mints its job_line_items row in the
  // database, so it reaches the invoice through the add-on path that already
  // exists — this panel never writes money itself.
  changeOrdersByJobId: Record<string, ChangeOrder[]>
  onCreateChangeOrder: (job: Job, input: ChangeOrderCreateInput) => Promise<void>
  onSendChangeOrder: (co: ChangeOrder) => Promise<void>
  onCancelChangeOrder: (co: ChangeOrder) => Promise<void>
  onOwnerChangeDecision: (co: ChangeOrder, decision: 'approve' | 'decline') => Promise<void>
  onRemindChangeOrder: (co: ChangeOrder) => Promise<void>
  // Reports the day's RESOLVED stop order (this list's order, by job id) so the
  // page's field bar can name the same next stop. Optional: the board renders
  // identically without it.
  onStopOrder?: (order: { date: string; ids: string[] }) => void
  // …and the crew-message unread counts it already loaded, for the same reason:
  // the field bar shows the next stop's badge, and a SECOND query for the same
  // answer is how two surfaces start disagreeing about whether there is a
  // message waiting. One pair of queries for the whole day, shared.
  onChatUnread?: (counts: Record<string, number>) => void
}


export function DayOpsPanel({
  date, dateLabel, jobs, quotesById, recurrences, baseCoord,
  onOpenJob, onStartJob, onMarkDone, onMove, onStopForToday, onResume, onSetPrice, workStartTime, capacityHours,
  workersOnDay, staffingOnDay, crewNames, crews, availabilityRecorded, learnedDurationFor, onRainDelay, onAddJob, onQuickSave,
  addonsByJobId, onAddLineItem, onDeleteLineItem, getPreviousAddons, onCopyPreviousAddons, addonTemplates,
  changeOrdersByJobId, onCreateChangeOrder, onSendChangeOrder, onCancelChangeOrder, onOwnerChangeDecision, onRemindChangeOrder,
  onStopOrder, onChatUnread,
}: Props) {
  const supabase = createClient()
  // Guards Start/Complete against a double-tap (which would double-stamp the job
  // and double-create its draft invoice) while the request is in flight.
  const [acting, setActing] = useState<string | null>(null)
  // The visit whose quick-edit sheet is open (VisitQuickEdit — the fast door
  // for service/date/time/duration/assignee/status/note on one visit).
  const [quickJob, setQuickJob] = useState<Job | null>(null)
  const [moveId, setMoveId] = useState<string | null>(null)
  // Which visit's "Stop for today" sheet is open. A sheet rather than the old
  // inline date picker because stopping is now three answers, not one, and the
  // most important of them ("when are you back?") has a legitimate "not yet".
  const [stopping, setStopping] = useState<Job | null>(null)
  const [stopBusy, setStopBusy] = useState(false)
  // First-class price: a dedicated, price-only inline editor on every card.
  const [priceId, setPriceId] = useState<string | null>(null)
  const [priceVal, setPriceVal] = useState('')
  const [priceReason, setPriceReason] = useState('')
  const [savingPrice, setSavingPrice] = useState(false)
  // Which job's before/after photo panel is open.
  const [photoId, setPhotoId] = useState<string | null>(null)
  // Which job's checklist panel is open (Job Forms V1 — the owner view of the
  // forms this visit carries, plus the waive door).
  const [checklistId, setChecklistId] = useState<string | null>(null)
  // Which job's add-on services panel is open.
  const [addonsId, setAddonsId] = useState<string | null>(null)
  // Which job's change-order panel is open.
  const [changesId, setChangesId] = useState<string | null>(null)
  // Which job's one-tap messaging panel is open. ⚠️ This one texts the CUSTOMER.
  const [messageId, setMessageId] = useState<string | null>(null)
  // Which job's CREW conversation is open — the internal one, which no customer
  // surface can read. Deliberately a separate panel from `messageId` above: the
  // two have opposite audiences and merging them is how a gate code ends up in
  // an SMS.
  const [chatId, setChatId] = useState<string | null>(null)
  // Unread crew messages per visit, so a card can say "2 new" without opening
  // every visit to find out. One pair of queries for the whole day.
  const [chatUnread, setChatUnread] = useState<Record<string, number>>({})
  // "Message today's customers" dialog (day-level bulk send).
  const [showDayMsg, setShowDayMsg] = useState(false)
  // Job currently sending a one-tap "On my way" (locks the button against double-tap).
  const [sendingEta, setSendingEta] = useState<string | null>(null)
  // Drag feedback (desktop reorder): dim the dragged card, ring the drop target —
  // same drag language as the calendar's cross-day move.
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  // What the one-tap "On my way" promises the customer, in minutes.
  //
  // It is a fixed guess and cannot honestly be anything else: there is no GPS fix
  // on the truck, and the route's leg times run from the PREVIOUS stop rather than
  // from wherever the owner actually is. So the number stays a default — but the
  // button that sends it now NAMES it, because the template turns this into a
  // specific, falsifiable promise ("arrive in approximately 15 minutes") that the
  // owner otherwise never saw and never chose. Label and payload both read from
  // here, so the button can never drift from what the customer is told. A
  // different ETA goes through Message, which has an input for it.
  const ONE_TAP_ETA_MIN = '15'

  // One-tap "On my way" — no composer, no typing. Sends the owner's on_my_way
  // template with the default ETA through the SAME pipeline as the editable
  // composer (/api/comms/send: opt-in-gated, logged, threaded, and it stamps
  // on_my_way_at so the customer portal shows a live status). The "Message" panel
  // remains for a custom ETA or wording.
  async function sendOnMyWay(job: Job) {
    if (sendingEta) return
    if (!job.customer_id) { toast.error('Link a customer to this job to send updates.'); return }
    setSendingEta(job.id)
    try {
      const res = await fetch('/api/comms/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: job.customer_id, template: 'on_my_way', jobId: job.id,
          channels: ['sms', 'email'],
          vars: { eta: ONE_TAP_ETA_MIN, address: job.properties?.address ?? undefined },
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { results?: Record<string, { sent?: boolean; reason?: string }> }
      const results = data.results || {}
      const sent = Object.entries(results).filter(([, v]) => v.sent).map(([ch]) => ch)
      if (sent.length) { toast.success(`“On my way” sent by ${sent.join(' & ')}.`); return }
      const reasons = Object.values(results).map(v => v.reason)
      if (reasons.includes('no-optin')) toast.error('Customer hasn’t opted in — turn on SMS/email on their profile.')
      else if (reasons.includes('disabled')) toast.error('Messaging is off — add Twilio/Resend keys in Settings.')
      else toast.error('Nothing sent — no phone or email on file for this customer.')
    } catch {
      toast.error('Could not reach the server. Please try again.')
    } finally {
      setSendingEta(null)
    }
  }

  // A card shows at most ONE inline panel at a time (price, quick edit, move,
  // photos, services or message). That invariant used to be re-implemented at
  // every button — each opener spelled out its own "close the other five" list,
  // and they drifted: the price/add-ons openers forgot Message, and the overflow
  // menu's Quick-edit and Move forgot Photos/Services/Message, so those stacked.
  // ONE closer, called by every opener, is the source of truth. Toggle helpers
  // keep the tap-again-to-close behaviour the buttons already had.
  function closePanels() {
    setPriceId(null); setQuickJob(null); setMoveId(null)
    setPhotoId(null); setAddonsId(null); setMessageId(null)
    setChatId(null); setChangesId(null); setChecklistId(null)
  }
  const toggleChecklist = (job: Job) => { const was = checklistId === job.id; closePanels(); if (!was) setChecklistId(job.id) }
  const toggleChat = (job: Job) => { const was = chatId === job.id; closePanels(); if (!was) setChatId(job.id) }
  const togglePhoto = (job: Job) => { const was = photoId === job.id; closePanels(); if (!was) setPhotoId(job.id) }
  const toggleAddons = (job: Job) => { const was = addonsId === job.id; closePanels(); if (!was) setAddonsId(job.id) }
  const toggleChanges = (job: Job) => { const was = changesId === job.id; closePanels(); if (!was) setChangesId(job.id) }
  const toggleMessage = (job: Job) => { const was = messageId === job.id; closePanels(); if (!was) setMessageId(job.id) }
  const toggleMove = (job: Job) => { const was = moveId === job.id; closePanels(); if (!was) setMoveId(job.id) }
  const openStop = (job: Job) => { closePanels(); setStopping(job) }

  function openPrice(job: Job) {
    closePanels()
    setPriceId(job.id)
    setPriceVal(job.price != null ? String(job.price) : '')
    setPriceReason('')
  }
  async function savePrice(job: Job) {
    setSavingPrice(true)
    const t = priceVal.trim()
    const next = t === '' ? null : (Number(t) > 0 ? Number(t) : null)
    // A reason is only meaningful on an increase (the user's rule); send it only then.
    const isIncrease = next != null && next > Math.round(jobValue(job))
    await onSetPrice(job, next, isIncrease ? (priceReason.trim() || undefined) : undefined)
    setSavingPrice(false)
    setPriceId(null)
  }
  // The quote-derived value for a job, ignoring any manual override — so the
  // editor can show "from quote" and offer a one-tap revert.
  function quoteValueFor(job: Job): number {
    const q = job.quote_id ? quotesById[job.quote_id] : null
    if (!q) return 0
    const rec = job.recurrence_id ? recurrences[job.recurrence_id] : null
    const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
    // The anchor visit derives the quote's INITIAL price, not the cadence price.
    return quoteVisitAmount(q as unknown as Record<string, unknown>, job.is_initial_visit ? null : freq)
  }
  function cadenceLabelFor(job: Job): string {
    if (job.is_initial_visit) return 'initial visit'
    const rec = job.recurrence_id ? recurrences[job.recurrence_id] : null
    const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
    return freq ?? 'first visit'
  }

  function openQuick(job: Job) {
    closePanels()
    setQuickJob(job)
  }
  const [route, setRoute] = useState<{ ordered: OrderedRouteStop[]; totalKm: number; mapsUrl: string | null; usedGoogle: boolean; usedRoad: boolean } | null>(null)
  // The day's road data, HELD rather than consumed inside the routing effect.
  //
  // ⚠️ It used to be discarded the moment the optimized order was built, so a
  // manual reorder re-ran sequenceRoute with the DEFAULT haversine distance:
  // dragging one stop silently swapped every kilometre and every arrival time
  // on the day from real-road to straight-line, and the only tell was the
  // "Real-road" badge quietly disappearing. Keeping it means the owner's order
  // and the optimizer's order are measured the same way — which is the least a
  // reorder should be able to assume.
  const [road, setRoad] = useState<{ dist: RoadDist; seconds: RoadSeconds; hasRoad: RoadHas; usedRoad: boolean } | null>(null)
  const [routing, setRouting] = useState(false)
  // Learned drive speed + load/unload overhead from completed routes — sharpens the
  // route's drive minutes and per-stop ETAs over time (falls back to 2 min/km).
  const [travel, setTravel] = useState<TravelModel>(DEFAULT_TRAVEL_MODEL)
  useEffect(() => { let alive = true; loadTravelModel(supabase).then(m => { if (alive) setTravel(m) }); return () => { alive = false } }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const lastKey = useRef<string>('')

  // The BASE value of one visit, from its quote/price (cadence-aware). One engine.
  function jobValue(job: Job): number {
    const q = job.quote_id ? quotesById[job.quote_id] : null
    const rec = job.recurrence_id ? recurrences[job.recurrence_id] : null
    const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
    return jobVisitValue(job.price, q as unknown as Record<string, unknown>, freq, job.is_initial_visit)
  }
  // Add-ons on a visit + the TOTAL job value (base + add-ons) — the number the
  // invoice will bill. Shown everywhere money is shown.
  function addonsFor(job: Job): JobLineItem[] { return addonsByJobId[job.id] || [] }
  function changesFor(job: Job): ChangeOrder[] { return changeOrdersByJobId[job.id] || [] }
  // The three-figure breakdown for this visit, from THE one engine. `jobTotal`
  // below stays the billable number (base + every add-on, approved changes
  // included, because approval already minted their line items) — this only
  // separates that number into the parts a customer would recognise.
  function avFor(job: Job) {
    return authorizedValue({ originalValue: jobValue(job), changeOrders: changesFor(job), lineItems: addonsFor(job) })
  }
  function jobTotal(job: Job): number { return jobValue(job) + addonsTotal(addonsFor(job)) }

  const active = jobs.filter(j => j.status !== 'cancelled')
  const completed = active.filter(j => j.status === 'completed')
  const remaining = active.filter(j => j.status !== 'completed')
  // Recipients for "Message today's customers" — one per customer scheduled today.
  const dayRecipients: MessageRecipient[] = (() => {
    const seen = new Set<string>()
    const out: MessageRecipient[] = []
    for (const j of active) {
      if (!j.customer_id || seen.has(j.customer_id)) continue
      seen.add(j.customer_id)
      out.push({ customerId: j.customer_id, name: j.customers?.name || j.title, phone: j.customers?.phone ?? null, service: j.service_type })
    }
    return out
  })()
  // The day's work minutes are no longer totalled here: lib/dayPlan resolves
  // each visit's duration (own estimate → learned → the shared default) and
  // reports how many it had to assume, so a second `|| DEFAULT_JOB_MIN` sum on
  // this screen could only drift from the one the plan is judged against.
  const totalRevenue = active.reduce((s, j) => s + jobTotal(j), 0)
  const revenueCompleted = completed.reduce((s, j) => s + jobTotal(j), 0)
  const revenueRemaining = remaining.reduce((s, j) => s + jobTotal(j), 0)
  const locatedCoords = active
    .filter(j => j.properties?.lat != null && j.properties?.lng != null)
    .map(j => ({ lat: j.properties!.lat as number, lng: j.properties!.lng as number }))

  // Optimize the day's route via the shared engine. Re-runs only when the set of
  // active jobs (or the base) changes — not when a status flips — so marking Done
  // doesn't re-hit the routing API.
  useEffect(() => {
    const key = date + '|' + (baseCoord ? `${baseCoord.lat},${baseCoord.lng}` : 'no-base') + '|' + active.map(j => j.id).join(',')
    if (key === lastKey.current) return
    lastKey.current = key
    let alive = true
    async function run() {
      if (!baseCoord || active.length === 0) { setRoute(null); return }
      setRouting(true)
      const stops: RouteStop[] = active.map(job => ({
        jobId: job.id,
        title: job.customers?.name || job.title,
        address: job.properties?.address || job.title,
        propertyId: job.properties?.id ?? null,
        lat: job.properties?.lat ?? null,
        lng: job.properties?.lng ?? null,
      }))
      await geocodeMissingStops(supabase, stops)
      const located = stops.filter(s => s.lat != null && s.lng != null)
      // Prefer cached real-road distances (fetched once, reused) for ordering and
      // km; fall back to the Directions API / haversine when none are available.
      const { data: { user } } = await supabase.auth.getUser()
      if (user && located.length > 1) {
        const { dist, seconds, hasRoad, usedRoad } = await buildRoadDistance(supabase, user.id, [baseCoord, ...located.map(s => ({ lat: s.lat as number, lng: s.lng as number }))])
        if (alive) setRoad({ dist, seconds, hasRoad, usedRoad })
        if (usedRoad) {
          const nn = nearestNeighborRoute(baseCoord, located, dist)
          if (alive) setRoute({ ordered: nn.ordered, totalKm: nn.totalKm, mapsUrl: roundTripMapsUrl(baseCoord, nn.ordered), usedGoogle: true, usedRoad: true })
          if (alive) setRouting(false)
          return
        }
      } else if (alive) {
        setRoad(null)
      }
      const res = await optimizeRoute(baseCoord, stops)
      if (alive) setRoute({ ordered: res.ordered, totalKm: res.totalKm, mapsUrl: res.mapsUrl, usedGoogle: res.usedGoogle, usedRoad: false })
      if (alive) setRouting(false)
    }
    run()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, baseCoord?.lat, baseCoord?.lng, active.map(j => j.id).join(',')])

  // ── Manual route order (drag-and-drop) ──
  // jobs.route_order is the saved manual sequence; localSeq is the optimistic
  // override while a reorder persists ('auto' = owner just reset to optimizer).
  const [localSeq, setLocalSeq] = useState<string[] | 'auto' | null>(null)
  useEffect(() => { setLocalSeq(null) }, [date])

  // Unread crew messages for the visits on this day. Two queries for the whole
  // board rather than one per card, and a failure is deliberately SILENT: an
  // absent badge hides an affordance, while an error banner over the day's work
  // would push the actual work off the screen. (CrewToday's media counts make
  // the same trade for the same reason.)
  const jobIdsKey = jobs.map(j => j.id).join(',')
  useEffect(() => {
    let alive = true
    ;(async () => {
      const ids = jobIdsKey ? jobIdsKey.split(',') : []
      if (!ids.length) { setChatUnread({}); return }
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid) return
      const counts = await loadOwnerUnread(supabase, uid, ids)
      if (alive) setChatUnread(counts)
    })()
    return () => { alive = false }
  }, [jobIdsKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // Publish the counts upward whenever they change — including the clear-to-zero
  // that opening a conversation causes, so the field bar's badge disappears at
  // the same moment the card's does.
  useEffect(() => { onChatUnread?.(chatUnread) }, [chatUnread, onChatUnread])
  const savedSeq = active.some(j => j.route_order != null)
    ? [...active].sort((a, b) => (a.route_order ?? 999) - (b.route_order ?? 999)).map(j => j.id)
    : null
  const manualSeq = localSeq === 'auto' ? null : (localSeq ?? savedSeq)

  // The EFFECTIVE route: the owner's manual sequence when set (via the same
  // sequenceRoute engine → same OrderedRouteStop shape), else the optimizer's.
  // ETAs, stats, Open-in-Maps and the list order all read from this ONE value,
  // so a reorder re-flows everything instantly with no special cases.
  const manualRoute = manualSeq && baseCoord
    ? sequenceRoute(baseCoord, active.map(job => ({
        jobId: job.id,
        title: job.customers?.name || job.title,
        address: job.properties?.address || job.title,
        propertyId: job.properties?.id ?? null,
        lat: job.properties?.lat ?? null,
        lng: job.properties?.lng ?? null,
      })), manualSeq, road?.dist)   // ⭐ the SAME distances the optimizer used
    : null
  const effOrdered: OrderedRouteStop[] = manualRoute ? manualRoute.ordered : route?.ordered ?? []
  // Navigation link: the REMAINING stops in the current (manual or optimized)
  // order — completed stops don't need directions, and Google caps the URL at
  // MAX_MAPS_WAYPOINTS anyway, so mid-day re-opens always cover what's next.
  const doneIds = new Set(active.filter(j => j.status === 'completed').map(j => j.id))
  const navStops = effOrdered.filter(s => !doneIds.has(s.jobId))
  const effMapsUrl = baseCoord && navStops.length ? roundTripMapsUrl(baseCoord, navStops) : null
  const mapsCapped = navStops.length > MAX_MAPS_WAYPOINTS

  const orderByJobId = new Map(effOrdered.map(s => [s.jobId, s.order]))
  // ONE ordering rule (lib/fieldStops), shared with the phone field bar — which
  // used to sort the same day by raw jobs.route_order and therefore named a
  // different "next stop" than the card list below. See fieldStops.ts.
  const sortedJobs = orderDayStops(active, orderByJobId)

  // Publish the RESOLVED order so page-level field affordances point at the same
  // stop this list puts first. The board owns this value — it is the only place
  // the manual sequence and the optimizer's output are reconciled — so it hands
  // the answer out rather than letting a second surface re-derive it.
  const stopOrderKey = sortedJobs.map(j => j.id).join('|')
  useEffect(() => {
    onStopOrder?.({ date, ids: stopOrderKey ? stopOrderKey.split('|') : [] })
  }, [date, stopOrderKey, onStopOrder])
  // ── Does the crew have THIS order? ──────────────────────────────────────────
  // The board re-resolves an order on every render; a crew phone cannot — its
  // day arrives pre-sorted by the crew_day RPC, which sorts on jobs.route_order
  // and falls through to booking order when none is saved. So the plan on this
  // screen only reaches the field if it has been WRITTEN. lib/fieldStops mirrors
  // the RPC's ordering so this comparison is against what the crew really sees.
  const crewOrder = crewOrderStatus(sortedJobs)
  const [sendingOrder, setSendingOrder] = useState(false)
  async function sendOrderToCrew() {
    if (sendingOrder) return
    setSendingOrder(true)
    // The SAME write the drag/chevron reorder uses — one path to route_order, so
    // "publish" can never mean something subtly different from "reorder".
    const ok = await applyOrder(sortedJobs.map(j => j.id))
    setSendingOrder(false)
    // applyOrder already says so when it fails; don't claim a delivery on top of it.
    if (ok) toast.success('Sent — the crew’s screen now lists these stops in this order.')
  }

  // Reorder: swap instantly (optimistic), then persist the whole day's sequence.
  // Writes are CHAINED so two quick drags can't interleave their per-row updates
  // (last full sequence wins), and failures surface instead of silently reverting
  // on the next refresh.
  const orderWrite = useRef<Promise<void>>(Promise.resolve())
  // How many route_order writes are still in flight, and which props version the
  // last write settled at — together they tell the release effect below when the
  // props are FRESH (refetched after our writes), so it can safely hand authority
  // back to the DB without flickering through a stale in-between state.
  const pendingOrderWrites = useRef(0)
  const propsVersion = useRef(0)
  const settledAtVersion = useRef(0)
  useEffect(() => { propsVersion.current++ }, [jobs])
  // Returns whether the sequence actually persisted, so a caller that ANNOUNCES
  // the write ("sent to the crew") cannot announce one that failed.
  async function applyOrder(seq: string[]): Promise<boolean> {
    let ok = true
    setLocalSeq(seq)
    pendingOrderWrites.current++
    orderWrite.current = orderWrite.current.then(async () => {
      try {
        const results = await Promise.all(seq.map((id, i) => supabase.from('jobs').update({ route_order: i + 1 }).eq('id', id)))
        if (results.some(r => r.error)) {
          ok = false
          // Reconcile, don't diverge: drop the optimistic order and fall back to
          // the last persisted sequence from props (realtime refetch confirms it).
          setLocalSeq(null)
          toast.error('Could not save the new stop order — showing the last saved one.')
        }
      } finally {
        pendingOrderWrites.current--
        if (pendingOrderWrites.current === 0) settledAtVersion.current = propsVersion.current
      }
    })
    // Await the promise THIS call chained, not whatever the ref points at by
    // now — a second reorder landing mid-flight would otherwise decide our
    // return value.
    const mine = orderWrite.current
    await mine
    return ok
  }
  // Release the optimistic override once the DB is the right authority again:
  // • props MATCH the optimistic order (our write round-tripped) → release;
  // • props are FRESH (refetched after our writes settled) and still differ →
  //   another tab/device won the write — adopt the persisted truth (release)
  //   instead of shadowing it forever.
  const savedKey = savedSeq ? savedSeq.join('|') : ''
  useEffect(() => {
    if (localSeq === null || pendingOrderWrites.current > 0) return
    const fresh = propsVersion.current > settledAtVersion.current
    if (localSeq === 'auto') { if (!savedKey || fresh) setLocalSeq(null); return }
    if (savedKey === localSeq.join('|') || fresh) setLocalSeq(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localSeq, savedKey, jobs])
  function moveStop(id: string, dir: -1 | 1) {
    const seq = (manualSeq ?? sortedJobs.map(j => j.id)).slice()
    const i = seq.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= seq.length) return
    ;[seq[i], seq[j]] = [seq[j], seq[i]]
    applyOrder(seq)
  }
  const dragId = useRef<string | null>(null)
  function dropOn(targetId: string) {
    const from = dragId.current
    dragId.current = null
    if (!from || from === targetId) return
    const seq = (manualSeq ?? sortedJobs.map(j => j.id)).slice()
    const fi = seq.indexOf(from)
    const ti = seq.indexOf(targetId)
    if (fi < 0 || ti < 0) return
    seq.splice(fi, 1)
    seq.splice(ti, 0, from)
    applyOrder(seq)
  }
  // "Reset to best route": clear any manual order so the day snaps back to the
  // continuously-computed optimized route (the SAME engine output in `route` —
  // nothing is recomputed twice). ETAs, drive time, finish and Open-in-Maps all
  // re-flow because effOrdered switches source. Confirms only when a manual
  // order actually exists; offers Undo to restore the exact previous sequence.
  const [optimizing, setOptimizing] = useState(false)
  async function optimizeRouteNow() {
    if (optimizing) return
    const prevSeq = manualSeq // snapshot of the DISPLAYED order (undo target)
    if (prevSeq) {
      const ok = await confirm({
        title: 'Re-optimize this day’s route?',
        message: 'Your manual stop order will be replaced with the optimized route. You can undo right after.',
        confirmLabel: 'Optimize',
        icon: Wand2,
      })
      if (!ok) return
    }
    setOptimizing(true)
    setLocalSeq('auto')
    pendingOrderWrites.current++
    const { error } = await supabase.from('jobs').update({ route_order: null }).in('id', active.map(j => j.id))
    pendingOrderWrites.current--
    if (pendingOrderWrites.current === 0) settledAtVersion.current = propsVersion.current
    setOptimizing(false)
    if (error) {
      // Write failed → put the display back and say so (no fake success/undo).
      setLocalSeq(prevSeq)
      toast.error('Could not re-optimize: ' + error.message)
      return
    }
    if (prevSeq) {
      toast.undo('Route re-optimized — manual order cleared.', () => { void applyOrder(prevSeq) })
    } else {
      toast.success('Route is optimized.')
    }
  }

  // ── The day as a PLAN ───────────────────────────────────────────────────────
  // ONE call answers what used to be four separate derivations on this screen
  // (ETAs, the load pill, the work chip, the finish estimate) — and it answers
  // them against the evidence actually available, rather than assuming a 45-min
  // visit, a 2-min/km drive and a serial day are all safe. lib/dayPlan.
  //
  // Legs are read off the RESOLVED route (`effOrdered` — manual order or the
  // optimizer's) in the SAME sequence the cards render, walking coordinates
  // forward so each leg's measured duration can be looked up for its own pair.
  const legByJob = new Map(effOrdered.map(s => [s.jobId, s]))
  const planStops: DayPlanStopInput[] = (() => {
    const out: DayPlanStopInput[] = []
    let prev: Coord | null = baseCoord
    for (const j of sortedJobs) {
      const lat = j.properties?.lat ?? null
      const lng = j.properties?.lng ?? null
      const located = lat != null && lng != null
      const here: Coord | null = located ? { lat, lng } : null
      const legKm = legByJob.get(j.id)?.legKm ?? null
      out.push({
        jobId: j.id,
        durationMinutes: j.duration_minutes,
        crewSize: j.crew_size,
        serviceType: j.service_type,
        status: j.status,
        crewId: j.crew_id ?? null,
        // Session 47: hours already banked against a carried-over visit, so
        // tomorrow plans the remainder rather than the whole estimate again.
        workedMinutes: j.actual_minutes,
        legKm,
        legSeconds: prev && here && road ? road.seconds(prev, here) : null,
        legIsRoad: !!(prev && here && road?.hasRoad(prev, here)),
        located,
      })
      if (here) prev = here
    }
    return out
  })()
  const plan = planDay({
    stops: planStops,
    startTime: workStartTime,
    capacityHours,
    workers: workersOnDay ?? null,
    learnedFor: learnedDurationFor,
    speed: travel,
    locatedCoords,
    hasBase: !!baseCoord,
    // Session 67: who, by name, cannot work a day their crew is booked on.
    // Null outside the loaded horizon, exactly as workersOnDay is — the same
    // read backs both, so the count and the names can never disagree.
    staffing: staffingOnDay ?? null,
    crewNames,
    availabilityRecorded,
  })
  // Every arrival on this screen comes from that ONE walk.
  const etas = plan.stopCount > 0
    ? { startMin: plan.startMin, finishMin: plan.finishMin, finish: plan.finish, stops: plan.stops }
    : null
  const etaByJob: Record<string, string> = {}
  const arrivalMinByJob: Record<string, number> = {}
  const durByJob: Record<string, number> = {}
  for (const s of plan.stops) {
    etaByJob[s.jobId] = s.arrival
    arrivalMinByJob[s.jobId] = s.arrivalMin
    durByJob[s.jobId] = s.minutes
  }
  // A 2-hour arrival window per visit for the "Send ETA" message: anchored on the
  // committed start time when set, else the route-computed arrival.
  const windowByJob: Record<string, string> = {}
  for (const j of active) {
    const startMin = j.start_time ? timeToMinutes(j.start_time) : (arrivalMinByJob[j.id] ?? null)
    if (startMin != null) windowByJob[j.id] = `${minutesToTime12(startMin)}–${minutesToTime12(startMin + 120)}`
  }
  // The load pill reads the plan's OWN clock total (work + the route's real
  // drive legs), through the same dayLoad state function the calendar uses — so
  // "Room for ~2h" is now a statement about this day's actual route rather than
  // about a flat 10-minutes-per-stop allowance.
  const usedMin = plan.usedClockMin
  const load = dayLoad(usedMin, capacityHours)
  const loadPct = plan.capacityMin > 0 ? Math.round((usedMin / plan.capacityMin) * 100) : null
  // ⭐ A clock with room is not a day that can happen: a visit needing 3 people
  // on a 1-person day used to show "Room for ~2h" in green. When the plan says
  // something blocking, the pill says THAT instead of a spare-hours figure it
  // cannot honour.
  const blocking = plan.warnings.find(w => w.severity === 'blocking') ?? null

  // The timeline reads the ETA chain the route engine already produced above —
  // no second ordering, no second distance lookup. Capacity ends at work start +
  // the day's labour budget, which is the same number the load pill uses.
  const timelineStops: TimelineStop[] = plan.stops
    .map(s => {
      const job = active.find(j => j.id === s.jobId)
      return job
        ? { jobId: job.id, name: job.customers?.name || job.title, arrivalMin: s.arrivalMin, durMin: s.minutes, status: job.status }
        : null
    })
    .filter((s): s is TimelineStop => s !== null)
  const capacityEndMin = plan.capacityEndMin

  // Tapping a block on the timeline brings its card into view — the timeline is a
  // map of the day, so it should navigate the day. scrollBehavior() honours the
  // reduced-motion preference (a JS-requested 'smooth' overrides the stylesheet).
  function jumpToStop(jobId: string) {
    document.getElementById(`stop-${jobId}`)?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' })
  }

  // ── Live day tracking (check-in/check-out data) ──
  const isToday = date === localTodayISO()
  const inProgress = active.find(j => j.status === 'in_progress') ?? null
  const tsTo12 = (iso: string) => { const t = new Date(iso); return minutesToTime12(t.getHours() * 60 + t.getMinutes()) }
  const elapsedMin = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  const firstStart = active.map(j => j.started_at).filter(Boolean).sort()[0] as string | undefined
  const workedMin = completed.reduce((s, j) => s + (j.actual_minutes || 0), 0)
    + (inProgress?.started_at ? elapsedMin(inProgress.started_at) : 0)
  const live = isToday && (!!inProgress || (!!firstStart && completed.length > 0))
  // ── End-of-day wrap-up ──
  // Once nothing is left to START (every job is done or on the clock), surface the
  // loose ends the owner would otherwise find tomorrow: a timer still running —
  // which banks overnight hours into actual_minutes the moment it's completed — and
  // completed work with no price, which silently drafts no invoice. Read-only over
  // arrays already in memory; jumps straight to the offending stop.
  const notStarted = remaining.filter(j => j.status === 'scheduled')
  const stillRunning = remaining.filter(j => j.status === 'in_progress')
  const unpricedDone = completed.filter(j => jobTotal(j) <= 0)
  const looseEnds = stillRunning.length > 0 || unpricedDone.length > 0
  const showWrapUp = isToday && completed.length > 0 && notStarted.length === 0
  // Re-render each minute on TODAY so elapsed, finish and the timeline's "now"
  // line stay current — the now line has to keep moving before the first
  // check-in, which is exactly when you're deciding whether you're already late.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!isToday) return
    const t = setInterval(() => setTick(x => x + 1), 60000)
    return () => clearInterval(t)
  }, [isToday])
  // Finish estimate: live (now + what's left) once the day is underway, else the
  // planned route ETAs from work start.
  let estFinish: string
  if (active.length === 0) estFinish = '—'
  else if (remaining.length === 0) estFinish = 'Done'
  else if (live) {
    const now = new Date()
    const curElapsed = inProgress?.started_at ? elapsedMin(inProgress.started_at) : 0
    // Live: now + what is left. Durations come from the PLAN (own estimate →
    // learned → the shared default), so the live finish and the planned finish
    // read the same minutes for the same visit — and the legs still to drive
    // are that day's real legs, not a flat allowance per remaining stop.
    const remainingLabor = remaining.reduce((s, j) => s + (durByJob[j.id] ?? DEFAULT_JOB_MIN), 0)
      - (inProgress ? Math.min(curElapsed, durByJob[inProgress.id] ?? DEFAULT_JOB_MIN) : 0)
    const legMinById = new Map(plan.stops.map(s => [s.jobId, s.leg.minutes]))
    const remainingLegs = remaining
      .filter(j => j.id !== inProgress?.id)
      .reduce((s, j) => s + (legMinById.get(j.id) ?? 10), 0)
    estFinish = minutesToTime12(now.getHours() * 60 + now.getMinutes() + Math.max(5, remainingLabor) + remainingLegs)
  } else {
    estFinish = plan.stopCount > 0 ? plan.finish : '—'
  }

  return (
    <div className="rounded-card border border-border bg-bg-secondary overflow-hidden">
      {/* Message today's customers — the shared Send-Message dialog, prefilled with the day's recipients */}
      {showDayMsg && (
        <SendMessageDialog open recipients={dayRecipients} title="Message today's customers" onClose={() => setShowDayMsg(false)} />
      )}
      {/* Header: date + add */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 bg-gradient-to-r from-accent/5 to-transparent">
        <div className="min-w-0 flex items-center gap-2">
          <p className="text-sm font-semibold tracking-tight text-ink truncate">{dateLabel}</p>
          {active.length > 0 && (
            <span title={blocking ? blocking.message : undefined} className={cn(
              'text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border shrink-0',
              blocking || load.state === 'overloaded' ? 'text-red-400 border-red-500/30 bg-red-500/10'
                : load.state === 'room' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
                : 'text-ink-muted border-border bg-bg-tertiary'
            )}>
              {blocking ? 'Won’t fit'
                : load.state === 'overloaded' ? `Over by ${Math.round(-load.spareMin / 6) / 10}h`
                : load.state === 'room' ? `Room for ~${Math.round(load.spareMin / 6) / 10}h`
                : 'Full day'}
              {loadPct != null && ` · ${loadPct}%`}
            </span>
          )}
        </div>
        {/* On a phone the two SECONDARY actions collapse to their icons (the same
            pattern the message thread header uses) — three full labels here are
            ~330px on a 360px screen, which squeezed the date out of its own
            header. The primary action keeps its label. */}
        <div className="flex items-center gap-2 shrink-0">
          {dayRecipients.length > 0 && (
            <Button size="sm" variant="secondary" onClick={() => setShowDayMsg(true)}
              title="Message everyone scheduled today" aria-label="Message everyone scheduled today">
              <MessageSquare className="w-4 h-4" /> <span className="hidden sm:inline">Message all</span>
            </Button>
          )}
          {remaining.length > 0 && (
            <Button size="sm" variant="secondary" onClick={onRainDelay}
              title="Bump all remaining jobs to your next work day" aria-label="Delay remaining jobs to the next work day">
              <CloudRain className="w-4 h-4" /> <span className="hidden sm:inline">Delay remaining</span>
            </Button>
          )}
          <Button size="sm" onClick={onAddJob}><Plus className="w-4 h-4" /> Add job</Button>
        </div>
      </div>

      {/* Daily revenue forecast — the first thing you see */}
      <div className="grid grid-cols-3 sm:grid-cols-5 sm:divide-x divide-border border-b border-border">
        <Metric icon={DollarSign} label="Planned" value={formatCurrency(totalRevenue)} tone="text-accent-text" />
        <Metric icon={Wallet} label="Completed" value={formatCurrency(revenueCompleted)} tone="text-emerald-400" />
        <Metric icon={DollarSign} label="Remaining" value={formatCurrency(revenueRemaining)} tone="text-amber-400" />
        <Metric icon={ListChecks} label="Stops left" value={String(remaining.length)} />
        <Metric icon={Hourglass} label="Est. finish" value={estFinish} />
      </div>

      {/* Live day tracking — appears once the day is underway */}
      {live && (
        <div className="px-4 py-2 border-b border-border bg-sky-400/5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="flex items-center gap-1.5 font-semibold text-sky-300"><Timer className="w-3.5 h-3.5" /> Live</span>
          {firstStart && <span className="text-ink-muted">Started <span className="text-ink font-medium">{tsTo12(firstStart)}</span></span>}
          {inProgress && (
            <span className="text-ink-muted">Now at <span className="text-ink font-medium">{inProgress.customers?.name || inProgress.title}</span>
              {inProgress.started_at && <span className="text-sky-300"> · {elapsedMin(inProgress.started_at)}m</span>}
            </span>
          )}
          {/* Done-count and finish live in the metric strip directly above — no repeats. */}
          <span className="text-ink-muted">Worked <span className="text-ink font-medium">{Math.floor(workedMin / 60)}h {workedMin % 60}m</span></span>
        </div>
      )}

      {active.length === 0 ? (
        <EmptyState icon={CalendarDays} className="py-12"
          title="No jobs scheduled"
          description="This day is open. Add a visit, or drag one here from another day."
          action={{ label: 'Add job', onClick: onAddJob }} />
      ) : (
        <div className="p-4 space-y-4">
          {/* End-of-day wrap-up — appears once nothing is left to start, so the
              owner clears loose ends (a running timer, unpriced completed work)
              before leaving instead of discovering them tomorrow. */}
          {showWrapUp && (looseEnds ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-3.5 py-3">
              <div className="flex items-center gap-2 mb-2">
                <ListChecks className="w-4 h-4 text-amber-300 shrink-0" />
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Before you wrap up</p>
              </div>
              <div className="space-y-1.5">
                {stillRunning.map(j => (
                  <button key={j.id} type="button" onClick={() => jumpToStop(j.id)}
                    className="w-full flex items-center gap-2 text-left text-xs group"
                    title="Finish or continue this job — a running timer banks overnight hours when completed">
                    <Timer className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span className="text-ink font-medium truncate">{j.customers?.name || j.title}</span>
                    <span className="text-ink-faint truncate">still on the clock{j.started_at ? ` · ${elapsedMin(j.started_at)}m` : ''} — finish or continue it</span>
                    <ChevronDown className="w-3.5 h-3.5 text-ink-faint ml-auto shrink-0 -rotate-90 group-hover:text-ink" />
                  </button>
                ))}
                {unpricedDone.map(j => (
                  <button key={j.id} type="button" onClick={() => jumpToStop(j.id)}
                    className="w-full flex items-center gap-2 text-left text-xs group"
                    title="Set a price so this completed job gets invoiced">
                    <DollarSign className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span className="text-ink font-medium truncate">{j.customers?.name || j.title}</span>
                    <span className="text-ink-faint truncate">done with no price — set one to bill it</span>
                    <ChevronDown className="w-3.5 h-3.5 text-ink-faint ml-auto shrink-0 -rotate-90 group-hover:text-ink" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] px-3.5 py-3 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-300 shrink-0" />
              <p className="text-xs text-ink">
                <span className="font-semibold text-emerald-300">Day wrapped up.</span> {completed.length} job{completed.length !== 1 ? 's' : ''} done · <span className="tabular-nums">{formatCurrency(revenueCompleted)}</span> ready to invoice.
              </p>
            </div>
          ))}
          {/* The day as a plan — ordered stops, what it will really take, what
              is left of the day, and what had to be assumed to say so.
              (lib/dayPlan; the old stats-only "Route" strip said ~km / ~min /
              ~h work and stood behind all three equally.) */}
          <DayPlanPanel
            plan={plan}
            crew={crewOrder}
            onSendOrderToCrew={sendOrderToCrew}
            sendingOrder={sendingOrder}
            resolving={routing && !manualRoute}
            noBase={!baseCoord}
            actions={<>
              {/* ⭐ CONFIRMED vs SUGGESTED. A saved sequence is the owner's
                  decision and is what the field drives; without one, what is on
                  screen is the optimizer's proposal. Naming which is which is
                  what stops a ranking algorithm from quietly appearing to be a
                  confirmed plan — and "Optimize route" still asks before it
                  replaces a confirmed one. */}
              <span className={cn(
                'text-[10px] font-semibold rounded px-1.5 py-0.5 border',
                manualSeq
                  ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
                  : 'text-ink-faint border-border bg-bg-secondary',
              )}>
                {manualSeq ? 'Confirmed order' : 'Suggested order'}
              </span>
                {/* Persistent "reset to best route" — reuses the continuously-computed
                    optimized order; confirms only when a manual order would be lost. */}
                {active.length > 1 && baseCoord && (
                  <button type="button" onClick={optimizeRouteNow} disabled={optimizing}
                    title="Recalculate the best stop order (clears manual reordering)"
                    className="text-xs font-medium rounded-lg border border-border-strong text-ink-muted hover:text-ink hover:bg-surface-raised px-2.5 py-1 flex items-center gap-1 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                    <Wand2 className="w-3 h-3" /> Optimize route
                  </button>
                )}
                {effMapsUrl && (
                  <a href={effMapsUrl} target="_blank" rel="noopener noreferrer"
                    title={mapsCapped ? `Google Maps caps directions at ${MAX_MAPS_WAYPOINTS} stops — this opens your next ${MAX_MAPS_WAYPOINTS}; reopen as you complete stops for the rest.` : 'Directions for the remaining stops, in order'}
                    className="text-xs text-accent-text font-medium flex items-center gap-1 hover:underline">
                    <ExternalLink className="w-3 h-3" /> {mapsCapped ? `Open in Maps (next ${MAX_MAPS_WAYPOINTS})` : 'Open in Maps'}
                  </a>
                )}
            </>}
          />

          {/* The same route, as time: where the day goes, how much is driving,
              and whether it runs past capacity. Reads the ETAs computed above. */}
          {etas && timelineStops.length > 0 && (
            <RouteTimeline
              startMin={etas.startMin}
              finishMin={etas.finishMin}
              capacityEndMin={capacityEndMin}
              stops={timelineStops}
              nowMin={isToday ? new Date().getHours() * 60 + new Date().getMinutes() : undefined}
              onSelectStop={jumpToStop}
              omitted={active.length - timelineStops.length}
            />
          )}

          {/* Jobs in route order, with one-tap actions */}
          <div className="space-y-2">
            {sortedJobs.map(job => {
              const order = orderByJobId.get(job.id)
              const done = job.status === 'completed'
              const value = jobValue(job)            // base
              const addons = addonsFor(job)
              const total = value + addonsTotal(addons)  // base + add-ons (billed amount)
              // Change orders on this visit. `ownerExtras` is what the add-on
              // editor may still touch: an approved change's line item is
              // customer-approved money and is not the owner's to bin from there.
              const changes = changesFor(job)
              const av = avFor(job)
              const ownerExtras = addons.filter(a => !a.change_order_id)
              const qVal = quoteValueFor(job)
              const idx = sortedJobs.findIndex(j => j.id === job.id)
              return (
                <div key={job.id}
                  id={`stop-${job.id}`}
                  draggable={sortedJobs.length > 1}
                  onDragStart={() => { dragId.current = job.id; setDraggingId(job.id) }}
                  onDragEnd={() => { setDraggingId(null); setDragOverId(null) }}
                  onDragOver={e => { e.preventDefault(); if (dragOverId !== job.id) setDragOverId(job.id) }}
                  onDragLeave={() => { if (dragOverId === job.id) setDragOverId(null) }}
                  onDrop={() => { dropOn(job.id); setDraggingId(null); setDragOverId(null) }}
                  className={cn('rounded-xl border px-3 py-2.5 transition-colors scroll-mt-4',
                    // Done cards RECEDE (neutral + faded); the live stop is sky end-to-end
                    // (badge, timer, live bar and card all agree); scheduled keeps the token.
                    done ? 'border-border bg-bg-tertiary/60 text-ink-muted opacity-60'
                      : job.status === 'in_progress' ? 'bg-sky-400/10 text-sky-300 border-sky-400/30'
                      : JOB_STATUS_COLORS[job.status],
                    sortedJobs.length > 1 && 'cursor-grab active:cursor-grabbing',
                    draggingId === job.id && 'opacity-50',
                    draggingId && draggingId !== job.id && dragOverId === job.id && 'ring-2 ring-accent')}>
                  <div className="flex items-start gap-2.5">
                    <div className="flex flex-col items-center gap-0.5 shrink-0">
                      <div className={cn(
                        'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold mt-0.5',
                        done ? 'bg-emerald-500/20 text-emerald-300'
                          : job.status === 'in_progress' ? 'bg-sky-400 text-black animate-pulse'
                          : 'bg-accent text-black'
                      )}>
                        {done ? <Check className="w-4 h-4" /> : job.status === 'in_progress' ? <Play className="w-3.5 h-3.5 fill-current" /> : (order ?? '–')}
                      </div>
                      {/* Touch-friendly reorder (drag works on desktop) — padded hit areas
                          so a thumb never grabs the card when it meant the chevron. */}
                      {sortedJobs.length > 1 && (
                        <div className="flex flex-col">
                          <button onClick={e => { e.stopPropagation(); moveStop(job.id, -1) }} disabled={idx === 0}
                            aria-label="Move up" className="p-1.5 -mx-1 text-ink-faint hover:text-ink disabled:opacity-25 leading-none">
                            <ChevronUp className="w-4 h-4" />
                          </button>
                          <button onClick={e => { e.stopPropagation(); moveStop(job.id, 1) }} disabled={idx === sortedJobs.length - 1}
                            aria-label="Move down" className="p-1.5 -mx-1 text-ink-faint hover:text-ink disabled:opacity-25 leading-none">
                            <ChevronDown className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-sm font-semibold min-w-0">
                          {job.recurrence_id && <Repeat className="w-3 h-3 shrink-0 opacity-70" />}
                          <span className={cn('truncate', done && 'line-through opacity-80')}>{job.customers?.name || job.title}</span>
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {total > 0
                            ? <button onClick={e => { e.stopPropagation(); priceId === job.id ? setPriceId(null) : openPrice(job) }}
                                title={addons.length ? `Base ${formatCurrency(value)} + add-ons ${formatCurrency(addonsTotal(addons))} · tap to edit base price` : 'Edit price'}
                                className="tap-target-y flex items-center gap-1 text-sm font-bold text-ink rounded-md px-1.5 py-0.5 hover:bg-black/10 transition-colors">
                                {formatCurrency(total)}<Pencil className="w-3 h-3 opacity-40" />
                              </button>
                            : <button onClick={e => { e.stopPropagation(); priceId === job.id ? setPriceId(null) : openPrice(job) }}
                                title="Set price"
                                className="tap-target-y text-[10px] font-semibold uppercase tracking-wide text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-1.5 py-0.5 flex items-center gap-1 hover:bg-amber-500/20">
                                <AlertTriangle className="w-3 h-3" /> Set price
                              </button>}
                          {/* Delete lives in the job form (Edit job → trash) — a 28px
                              destructive button beside the price invited mis-taps. */}
                        </div>
                      </div>

                      {/* Property address — a customer can have several properties;
                          the name alone never says which one this visit is at. */}
                      <VisitAddress address={job.properties?.address} className="mt-0.5" />

                      {/* Access note (gate code, where to park, crew note) on the card
                          face — it was only reachable via overflow → Quick edit, so the
                          one thing you need before pulling into the driveway was two taps
                          and a panel away. Read-only here; still edited in Quick edit. */}
                      {job.notes?.trim() && (
                        <div className="mt-1.5 flex items-start gap-1.5 rounded-md border border-border bg-bg-tertiary/60 px-2 py-1 text-xs text-ink-muted"
                          title={job.notes.trim()}>
                          <StickyNote className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400/80" />
                          <span className="line-clamp-2 whitespace-pre-wrap break-words">{job.notes.trim()}</span>
                        </div>
                      )}

                      {/* Clean price-only editor — first-class, opens inline */}
                      {priceId === job.id && (
                        <div className="mt-2 rounded-lg border border-border bg-bg-secondary p-2.5 space-y-2" onClick={e => e.stopPropagation()}>
                          {job.recurrence_id && (
                            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-accent-text">
                              <Repeat className="w-3 h-3" /> Recurring series pricing
                            </div>
                          )}
                          <label className="text-[10px] uppercase tracking-wide text-ink-faint block">Price ($/visit)
                            <input type="number" min="0" step="5" autoFocus
                              placeholder={qVal > 0 ? `${qVal} from quote` : 'e.g. 55'}
                              value={priceVal}
                              onChange={e => setPriceVal(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') savePrice(job) }}
                              className="w-full mt-0.5 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
                          </label>
                          {/* Decision-first: the change at a glance (Original → New). */}
                          {(() => {
                            const current = value
                            const next = priceVal.trim() ? Number(priceVal) : qVal
                            if (!(next > 0) || Math.round(next) === Math.round(current)) return null
                            return (
                              <p className="text-xs text-ink">
                                <span className="text-ink-faint">{formatCurrency(current)}</span>
                                <span className="text-ink-faint mx-1">→</span>
                                <span className="font-semibold text-accent-text">{formatCurrency(next)}</span>
                              </p>
                            )
                          })()}
                          {/* Reason is only asked on an INCREASE (audit trail for
                              upsells/surcharges); decreases & corrections save instantly. */}
                          {(() => {
                            const next = priceVal.trim() ? Number(priceVal) : qVal
                            const isIncrease = next > 0 && Math.round(next) > Math.round(value)
                            if (!isIncrease) return null
                            const presets = PRICE_REASONS.filter(r => r !== 'Custom')
                            const isCustom = priceReason !== '' && !presets.includes(priceReason as typeof presets[number])
                            return (
                              <div className="space-y-1.5">
                                <p className="text-[10px] uppercase tracking-wide text-ink-faint">Reason for increase</p>
                                <div className="flex flex-wrap gap-1.5">
                                  {presets.map(r => (
                                    <button key={r} type="button" onClick={() => setPriceReason(r)}
                                      className={cn('text-[11px] font-medium rounded-full px-2 py-0.5 border transition-colors',
                                        priceReason === r ? 'bg-accent text-black border-accent' : 'border-border text-ink-muted hover:text-ink')}>
                                      {r}
                                    </button>
                                  ))}
                                  <button type="button" onClick={() => setPriceReason(isCustom ? '' : ' ')}
                                    className={cn('text-[11px] font-medium rounded-full px-2 py-0.5 border transition-colors',
                                      isCustom ? 'bg-accent text-black border-accent' : 'border-border text-ink-muted hover:text-ink')}>
                                    Custom
                                  </button>
                                </div>
                                {isCustom && (
                                  <input type="text" autoFocus value={priceReason.trim()} onChange={e => setPriceReason(e.target.value || ' ')}
                                    placeholder="Describe the increase" className="w-full bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-xs text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
                                )}
                              </div>
                            )
                          })()}
                          {qVal > 0 && (
                            <div className="flex items-center justify-between gap-2 text-[11px]">
                              <span className="text-ink-faint">From quote · {cadenceLabelFor(job)}: <span className="text-ink-muted font-medium">{formatCurrency(qVal)}</span></span>
                              <button type="button" onClick={() => setPriceVal('')} className="text-accent-text hover:underline font-medium">Use quote price</button>
                            </div>
                          )}
                          <div className="flex items-center gap-2">
                            <Button size="sm" onClick={() => savePrice(job)} loading={savingPrice}>Save price</Button>
                            <Button size="sm" variant="ghost" onClick={() => setPriceId(null)}>Cancel</Button>
                            {job.price != null
                              ? <span className="text-[10px] text-amber-400 ml-auto">Manual override</span>
                              : qVal > 0 ? <span className="text-[10px] text-ink-faint ml-auto">Auto from quote</span> : null}
                          </div>
                          <p className="text-[10px] text-ink-faint">Saving updates this visit's draft invoice automatically.</p>
                        </div>
                      )}
                      <div className="flex items-center gap-1.5 text-xs opacity-80 mt-0.5 flex-wrap">
                        {job.status === 'scheduled' && etaByJob[job.id] && (
                          <span className="font-semibold text-accent-text shrink-0">ETA {etaByJob[job.id]}</span>
                        )}
                        {/* The route orders stops by GEOGRAPHY — it never reads a job's
                            committed start_time — so a visit you promised for 10:00 can be
                            routed last and land hours later. Both numbers were already on
                            this card, side by side, with nothing saying they disagreed.
                            Flag it only once the route misses the window we'd actually TEXT
                            the customer (windowByJob = start → +2h), so this fires when a
                            promise breaks, not when a minute slips. Presentation only: the
                            route is not re-ordered and no engine is consulted. */}
                        {(() => {
                          if (job.status !== 'scheduled' || !job.start_time) return null
                          const arrive = arrivalMinByJob[job.id]
                          if (arrive == null) return null
                          const promised = timeToMinutes(job.start_time)
                          if (arrive <= promised + 120) return null
                          return (
                            <span className="shrink-0 text-[10px] font-semibold text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-1.5 py-0.5 flex items-center gap-1"
                              title={`You'd tell this customer ${windowByJob[job.id]}, but the route has you arriving ${minutesToTime12(arrive)}. Reorder the stop, or move it.`}>
                              <AlertTriangle className="w-3 h-3" /> misses {windowByJob[job.id]}
                            </span>
                          )
                        })()}
                        {job.status === 'in_progress' && job.started_at && (
                          <span className="font-semibold text-sky-300 shrink-0">▶ {tsTo12(job.started_at)} · {elapsedMin(job.started_at)}m</span>
                        )}
                        {done && job.started_at && job.completed_at && (
                          <span className="font-semibold text-emerald-300 shrink-0">{tsTo12(job.started_at)}–{tsTo12(job.completed_at)} · {job.actual_minutes ?? '?'}m</span>
                        )}
                        {done && job.actual_minutes != null && job.duration_minutes != null && job.duration_minutes > 0 && (
                          <span className={cn('text-[10px] font-semibold shrink-0', job.actual_minutes > job.duration_minutes ? 'text-amber-400' : 'text-emerald-400')}>
                            ({job.actual_minutes > job.duration_minutes ? '+' : ''}{job.actual_minutes - job.duration_minutes}m vs est {job.duration_minutes}m)
                          </span>
                        )}
                        {job.service_type && <span className="truncate">{job.service_type}</span>}
                        {job.start_time && <span>· {job.start_time.slice(0, 5)}</span>}
                        {/* At-a-glance add-on indicator — names when few, else count */}
                        {ownerExtras.length > 0 && (
                          <button onClick={e => { e.stopPropagation(); toggleAddons(job) }}
                            title={ownerExtras.map(a => `${a.description} ${formatCurrency(Number(a.amount))}`).join(' · ')}
                            className="text-[10px] font-semibold text-accent-text border border-accent/30 bg-accent/10 rounded px-1.5 py-0.5 shrink-0 hover:bg-accent/20">
                            +{ownerExtras.length <= 2 ? ownerExtras.map(a => a.description).join(' + ') : `${ownerExtras.length} services`}
                          </button>
                        )}
                        {/* A change the customer hasn't answered is the one thing on
                            this card that needs chasing — amber, on the face, always. */}
                        {av.pendingCount > 0 && (
                          <button onClick={e => { e.stopPropagation(); toggleChanges(job) }}
                            title="Change orders awaiting the customer's approval — not counted in the authorized value"
                            className="text-[10px] font-semibold text-amber-300 border border-amber-500/40 bg-amber-500/10 rounded px-1.5 py-0.5 shrink-0 hover:bg-amber-500/20">
                            {formatCurrency(av.pending)} awaiting approval
                          </button>
                        )}
                        {av.approvedChanges > 0 && (
                          <button onClick={e => { e.stopPropagation(); toggleChanges(job) }}
                            title={`Approved changes on top of the original ${formatCurrency(av.original)}`}
                            className="text-[10px] font-semibold text-emerald-300 border border-emerald-500/30 bg-emerald-500/10 rounded px-1.5 py-0.5 shrink-0 hover:bg-emerald-500/20">
                            +{formatCurrency(av.approvedChanges)} approved change{av.approvedCount > 1 ? 's' : ''}
                          </button>
                        )}
                        {/* No status chip — the order badge, card tone, ETA/timer and
                            strikethrough already say the status (it was a 4th repeat). */}
                      </div>

                      {/* One-tap actions — ONE primary per stage (On my way → Start →
                          Complete), field actions first, edit actions after. Completed
                          cards collapse to the three that still matter. */}
                      {done ? (
                        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                          {/* Get paid before you drive away. Lands on this job's invoice
                              with the record-payment form open (`?pay=1`) — cash or
                              e-transfer goes down while you're still standing there,
                              which is the only moment the customer is in front of you. */}
                          <a href={`/dashboard/invoices?job=${job.id}&pay=1`}
                            className="tap-target h-10 sm:h-8 px-3 sm:px-2.5 rounded-lg bg-emerald-500 border border-emerald-500 text-black text-xs font-semibold flex items-center justify-center gap-1 hover:opacity-90 active:scale-95 transition-transform">
                            <Wallet className="w-3.5 h-3.5" /> Get paid
                          </a>
                          <a href={`/dashboard/invoices?job=${job.id}`}
                            className="tap-target h-10 sm:h-8 px-3 sm:px-2.5 rounded-lg border border-current/30 text-xs font-medium flex items-center justify-center gap-1 hover:bg-black/10">
                            <Receipt className="w-3.5 h-3.5" /> Invoice
                          </a>
                          {/* "Edit job" (main's wording — it matches the overflow
                              item and the quick panel's footer) driving the
                              togglePhoto helper (this commit's point: closePanels()
                              first, so two inline panels can never stack). */}
                          <ActionBtn onClick={() => onOpenJob(job)} icon={Pencil} label="Edit job" />
                          <ActionBtn onClick={() => togglePhoto(job)} icon={Camera} label="Photos" />
                        </div>
                      ) : (
                      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                        {/* Stage primary. on_my_way_at stamps when the text sends, so the
                            primary advances On my way → Start on its own. */}
                        {job.status === 'scheduled' && !job.on_my_way_at && (
                          <ActionBtn disabled={sendingEta !== null} onClick={() => sendOnMyWay(job)} icon={Send} label={sendingEta === job.id ? 'Sending…' : `On my way · ${ONE_TAP_ETA_MIN}m`}
                            title={`Texts ${job.customers?.name || 'the customer'} that you'll arrive in about ${ONE_TAP_ETA_MIN} minutes. Use Message to send a different ETA.`} tone="primary" />
                        )}
                        {job.status === 'scheduled' && (
                          <ActionBtn disabled={acting !== null} onClick={async () => { if (acting) return; setActing(job.id); try { await onStartJob(job) } finally { setActing(null) } }} icon={Play} label="Start" tone={job.on_my_way_at ? 'primary' : undefined} />
                        )}
                        {/* ⭐ THE THREE FIELD DOORS ON AN ACTIVE VISIT, all
                            visible, none hidden in an overflow menu:
                              on the clock → Stop for today · Complete
                              stopped      → Resume · Complete
                            "Stop for today" used to be a menu item called
                            "Continue on another day", which meant the only
                            one-tap way out of a job you hadn't finished was
                            Complete — and Complete drafts an invoice and can
                            text the customer that the work is done. */}
                        {job.status === 'in_progress' && job.started_at && (
                          <ActionBtn disabled={acting !== null} onClick={() => openStop(job)} icon={PauseCircle} label="Stop for today"
                            title="Records today’s time and keeps the job open — nothing is invoiced and the customer isn’t told anything." />
                        )}
                        {job.status === 'in_progress' && !job.started_at && (
                          <ActionBtn disabled={acting !== null} onClick={async () => { if (acting) return; setActing(job.id); try { await onResume(job) } finally { setActing(null) } }} icon={Play} label="Resume" tone="primary"
                            title="Start the clock again on this job. The time already recorded is kept." />
                        )}
                        {job.status === 'in_progress' && (
                          <ActionBtn disabled={acting !== null} onClick={async () => { if (acting) return; setActing(job.id); try { await onMarkDone(job) } finally { setActing(null) } }} icon={CheckCircle2} label="Complete" tone="complete" />
                        )}
                        <a
                          href={directionsUrl({ lat: job.properties?.lat ?? null, lng: job.properties?.lng ?? null, address: job.properties?.address }, baseCoord)}
                          target="_blank" rel="noopener noreferrer"
                          className="tap-target h-10 sm:h-8 px-3 sm:px-2.5 rounded-lg border border-current/30 text-xs font-medium flex items-center justify-center gap-1 hover:bg-black/10"
                        >
                          <Navigation className="w-3.5 h-3.5" /> Route to
                        </a>
                        <ActionBtn className="hidden sm:inline-flex" onClick={() => toggleMessage(job)} icon={MessageSquare} label="Message" />
                        {job.status === 'scheduled' && job.on_my_way_at && (
                          <ActionBtn disabled={sendingEta !== null} onClick={() => sendOnMyWay(job)} icon={Send} label={sendingEta === job.id ? 'Sending…' : `On my way · ${ONE_TAP_ETA_MIN}m`}
                            title={`Texts ${job.customers?.name || 'the customer'} that you'll arrive in about ${ONE_TAP_ETA_MIN} minutes. Use Message to send a different ETA.`} />
                        )}
                        {/* Complete a scheduled visit without a check-in (no time tracked);
                            completeJob handles the missing started_at and offers Undo. */}
                        {job.status === 'scheduled' && (
                          <ActionBtn disabled={acting !== null} onClick={async () => { if (acting) return; setActing(job.id); try { await onMarkDone(job) } finally { setActing(null) } }} icon={CheckCircle2} label="Complete" />
                        )}
                        {/* The toggle helpers (this commit) call closePanels() before
                            opening, which is what stops two inline panels stacking —
                            the hand-rolled setState chains they replace could only
                            close the panels whose setters they happened to list.
                            Main's richer overflow is kept: width + descriptions carry
                            the hierarchy a flat list can't. */}
                        {/* ── PANEL OPENERS FOLD ON A PHONE ─────────────────
                            Measured on the shipped build at 375×844 with a real
                            11-visit day: the first card carried TWELVE controls
                            in 347px, and the whole board ran 6.6 screens. Three
                            of those twelve open an inline panel — Photos,
                            Services, and Message above — and none of them is
                            what a person standing on site taps. The doors that
                            change the WORK (On my way · Start · Stop for today ·
                            Complete) and the one that gets you there (Route to)
                            stay buttons at every width.
                            `sm:hidden` menu twins rather than a width hook: a
                            hook is false during SSR and the first paint, so the
                            row would render full and then collapse under the
                            thumb that was already moving. */}
                        <ActionBtn className="hidden sm:inline-flex" onClick={() => togglePhoto(job)} icon={Camera} label="Photos" />
                        {/* The visit's checklist — what the office requires
                            done and shown before Complete counts. Folds on a
                            phone like its neighbours; the completion door
                            itself reports missing items either way. */}
                        <ActionBtn className="hidden sm:inline-flex" onClick={() => toggleChecklist(job)} icon={ClipboardCheck} label="Checklist" />
                        {/* ⚠️ "Crew chat" ≠ the "Message" button above it. That
                            one TEXTS THE CUSTOMER (consent-gated, costs money,
                            leaves the building). This one reaches the crew
                            assigned to this visit and no customer surface can
                            read it. Two audiences, two buttons, two words.
                            It folds like the others — EXCEPT when it is carrying
                            unread messages. An unread count is news, and news
                            does not go behind a menu. */}
                        <ActionBtn className={cn(!chatUnread[job.id] && 'hidden sm:inline-flex')}
                          onClick={() => toggleChat(job)} icon={MessagesSquare}
                          label={chatUnread[job.id] ? `Crew chat (${chatUnread[job.id]})` : 'Crew chat'} />
                        <ActionBtn className="hidden sm:inline-flex" onClick={() => toggleAddons(job)} icon={PlusCircle} label={ownerExtras.length ? `Services (${ownerExtras.length})` : 'Services'} />
                        {/* ⚠️ "Changes" ≠ "Services" beside it. Services are extras
                            the owner adds and bills; a CHANGE is new scope the
                            CUSTOMER has to approve before it counts or bills.
                            Two meanings, two doors — never merged by label.
                            It folds into the phone menu like its neighbours —
                            EXCEPT while a change is unanswered. Same rule as an
                            unread crew chat: somebody is waiting on an answer,
                            and news does not go behind a menu. */}
                        <ActionBtn className={cn(av.pendingCount === 0 && 'hidden sm:inline-flex')}
                          onClick={() => toggleChanges(job)} icon={FileSignature}
                          tone={av.pendingCount > 0 ? 'amber' : undefined}
                          label={av.pendingCount > 0 ? `Changes (${av.pendingCount} waiting)` : changes.length ? `Changes (${changes.length})` : 'Add change'} />
                        <Menu align="end" width={300} items={[
                          // The phone twins of the three buttons above. They
                          // exist ONLY below sm, so no width ever shows the same
                          // action twice.
                          { key: 'p-message', className: 'sm:hidden', label: 'Message', description: 'Text this customer', icon: MessageSquare, onSelect: () => toggleMessage(job) },
                          { key: 'p-photos', className: 'sm:hidden', label: 'Photos', description: 'Before & after for this visit', icon: Camera, onSelect: () => togglePhoto(job) },
                          { key: 'p-checklist', className: 'sm:hidden', label: 'Checklist', description: 'What must be done and shown before completing', icon: ClipboardCheck, onSelect: () => toggleChecklist(job) },
                          ...(chatUnread[job.id] ? [] : [{ key: 'p-chat', className: 'sm:hidden', label: 'Crew chat', description: 'The crew conversation for this visit', icon: MessagesSquare, onSelect: () => toggleChat(job) }]),
                          { key: 'p-services', className: 'sm:hidden', label: ownerExtras.length ? `Services (${ownerExtras.length})` : 'Services', description: 'Extra work billed with this visit', icon: PlusCircle, onSelect: () => toggleAddons(job) },
                          ...(av.pendingCount ? [] : [{ key: 'p-changes', className: 'sm:hidden', label: changes.length ? `Changes (${changes.length})` : 'Add change', description: 'New scope the customer has to approve first', icon: FileSignature, onSelect: () => toggleChanges(job) }]),
                          { key: 'quick', label: 'Quick edit', description: 'Service, date, time, crew & notes — this visit', icon: SlidersHorizontal, onSelect: () => openQuick(job) },
                          { key: 'edit', label: 'Edit job', description: 'Property, title & the recurring schedule', icon: Pencil, onSelect: () => onOpenJob(job) },
                          // Stop for today is a first-class button on the card
                          // above, not a menu item — it is one of the three
                          // things a person standing on site actually does.
                          { key: 'move', label: 'Move to another day', description: 'Reschedule this visit to another date', icon: Move, onSelect: () => toggleMove(job) },
                        ]}>
                          {({ toggle, triggerProps }) => (
                            <Button size="sm" variant="ghost" onClick={toggle} aria-label="More actions" title="More actions" {...triggerProps}>
                              <MoreHorizontal className="w-4 h-4" />
                            </Button>
                          )}
                        </Menu>
                      </div>
                      )}

                      {/* Move to another day — drag isn't available within a single day */}
                      {moveId === job.id && (
                        <div className="mt-2 flex items-center gap-2 flex-wrap" onClick={e => e.stopPropagation()}>
                          <span className="text-xs text-ink-muted">Move to</span>
                          <input type="date" defaultValue={date}
                            onChange={e => { if (e.target.value && e.target.value !== date) { onMove(job, e.target.value); setMoveId(null) } }}
                            className="bg-bg-secondary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
                          <Button size="sm" variant="ghost" onClick={() => setMoveId(null)}>Cancel</Button>
                        </div>
                      )}

                      {/* Before/after photos for this visit — proof of work + service history */}
                      {photoId === job.id && (
                        job.property_id ? (
                          <div className="mt-2 rounded-lg border border-border bg-bg-secondary p-2.5" onClick={e => e.stopPropagation()}>
                            <JobPhotos propertyId={job.property_id} jobId={job.id} customerId={job.customer_id} variant="visit" />
                          </div>
                        ) : (
                          <p className="mt-2 text-xs text-amber-400">Link a property to this visit to attach photos.</p>
                        )
                      )}

                      {/* The visit's checklist — owner view of the forms it
                          carries: fill, see who answered, waive with a reason.
                          Internal+crew audience; nothing here reaches the
                          portal. */}
                      {checklistId === job.id && (
                        <div className="mt-2 rounded-lg border border-border bg-bg-secondary p-2.5" onClick={e => e.stopPropagation()}>
                          <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-2 flex items-center gap-1"><ClipboardCheck className="w-3 h-3" /> Checklist · your team only</p>
                          <JobFormsPanel job={job} />
                        </div>
                      )}

                      {/* One-tap messages — text the customer without typing */}
                      {messageId === job.id && (
                        <div className="mt-2 rounded-lg border border-border bg-bg-secondary p-2.5" onClick={e => e.stopPropagation()}>
                          <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-2 flex items-center gap-1"><MessageSquare className="w-3 h-3" /> Message customer</p>
                          <JobMessages jobId={job.id} customerId={job.customer_id} customerName={job.customers?.name || job.title}
                            visitDate={job.scheduled_date} timeWindow={windowByJob[job.id]} address={job.properties?.address ?? undefined} />
                        </div>
                      )}

                      {/* The crew conversation for this visit — internal, and it
                          stays with the visit. Never customer-facing: no portal
                          projection, no PDF, no public API selects crew_messages
                          (verify:scoped-notes pins all three). */}
                      {chatId === job.id && (
                        <div className="mt-2 rounded-lg border border-border bg-bg-secondary p-2.5" onClick={e => e.stopPropagation()}>
                          <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-2 flex items-center gap-1">
                            <MessagesSquare className="w-3 h-3" /> Crew conversation · your team only
                          </p>
                          <VisitConversation
                            jobId={job.id}
                            onUnreadChange={(id, n) => setChatUnread(prev => (prev[id] ?? 0) === n ? prev : { ...prev, [id]: n })}
                          />
                        </div>
                      )}

                      {/* Extra services for this visit — add-ons flow into the invoice */}
                      {addonsId === job.id && (
                        <div className="mt-2 rounded-lg border border-border bg-bg-secondary p-2.5" onClick={e => e.stopPropagation()}>
                          <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-2 flex items-center gap-1"><PlusCircle className="w-3 h-3" /> Extra services</p>
                          <JobAddons
                            baseValue={value}
                            items={ownerExtras}
                            isRecurring={!!job.recurrence_id}
                            onAdd={(input) => onAddLineItem(job, input)}
                            onDelete={onDeleteLineItem}
                            previousAddons={getPreviousAddons(job)}
                            onCopyPrevious={() => onCopyPreviousAddons(job)}
                            addonTemplates={addonTemplates}
                            approvedChanges={av.approvedChanges}
                          />
                        </div>
                      )}

                      {/* Change orders — new scope, priced and sent for the
                          customer's decision. The original approval is read here
                          and never written; approval is what makes the money real. */}
                      {changesId === job.id && (
                        <div className="mt-2 rounded-lg border border-border bg-bg-secondary p-2.5" onClick={e => e.stopPropagation()}>
                          <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-2 flex items-center gap-1"><FileSignature className="w-3 h-3" /> Changes to this visit</p>
                          <JobChangeOrders
                            originalValue={value}
                            changeOrders={changes}
                            lineItems={addons}
                            canAsk={!!job.customer_id}
                            canMessage={!!(job.customers?.phone || job.customers?.email)}
                            onCreate={(input) => onCreateChangeOrder(job, input)}
                            onSend={onSendChangeOrder}
                            onCancel={onCancelChangeOrder}
                            onOwnerDecision={onOwnerChangeDecision}
                            onRemind={onRemindChangeOrder}
                          />
                        </div>
                      )}

                      {/* Quick edit lives in VisitQuickEdit (the sheet mounted
                          once below) — the old hand-styled inline panel was a
                          second implementation of fields the shared primitives
                          already own, and it couldn't hold the date/assignee/
                          service controls the fast path needs. */}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* The one stop sheet for this board. */}
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
            try { await onStopForToday(stopping, input) } finally { setStopBusy(false); setStopping(null) }
          }} />
      )}

      {/* The one quick-edit sheet for this board — field saves go through the
          page's quickSaveJob engine; a date change routes through the page's
          move engine (warnings, recurring scope, undo), never a bare patch. */}
      <VisitQuickEdit
        job={quickJob}
        crews={crews ?? []}
        onClose={() => setQuickJob(null)}
        onSave={onQuickSave}
        onMove={onMove}
      />
    </div>
  )
}

function Metric({ icon: Icon, label, value, tone }: { icon: typeof DollarSign; label: string; value: string; tone?: string }) {
  return (
    <div className="px-3 py-2.5 sm:px-4 sm:py-3">
      <div className="flex items-center gap-1.5 text-[10px] sm:text-[11px] font-semibold text-ink-muted uppercase tracking-wide">
        <Icon className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">{label}</span>
      </div>
      <p className={cn('text-lg sm:text-xl font-bold tracking-tight tabular-nums mt-0.5 truncate', tone || 'text-ink')}>{value}</p>
    </div>
  )
}

// h-10 on touch screens (one-thumb, in a driveway), compact h-8 on desktop.
// `tap-target` lifts that 40px to the 44px minimum on a coarse pointer — the last
// 4px matter with a glove on — while `sm:h-8` keeps the mouse density identical.
// 'primary' = THE next action for the stage; 'complete' = the finish action.
// 'amber' = something is WAITING ON SOMEBODY ELSE (a change order the customer
// hasn't answered) — not an error, not a next action of the owner's.
function ActionBtn({ onClick, icon: Icon, label, tone, disabled, title, className }: { onClick: () => void; icon: typeof Pencil; label: string; tone?: 'emerald' | 'sky' | 'primary' | 'complete' | 'amber'; disabled?: boolean; title?: string; className?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        // `inline-flex`, not `flex`: a caller folding this button on phones does
        // it with `hidden sm:inline-flex`, and a base `flex` later in the class
        // list would win and un-hide it at every width.
        'tap-target h-10 sm:h-8 px-3 sm:px-2.5 rounded-lg border text-xs font-medium inline-flex items-center justify-center gap-1 active:scale-95 transition-transform disabled:opacity-50 disabled:pointer-events-none',
        tone === 'primary'
          ? 'bg-accent border-accent text-black font-semibold hover:opacity-90'
          : tone === 'complete'
            ? 'bg-emerald-500 border-emerald-500 text-black font-semibold hover:opacity-90'
            : tone === 'emerald'
              ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25'
              : tone === 'sky'
                ? 'bg-sky-400/15 border-sky-400/30 text-sky-300 hover:bg-sky-400/25'
                : tone === 'amber'
                  ? 'bg-amber-500/15 border-amber-500/40 text-amber-300 hover:bg-amber-500/25'
                  : 'border-current/30 hover:bg-black/10',
        className,
      )}
    >
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  )
}
