'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import { confirm } from '@/lib/confirm'
import { createClient } from '@/lib/supabase/client'
import { Job, JobStatus, JobRecurrence, JobLineItem, RecurrenceScope, PRICE_REASONS, JOB_STATUS_LABELS, JOB_STATUS_COLORS } from '@/types'
import { Coord } from '@/lib/geo'
import { RouteStop, OrderedRouteStop, geocodeMissingStops, optimizeRoute, nearestNeighborRoute, sequenceRoute, roundTripMapsUrl, MAX_MAPS_WAYPOINTS, routeStats, directionsUrl, computeDayEtas, roughFinishEstimate, dayLoad, minutesToTime12, timeToMinutes, DEFAULT_JOB_MIN } from '@/lib/route'
import { loadTravelModel, DEFAULT_TRAVEL_MODEL, type TravelModel } from '@/lib/travelLearning'
import { buildRoadDistance } from '@/lib/distance'
import { jobVisitValue, effectiveFreq, quoteVisitAmount } from '@/lib/invoicing'
import { addonsTotal } from '@/lib/jobPricing'
import { formatCurrency, cn, localTodayISO } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Menu } from '@/components/ui/Menu'
import { EmptyState } from '@/components/ui/EmptyState'
import { JobPhotos } from '@/components/photos/JobPhotos'
import { RouteTimeline, type TimelineStop } from '@/components/schedule/RouteTimeline'
import { JobAddons } from '@/components/schedule/JobAddons'
import { JobMessages } from '@/components/schedule/JobMessages'
import { SendMessageDialog, type MessageRecipient } from '@/components/comms/SendMessageDialog'
import {
  DollarSign, Clock, CheckCircle2, Check, Repeat, Navigation, ExternalLink,
  Plus, Pencil, Move, Route as RouteIcon, ListChecks, Wallet, Hourglass, SlidersHorizontal, AlertTriangle, CloudRain, Play, Timer, Camera, PlusCircle, MessageSquare, Send, Receipt,
  ChevronUp, ChevronDown, Wand2, MoreHorizontal, CalendarDays,
} from 'lucide-react'

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
  onDeleteJob: (job: Job) => void
  onSetPrice: (job: Job, price: number | null, reason?: string) => Promise<void>
  workStartTime: string
  capacityHours: number
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
}

export interface QuickPatch {
  start_time: string | null
  crew_size: number
  duration_minutes: number | null
  status: JobStatus
  notes: string | null
  price: number | null
}

export function DayOpsPanel({
  date, dateLabel, jobs, quotesById, recurrences, baseCoord,
  onOpenJob, onStartJob, onMarkDone, onMove, onSetPrice, workStartTime, capacityHours, onRainDelay, onAddJob, onQuickSave,
  addonsByJobId, onAddLineItem, onDeleteLineItem, getPreviousAddons, onCopyPreviousAddons,
}: Props) {
  const supabase = createClient()
  // Guards Start/Complete against a double-tap (which would double-stamp the job
  // and double-create its draft invoice) while the request is in flight.
  const [acting, setActing] = useState<string | null>(null)
  const [quickId, setQuickId] = useState<string | null>(null)
  const [moveId, setMoveId] = useState<string | null>(null)
  const [qv, setQv] = useState<{ start_time: string; crew_size: number; duration_minutes: number; status: JobStatus; notes: string; price: number }>({ start_time: '', crew_size: 1, duration_minutes: 0, status: 'scheduled', notes: '', price: 0 })
  const [savingQuick, setSavingQuick] = useState(false)
  // First-class price: a dedicated, price-only inline editor on every card.
  const [priceId, setPriceId] = useState<string | null>(null)
  const [priceVal, setPriceVal] = useState('')
  const [priceReason, setPriceReason] = useState('')
  const [savingPrice, setSavingPrice] = useState(false)
  // Which job's before/after photo panel is open.
  const [photoId, setPhotoId] = useState<string | null>(null)
  // Which job's add-on services panel is open.
  const [addonsId, setAddonsId] = useState<string | null>(null)
  // Which job's one-tap messaging panel is open.
  const [messageId, setMessageId] = useState<string | null>(null)
  // "Message today's customers" dialog (day-level bulk send).
  const [showDayMsg, setShowDayMsg] = useState(false)
  // Job currently sending a one-tap "On my way" (locks the button against double-tap).
  const [sendingEta, setSendingEta] = useState<string | null>(null)
  // Drag feedback (desktop reorder): dim the dragged card, ring the drop target —
  // same drag language as the calendar's cross-day move.
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

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
          vars: { eta: '15', address: job.properties?.address ?? undefined },
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

  function openPrice(job: Job) {
    setQuickId(null); setMoveId(null); setPhotoId(null); setAddonsId(null)
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
    setPriceId(null); setMoveId(null)
    setQuickId(job.id)
    setQv({
      start_time: job.start_time || '',
      crew_size: job.crew_size,
      duration_minutes: job.duration_minutes || 0,
      status: job.status,
      notes: job.notes || '',
      price: Number(job.price) || 0,
    })
  }
  async function saveQuick(job: Job) {
    setSavingQuick(true)
    await onQuickSave(job, {
      start_time: qv.start_time || null,
      crew_size: Number(qv.crew_size) || 1,
      duration_minutes: qv.duration_minutes ? Number(qv.duration_minutes) : null,
      status: qv.status,
      notes: qv.notes || null,
      price: qv.price ? Number(qv.price) : null,
    })
    setSavingQuick(false)
    setQuickId(null)
  }
  const [route, setRoute] = useState<{ ordered: OrderedRouteStop[]; totalKm: number; mapsUrl: string | null; usedGoogle: boolean; usedRoad: boolean } | null>(null)
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
  const totalMin = active.reduce((s, j) => s + (j.duration_minutes || 0), 0)
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
        const { dist, usedRoad } = await buildRoadDistance(supabase, user.id, [baseCoord, ...located.map(s => ({ lat: s.lat as number, lng: s.lng as number }))])
        if (usedRoad) {
          const nn = nearestNeighborRoute(baseCoord, located, dist)
          if (alive) setRoute({ ordered: nn.ordered, totalKm: nn.totalKm, mapsUrl: roundTripMapsUrl(baseCoord, nn.ordered), usedGoogle: true, usedRoad: true })
          if (alive) setRouting(false)
          return
        }
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
      })), manualSeq)
    : null
  const effOrdered: OrderedRouteStop[] = manualRoute ? manualRoute.ordered : route?.ordered ?? []
  const effTotalKm = manualRoute ? manualRoute.totalKm : route?.totalKm ?? 0
  // Navigation link: the REMAINING stops in the current (manual or optimized)
  // order — completed stops don't need directions, and Google caps the URL at
  // MAX_MAPS_WAYPOINTS anyway, so mid-day re-opens always cover what's next.
  const doneIds = new Set(active.filter(j => j.status === 'completed').map(j => j.id))
  const navStops = effOrdered.filter(s => !doneIds.has(s.jobId))
  const effMapsUrl = baseCoord && navStops.length ? roundTripMapsUrl(baseCoord, navStops) : null
  const mapsCapped = navStops.length > MAX_MAPS_WAYPOINTS

  const orderByJobId = new Map(effOrdered.map(s => [s.jobId, s.order]))
  const sortedJobs = [...active].sort((a, b) => {
    const oa = orderByJobId.get(a.id) ?? 999
    const ob = orderByJobId.get(b.id) ?? 999
    if (oa !== ob) return oa - ob
    return (a.start_time || '').localeCompare(b.start_time || '')
  })
  const stats = (manualRoute || route) && locatedCoords.length > 0 ? routeStats(locatedCoords, effTotalKm, travel) : null

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
  async function applyOrder(seq: string[]) {
    setLocalSeq(seq)
    pendingOrderWrites.current++
    orderWrite.current = orderWrite.current.then(async () => {
      try {
        const results = await Promise.all(seq.map((id, i) => supabase.from('jobs').update({ route_order: i + 1 }).eq('id', id)))
        if (results.some(r => r.error)) {
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
    await orderWrite.current
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
      toast.undo('Route re-optimized — manual order cleared.', () => applyOrder(prevSeq))
    } else {
      toast.success('Route is optimized.')
    }
  }

  // Real-world timing: work start + route order + drive legs + job durations →
  // an arrival time per stop and the day's estimated finish (ONE engine, lib/route).
  const durByJob: Record<string, number> = {}
  for (const j of active) durByJob[j.id] = j.duration_minutes || DEFAULT_JOB_MIN
  const etas = effOrdered.length > 0 ? computeDayEtas(workStartTime, effOrdered, durByJob, travel) : null
  const etaByJob: Record<string, string> = {}
  const arrivalMinByJob: Record<string, number> = {}
  if (etas) for (const s of etas.stops) { etaByJob[s.jobId] = s.arrival; arrivalMinByJob[s.jobId] = s.arrivalMin }
  // A 2-hour arrival window per visit for the "Send ETA" message: anchored on the
  // committed start time when set, else the route-computed arrival.
  const windowByJob: Record<string, string> = {}
  for (const j of active) {
    const startMin = j.start_time ? timeToMinutes(j.start_time) : (arrivalMinByJob[j.id] ?? null)
    if (startMin != null) windowByJob[j.id] = `${minutesToTime12(startMin)}–${minutesToTime12(startMin + 120)}`
  }
  const laborTotalMin = active.reduce((s, j) => s + (j.duration_minutes || DEFAULT_JOB_MIN), 0)
  const usedMin = laborTotalMin + (stats ? stats.driveMinutes : active.length * 10)
  const load = dayLoad(usedMin, capacityHours)
  // Capacity % for the always-visible header badge (used ÷ day capacity).
  const dayCapMin = usedMin + load.spareMin
  const loadPct = dayCapMin > 0 ? Math.round((usedMin / dayCapMin) * 100) : null

  // The timeline reads the ETA chain the route engine already produced above —
  // no second ordering, no second distance lookup. Capacity ends at work start +
  // the day's labour budget, which is the same number the load pill uses.
  const timelineStops: TimelineStop[] = etas
    ? etas.stops
        .map(s => {
          const job = active.find(j => j.id === s.jobId)
          return job
            ? { jobId: job.id, name: job.customers?.name || job.title, arrivalMin: s.arrivalMin, durMin: durByJob[job.id] ?? DEFAULT_JOB_MIN, status: job.status }
            : null
        })
        .filter((s): s is TimelineStop => s !== null)
    : []
  const capacityEndMin = (etas?.startMin ?? timeToMinutes(workStartTime)) + Math.round((capacityHours > 0 ? capacityHours : 8) * 60)

  // ── Live day tracking (check-in/check-out data) ──
  const isToday = date === localTodayISO()
  const inProgress = active.find(j => j.status === 'in_progress') ?? null
  const tsTo12 = (iso: string) => { const t = new Date(iso); return minutesToTime12(t.getHours() * 60 + t.getMinutes()) }
  const elapsedMin = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  const firstStart = active.map(j => j.started_at).filter(Boolean).sort()[0] as string | undefined
  const workedMin = completed.reduce((s, j) => s + (j.actual_minutes || 0), 0)
    + (inProgress?.started_at ? elapsedMin(inProgress.started_at) : 0)
  const live = isToday && (!!inProgress || (!!firstStart && completed.length > 0))
  // Re-render each minute while a job is running so elapsed/finish stay current.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!isToday || !inProgress) return
    const t = setInterval(() => setTick(x => x + 1), 60000)
    return () => clearInterval(t)
  }, [isToday, inProgress])
  // Finish estimate: live (now + what's left) once the day is underway, else the
  // planned route ETAs from work start.
  let estFinish: string
  if (active.length === 0) estFinish = '—'
  else if (remaining.length === 0) estFinish = 'Done'
  else if (live) {
    const now = new Date()
    const curElapsed = inProgress?.started_at ? elapsedMin(inProgress.started_at) : 0
    const remainingLabor = remaining.reduce((s, j) => s + (j.duration_minutes || DEFAULT_JOB_MIN), 0)
      - (inProgress ? Math.min(curElapsed, inProgress.duration_minutes || DEFAULT_JOB_MIN) : 0)
    const remainingLegs = remaining.filter(j => j.id !== inProgress?.id).length * 10
    estFinish = minutesToTime12(now.getHours() * 60 + now.getMinutes() + Math.max(5, remainingLabor) + remainingLegs)
  } else {
    estFinish = etas?.finish ?? roughFinishEstimate(workStartTime, laborTotalMin, active.length).finish
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
            <span className={cn(
              'text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border shrink-0',
              load.state === 'overloaded' ? 'text-red-400 border-red-500/30 bg-red-500/10'
                : load.state === 'room' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
                : 'text-ink-muted border-border bg-bg-tertiary'
            )}>
              {load.state === 'overloaded' ? `Over by ${Math.round(-load.spareMin / 6) / 10}h`
                : load.state === 'room' ? `Room for ~${Math.round(load.spareMin / 6) / 10}h`
                : 'Full day'}
              {loadPct != null && ` · ${loadPct}%`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {dayRecipients.length > 0 && (
            <Button size="sm" variant="secondary" onClick={() => setShowDayMsg(true)} title="Message everyone scheduled today">
              <MessageSquare className="w-4 h-4" /> Message all
            </Button>
          )}
          {remaining.length > 0 && (
            <Button size="sm" variant="secondary" onClick={onRainDelay} title="Bump all remaining jobs to your next work day">
              <CloudRain className="w-4 h-4" /> Delay remaining
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
          {/* Route intelligence — the dispatcher board. (The old 4-stat "day
              operations" grid repeated the metric strip and settings bar — gone.) */}
          <div className="rounded-xl border border-border bg-bg-tertiary px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted uppercase tracking-wide">
                <RouteIcon className="w-3.5 h-3.5 text-accent-text" /> Route
                {manualSeq && (
                  <span className="normal-case tracking-normal text-[10px] font-semibold text-amber-300 border border-amber-500/30 bg-amber-500/10 rounded px-1.5 py-0.5">
                    Custom order
                  </span>
                )}
              </span>
              <span className="flex items-center gap-3 shrink-0">
                {/* Persistent "reset to best route" — reuses the continuously-computed
                    optimized order; confirms only when a manual order would be lost. */}
                {active.length > 1 && baseCoord && (
                  <button type="button" onClick={optimizeRouteNow} disabled={optimizing}
                    title="Recalculate the best stop order (clears manual reordering)"
                    className="text-xs font-medium rounded-lg border border-border-strong text-ink-muted hover:text-ink hover:bg-surface px-2.5 py-1 flex items-center gap-1 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
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
              </span>
            </div>
            {!baseCoord ? (
              <p className="text-xs text-amber-400 mt-1.5">Set your base address in Settings to optimize the route.</p>
            ) : routing && !manualRoute ? (
              <p className="text-xs text-ink-faint mt-1.5">Optimizing route…</p>
            ) : (manualRoute || route) && stats ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-xs text-ink-muted">
                <span className="flex items-center gap-1"><Navigation className="w-3 h-3" /> ~{effTotalKm} km</span>
                {!manualRoute && route?.usedRoad && <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 rounded px-1.5 py-0.5">Real-road</span>}
                <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> ~{stats.driveMinutes} min driving</span>
                {totalMin > 0 && <span className="flex items-center gap-1"><Hourglass className="w-3 h-3" /> ~{Math.round(totalMin / 6) / 10}h work</span>}
              </div>
            ) : (
              <p className="text-xs text-ink-faint mt-1.5">No locatable stops yet.</p>
            )}
          </div>

          {/* The same route, as time: where the day goes, how much is driving,
              and whether it runs past capacity. Reads the ETAs computed above. */}
          {etas && timelineStops.length > 0 && (
            <RouteTimeline
              startMin={etas.startMin}
              finishMin={etas.finishMin}
              capacityEndMin={capacityEndMin}
              stops={timelineStops}
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
              const qVal = quoteValueFor(job)
              const idx = sortedJobs.findIndex(j => j.id === job.id)
              return (
                <div key={job.id}
                  draggable={sortedJobs.length > 1}
                  onDragStart={() => { dragId.current = job.id; setDraggingId(job.id) }}
                  onDragEnd={() => { setDraggingId(null); setDragOverId(null) }}
                  onDragOver={e => { e.preventDefault(); if (dragOverId !== job.id) setDragOverId(job.id) }}
                  onDragLeave={() => { if (dragOverId === job.id) setDragOverId(null) }}
                  onDrop={() => { dropOn(job.id); setDraggingId(null); setDragOverId(null) }}
                  className={cn('rounded-xl border px-3 py-2.5 transition-colors',
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
                                className="flex items-center gap-1 text-sm font-bold text-ink rounded-md px-1.5 py-0.5 hover:bg-black/10 transition-colors">
                                {formatCurrency(total)}<Pencil className="w-3 h-3 opacity-40" />
                              </button>
                            : <button onClick={e => { e.stopPropagation(); priceId === job.id ? setPriceId(null) : openPrice(job) }}
                                title="Set price"
                                className="text-[10px] font-semibold uppercase tracking-wide text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-1.5 py-0.5 flex items-center gap-1 hover:bg-amber-500/20">
                                <AlertTriangle className="w-3 h-3" /> Set price
                              </button>}
                          {/* Delete lives in the job form (Open → trash) — a 28px
                              destructive button beside the price invited mis-taps. */}
                        </div>
                      </div>

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
                        {addons.length > 0 && (
                          <button onClick={e => { e.stopPropagation(); setQuickId(null); setMoveId(null); setPriceId(null); setPhotoId(null); setAddonsId(addonsId === job.id ? null : job.id) }}
                            title={addons.map(a => `${a.description} ${formatCurrency(Number(a.amount))}`).join(' · ')}
                            className="text-[10px] font-semibold text-accent-text border border-accent/30 bg-accent/10 rounded px-1.5 py-0.5 shrink-0 hover:bg-accent/20">
                            +{addons.length <= 2 ? addons.map(a => a.description).join(' + ') : `${addons.length} services`}
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
                          <a href={`/dashboard/invoices?job=${job.id}`}
                            className="h-10 sm:h-8 px-3 sm:px-2.5 rounded-lg border border-current/30 text-xs font-medium flex items-center gap-1 hover:bg-black/10">
                            <Receipt className="w-3.5 h-3.5" /> Invoice
                          </a>
                          <ActionBtn onClick={() => onOpenJob(job)} icon={Pencil} label="Edit" />
                          <ActionBtn onClick={() => { setQuickId(null); setMoveId(null); setPriceId(null); setAddonsId(null); setMessageId(null); setPhotoId(photoId === job.id ? null : job.id) }} icon={Camera} label="Photos" />
                        </div>
                      ) : (
                      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                        {/* Stage primary. on_my_way_at stamps when the text sends, so the
                            primary advances On my way → Start on its own. */}
                        {job.status === 'scheduled' && !job.on_my_way_at && (
                          <ActionBtn disabled={sendingEta !== null} onClick={() => sendOnMyWay(job)} icon={Send} label={sendingEta === job.id ? 'Sending…' : 'On my way'} tone="primary" />
                        )}
                        {job.status === 'scheduled' && (
                          <ActionBtn disabled={acting !== null} onClick={async () => { if (acting) return; setActing(job.id); try { await onStartJob(job) } finally { setActing(null) } }} icon={Play} label="Start" tone={job.on_my_way_at ? 'primary' : undefined} />
                        )}
                        {job.status === 'in_progress' && (
                          <ActionBtn disabled={acting !== null} onClick={async () => { if (acting) return; setActing(job.id); try { await onMarkDone(job) } finally { setActing(null) } }} icon={CheckCircle2} label="Complete" tone="complete" />
                        )}
                        <a
                          href={directionsUrl({ lat: job.properties?.lat ?? null, lng: job.properties?.lng ?? null, address: job.properties?.address }, baseCoord)}
                          target="_blank" rel="noopener noreferrer"
                          className="h-10 sm:h-8 px-3 sm:px-2.5 rounded-lg border border-current/30 text-xs font-medium flex items-center gap-1 hover:bg-black/10"
                        >
                          <Navigation className="w-3.5 h-3.5" /> Route to
                        </a>
                        <ActionBtn onClick={() => { setQuickId(null); setMoveId(null); setPriceId(null); setPhotoId(null); setAddonsId(null); setMessageId(messageId === job.id ? null : job.id) }} icon={MessageSquare} label="Message" />
                        {job.status === 'scheduled' && job.on_my_way_at && (
                          <ActionBtn disabled={sendingEta !== null} onClick={() => sendOnMyWay(job)} icon={Send} label={sendingEta === job.id ? 'Sending…' : 'On my way'} />
                        )}
                        {/* Complete a scheduled visit without a check-in (no time tracked);
                            completeJob handles the missing started_at and offers Undo. */}
                        {job.status === 'scheduled' && (
                          <ActionBtn disabled={acting !== null} onClick={async () => { if (acting) return; setActing(job.id); try { await onMarkDone(job) } finally { setActing(null) } }} icon={CheckCircle2} label="Complete" />
                        )}
                        <ActionBtn onClick={() => { setQuickId(null); setMoveId(null); setPriceId(null); setAddonsId(null); setMessageId(null); setPhotoId(photoId === job.id ? null : job.id) }} icon={Camera} label="Photos" />
                        <ActionBtn onClick={() => { setQuickId(null); setMoveId(null); setPriceId(null); setPhotoId(null); setMessageId(null); setAddonsId(addonsId === job.id ? null : job.id) }} icon={PlusCircle} label={addons.length ? `Services (${addons.length})` : 'Services'} />
                        {/* Rare edit actions live in ONE overflow — same handlers, less chrome. */}
                        <Menu align="end" items={[
                          { key: 'quick', label: 'Quick edit', icon: SlidersHorizontal, onSelect: () => { quickId === job.id ? setQuickId(null) : openQuick(job) } },
                          { key: 'edit', label: 'Edit job', icon: Pencil, onSelect: () => onOpenJob(job) },
                          { key: 'move', label: 'Move to another day', icon: Move, onSelect: () => setMoveId(moveId === job.id ? null : job.id) },
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
                          <p className="mt-2 text-xs text-amber-400">Link a property to this job to attach photos.</p>
                        )
                      )}

                      {/* One-tap messages — text the customer without typing */}
                      {messageId === job.id && (
                        <div className="mt-2 rounded-lg border border-border bg-bg-secondary p-2.5" onClick={e => e.stopPropagation()}>
                          <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-2 flex items-center gap-1"><MessageSquare className="w-3 h-3" /> Message customer</p>
                          <JobMessages jobId={job.id} customerId={job.customer_id} customerName={job.customers?.name || job.title}
                            visitDate={job.scheduled_date} timeWindow={windowByJob[job.id]} address={job.properties?.address ?? undefined} />
                        </div>
                      )}

                      {/* Extra services for this visit — add-ons flow into the invoice */}
                      {addonsId === job.id && (
                        <div className="mt-2 rounded-lg border border-border bg-bg-secondary p-2.5" onClick={e => e.stopPropagation()}>
                          <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-2 flex items-center gap-1"><PlusCircle className="w-3 h-3" /> Extra services</p>
                          <JobAddons
                            baseValue={value}
                            items={addons}
                            isRecurring={!!job.recurrence_id}
                            onAdd={(input) => onAddLineItem(job, input)}
                            onDelete={onDeleteLineItem}
                            previousAddons={getPreviousAddons(job)}
                            onCopyPrevious={() => onCopyPreviousAddons(job)}
                          />
                        </div>
                      )}

                      {/* Inline quick edit — small changes without the full form */}
                      {quickId === job.id && (
                        <div className="mt-2 rounded-lg border border-border bg-bg-secondary p-2.5 space-y-2" onClick={e => e.stopPropagation()}>
                          <div className="grid grid-cols-3 gap-2">
                            <label className="text-[10px] uppercase tracking-wide text-ink-faint">Time
                              <input type="time" value={qv.start_time} onChange={e => setQv(v => ({ ...v, start_time: e.target.value }))}
                                className="w-full mt-0.5 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
                            </label>
                            <label className="text-[10px] uppercase tracking-wide text-ink-faint">Crew
                              <input type="number" min="1" value={qv.crew_size} onChange={e => setQv(v => ({ ...v, crew_size: Number(e.target.value) || 1 }))}
                                className="w-full mt-0.5 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
                            </label>
                            <label className="text-[10px] uppercase tracking-wide text-ink-faint">Mins
                              <input type="number" min="0" step="5" value={qv.duration_minutes} onChange={e => setQv(v => ({ ...v, duration_minutes: Number(e.target.value) || 0 }))}
                                className="w-full mt-0.5 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
                            </label>
                          </div>
                          <label className="text-[10px] uppercase tracking-wide text-ink-faint block">Status
                            <select value={qv.status} onChange={e => setQv(v => ({ ...v, status: e.target.value as JobStatus }))}
                              className="w-full mt-0.5 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20">
                              {(['scheduled', 'in_progress', 'completed', 'cancelled'] as JobStatus[]).map(s => (
                                <option key={s} value={s} className="bg-bg-secondary">{JOB_STATUS_LABELS[s]}</option>
                              ))}
                            </select>
                          </label>
                          <label className="text-[10px] uppercase tracking-wide text-ink-faint block">Notes
                            <textarea value={qv.notes} onChange={e => setQv(v => ({ ...v, notes: e.target.value }))} placeholder="Gate code, access, crew notes…" rows={2}
                              className="w-full mt-0.5 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
                          </label>
                          <div className="flex items-center gap-2">
                            <Button size="sm" onClick={() => saveQuick(job)} loading={savingQuick}>Save</Button>
                            <Button size="sm" variant="ghost" onClick={() => setQuickId(null)}>Cancel</Button>
                            <span className="text-[10px] text-ink-faint ml-auto">This visit only · use Open for more</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
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
// 'primary' = THE next action for the stage; 'complete' = the finish action.
function ActionBtn({ onClick, icon: Icon, label, tone, disabled }: { onClick: () => void; icon: typeof Pencil; label: string; tone?: 'emerald' | 'sky' | 'primary' | 'complete'; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'h-10 sm:h-8 px-3 sm:px-2.5 rounded-lg border text-xs font-medium flex items-center gap-1 active:scale-95 transition-transform disabled:opacity-50 disabled:pointer-events-none',
        tone === 'primary'
          ? 'bg-accent border-accent text-black font-semibold hover:opacity-90'
          : tone === 'complete'
            ? 'bg-emerald-500 border-emerald-500 text-black font-semibold hover:opacity-90'
            : tone === 'emerald'
              ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25'
              : tone === 'sky'
                ? 'bg-sky-400/15 border-sky-400/30 text-sky-300 hover:bg-sky-400/25'
                : 'border-current/30 hover:bg-black/10'
      )}
    >
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  )
}
