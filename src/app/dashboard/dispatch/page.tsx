'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { format, parseISO, addDays } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { useBulkSelect } from '@/hooks/useBulkSelect'
import { useFlipList } from '@/hooks/useFlipList'
import { Job, Crew, Technician, DispatchNote, TechnicianStatus, TECHNICIAN_STATUS_LABELS, JOB_STATUS_LABELS, JobStatus } from '@/types'
import {
  partitionByCrew, laneSequence, laneWorkMinutes, laneLoad, crewCapacityMinutes, crewDayStart,
  balanceDay, BalancePlan, UNASSIGNED_ID, CrewLaneData, laneLabel, personLaneId, technicianOfLane,
  loadCrews, loadTechnicians, loadDispatchNotes, saveDispatchNote, setTechnicianStatus, assignJob,
  TECH_STATUS_META, TECH_STATUSES,
} from '@/lib/crews'
import {
  Assignee, UNASSIGNED, assigneeOf, assigneeColumns, assignmentOptions, sameAssignee,
  ASSIGNMENT_GROUP_LABELS,
} from '@/lib/crewAssignment'
import {
  RouteStop, OrderedRouteStop, sequenceRoute, optimizeRoute, geocodeMissingStops,
  computeDayEtas, DayEtas, timeToMinutes, minutesToTime12, roundTripMapsUrl, directionsUrl,
  legMinutes, DEFAULT_JOB_MIN, DEFAULT_WORK_START,
} from '@/lib/route'
import { DayStatusRow, DAY_STATUS_SELECT, dayStatusLabel } from '@/lib/dayStatus'
import {
  laneStats, LaneStats, detectDayConflicts, DispatchConflict, ConflictLaneInput, laneConflictSummary,
  laneProgress, nudgeAcrossVisible, bestOrderSavingsKm, dayKpis, buildActivityFeed, ActivityItem,
  itineraryText, suggestPromiseOrder, PromiseOrderSuggestion,
  DispatchSheet, SheetLane, sheetCsvRows, SHEET_CSV_COLUMNS, openPrintSheet,
} from '@/lib/dispatchOps'
import { startVisit, completeVisit, revertVisit } from '@/lib/jobStatus'
import { checklistBlockMessage } from '@/lib/jobForms'
import { formatDuration, formatWorked, workdayMinutes } from '@/lib/workDuration'
import { resolveAutomations, Automations } from '@/lib/comms/automations'
import { usePageCommands, PageCommand } from '@/components/command/pageCommands'
import { exportRowsToCsv } from '@/lib/csv'
import { notifyRescheduleBatch } from '@/lib/reschedule'
import { DisruptionReason } from '@/lib/disruption'
import { Coord } from '@/lib/geo'
import dynamic from 'next/dynamic'
import { RouteTimeline, TimelineStop } from '@/components/schedule/RouteTimeline'
import { VisitAddress } from '@/components/schedule/VisitAddress'
import type { DispatchMapLane } from '@/components/dispatch/DispatchMap'

// The map renders only in map view, and it already sits behind its own
// "Loading map…" state while the Google SDK fetches — so its code (and the
// Maps loader) can arrive the same way, off the board's critical bundle. The
// fallback mirrors the component's own placeholder, making the first switch
// to map view visually identical.
const DispatchMap = dynamic(
  () => import('@/components/dispatch/DispatchMap').then(m => m.DispatchMap),
  {
    ssr: false,
    loading: () => (
      <div style={{ height: 560 }} className="relative rounded-card overflow-hidden border border-border bg-bg-secondary flex items-center justify-center text-sm text-ink-muted">
        Loading map…
      </div>
    ),
  },
)
import { CrewManager, AssignableEquipment } from '@/components/dispatch/CrewManager'
import { ConflictPanel } from '@/components/dispatch/ConflictPanel'
import { DispatchFilters, DispatchFilterState, EMPTY_DISPATCH_FILTER, hasActiveFilter } from '@/components/dispatch/DispatchFilters'
import { RescheduleDialog } from '@/components/dispatch/RescheduleDialog'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { StatTile } from '@/components/ui/StatTile'
import { Kbd } from '@/components/ui/Kbd'
import { FilterPill } from '@/components/ui/FilterPill'
import { Badge, jobStatusTone } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Menu, MenuItem } from '@/components/ui/Menu'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonTiles, SkeletonRows } from '@/components/ui/Skeleton'
import { Modal } from '@/components/ui/Modal'
import { CompletionSheet } from '@/components/completion/CompletionSheet'
import { CompletionReportSheet } from '@/components/completion/CompletionReportSheet'
import { JobPhotos } from '@/components/photos/JobPhotos'
import { JobFormsPanel } from '@/components/forms/JobFormsPanel'
import { saveCompletionRecord } from '@/lib/completion'
import { BulkActionBar, BulkAction, SelectCheckbox, SelectAllToggle } from '@/components/ui/BulkActions'
import { toast as notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  Radio, Users, UserMinus, MapIcon, LayoutGrid, ChevronLeft, ChevronRight, Scale, GripVertical,
  ChevronUp, ChevronDown, Wand2, ExternalLink, Truck, StickyNote, HardHat, Navigation, Clock,
  Printer, FileDown, CalendarDays, AlertTriangle, Keyboard, Phone, MessageSquare, Check,
  Play, Copy, History, Activity, CheckCircle2, PlayCircle, Send, Loader2, MoreHorizontal,
  NotebookPen,
} from 'lucide-react'

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Per-lane route view: the lane's manual order run through the SAME engines the
// schedule uses (sequenceRoute → computeDayEtas). No route math lives here.
interface LaneRoute {
  seq: Job[]
  ordered: OrderedRouteStop[]
  etas: DayEtas
  totalKm: number
  capacityMin: number
  workMin: number
  startHHmm: string
}

function jobStop(j: Job): RouteStop {
  return {
    jobId: j.id,
    title: j.customers?.name || j.title,
    address: j.properties?.address || '',
    propertyId: j.properties?.id ?? null,
    lat: j.properties?.lat ?? null,
    lng: j.properties?.lng ?? null,
  }
}

// A lane id IS an assignment — the unassigned lane, one person's lane, or a
// crew — and these two turn it back and forth. Every drop target on this board
// (drag, arrow keys, a balance move) names a lane; every write names an
// assignee, so the translation lives in one place rather than at each edge.
function assigneeOfLane(laneId: string): Assignee {
  if (laneId === UNASSIGNED_ID) return UNASSIGNED
  const technicianId = technicianOfLane(laneId)
  return technicianId ? { kind: 'person', technicianId } : { kind: 'crew', crewId: laneId }
}
const laneIdOfAssignee = (a: Assignee): string =>
  a.kind === 'crew' ? a.crewId : a.kind === 'person' ? personLaneId(a.technicianId) : UNASSIGNED_ID

// Keyboard-move state: one visit "grabbed" off the board, arrows steer it.
interface KbGrab {
  jobId: string
  homeLaneId: string
  /** Where it came FROM, both columns — putting it back on a person is a
   *  restore a crew_id snapshot could not express. */
  homeAssignee: Assignee
  homeOrder: string[]
}

export default function DispatchPage() {
  const supabase = useMemo(() => createClient(), [])
  const [uid, setUid] = useState<string | null>(null)
  const [date, setDate] = useState<string>(todayISO)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [crews, setCrews] = useState<Crew[]>([])
  const [technicians, setTechnicians] = useState<Technician[]>([])
  const [equipment, setEquipment] = useState<AssignableEquipment[]>([])
  const [notes, setNotes] = useState<DispatchNote[]>([])
  const [dayRow, setDayRow] = useState<DayStatusRow | null>(null)
  const [settings, setSettings] = useState<{ base: Coord | null; workStart: string; dailyHours: number }>({ base: null, workStart: DEFAULT_WORK_START, dailyHours: 8 })
  const [view, setView] = useState<'board' | 'map'>('board')
  // Which visit's proof-of-work record is open. By ID, never a snapshot: the
  // sheet must read whatever the last fetch put in `jobs`, or a crew note
  // written while this board sat open would be saved over.
  const [recordingId, setRecordingId] = useState<string | null>(null)
  // Which completed visit's customer-facing report preview is open. Read-only:
  // the report is composed from canonical evidence (lib/completionReport) and
  // never stored — durable save/share parks on the S74 document system.
  const [reportJobId, setReportJobId] = useState<string | null>(null)
  // `?roster=1` opens the roster straight away. Every "add your people" empty
  // state across Workforce/Payroll/Timesheet links here — previously they told
  // the owner to "add people under Crews & roster on the dispatch board" and left
  // them to find it, which is a dead end on the first screen a new owner sees.
  // Session-sticky: once opened, the day-note box never collapses back — the one
  // moment it must not vanish is right after the owner clears its text mid-edit.
  const [dayNoteOpen, setDayNoteOpen] = useState(false)
  const [managerOpen, setManagerOpen] = useState(() => {
    if (typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).get('roster') === '1'
  })
  const [balancePlan, setBalancePlan] = useState<BalancePlan | null>(null)
  const [applyingBalance, setApplyingBalance] = useState(false)
  const [optimizingLane, setOptimizingLane] = useState<string | null>(null)
  const [filter, setFilter] = useState<DispatchFilterState>(EMPTY_DISPATCH_FILTER)
  const [assignPickOpen, setAssignPickOpen] = useState(false)
  const [reschedOpen, setReschedOpen] = useState(false)
  const [bulkBusy, setBulkBusy] = useState<string | null>(null)
  const [flashJobId, setFlashJobId] = useState<string | null>(null)
  const [kbGrab, setKbGrab] = useState<KbGrab | null>(null)
  const [announce, setAnnounce] = useState('')
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyRows, setHistoryRows] = useState<{ date: string; total: number; done: number; cancelled: number }[] | null>(null)
  const [automations, setAutomations] = useState<Automations>(() => resolveAutomations(null))
  const [statusBusy, setStatusBusy] = useState<Set<string>>(new Set())
  // Ticks once a minute while viewing today, so the "now" line, ETAs-vs-clock
  // and behind-schedule chips stay honest without anyone touching the page.
  const [nowTick, setNowTick] = useState(0)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const geocodedFor = useRef<string | null>(null)
  // Roving-focus API for the j/k/x/s keys — assigned fresh each render, read
  // by the one document-level key handler.
  const kbApiRef = useRef<{ ids: string[]; toggle: (id: string, shift?: boolean) => void; advance: (id: string) => void }>({ ids: [], toggle: () => {}, advance: () => {} })
  // Serialized route_order writes — a second reorder waits for the first, so
  // two quick moves can't interleave their day-wide sequence writes.
  const orderWrite = useRef<Promise<unknown>>(Promise.resolve())

  const fetchAll = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { setLoadError('Session expired — sign in again.'); setLoading(false); return }
      setUid(user.id)
      const [jRes, cRes, tRes, eRes, dRes, sRes, nRes] = await Promise.all([
        supabase.from('jobs')
          .select('*, customers(id, name, phone, preferred_days, avoid_days, pref_time_start, pref_time_end), properties(id, address, lat, lng, neighborhood, preferred_days, avoid_days, pref_time_start, pref_time_end)')
          .eq('user_id', user.id).eq('scheduled_date', date),
        loadCrews(supabase, user.id),
        loadTechnicians(supabase, user.id),
        supabase.from('equipment').select('id, name, category, crew_id').eq('user_id', user.id).eq('status', 'active').order('name'),
        supabase.from('day_statuses').select(DAY_STATUS_SELECT).eq('user_id', user.id).eq('date', date).maybeSingle(),
        supabase.from('business_settings').select('base_lat, base_lng, work_start_time, daily_capacity_hours, automations').eq('user_id', user.id).maybeSingle(),
        loadDispatchNotes(supabase, user.id, date),
      ])
      // Every read is checked, not just the visits. `dRes` is the day's status —
      // the "this day is rained out, capacity is zero" banner below reads it, and
      // an unchecked failure silently CLEARED it, so a blocked day rendered as a
      // normal working day on the crew's board. `eRes` (assigned vehicles) and
      // `sRes` (work start, capacity, base, automations) fail the same way. A load
      // that couldn't answer must say so and keep the last known-good on screen —
      // never substitute a confident default. (`maybeSingle` gives data:null with
      // error:null for "no row", so this only trips on a REAL failure.)
      const readErr = jRes.error ?? eRes.error ?? dRes.error ?? sRes.error
      if (readErr) { setLoadError('Could not load the day: ' + readErr.message); return }
      setLoadError(null)
      setJobs((jRes.data as Job[]) || [])
      setCrews(cRes)
      setTechnicians(tRes)
      setEquipment((eRes.data as AssignableEquipment[] | null) || [])
      setDayRow((dRes.data as DayStatusRow | null) ?? null)
      const s = sRes.data as { base_lat: number | null; base_lng: number | null; work_start_time: string | null; daily_capacity_hours: number | null; automations: unknown } | null
      setAutomations(resolveAutomations(s?.automations))
      setSettings({
        base: s?.base_lat != null && s?.base_lng != null ? { lat: Number(s.base_lat), lng: Number(s.base_lng) } : null,
        workStart: s?.work_start_time || DEFAULT_WORK_START,
        dailyHours: Number(s?.daily_capacity_hours) > 0 ? Number(s?.daily_capacity_hours) : 8,
      })
      setNotes(nRes)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load the day.')
    } finally {
      setLoading(false)
    }
  }, [supabase, date])

  useEffect(() => { setLoading(true); fetchAll() }, [fetchAll])

  const rtFilter = uid ? `user_id=eq.${uid}` : null
  useRealtimeRefresh('jobs', rtFilter, fetchAll)
  useRealtimeRefresh('crews', rtFilter, fetchAll)
  useRealtimeRefresh('technicians', rtFilter, fetchAll)
  useRealtimeRefresh('dispatch_notes', rtFilter, fetchAll)
  // day_statuses too. The board RENDERS this table (the blocked-day banner) and
  // COMPUTES from it (crewCapacityMinutes → 0 when blocked, crewDayStart for a late
  // frost start) — but it was the one input with no subscription. So the manager
  // marking today rained-out reached the calendar instantly and never reached the
  // board already open in the truck: it kept showing a full-capacity normal day
  // until something ELSE changed or the tab was refocused. Same hook, same filter,
  // same fetchAll — runCoalesced dedupes it against the four subs above, so this
  // adds a signal, not a refetch.
  useRealtimeRefresh('day_statuses', rtFilter, fetchAll)

  // Geocode once per day-load: any stop with an address but no coords gets
  // located (and written back to its property by the shared helper), then the
  // local jobs pick up the coords so routes/ETAs/map sharpen in place.
  useEffect(() => {
    if (loading || geocodedFor.current === date) return
    const missing = jobs.filter(j => j.status !== 'cancelled' && j.properties?.address && (j.properties?.lat == null || j.properties?.lng == null))
    if (missing.length === 0) { geocodedFor.current = date; return }
    geocodedFor.current = date
    const stops = missing.map(jobStop)
    geocodeMissingStops(supabase, stops).then(n => {
      if (n === 0) return
      const byJob = new Map(stops.map(s => [s.jobId, s]))
      setJobs(prev => prev.map(j => {
        const s = byJob.get(j.id)
        return s && j.properties && s.lat != null
          ? { ...j, properties: { ...j.properties, lat: s.lat, lng: s.lng } }
          : j
      }))
    })
  }, [loading, jobs, date, supabase])

  // ── Lanes + per-lane routes (pure derivations of the shared engines) ──
  const lanes = useMemo(() => partitionByCrew(jobs, crews, technicians), [jobs, crews, technicians])
  const activeCrewCount = crews.filter(c => c.is_active).length

  // A visit's home lane, in ONE place: its crew's lane, else the person's own
  // lane, else Unassigned. It must mirror partitionByCrew's key exactly — a
  // second spelling of this rule is how a visit assigned to one person ends up
  // filed under "nobody" on one surface and under their name on another.
  const laneIdOf = useCallback((j: Job): string =>
    j.crew_id && crews.some(c => c.id === j.crew_id && c.is_active) ? j.crew_id
      : j.technician_id && technicians.some(t => t.id === j.technician_id) ? personLaneId(j.technician_id)
      : UNASSIGNED_ID, [crews, technicians])

  // What to call a lane in a sentence — read from the lanes themselves, so no
  // surface can invent a second name for one.
  const laneNameOf = useCallback((laneId: string): string => {
    const lane = lanes.find(l => l.laneId === laneId)
    return lane ? laneLabel(lane) : 'Unassigned'
  }, [lanes])

  // Who an assignment names, for the "→ X" toasts.
  const assigneeName = useCallback((a: Assignee): string =>
    a.kind === 'crew' ? crews.find(c => c.id === a.crewId)?.name ?? 'that crew'
      : a.kind === 'person' ? technicians.find(t => t.id === a.technicianId)?.name ?? 'that person'
      : 'Unassigned', [crews, technicians])

  const laneRoutes = useMemo(() => {
    const out: Record<string, LaneRoute> = {}
    for (const lane of lanes) {
      const seq = laneSequence(lane.jobs)
      const stops = seq.map(jobStop)
      const ids = seq.map(j => j.id)
      let ordered: OrderedRouteStop[]
      let totalKm = 0
      if (settings.base) {
        const r = sequenceRoute(settings.base, stops, ids)
        ordered = r.ordered; totalKm = r.totalKm
      } else {
        ordered = stops.map((s, i) => ({ ...s, order: i + 1, legKm: null }))
      }
      const startHHmm = crewDayStart(lane.crew, dayRow, settings.workStart)
      const durations = Object.fromEntries(seq.map(j => [j.id, j.duration_minutes || DEFAULT_JOB_MIN]))
      const etas = computeDayEtas(startHHmm, ordered, durations)
      out[lane.laneId] = {
        seq, ordered, etas, totalKm,
        capacityMin: crewCapacityMinutes(lane.crew, dayRow, settings.dailyHours),
        workMin: laneWorkMinutes(lane.jobs),
        startHHmm,
      }
    }
    return out
  }, [lanes, settings, dayRow])
  // Pointer-drag handlers outlive renders; they read routes through this ref.
  const laneRoutesRef = useRef(laneRoutes)
  laneRoutesRef.current = laneRoutes

  const activeJobs = useMemo(() => jobs.filter(j => j.status !== 'cancelled'), [jobs])
  // Assigned = it has a crew OR a person. Counting crews only reported work
  // handed to somebody by name as nobody's.
  const assignedCount = activeJobs.filter(j => laneIdOf(j) !== UNASSIGNED_ID).length
  const isToday = date === todayISO()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nowMin = useMemo(() => isToday ? new Date().getHours() * 60 + new Date().getMinutes() : undefined, [isToday, nowTick])
  useEffect(() => {
    if (!isToday) return
    const t = setInterval(() => setNowTick(n => n + 1), 60_000)
    return () => clearInterval(t)
  }, [isToday])
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])
  const latestFinish = useMemo(() => {
    const fins = lanes.filter(l => laneRoutes[l.laneId]?.seq.length).map(l => laneRoutes[l.laneId].etas.finishMin)
    return fins.length ? Math.max(...fins) : null
  }, [lanes, laneRoutes])
  const totalKm = useMemo(() =>
    Math.round(lanes.reduce((s, l) => s + (laneRoutes[l.laneId]?.totalKm ?? 0), 0) * 10) / 10,
  [lanes, laneRoutes])

  const mapLanes: DispatchMapLane[] = useMemo(() => lanes.map(lane => {
    const route = laneRoutes[lane.laneId]
    const etaByJob = new Map((route?.etas.stops ?? []).map(s => [s.jobId, s.arrival]))
    return {
      id: lane.laneId,
      name: laneLabel(lane),
      hex: lane.palette.hex,
      stops: (route?.ordered ?? [])
        .filter(s => s.lat != null && s.lng != null)
        .map(s => ({ lat: s.lat as number, lng: s.lng as number, order: s.order, title: s.title, jobId: s.jobId, eta: etaByJob.get(s.jobId) ?? null })),
    }
  }), [lanes, laneRoutes])

  // ── Per-lane aux data, memoized once so the lane cards can be memo()'d ──
  const laneAux = useMemo(() => {
    const out: Record<string, { techs: Technician[]; vehicles: AssignableEquipment[]; note: DispatchNote | null }> = {}
    for (const lane of lanes) {
      out[lane.laneId] = {
        // A person's lane has a roster of exactly one — them. Vehicles and the
        // dispatch note stay crew-only facts: equipment is assigned to a crew,
        // and dispatch_notes.crew_id can never hold a person lane's id.
        techs: lane.technician
          ? [lane.technician]
          : technicians.filter(t => t.is_active && (lane.crew ? t.crew_id === lane.crew.id : t.crew_id === null)),
        vehicles: equipment.filter(e => (lane.crew ? e.crew_id === lane.crew.id : false)),
        note: lane.crew ? notes.find(n => n.crew_id === lane.laneId) ?? null : null,
      }
    }
    return out
  }, [lanes, technicians, equipment, notes])

  // The optimizer's own estimator, held against the current manual order — a
  // hint only when "Best order" would genuinely shorten the drive.
  const laneSavings = useMemo(() => {
    const out: Record<string, number> = {}
    if (!settings.base) return out
    for (const lane of lanes) {
      if (lane.laneId === UNASSIGNED_ID) continue
      const r = laneRoutes[lane.laneId]
      if (!r || r.seq.filter(j => j.status === 'scheduled').length < 3) continue
      out[lane.laneId] = bestOrderSavingsKm(settings.base, r.seq.map(jobStop), r.totalKm)
    }
    return out
  }, [lanes, laneRoutes, settings.base])

  // ── One derivation, three consumers ──────────────────────────────────────
  // These rows feed conflict detection, the KPI tiles AND the behind-schedule
  // reads, so the panel, the tiles and the lane meters can never disagree.
  // Facts about the FULL day — filters never hide a problem.
  const laneInputs: ConflictLaneInput[] = useMemo(() => lanes.map(lane => {
    const route = laneRoutes[lane.laneId]
    const etaByJob = new Map((route?.etas.stops ?? []).map(s => [s.jobId, s.arrivalMin]))
    // A person's lane is run by that one person. Without this the roster check
    // below would read "nobody on the crew" for a lane whose whole point is
    // that somebody was named.
    const laneTechs = lane.technician
      ? [lane.technician]
      : technicians.filter(t => t.is_active && (lane.crew ? t.crew_id === lane.crew.id : false))
    return {
      laneId: lane.laneId,
      laneName: laneLabel(lane),
      isUnassigned: lane.laneId === UNASSIGNED_ID,
      startMin: route?.etas.startMin ?? 0,
      finishMin: route?.etas.finishMin ?? 0,
      capacityMin: route?.capacityMin ?? 0,
      workMin: route?.workMin ?? 0,
      stops: (route?.seq ?? []).map(j => ({
        jobId: j.id,
        title: j.customers?.name || j.title,
        startTime: j.start_time,
        durMin: j.duration_minutes || DEFAULT_JOB_MIN,
        arrivalMin: etaByJob.get(j.id) ?? null,
        status: j.status,
      })),
      availableTechs: laneTechs.filter(t => t.status !== 'off').length,
      rosteredTechs: laneTechs.length,
      isPerson: !!lane.technician,
      // Somebody on a crew that is ALSO working today already has their workday
      // counted in that crew's lane. Their personal lane's work still counts;
      // a second day of capacity for one person would not.
      capacityCountedElsewhere: !!lane.technician?.crew_id &&
        lanes.some(l => l.crew?.id === lane.technician?.crew_id && l.jobs.some(j => j.status !== 'cancelled')),
    }
  }), [lanes, laneRoutes, technicians])

  const conflicts: DispatchConflict[] = useMemo(() => detectDayConflicts(
    laneInputs, { dayBlocked: !!dayRow?.blocks, activeCrewCount },
  ), [laneInputs, dayRow, activeCrewCount])

  const kpis = useMemo(() => dayKpis(laneInputs, nowMin), [laneInputs, nowMin])

  // Running-behind lanes as ConflictPanel rows — today only. The KPI tile said
  // "2 crews running behind" and each lane wore a chip, but the panel that
  // gathers "where intervention is needed" never listed them: the one condition
  // that most wants a human's eyes was the one the intervention list omitted.
  // Same engine (laneProgress) and the same ≥10/≥30-minute thresholds as the
  // lane chip, so the panel and the chip can never disagree.
  //
  // These rows are appended for the PANEL only. laneBadges stays on the
  // detected (plan-defect) conflicts: the lane already wears its own dedicated
  // "~Xm behind" chip, and counting the same fact into the triangle badge would
  // double-signal it on the very lane the owner is already looking at.
  const behindConflicts: DispatchConflict[] = useMemo(() => {
    if (nowMin == null) return []
    const out: DispatchConflict[] = []
    for (const lane of lanes) {
      if (lane.laneId === UNASSIGNED_ID) continue
      const route = laneRoutes[lane.laneId]
      if (!route || route.seq.length === 0) continue
      const etaByJob = new Map(route.etas.stops.map(s => [s.jobId, s.arrivalMin]))
      const p = laneProgress(nowMin, route.seq.map(j => ({
        jobId: j.id,
        arrivalMin: etaByJob.get(j.id) ?? null,
        durMin: j.duration_minutes || DEFAULT_JOB_MIN,
        status: j.status,
      })))
      if (p.behindMin >= 10) {
        out.push({
          kind: 'running_behind',
          severity: p.behindMin >= 30 ? 'error' : 'warn',
          laneId: lane.laneId,
          laneName: laneLabel(lane),
          jobId: p.nextJobId ?? undefined,
          message: `${laneLabel(lane)} is ~${p.behindMin}m behind their own ETAs — check in before the promises downstream slip.`,
        })
      }
    }
    return out
  }, [lanes, laneRoutes, nowMin])

  const panelConflicts = useMemo(() => [...conflicts, ...behindConflicts], [conflicts, behindConflicts])

  // Per-CREW spare minutes for the Move-to menu — the SAME laneLoad the capacity
  // meters draw, re-read (never recomputed) so the menu and the meter can't
  // disagree. Reassigning used to be a blind pick from a name list; which crew
  // had room lived in meters scattered across the other cards. Keyed by crew id
  // only: room comes from a crew's capacity row, and a person hasn't got one.
  const crewSpareMin = useMemo(() => {
    const out: Record<string, number> = {}
    for (const lane of lanes) {
      if (!lane.crew) continue
      const r = laneRoutes[lane.laneId]
      if (r) out[lane.laneId] = laneLoad(r.workMin, r.capacityMin).spareMin
    }
    return out
  }, [lanes, laneRoutes])

  const laneBadges = useMemo(() => {
    const out: Record<string, { count: number; severity: 'error' | 'warn' | 'info' } | null> = {}
    for (const lane of lanes) out[lane.laneId] = laneConflictSummary(conflicts, lane.laneId)
    return out
  }, [lanes, conflicts])

  // ── Filters (display only — the engines above never see them) ──
  const laneMatchesFilter = useCallback((lane: CrewLaneData): boolean => {
    if (filter.crewIds.length > 0 && !filter.crewIds.includes(lane.laneId)) return false
    if (filter.technicianId) {
      const t = technicians.find(x => x.id === filter.technicianId)
      if (!t) return false
      // Someone's day can sit in two lanes: their crew's, and their own for
      // visits assigned to them by name. Filtering to one of the two would hide
      // half of what they are actually expected to do today.
      const home = t.crew_id ?? UNASSIGNED_ID
      if (lane.laneId !== home && lane.laneId !== personLaneId(t.id)) return false
    }
    if (filter.vehicleId) {
      const v = equipment.find(x => x.id === filter.vehicleId)
      if (!v || (v.crew_id ?? UNASSIGNED_ID) !== lane.laneId) return false
    }
    return true
  }, [filter, technicians, equipment])

  const visibleLanes = useMemo(() => lanes.filter(laneMatchesFilter), [lanes, laneMatchesFilter])
  const statusVisible = useCallback((j: Job) =>
    filter.statuses.length === 0 || filter.statuses.includes(j.status as JobStatus), [filter.statuses])

  // ── Bulk selection (over what's visible, in board order) ──
  const selectableJobs = useMemo(() =>
    visibleLanes.flatMap(l => (laneRoutes[l.laneId]?.seq ?? []).filter(statusVisible)),
  [visibleLanes, laneRoutes, statusVisible])
  const bulk = useBulkSelect(selectableJobs)

  // ── Actions ──
  // Write a lane's visit order as route_order 1..n (serialized, optimistic).
  const applyLaneOrder = useCallback((laneJobIds: string[]) => {
    setJobs(cur => {
      const pos = new Map(laneJobIds.map((id, i) => [id, i + 1]))
      return cur.map(j => pos.has(j.id) ? { ...j, route_order: pos.get(j.id)! } : j)
    })
    orderWrite.current = orderWrite.current.then(() =>
      Promise.all(laneJobIds.map((id, i) => supabase.from('jobs').update({ route_order: i + 1 }).eq('id', id))),
    ).then((results) => {
      const failed = (results as { error: { message: string } | null }[]).find(r => r.error)
      if (failed?.error) { notify.error('Could not save the order: ' + failed.error.message); fetchAll() }
    })
  }, [supabase, fetchAll])

  // Move one visit to a crew, to one person, or to nobody. `beforeJobId` places
  // it at a specific slot in the target lane (undefined = end, the legacy
  // behaviour). `silent` suppresses ONLY the success toast+undo — for the Escape
  // put-back, which is itself a cancellation: announcing "→ Green crew · Undo"
  // for undoing reads as a new move that now wants undoing in turn. Errors always
  // toast, and every real move (drag, arrows, menu) stays loud with its undo.
  const moveJob = useCallback(async (jobId: string, to: Assignee, beforeJobId?: string | null, opts?: { silent?: boolean }) => {
    const job = jobs.find(j => j.id === jobId)
    if (!job || sameAssignee(assigneeOf(job), to)) return
    // BOTH columns, in the snapshot as in the write: a visit that was one
    // person's must be restorable to them, and crew_id alone would put it back
    // as nobody's.
    const prev = { crew_id: job.crew_id ?? null, technician_id: job.technician_id ?? null, route_order: job.route_order ?? null }
    setJobs(cur => cur.map(j => j.id === jobId ? { ...j, ...assigneeColumns(to), route_order: null } : j))
    const err = await assignJob(supabase, jobId, to)
    if (err) {
      setJobs(cur => cur.map(j => j.id === jobId ? { ...j, ...prev } : j))
      notify.error('Could not move the job: ' + err)
      return
    }
    if (beforeJobId !== undefined) {
      const targetLane = laneIdOfAssignee(to)
      const rest = (laneRoutesRef.current[targetLane]?.seq ?? []).map(j => j.id).filter(id => id !== jobId)
      const at = beforeJobId ? rest.indexOf(beforeJobId) : -1
      const next = at >= 0 ? [...rest.slice(0, at), jobId, ...rest.slice(at)] : [...rest, jobId]
      applyLaneOrder(next)
    }
    if (opts?.silent) return
    notify(`${job.customers?.name || job.title} → ${assigneeName(to)}`, {
      // Branch on the write: a failed put-back that stays silent leaves the job
      // on the wrong crew while the owner walks away believing it's home. (Same
      // contract verify:undo-contract enforces — these `undo:` option callbacks
      // are the one shape its `.undo(` scan can't see.)
      undo: async () => {
        const { error } = await supabase.from('jobs').update(prev).eq('id', jobId)
        if (error) notify.error(`Could not put ${job.customers?.name || job.title} back: ${error.message}`)
        fetchAll()
      },
    })
  }, [jobs, supabase, fetchAll, applyLaneOrder, assigneeName])

  // Reorder within a lane: place the dragged visit before `anchorId` (null = end).
  const reorderWithinLane = useCallback((laneId: string, jobId: string, anchorId: string | null) => {
    const seq = (laneRoutesRef.current[laneId]?.seq ?? []).map(j => j.id)
    const rest = seq.filter(id => id !== jobId)
    const at = anchorId ? rest.indexOf(anchorId) : -1
    const next = at >= 0 ? [...rest.slice(0, at), jobId, ...rest.slice(at)] : [...rest, jobId]
    if (next.join() === seq.join()) return
    applyLaneOrder(next)
  }, [applyLaneOrder])

  // Nudges hop the adjacent VISIBLE neighbour (lib/dispatchOps.nudgeAcrossVisible)
  // — with a status filter on, the full-sequence neighbour can be a hidden row,
  // and swapping with it persisted a real route_order change that looked like the
  // button did nothing. No filter → identical to the old adjacent swap.
  const nudgeJob = useCallback((laneId: string, jobId: string, dir: -1 | 1) => {
    const lane = laneRoutes[laneId]?.seq ?? []
    const next = nudgeAcrossVisible(
      lane.map(j => j.id),
      lane.filter(statusVisible).map(j => j.id),
      jobId, dir,
    )
    if (next) applyLaneOrder(next)
  }, [laneRoutes, statusVisible, applyLaneOrder])

  // Per-lane route optimization: the SAME optimizeRoute (real-road first,
  // haversine fallback) the schedule uses, persisted as this lane's order.
  const bestOrderLane = useCallback(async (laneId: string, opts?: { quiet?: boolean }) => {
    const route = laneRoutesRef.current[laneId]
    if (!route || !settings.base) return
    setOptimizingLane(laneId)
    try {
      const stops = route.seq.map(jobStop)
      await geocodeMissingStops(supabase, stops)
      const r = await optimizeRoute(settings.base, stops)
      if (r.ordered.length === 0) { if (!opts?.quiet) notify('No located stops to order in this lane.'); return }
      const orderedIds = r.ordered.map(s => s.jobId)
      const rest = route.seq.map(j => j.id).filter(id => !orderedIds.includes(id))
      // Membership is re-read AFTER the awaits (geocode + a real network round-trip
      // to the optimizer). The snapshot above is from before them: a job dragged to
      // another crew mid-optimize would still be in it, and applyLaneOrder's per-id
      // writes carry no lane guard — the stale write would stamp a foreign lane's
      // route_order onto it, injecting it mid-sequence over there. Jobs that LEFT
      // are dropped; jobs that ARRIVED during the optimize keep their slot (nulls
      // sort last, so they land at the end until the next optimize).
      const nowInLane = new Set((laneRoutesRef.current[laneId]?.seq ?? []).map(j => j.id))
      const idsAfter = [...orderedIds, ...rest].filter(id => nowInLane.has(id))
      if (idsAfter.length === 0) { if (!opts?.quiet) notify('This lane changed while ordering — nothing to apply.'); return }
      applyLaneOrder(idsAfter)
      if (!opts?.quiet) {
        // Say what actually changed — the after picture run through the SAME
        // engines (sequenceRoute → computeDayEtas), so both sides of the arrow
        // use one estimator and the toast can't overpromise.
        const after = sequenceRoute(settings.base, stops, idsAfter)
        const durations = Object.fromEntries(route.seq.map(j => [j.id, j.duration_minutes || DEFAULT_JOB_MIN]))
        const afterEtas = computeDayEtas(route.startHHmm, after.ordered, durations)
        const kmPart = route.totalKm > 0 && after.totalKm < route.totalKm
          ? `${route.totalKm} → ${after.totalKm} km`
          : `~${after.totalKm} km`
        const wrapPart = afterEtas.finishMin < route.etas.finishMin
          ? ` · wraps ${route.etas.finish} → ${afterEtas.finish}`
          : ''
        notify.success(`Route ordered${r.usedGoogle ? ' by road' : ''} — ${kmPart}${wrapPart}${rest.length ? ` · ${rest.length} without an address kept at the end` : ''}`)
      }
    } finally {
      setOptimizingLane(null)
    }
  }, [settings.base, supabase, applyLaneOrder])

  // What Balance is allowed to see. Balancing is a CREW capacity tool: person
  // lanes never enter it, and a visit given to somebody by name never leaves —
  // that assignment is a deliberate choice by the owner, not slack to even out.
  // (The database keeps personal assignments off crew lanes, so the job filter
  // only bites on Unassigned, where a visit whose person left the roster lands.)
  const balanceLanes = useCallback(() => lanes
    .filter(lane => !lane.technician)
    .map(lane => ({
      laneId: lane.laneId,
      jobs: lane.jobs.filter(j => !j.technician_id),
      capacityMin: laneRoutes[lane.laneId]?.capacityMin ?? 0,
    })), [lanes, laneRoutes])

  const openBalance = useCallback(() => {
    setBalancePlan(balanceDay(balanceLanes()))
  }, [balanceLanes])

  const applyBalance = useCallback(async () => {
    if (!balancePlan || balancePlan.moves.length === 0) { setBalancePlan(null); return }
    setApplyingBalance(true)
    const snapshot = balancePlan.moves.map(m => {
      const j = jobs.find(x => x.id === m.jobId)
      return { id: m.jobId, crew_id: j?.crew_id ?? null, technician_id: j?.technician_id ?? null, route_order: j?.route_order ?? null }
    })
    // THE assignment writer rather than a hand-rolled update: it writes both
    // columns, so a balanced move can never leave a second answer behind.
    const errs = (await Promise.all(balancePlan.moves.map(m =>
      assignJob(supabase, m.jobId, assigneeOfLane(m.toLaneId)),
    ))).filter(Boolean)
    setApplyingBalance(false)
    setBalancePlan(null)
    if (errs.length > 0) { notify.error('Some moves failed: ' + errs[0]); fetchAll(); return }
    fetchAll()
    notify(`Balanced — ${balancePlan.moves.length} visit${balancePlan.moves.length !== 1 ? 's' : ''} moved.`, {
      undo: async () => {
        const rs = await Promise.all(snapshot.map(s => supabase.from('jobs').update({ crew_id: s.crew_id, technician_id: s.technician_id, route_order: s.route_order }).eq('id', s.id)))
        const bad = rs.filter(r => r.error).length
        if (bad) notify.error(`${bad} visit${bad !== 1 ? 's' : ''} could not be put back — check the board.`)
        fetchAll()
      },
    })
  }, [balancePlan, jobs, supabase, fetchAll])

  // ── Bulk actions (act on the current selection, then say what happened) ──
  const bulkAssign = useCallback(async (to: Assignee) => {
    const targets = bulk.selectedItems.filter(j => !sameAssignee(assigneeOf(j), to))
    if (targets.length === 0) { setAssignPickOpen(false); bulk.clear(); return }
    setBulkBusy(to.kind === 'unassigned' ? 'unassign' : 'assign')
    const snapshot = targets.map(j => ({ id: j.id, crew_id: j.crew_id ?? null, technician_id: j.technician_id ?? null, route_order: j.route_order ?? null }))
    setJobs(cur => cur.map(j => targets.some(t => t.id === j.id) ? { ...j, ...assigneeColumns(to), route_order: null } : j))
    const errs = (await Promise.all(targets.map(t => assignJob(supabase, t.id, to)))).filter(Boolean)
    setBulkBusy(null)
    setAssignPickOpen(false)
    bulk.clear()
    if (errs.length > 0) { notify.error(`${errs.length} move${errs.length !== 1 ? 's' : ''} failed: ` + errs[0]); fetchAll(); return }
    notify(`${targets.length} visit${targets.length !== 1 ? 's' : ''} → ${assigneeName(to)}`, {
      undo: async () => {
        const rs = await Promise.all(snapshot.map(s => supabase.from('jobs').update({ crew_id: s.crew_id, technician_id: s.technician_id, route_order: s.route_order }).eq('id', s.id)))
        const bad = rs.filter(r => r.error).length
        if (bad) notify.error(`${bad} visit${bad !== 1 ? 's' : ''} could not be put back — check the board.`)
        fetchAll()
      },
    })
  }, [bulk, supabase, fetchAll, assigneeName])

  const bulkOptimize = useCallback(async () => {
    // "Optimize selected" = re-run each touched lane through the ONE optimizer.
    // A lane's ETAs interlock, so ordering a subset in isolation would lie.
    const laneIds = [...new Set(bulk.selectedItems.map(laneIdOf))]
      .filter(id => (laneRoutesRef.current[id]?.seq.filter(j => j.status === 'scheduled').length ?? 0) >= 2)
    if (laneIds.length === 0) { notify('Nothing to optimize — the selected lanes have fewer than 2 open stops.'); return }
    setBulkBusy('optimize')
    for (const id of laneIds) await bestOrderLane(id, { quiet: true })
    setBulkBusy(null)
    notify.success(`Best order applied to ${laneIds.map(laneNameOf).join(', ')}.`)
  }, [bulk.selectedItems, bestOrderLane, laneIdOf, laneNameOf])

  const reschedulable = useMemo(() => bulk.selectedItems.filter(j => j.status === 'scheduled'), [bulk.selectedItems])

  const bulkReschedule = useCallback(async (toDate: string, opts: { notify: boolean; reason: DisruptionReason }) => {
    if (reschedulable.length === 0) { setReschedOpen(false); return }
    setBulkBusy('reschedule')
    const snapshot = reschedulable.map(j => ({ id: j.id, scheduled_date: j.scheduled_date, route_order: j.route_order ?? null }))
    const results = await Promise.all(reschedulable.map(j =>
      supabase.from('jobs').update({ scheduled_date: toDate, route_order: null }).eq('id', j.id),
    ))
    const failed = results.filter(r => r.error).length
    let notified = 0
    if (opts.notify && failed === 0) {
      // The EXISTING reschedule seam: opt-in gated per customer, idempotent, logged.
      const notices = reschedulable.filter(j => j.customers?.id).map(j => ({
        customerId: j.customers!.id, toDate, fromDate: date, reason: opts.reason, jobId: j.id,
      }))
      notified = (await notifyRescheduleBatch(notices)).filter(r => r.ok).length
    }
    setBulkBusy(null)
    setReschedOpen(false)
    const skipped = bulk.count - reschedulable.length
    bulk.clear()
    fetchAll()
    if (failed > 0) { notify.error(`${failed} visit${failed !== 1 ? 's' : ''} could not be moved.`); return }
    const dateLabel = format(parseISO(toDate + 'T00:00:00'), 'EEE, MMM d')
    notify(
      `${reschedulable.length} visit${reschedulable.length !== 1 ? 's' : ''} → ${dateLabel}` +
      (notified > 0 ? ` · ${notified} customer${notified !== 1 ? 's' : ''} notified` : '') +
      (skipped > 0 ? ` · ${skipped} in-progress/done left alone` : ''),
      {
        undo: async () => {
          const rs = await Promise.all(snapshot.map(s => supabase.from('jobs').update({ scheduled_date: s.scheduled_date, route_order: s.route_order }).eq('id', s.id)))
          const bad = rs.filter(r => r.error).length
          fetchAll()
          if (bad) { notify.error(`${bad} visit${bad !== 1 ? 's' : ''} could not be moved back — check the board.`); return }
          if (notified > 0) notify('Dates restored — the notices already sent can’t be recalled.')
        },
      },
    )
  }, [reschedulable, bulk, supabase, date, fetchAll])

  // ── The daily sheet (ONE derivation → CSV and print read the same rows) ──
  const buildSheet = useCallback((onlyIds?: Set<string>): DispatchSheet => {
    const sheetLanes: SheetLane[] = lanes.map(lane => {
      const route = laneRoutes[lane.laneId]
      if (!route) return null
      const etaByJob = new Map(route.etas.stops.map(s => [s.jobId, s.arrival]))
      const orderByJob = new Map(route.seq.map((j, i) => [j.id, i + 1]))
      const included = route.seq.filter(j => !onlyIds || onlyIds.has(j.id))
      if (included.length === 0) return null
      const stats = laneStats(route.etas.startMin, route.etas.finishMin, route.workMin, route.capacityMin)
      return {
        name: laneLabel(lane),
        hex: lane.palette.hex,
        // A person's sheet is headed by the one name on it; the crew note and
        // the vehicles stay crew facts (see laneAux).
        techs: lane.technician
          ? [lane.technician.name]
          : technicians.filter(t => t.is_active && (lane.crew ? t.crew_id === lane.crew.id : t.crew_id === null)).map(t => t.name),
        vehicles: equipment.filter(e => lane.crew ? e.crew_id === lane.crew.id : false).map(e => e.name),
        note: lane.crew ? notes.find(n => n.crew_id === lane.laneId)?.body ?? null : null,
        startLabel: minutesToTime12(route.etas.startMin),
        finishLabel: route.seq.length > 0 ? route.etas.finish : null,
        driveMin: stats.driveMin,
        workMin: stats.workMin,
        stops: included.map(j => ({
          order: orderByJob.get(j.id) ?? 0,
          eta: etaByJob.get(j.id) ?? null,
          promised: j.start_time ? minutesToTime12(timeToMinutes(j.start_time)) : null,
          customer: j.customers?.name || j.title,
          address: j.properties?.address || '',
          phone: j.customers?.phone || '',
          service: j.service_type || '',
          durMin: j.duration_minutes || DEFAULT_JOB_MIN,
          status: JOB_STATUS_LABELS[j.status] ?? j.status,
        })),
      }
    }).filter((l): l is SheetLane => l !== null)
    return {
      dateISO: date,
      dateLabel: format(parseISO(date + 'T00:00:00'), 'EEEE, MMM d, yyyy'),
      dayNote: notes.find(n => n.crew_id === null)?.body ?? null,
      lanes: sheetLanes,
    }
  }, [lanes, laneRoutes, technicians, equipment, notes, date])

  const printDay = useCallback(() => {
    const sheet = buildSheet()
    if (sheet.lanes.length === 0) { notify('Nothing scheduled to print.'); return }
    if (!openPrintSheet(sheet)) notify.error('The print window was blocked — allow pop-ups for this site.')
  }, [buildSheet])

  const exportDayCsv = useCallback((onlyIds?: Set<string>) => {
    const sheet = buildSheet(onlyIds)
    const rows = sheetCsvRows(sheet)
    if (rows.length === 0) { notify('Nothing to export.'); return }
    exportRowsToCsv(`dispatch-${date}`, rows, SHEET_CSV_COLUMNS)
  }, [buildSheet, date])

  // ── Cross-lane drag (pointer events — the Calendar's touch-safe engine) ──
  // The ghost follows the pointer via a direct style write on an always-mounted
  // element — 60fps with ZERO re-renders per move. React state only changes when
  // the drop target (lane / insertion slot) changes, which is what the board
  // actually needs to redraw. Hit-testing is rAF-throttled; dragging near the
  // viewport edge auto-scrolls the page; Escape abandons the drag.
  const dragRef = useRef<{
    jobId: string; fromLane: string; title: string; started: boolean
    sx: number; sy: number; lastX: number; lastY: number
    scrollDir: -1 | 0 | 1; hitRaf: number | null; scrollRaf: number | null
  } | null>(null)
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState<{ jobId: string; title: string; durMin: number } | null>(null)
  const [overLane, setOverLane] = useState<string | null>(null)
  const [overAnchor, setOverAnchor] = useState<string | null>(null)   // insert BEFORE this stop (null = end)
  const overRef = useRef<{ lane: string | null; anchor: string | null }>({ lane: null, anchor: null })

  // Where would a drop land? The first non-dragged stop row whose midpoint is
  // below the pointer — insertion happens before it (none → end of lane).
  const dropAnchorAt = useCallback((laneEl: HTMLElement, y: number, draggedId: string): string | null => {
    const rows = Array.from(laneEl.querySelectorAll<HTMLElement>('[data-stop-row]'))
    for (const row of rows) {
      if (row.dataset.stopRow === draggedId) continue
      const r = row.getBoundingClientRect()
      if (y < r.top + r.height / 2) return row.dataset.stopRow ?? null
    }
    return null
  }, [])

  const onDragHandleDown = useCallback((e: React.PointerEvent, job: Job, laneId: string) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    dragRef.current = {
      jobId: job.id, fromLane: laneId, title: job.customers?.name || job.title, started: false,
      sx: e.clientX, sy: e.clientY, lastX: e.clientX, lastY: e.clientY,
      scrollDir: 0, hitRaf: null, scrollRaf: null,
    }

    const positionGhost = (x: number, y: number) => {
      if (ghostRef.current) ghostRef.current.style.transform = `translate(${x}px, ${y - 8}px)`
    }

    const hitTest = () => {
      const d = dragRef.current
      if (!d?.started) return
      const laneEl = document.elementFromPoint(d.lastX, d.lastY)?.closest('[data-lane]') as HTMLElement | null
      const lane = laneEl?.dataset.lane ?? null
      const anchor = laneEl ? dropAnchorAt(laneEl, d.lastY, d.jobId) : null
      if (lane !== overRef.current.lane) { overRef.current.lane = lane; setOverLane(lane) }
      if (anchor !== overRef.current.anchor) { overRef.current.anchor = anchor; setOverAnchor(anchor) }
    }
    const scheduleHitTest = () => {
      const d = dragRef.current
      if (!d || d.hitRaf != null) return
      d.hitRaf = requestAnimationFrame(() => { if (dragRef.current) dragRef.current.hitRaf = null; hitTest() })
    }

    // Auto-scroll while the pointer parks near the top/bottom edge — the drop
    // target three lanes down must be reachable without letting go. The board
    // lives in the dashboard's own scroll container (not the window), so find
    // the actual scroller from the grip.
    const scroller = ((): HTMLElement => {
      let el: HTMLElement | null = e.currentTarget as HTMLElement
      while (el) {
        const s = getComputedStyle(el)
        if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight) return el
        el = el.parentElement
      }
      return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
    })()
    const srect = scroller.getBoundingClientRect()
    const edgeTop = Math.max(srect.top, 0) + 88
    const edgeBottom = Math.min(srect.bottom, window.innerHeight) - 88
    const scrollStep = () => {
      const d = dragRef.current
      if (!d) return
      if (d.started && d.scrollDir !== 0) {
        scroller.scrollBy(0, d.scrollDir * 14)
        hitTest()   // content moved under a stationary pointer
      }
      d.scrollRaf = requestAnimationFrame(scrollStep)
    }

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      if (!d.started) {
        if (Math.abs(ev.clientX - d.sx) + Math.abs(ev.clientY - d.sy) < 6) return
        d.started = true
        setDragging({ jobId: d.jobId, title: d.title, durMin: job.duration_minutes || DEFAULT_JOB_MIN })
        d.scrollRaf = requestAnimationFrame(scrollStep)
      }
      ev.preventDefault()
      d.lastX = ev.clientX; d.lastY = ev.clientY
      positionGhost(ev.clientX, ev.clientY)
      d.scrollDir = ev.clientY < edgeTop ? -1 : ev.clientY > edgeBottom ? 1 : 0
      scheduleHitTest()
    }

    const cleanup = () => {
      const d = dragRef.current
      if (d?.hitRaf != null) cancelAnimationFrame(d.hitRaf)
      if (d?.scrollRaf != null) cancelAnimationFrame(d.scrollRaf)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('keydown', onKey)
      dragRef.current = null
      overRef.current = { lane: null, anchor: null }
      setDragging(null); setOverLane(null); setOverAnchor(null)
    }

    const finish = (ev: PointerEvent) => {
      const d = dragRef.current
      if (d?.started && ev.type === 'pointerup') {
        const laneEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-lane]') as HTMLElement | null
        const target = laneEl?.dataset.lane
        if (target && laneEl) {
          const anchor = dropAnchorAt(laneEl, ev.clientY, d.jobId)
          if (target === d.fromLane) {
            reorderWithinLane(target, d.jobId, anchor)
          } else {
            // The lane you dropped on IS the assignment — a crew, a person, or
            // nobody.
            moveJob(d.jobId, assigneeOfLane(target), anchor)
          }
        }
      }
      cleanup()
    }

    // Escape abandons the drag — nothing moves, nothing is written.
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { ev.preventDefault(); cleanup() }
    }

    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('keydown', onKey)
  }, [moveJob, reorderWithinLane, dropAnchorAt])

  // ── Keyboard moves (grab → arrows → drop/cancel), announced politely ──
  const refocusGrip = useCallback((jobId: string) => {
    requestAnimationFrame(() => document.getElementById(`dispatch-grip-${jobId}`)?.focus())
  }, [])

  const onGripKeyDown = useCallback((e: React.KeyboardEvent, job: Job, laneId: string) => {
    const grabbed = kbGrab?.jobId === job.id
    const title = job.customers?.name || job.title
    if (!grabbed && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      setKbGrab({ jobId: job.id, homeLaneId: laneId, homeAssignee: assigneeOf(job), homeOrder: (laneRoutes[laneId]?.seq ?? []).map(j => j.id) })
      setAnnounce(`${title} grabbed. Up and down reorder it, left and right move it between crews and people, Enter drops it, Escape puts it back.`)
      return
    }
    if (!grabbed) return
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      nudgeJob(laneId, job.id, e.key === 'ArrowUp' ? -1 : 1)
      setAnnounce(`${title} moved ${e.key === 'ArrowUp' ? 'earlier' : 'later'}.`)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const idx = visibleLanes.findIndex(l => l.laneId === laneId)
      const next = visibleLanes[idx + (e.key === 'ArrowLeft' ? -1 : 1)]
      if (!next) return
      moveJob(job.id, assigneeOfLane(next.laneId), null)
      setAnnounce(`${title} moved to ${laneLabel(next)}.`)
      refocusGrip(job.id)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setKbGrab(null)
      setAnnounce(`${title} dropped.`)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      const g = kbGrab
      if (!g) return
      setKbGrab(null)
      ;(async () => {
        // silent: the put-back IS the cancellation — a "→ crew · Undo" toast for
        // it would offer to undo an undo. The aria announcement carries the news.
        if (!sameAssignee(assigneeOf(job), g.homeAssignee)) await moveJob(job.id, g.homeAssignee, null, { silent: true })
        applyLaneOrder(g.homeOrder)
        setAnnounce(`${title} put back.`)
        refocusGrip(job.id)
      })()
    }
  }, [kbGrab, laneRoutes, visibleLanes, nudgeJob, moveJob, applyLaneOrder, refocusGrip])

  // Jump from the conflict panel to the lane/stop it names, revealing it if a
  // filter had it hidden. Conflicts outrank filters.
  const jumpTo = useCallback((laneId: string, jobId?: string) => {
    const laneHidden = !visibleLanes.some(l => l.laneId === laneId)
    const job = jobId ? jobs.find(j => j.id === jobId) : null
    const stopHidden = job ? !statusVisible(job) : false
    if (laneHidden || stopHidden) setFilter(EMPTY_DISPATCH_FILTER)
    requestAnimationFrame(() => {
      const el = document.getElementById(jobId ? `dispatch-stop-${jobId}` : `dispatch-lane-${laneId}`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      if (jobId) {
        setFlashJobId(jobId)
        if (flashTimer.current) clearTimeout(flashTimer.current)
        flashTimer.current = setTimeout(() => setFlashJobId(cur => cur === jobId ? null : cur), 1800)
      }
    })
  }, [visibleLanes, jobs, statusVisible])

  // A map pin is a question about a stop — the board card is the answer.
  const mapSelectStop = useCallback((jobId: string) => {
    const j = jobs.find(x => x.id === jobId)
    if (!j) return
    setView('board')
    jumpTo(laneIdOf(j), jobId)
  }, [jobs, laneIdOf, jumpTo])

  // If the grabbed visit leaves the day (realtime, another session, a filter on
  // a deleted job), release the keyboard grab instead of steering a phantom.
  useEffect(() => {
    if (kbGrab && !jobs.some(j => j.id === kbGrab.jobId)) {
      setKbGrab(null)
      setAnnounce('That visit is no longer on this day.')
    }
  }, [jobs, kbGrab])

  // ── Page shortcuts (same guards as the list idiom: never while typing,
  // never with a modifier, never when a dialog owns the keyboard) ──
  const printDayRef = useRef<() => void>(() => {})
  printDayRef.current = printDay
  const kbBusyRef = useRef(false)
  kbBusyRef.current = kbGrab != null
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (document.querySelector('[role="dialog"]')) return
      if (kbBusyRef.current || dragRef.current) return   // a grabbed/dragged visit owns the keys
      // Which stop's grip currently holds focus (the roving cursor for x/s).
      const gripId = (): string | null => {
        const a = document.activeElement as HTMLElement | null
        return a?.id?.startsWith('dispatch-grip-') ? a.id.slice('dispatch-grip-'.length) : null
      }
      switch (e.key) {
        case '[': setDate(d => format(addDays(parseISO(d + 'T00:00:00'), -1), 'yyyy-MM-dd')); break
        case ']': setDate(d => format(addDays(parseISO(d + 'T00:00:00'), 1), 'yyyy-MM-dd')); break
        case 't': case 'T': setDate(todayISO()); break
        case 'b': case 'B': setView('board'); break
        case 'm': case 'M': setView('map'); break
        case 'p': case 'P': printDayRef.current(); break
        case '?': setShortcutsOpen(true); break
        case 'j': case 'J': case 'k': case 'K': {
          const ids = kbApiRef.current.ids
          if (ids.length === 0) return
          const cur = gripId() ? ids.indexOf(gripId()!) : -1
          const down = e.key === 'j' || e.key === 'J'
          const next = cur === -1 ? 0 : Math.max(0, Math.min(ids.length - 1, cur + (down ? 1 : -1)))
          const el = document.getElementById(`dispatch-grip-${ids[next]}`)
          el?.focus()
          el?.scrollIntoView({ block: 'nearest' })
          break
        }
        case 'x': case 'X': {
          const id = gripId()
          if (!id) return
          kbApiRef.current.toggle(id, e.shiftKey)
          break
        }
        case 's': case 'S': {
          const id = gripId()
          if (!id) return
          kbApiRef.current.advance(id)
          break
        }
        default: return
      }
      e.preventDefault()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Would dropping the dragged visit here overbook whoever receives it? Same
  // numbers as the capacity meter — the ring just says it before the drop.
  const dropWouldOverload = useMemo(() => {
    if (!dragging || !overLane || overLane === UNASSIGNED_ID) return false
    const j = jobs.find(x => x.id === dragging.jobId)
    const fromLane = j ? laneIdOf(j) : UNASSIGNED_ID
    if (fromLane === overLane) return false
    const r = laneRoutes[overLane]
    if (!r || r.capacityMin <= 0) return false
    return r.workMin + dragging.durMin > r.capacityMin
  }, [dragging, overLane, jobs, laneIdOf, laneRoutes])

  // Stable handlers so the memo()'d lane cards only re-render on real changes.
  const setTechStatusStable = useCallback(async (t: Technician, status: TechnicianStatus) => {
    const err = await setTechnicianStatus(supabase, t.id, status)
    if (err) notify.error('Could not update status: ' + err); else fetchAll()
  }, [supabase, fetchAll])

  // Returns the failure (null = it landed) so NoteBox can only claim "Saved" once
  // the row is actually written — see NoteBox's header.
  const saveLaneNote = useCallback(async (laneId: string, body: string): Promise<string | null> => {
    if (!uid) return 'not signed in'
    const err = await saveDispatchNote(supabase, uid, date, laneId === UNASSIGNED_ID ? null : laneId, body)
    if (err) { notify.error('Could not save the note: ' + err); return err }
    fetchAll()
    return null
  }, [uid, supabase, date, fetchAll])

  // ── One-tap visit status (▶ start / ✓ complete) through THE shared seam ──
  // lib/jobStatus composes the same op kinds the offline queue replays, so a
  // tap here means exactly what it means on the calendar: complete = patch +
  // draft invoice + (opt-in, deduped) customer message.
  const setJobBusy = useCallback((id: string, on: boolean) => {
    setStatusBusy(prev => {
      const n = new Set(prev)
      if (on) n.add(id); else n.delete(id)
      return n
    })
  }, [])

  const quickStart = useCallback(async (job: Job) => {
    setJobBusy(job.id, true)
    const res = await startVisit(supabase, job)
    setJobBusy(job.id, false)
    if (!res.ok) { notify.error('Could not start the visit: ' + res.error); return }
    setJobs(cur => cur.map(j => j.id === job.id ? { ...j, ...res.patch } : j))
    if (res.outcome === 'ran') fetchAll()
    notify(`${job.customers?.name || job.title} started${res.outcome === 'queued' ? ' — will sync' : ''}`, {
      undo: async () => {
        setJobs(cur => cur.map(j => j.id === job.id ? { ...j, ...res.prev } : j))
        // revertVisit queues offline (that path is its own honesty mechanism);
        // an ONLINE failure throws, and swallowing it would leave the optimistic
        // repaint above lying about a start that is still stamped.
        try { await revertVisit(supabase, job.id, res.prev, `Undo start ${job.title || 'job'}`, { baseUpdatedAt: job.updated_at }) }
        catch (e) { notify.error('Could not undo the start: ' + (e instanceof Error ? e.message : 'write failed')) }
        fetchAll()
      },
    })
  }, [supabase, fetchAll, setJobBusy])

  const quickComplete = useCallback(async (job: Job) => {
    setJobBusy(job.id, true)
    const res = await completeVisit(supabase, job, { notify: automations.job_complete })
    setJobBusy(job.id, false)
    if (!res.ok) {
      // The completion gate's refusal is instructions, not an error message —
      // show the checklist sentence, and where to finish it.
      const gate = checklistBlockMessage(res.error)
      notify.error(gate
        ? `${job.customers?.name || job.title} — ${gate} (open its Record sheet to fill the checklist)`
        : 'Could not complete the visit: ' + res.error)
      return
    }
    setJobs(cur => cur.map(j => j.id === job.id ? { ...j, ...res.patch } : j))
    if (res.outcome === 'ran') fetchAll()
    const invoiceCreated = res.invoice?.created === true
    // Undo mirrors the schedule's: revert the fields AND remove the draft this
    // completion just created — never leave a bill for work marked not-done.
    const undo = async () => {
      setJobs(cur => cur.map(j => j.id === job.id ? { ...j, ...res.prev } : j))
      await revertVisit(supabase, job.id, res.prev, `Undo complete ${job.title || 'job'}`, {
        baseUpdatedAt: job.updated_at, deleteDraftInvoice: invoiceCreated,
      })
      fetchAll()
    }
    if (res.outcome === 'queued') notify('Completed offline — it’ll sync and draft the invoice when you’re back in signal.', { undo })
    else if (invoiceCreated) notify(`${job.customers?.name || job.title} done — draft invoice ${res.invoice!.invoiceNumber} created.`, { undo })
    else if (res.invoice?.reason === 'no-amount') notify('Done — no invoice drafted because this visit has no price.', { undo })
    else if (res.invoice?.reason === 'error') notify.error('Completed, but the draft invoice failed — invoice it manually from the job.')
    else notify(`${job.customers?.name || job.title} done.`, { undo })
  }, [supabase, fetchAll, setJobBusy, automations.job_complete])

  // Bulk complete — the end-of-day sweep. Sequential on purpose: each visit
  // runs the FULL completion (invoice + message), same as tapping them one by
  // one, and the invoice/comms seams de-dupe so a retry can't double anything.
  const bulkComplete = useCallback(async () => {
    const targets = bulk.selectedItems.filter(j => j.status === 'scheduled' || j.status === 'in_progress')
    if (targets.length === 0) return
    setBulkBusy('complete')
    let doneN = 0, invoices = 0, failed = 0
    const reverts: { id: string; prev: Partial<Job>; base: string; draft: boolean }[] = []
    for (const job of targets) {
      const res = await completeVisit(supabase, job, { notify: automations.job_complete })
      if (!res.ok) { failed++; continue }
      doneN++
      if (res.invoice?.created) invoices++
      reverts.push({ id: job.id, prev: res.prev, base: job.updated_at, draft: res.invoice?.created === true })
      setJobs(cur => cur.map(j => j.id === job.id ? { ...j, ...res.patch } : j))
    }
    setBulkBusy(null)
    bulk.clear()
    fetchAll()
    if (failed > 0) notify.error(`${failed} visit${failed !== 1 ? 's' : ''} could not be completed.`)
    if (doneN > 0) notify(`${doneN} visit${doneN !== 1 ? 's' : ''} completed${invoices > 0 ? ` · ${invoices} draft invoice${invoices !== 1 ? 's' : ''}` : ''}`, {
      undo: async () => {
        let bad = 0
        for (const r of reverts) {
          try { await revertVisit(supabase, r.id, r.prev, 'Undo bulk complete', { baseUpdatedAt: r.base, deleteDraftInvoice: r.draft }) }
          catch { bad++ }
        }
        if (bad) notify.error(`${bad} visit${bad !== 1 ? 's' : ''} could not be un-completed — check the board.`)
        fetchAll()
      },
    })
  }, [bulk, supabase, fetchAll, automations.job_complete])

  // ── Smarter conflict remedies, computed by the engines that own them ──
  // Overloaded lane → the FIRST move the balance planner would make out of it.
  const overloadMoves = useMemo(() => {
    if (!conflicts.some(c => c.kind === 'overloaded')) return {} as Record<string, BalancePlan['moves'][number]>
    const plan = balanceDay(balanceLanes())
    const byLane: Record<string, BalancePlan['moves'][number]> = {}
    for (const m of plan.moves) if (!byLane[m.fromLaneId]) byLane[m.fromLaneId] = m
    return byLane
  }, [conflicts, balanceLanes])

  // Late promise → the timed visits swapped into promise order within their
  // current slots, accepted only if the ETA chain says it actually helps.
  const promiseFixes = useMemo(() => {
    const out: Record<string, PromiseOrderSuggestion> = {}
    for (const laneId of new Set(conflicts.filter(c => c.kind === 'late_arrival').map(c => c.laneId))) {
      const route = laneRoutes[laneId]
      if (!route) continue
      const promises: Record<string, number> = {}
      for (const j of route.seq) if (j.start_time) promises[j.id] = timeToMinutes(j.start_time)
      const durations = Object.fromEntries(route.seq.map(j => [j.id, j.duration_minutes || DEFAULT_JOB_MIN]))
      const fix = suggestPromiseOrder(settings.base, route.seq.map(jobStop), route.seq.map(j => j.id), route.startHHmm, durations, promises)
      if (fix) out[laneId] = fix
    }
    return out
  }, [conflicts, laneRoutes, settings.base])

  // The one-tap remedy for each conflict kind — every fix is an EXISTING
  // engine's answer; the panel never grows its own logic.
  const conflictFix = useCallback((c: DispatchConflict): { label: string; run: () => void } | null => {
    switch (c.kind) {
      case 'overloaded': {
        const m = overloadMoves[c.laneId]
        if (m) {
          return {
            label: `Move ${m.title} → ${laneNameOf(m.toLaneId)}`,
            run: () => moveJob(m.jobId, assigneeOfLane(m.toLaneId)),
          }
        }
        return { label: 'Balance day', run: openBalance }
      }
      case 'unassigned_work':
        return { label: 'Balance day', run: openBalance }
      case 'late_arrival': {
        const fix = promiseFixes[c.laneId]
        if (fix) {
          return {
            label: `Fix order — ${fix.lateBefore} late → ${fix.lateAfter}`,
            run: () => { applyLaneOrder(fix.ids); notify.success(`Timed visits re-slotted by promise — ${fix.lateBefore} late became ${fix.lateAfter}.`) },
          }
        }
        return settings.base ? { label: 'Optimize route', run: () => bestOrderLane(c.laneId) } : null
      }
      case 'overrun':
        return settings.base ? { label: 'Optimize route', run: () => bestOrderLane(c.laneId) } : null
      // Deliberately NO fix. Behind is a field reality, not a plan defect —
      // "Optimize route" would re-sequence the day a crew is already driving
      // and make nobody less late. The row's Jump is the whole offer: go look.
      case 'running_behind':
        return null
      case 'no_roster':
        return { label: 'Open roster', run: () => setManagerOpen(true) }
      default:
        return null
    }
  }, [openBalance, bestOrderLane, settings.base, overloadMoves, promiseFixes, laneNameOf, moveJob, applyLaneOrder])

  // ── Per-crew sheet actions (same buildSheet, scoped to one lane) ──
  const printLane = useCallback((laneId: string) => {
    const ids = new Set((laneRoutesRef.current[laneId]?.seq ?? []).map(j => j.id))
    if (ids.size === 0) { notify('Nothing to print for this crew.'); return }
    if (!openPrintSheet(buildSheet(ids))) notify.error('The print window was blocked — allow pop-ups for this site.')
  }, [buildSheet])

  const copyItinerary = useCallback(async (laneId: string) => {
    const ids = new Set((laneRoutesRef.current[laneId]?.seq ?? []).map(j => j.id))
    const sheet = buildSheet(ids)
    const lane = sheet.lanes[0]
    if (!lane) { notify('Nothing to copy for this crew.'); return }
    try {
      await navigator.clipboard.writeText(itineraryText(lane, sheet.dateLabel))
      notify.success(`${lane.name}'s itinerary copied — paste it anywhere.`)
    } catch {
      notify.error('Could not reach the clipboard.')
    }
  }, [buildSheet])

  // ── Activity feed (derived from timestamps the day already carries) ──
  const feed: ActivityItem[] = useMemo(() => buildActivityFeed(
    jobs.map(j => ({
      id: j.id, title: j.title, customerName: j.customers?.name ?? null, laneId: laneIdOf(j),
      started_at: j.started_at, completed_at: j.completed_at, on_my_way_at: j.on_my_way_at,
    })),
    // Technician status is a NOW fact — it belongs on today's feed only.
    isToday ? technicians.filter(t => t.is_active).map(t => ({
      name: t.name, statusLabel: TECHNICIAN_STATUS_LABELS[t.status], status_changed_at: t.status_changed_at, laneId: t.crew_id,
    })) : [],
    notes.map(n => ({
      crewName: n.crew_id ? crews.find(c => c.id === n.crew_id)?.name ?? null : null,
      updated_at: n.updated_at, created_at: n.created_at, laneId: n.crew_id,
    })),
  ), [jobs, technicians, notes, crews, isToday, laneIdOf])

  // ── Recent days (loaded when the panel opens — one grouped query) ──
  const loadHistory = useCallback(async () => {
    if (!uid) return
    setHistoryRows(null)
    const from = format(addDays(parseISO(date + 'T00:00:00'), -13), 'yyyy-MM-dd')
    const { data } = await supabase.from('jobs').select('scheduled_date, status')
      .eq('user_id', uid).gte('scheduled_date', from).lte('scheduled_date', date)
    const byDate = new Map<string, { total: number; done: number; cancelled: number }>()
    for (const r of (data as { scheduled_date: string; status: string }[] | null) ?? []) {
      const row = byDate.get(r.scheduled_date) ?? { total: 0, done: 0, cancelled: 0 }
      if (r.status === 'cancelled') row.cancelled++
      else { row.total++; if (r.status === 'completed') row.done++ }
      byDate.set(r.scheduled_date, row)
    }
    setHistoryRows([...byDate.entries()].map(([d, v]) => ({ date: d, ...v })).sort((a, b) => b.date.localeCompare(a.date)))
  }, [uid, supabase, date])

  const openHistory = useCallback(() => { setHistoryOpen(true); loadHistory() }, [loadHistory])

  // ── The ONE command palette learns this page's verbs (Cmd/Ctrl+K) ──
  const pageCommands = useMemo<PageCommand[]>(() => [
    { id: 'today', label: 'Dispatch: Go to today', icon: CalendarDays, keywords: 'date now', run: () => setDate(todayISO()) },
    { id: 'board', label: 'Dispatch: Board view', icon: LayoutGrid, keywords: 'lanes', run: () => setView('board') },
    { id: 'map', label: 'Dispatch: Map view', icon: MapIcon, keywords: 'pins routes', run: () => setView('map') },
    { id: 'balance', label: 'Dispatch: Balance the day', icon: Scale, keywords: 'even workload', run: openBalance },
    { id: 'print', label: 'Dispatch: Print day sheet', icon: Printer, keywords: 'paper pdf', run: () => printDayRef.current() },
    { id: 'csv', label: 'Dispatch: Export day CSV', icon: FileDown, keywords: 'spreadsheet excel', run: () => exportDayCsv() },
    { id: 'activity', label: 'Dispatch: Activity feed', icon: Activity, keywords: 'log events history', run: () => setActivityOpen(true) },
    { id: 'history', label: 'Dispatch: Recent days', icon: History, keywords: 'past yesterday', run: openHistory },
    { id: 'roster', label: 'Dispatch: Crews & roster', icon: Users, keywords: 'technicians team', run: () => setManagerOpen(true) },
    { id: 'shortcuts', label: 'Dispatch: Keyboard shortcuts', icon: Keyboard, keywords: 'keys help', run: () => setShortcutsOpen(true) },
    ...crews.filter(c => c.is_active).map((c): PageCommand => ({
      id: `optimize-${c.id}`, label: `Dispatch: Optimize ${c.name}`, icon: Wand2, keywords: 'best order route',
      run: () => bestOrderLane(c.id),
    })),
  ], [crews, openBalance, exportDayCsv, bestOrderLane, openHistory])
  usePageCommands(pageCommands)

  // Feed the roving-focus keys their current world.
  kbApiRef.current = {
    ids: selectableJobs.map(j => j.id),
    toggle: bulk.toggle,
    advance: (id: string) => {
      const j = jobs.find(x => x.id === id)
      if (!j || statusBusy.has(id)) return
      if (j.status === 'scheduled') quickStart(j)
      else if (j.status === 'in_progress') quickComplete(j)
    },
  }

  // ── Render ──
  const dateLabel = format(parseISO(date + 'T00:00:00'), 'EEEE, MMM d')
  // One workday, this business's own — so a long visit reads "1 day 2h", not "600m".
  const dispatchWorkdayMin = workdayMinutes(settings.dailyHours)
  const dayNote = notes.find(n => n.crew_id === null)

  // Work can go to a crew OR to one person, so the door stays open when there
  // are no crews yet but there are people to hand it to.
  const canAssign = activeCrewCount > 0 || technicians.some(t => t.is_active && !t.archived_at)
  const bulkActions: BulkAction[] = [
    { key: 'assign', label: 'Assign to…', icon: Users, onClick: () => setAssignPickOpen(true), tone: 'primary', hidden: !canAssign },
    { key: 'unassign', label: 'Unassign', icon: UserMinus, onClick: () => bulkAssign(UNASSIGNED), hidden: !bulk.selectedItems.some(j => j.crew_id || j.technician_id) },
    { key: 'complete', label: 'Mark done', icon: CheckCircle2, onClick: bulkComplete, hidden: !bulk.selectedItems.some(j => j.status === 'scheduled' || j.status === 'in_progress') },
    { key: 'optimize', label: 'Optimize routes', icon: Wand2, onClick: bulkOptimize, disabled: !settings.base },
    { key: 'reschedule', label: 'Reschedule…', icon: CalendarDays, onClick: () => setReschedOpen(true), disabled: reschedulable.length === 0 },
    { key: 'export', label: 'Export CSV', icon: FileDown, onClick: () => exportDayCsv(bulk.selected) },
  ]

  if (loading) {
    return (
      <div className="max-w-7xl space-y-6">
        <PageHeader title="Dispatch" description="Crews, routes and the day's plan — one board." />
        <SkeletonTiles count={4} />
        <SkeletonRows count={6} />
      </div>
    )
  }

  return (
    <div className="max-w-7xl space-y-5">
      {/* Keyboard-move narration for screen readers. */}
      <div aria-live="polite" className="sr-only">{announce}</div>

      <PageHeader
        title="Dispatch"
        description={`${dateLabel} · ${activeJobs.length} visit${activeJobs.length !== 1 ? 's' : ''}`}
        action={
          <div className="flex items-center gap-2">
            <Link href="/dashboard/dispatch/time">
              <Button variant="secondary" size="sm">
                <Clock className="w-3.5 h-3.5" /> Timesheet
              </Button>
            </Link>
            <Button variant="secondary" size="sm" onClick={() => setManagerOpen(true)}>
              <Users className="w-3.5 h-3.5" /> Crews & roster
            </Button>
          </div>
        }
      />

      {loadError && (
        <Banner tone="danger" action={<Button size="sm" variant="secondary" onClick={() => { setLoading(true); fetchAll() }}>Retry</Button>}>
          {loadError}
        </Banner>
      )}

      {/* A blocked day told the owner what was needed ("anything still scheduled
          needs a new day") and offered no way to do it — the only reschedule
          door was three undiscoverable steps deep in the bulk bar. The banner
          now IS the door: select everything still standing, open the same
          dialog. Deliberately clobbers any in-progress selection — on a blocked
          day, moving the day is the task. */}
      {dayRow?.blocks && (
        <Banner tone="warn"
          action={activeJobs.some(j => j.status === 'scheduled') ? (
            <Button size="sm" variant="secondary"
              onClick={() => { if (!bulk.allSelected) bulk.toggleAll(); setReschedOpen(true) }}>
              <CalendarDays className="w-3.5 h-3.5" /> Reschedule the day
            </Button>
          ) : undefined}>
          This day is marked {dayStatusLabel(dayRow)} — capacity is zero. Anything still scheduled needs a new day or an explicit exception.
        </Banner>
      )}

      {/* Toolbar: date nav · view · sheet · balance */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setDate(d => format(addDays(parseISO(d + 'T00:00:00'), -1), 'yyyy-MM-dd'))} aria-label="Previous day">
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDate(d => format(addDays(parseISO(d + 'T00:00:00'), 1), 'yyyy-MM-dd'))} aria-label="Next day">
            <ChevronRight className="w-4 h-4" />
          </Button>
          <input
            type="date"
            value={date}
            onChange={e => { if (e.target.value) setDate(e.target.value) }}
            aria-label="Jump to date"
            className="rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-ink-muted hover:text-ink hover:border-border-strong transition-colors tabular-nums focus-visible:outline-none focus:ring-2 focus:ring-accent/40 [color-scheme:dark]"
          />
          {!isToday && (
            <Button variant="secondary" size="sm" onClick={() => setDate(todayISO())}>Today</Button>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <FilterPill active={view === 'board'} onClick={() => setView('board')}><LayoutGrid className="w-3.5 h-3.5" /> Board</FilterPill>
          <FilterPill active={view === 'map'} onClick={() => setView('map')}><MapIcon className="w-3.5 h-3.5" /> Map</FilterPill>
          <Button variant="ghost" size="sm" onClick={() => setActivityOpen(true)} aria-label="Today's activity" title="Today's activity">
            <Activity className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={openHistory} aria-label="Recent days" title="Recent days">
            <History className="w-4 h-4" />
          </Button>
          <Menu width={210} ariaLabel="Dispatch sheet" items={[
            { key: 'print', label: 'Print day sheet', icon: Printer, onSelect: printDay },
            { key: 'csv', label: 'Export day CSV', icon: FileDown, onSelect: () => exportDayCsv() },
            { key: 'keys', label: 'Keyboard shortcuts', icon: Keyboard, onSelect: () => setShortcutsOpen(true) },
          ]}>
            {({ toggle, triggerProps }) => (
              <Button variant="secondary" size="sm" onClick={toggle} {...triggerProps}>
                <Printer className="w-3.5 h-3.5" /> Sheet
              </Button>
            )}
          </Menu>
          <Button variant="secondary" size="sm" onClick={openBalance} disabled={activeCrewCount < 1 || activeJobs.length === 0}
            title="Even out the day's booked minutes across crews">
            <Scale className="w-3.5 h-3.5" /> Balance
          </Button>
        </div>
      </div>

      {/* Day pulse — every number an aggregate of what the lanes already computed */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 animate-rise">
        <StatTile label="Visits" value={kpis.total} icon={Radio}
          sub={kpis.done > 0 || kpis.running > 0
            ? `${kpis.done} done${kpis.running > 0 ? ` · ${kpis.running} running` : ''}`
            : kpis.total > 0 ? 'none started yet' : undefined} />
        <StatTile label="Assigned" value={activeCrewCount > 0 || assignedCount > 0 ? `${assignedCount}/${activeJobs.length}` : '—'}
          sub={activeCrewCount === 0 && assignedCount === 0 ? 'Create crews to assign work'
            : assignedCount === activeJobs.length ? 'Everything has a crew or a person'
            : activeCrewCount > 0 ? 'Balance can place the rest'
            : `${activeJobs.length - assignedCount} still to hand out`} />
        <StatTile label="Day finish" value={latestFinish != null ? minutesToTime12(latestFinish) : '—'}
          sub={kpis.behindLanes > 0 ? `${kpis.behindLanes} crew${kpis.behindLanes !== 1 ? 's' : ''} running behind` : latestFinish != null ? 'latest crew, est.' : undefined} />
        <StatTile label="Day used" value={kpis.utilizationPct != null ? `${kpis.utilizationPct}%` : '—'}
          sub={kpis.utilizationPct != null ? 'of crew capacity, work + drive' : 'no crew work yet'} />
        <StatTile label="Drive" value={settings.base ? `~${totalKm} km` : '—'}
          sub={settings.base
            ? (kpis.driveSharePct != null ? `${kpis.driveSharePct}% of the day · straight-line est.` : 'all crews, straight-line est.')
            : 'Set a base address in Settings'} />
      </div>

      {activeCrewCount === 0 && activeJobs.length > 0 && (
        <Banner tone="accent" icon={Users}
          action={<Button size="sm" onClick={() => setManagerOpen(true)}>Create a crew</Button>}>
          The whole day is one route today. Create crews to dispatch it across teams.
        </Banner>
      )}

      <ConflictPanel conflicts={panelConflicts} onJump={jumpTo} fixFor={conflictFix} />

      {view === 'map' ? (
        <div className="animate-rise">
          <DispatchMap base={settings.base} lanes={mapLanes} height={560} onSelectStop={mapSelectStop} />
          {!settings.base && (
            <p className="text-[11px] text-ink-faint mt-2">No base address set — routes can’t anchor to a start point. Set it in Settings → Business.</p>
          )}
        </div>
      ) : activeJobs.length === 0 ? (
        <EmptyState icon={Radio} title="Nothing scheduled this day"
          description="Visits land here from the Schedule. Once a day has work, dispatch it across crews." />
      ) : (
        <>
          {/* Filters + select-all */}
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <DispatchFilters value={filter} onChange={setFilter} crews={crews} technicians={technicians} equipment={equipment} />
            <SelectAllToggle allSelected={bulk.allSelected} onToggle={bulk.toggleAll} count={selectableJobs.length} noun="visit" />
          </div>

          {bulk.someSelected && (
            <BulkActionBar count={bulk.count} actions={bulkActions} onClear={bulk.clear} busyKey={bulkBusy} />
          )}

          {/* Day-level note. An EMPTY note box was ~70px of chrome on every day
              that had nothing to say — one of the reasons no job row was visible
              at first paint on a laptop. Collapsed to one line until it has a
              note or the owner opens it; `dayNoteOpen` is sticky for the session
              so clearing the text mid-edit can't collapse the box underneath the
              cursor. The NoteBox itself — and its awaited-save contract — is
              untouched. */}
          {dayNoteOpen || dayNote?.body ? (
            <NoteBox
              icon={StickyNote}
              placeholder="Day note for the whole operation — gate codes, yard reminders, weather calls…"
              value={dayNote?.body ?? ''}
              updatedAt={dayNote?.updated_at ?? null}
              autoFocus={dayNoteOpen && !dayNote?.body}
              onSave={async body => {
                if (!uid) return 'not signed in'
                const err = await saveDispatchNote(supabase, uid, date, null, body)
                if (err) { notify.error('Could not save the note: ' + err); return err }
                fetchAll()
                return null
              }}
            />
          ) : (
            <button type="button" onClick={() => setDayNoteOpen(true)}
              className="flex items-center gap-1.5 text-[11px] text-ink-faint hover:text-ink transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              <StickyNote className="w-3.5 h-3.5" aria-hidden /> Add a day note — gate codes, yard reminders, weather calls
            </button>
          )}

          {/* Lane jumper — the lanes stack single-column everywhere below lg
              (the grid's first multi-column step), not just on phones; a tablet
              owner scrolling a four-crew stack needs the map of the stack just
              as much. Hidden from lg up, where lanes sit side by side. */}
          {visibleLanes.filter(l => (laneRoutes[l.laneId]?.seq.length ?? 0) > 0).length > 1 && (
            <nav aria-label="Jump to crew" className="lg:hidden sticky top-0 z-20 -mx-1 px-1 py-1.5 bg-bg/85 backdrop-blur flex items-center gap-1.5 overflow-x-auto">
              {visibleLanes.filter(l => (laneRoutes[l.laneId]?.seq.length ?? 0) > 0).map(lane => {
                const badge = laneBadges[lane.laneId]
                return (
                  <button key={lane.laneId} type="button"
                    onClick={() => document.getElementById(`dispatch-lane-${lane.laneId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1.5 text-[11px] font-medium text-ink-muted active:scale-[0.97] transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                    <span className={cn('w-1.5 h-1.5 rounded-full', lane.palette.dot)} aria-hidden />
                    {laneLabel(lane)}
                    <span className="text-ink-faint tabular-nums">{laneRoutes[lane.laneId]?.seq.length ?? 0}</span>
                    {badge && <AlertTriangle className={cn('w-3 h-3', badge.severity === 'error' ? 'text-red-400' : badge.severity === 'warn' ? 'text-amber-400' : 'text-sky-400')} aria-label={`${badge.count} conflicts`} />}
                  </button>
                )
              })}
            </nav>
          )}

          {/* Three-across waits for 2xl (~400px lanes). At xl (1280px — the modal
              laptop) three tracks left ~30px for the customer's NAME on an
              in-progress row: every fixed control (checkbox, grip, order chip,
              status badge, start/complete, nudges, menu) kept its width and the
              one flexible thing on the row absorbed the whole squeeze. The board
              was WIDER per lane at 1024px than at 1280px. */}
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3 items-start">
            {visibleLanes.map((lane, i) => (
              <CrewLaneCard
                key={lane.laneId}
                lane={lane}
                route={laneRoutes[lane.laneId]}
                technicians={laneAux[lane.laneId]?.techs ?? []}
                vehicles={laneAux[lane.laneId]?.vehicles ?? []}
                note={laneAux[lane.laneId]?.note ?? null}
                crews={crews}
                roster={technicians}
                crewSpare={crewSpareMin}
                workdayMin={dispatchWorkdayMin}
                nowMin={nowMin}
                base={settings.base}
                index={i}
                conflictBadge={laneBadges[lane.laneId] ?? null}
                savingsKm={laneSavings[lane.laneId] ?? 0}
                statusVisible={statusVisible}
                isDropTarget={overLane === lane.laneId && dragging != null}
                dropOverload={overLane === lane.laneId && dropWouldOverload}
                dropAnchor={overLane === lane.laneId ? overAnchor : undefined}
                dragging={dragging}
                kbGrabbedId={kbGrab?.jobId ?? null}
                flashJobId={flashJobId}
                selectedSet={bulk.selected}
                onToggleSelect={bulk.toggle}
                onDragHandleDown={onDragHandleDown}
                onGripKeyDown={onGripKeyDown}
                onNudge={nudgeJob}
                onMoveTo={moveJob}
                onBestOrder={bestOrderLane}
                optimizing={optimizingLane === lane.laneId}
                onSetTechStatus={setTechStatusStable}
                onSaveNote={saveLaneNote}
                statusBusy={statusBusy}
                onQuickStart={quickStart}
                onQuickComplete={quickComplete}
                onRecord={j => setRecordingId(j.id)}
                onPrintLane={printLane}
                onCopyItinerary={copyItinerary}
              />
            ))}
          </div>
          {visibleLanes.length === 0 && (
            <InlineEmpty icon={Radio} className="py-8">
              Nothing matches these filters. <button type="button" className="underline hover:text-ink rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" onClick={() => setFilter(EMPTY_DISPATCH_FILTER)}>Clear them</button>.
            </InlineEmpty>
          )}
          {hasActiveFilter(filter) && visibleLanes.length > 0 && visibleLanes.length < lanes.filter(l => (laneRoutes[l.laneId]?.seq.length ?? 0) > 0).length && (
            <p className="text-[11px] text-ink-faint">
              {lanes.filter(l => (laneRoutes[l.laneId]?.seq.length ?? 0) > 0).length - visibleLanes.filter(l => (laneRoutes[l.laneId]?.seq.length ?? 0) > 0).length} lane(s) hidden by filters.
            </p>
          )}
        </>
      )}

      {/* Drag ghost — always mounted; the pointer drives it via a direct
          transform write, so following the finger costs zero re-renders. */}
      <div
        ref={ghostRef}
        aria-hidden
        className={cn('fixed left-0 top-0 z-[300] pointer-events-none will-change-transform', !dragging && 'hidden')}
      >
        <div className={cn(
          '-translate-x-1/2 -translate-y-full rounded-lg border bg-bg-secondary shadow-2xl px-3 py-1.5 text-xs font-semibold text-ink rotate-[-1.5deg] scale-105 transition-colors',
          dropWouldOverload ? 'border-red-400/60' : 'border-accent/40',
        )}>
          {dragging?.title}
          {/* "their day", not "this crew" — the lane under the pointer can be
              one person's. */}
          {dropWouldOverload && <span className="block text-[10px] font-medium text-red-400">would overbook their day</span>}
        </div>
      </div>

      {/* Today's activity — derived from the day's own timestamps, live via realtime */}
      {activityOpen && (
        <Modal open onClose={() => setActivityOpen(false)} title="Today's activity" icon={Activity} size="sm">
          {feed.length === 0 ? (
            <InlineEmpty icon={Activity}>Nothing yet — the day hasn&apos;t moved.</InlineEmpty>
          ) : (
            <div className="space-y-1 max-h-[60vh] overflow-y-auto pr-1">
              {feed.map((item, i) => {
                const Icon = item.kind === 'completed' ? CheckCircle2
                  : item.kind === 'started' ? PlayCircle
                  : item.kind === 'on_my_way' ? Send
                  : item.kind === 'tech_status' ? HardHat : StickyNote
                const tone = item.kind === 'completed' ? 'text-emerald-400'
                  : item.kind === 'started' ? 'text-sky-400'
                  : 'text-ink-faint'
                const t = new Date(item.atISO)
                const inner = (
                  <>
                    <Icon className={cn('w-3.5 h-3.5 shrink-0', tone)} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-ink-muted">{item.text}</span>
                    <span className="shrink-0 text-[11px] text-ink-faint tabular-nums">
                      {format(t, 'h:mm a')}
                    </span>
                  </>
                )
                return item.jobId ? (
                  <button key={`${item.kind}-${item.atISO}-${i}`} type="button"
                    onClick={() => { setActivityOpen(false); jumpTo(item.laneId ?? UNASSIGNED_ID, item.jobId) }}
                    className="w-full flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-left text-xs hover:border-border-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                    {inner}
                  </button>
                ) : (
                  <div key={`${item.kind}-${item.atISO}-${i}`} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs">
                    {inner}
                  </div>
                )
              })}
            </div>
          )}
        </Modal>
      )}

      {/* Recent days — summaries only; clicking one IS the history view (the
          board is date-driven, so any past day renders in full). */}
      {historyOpen && (
        <Modal open onClose={() => setHistoryOpen(false)} title="Recent days" icon={History} size="sm">
          {historyRows === null ? (
            <div className="flex items-center gap-2 py-6 justify-center text-sm text-ink-muted">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> Loading…
            </div>
          ) : historyRows.length === 0 ? (
            <InlineEmpty icon={History}>No visits in the last two weeks.</InlineEmpty>
          ) : (
            <div className="space-y-1">
              {historyRows.map(row => (
                <button key={row.date} type="button"
                  onClick={() => { setHistoryOpen(false); setDate(row.date) }}
                  className={cn('w-full flex items-center gap-3 rounded-lg border px-3 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    row.date === date ? 'border-accent/50 bg-accent/5' : 'border-border bg-surface hover:border-border-strong')}>
                  <span className="w-24 shrink-0 font-semibold text-ink">{format(parseISO(row.date + 'T00:00:00'), 'EEE, MMM d')}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block h-1 rounded-full bg-border overflow-hidden">
                      <span className="block h-full bg-emerald-400/80" style={{ width: `${row.total > 0 ? Math.round((row.done / row.total) * 100) : 0}%` }} />
                    </span>
                  </span>
                  <span className="shrink-0 text-ink-muted tabular-nums">
                    {row.done}/{row.total} done{row.cancelled > 0 ? ` · ${row.cancelled} cancelled` : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}

      {/* Keyboard shortcuts */}
      {shortcutsOpen && (
        <Modal open onClose={() => setShortcutsOpen(false)} title="Keyboard shortcuts" icon={Keyboard} size="sm">
          <div className="space-y-3 text-sm">
            {([
              ['Day', [['[', 'Previous day'], [']', 'Next day'], ['T', 'Today']]],
              ['View', [['B', 'Board'], ['M', 'Map'], ['P', 'Print day sheet'], ['?', 'This help']]],
              ['Visits', [['J / K', 'Walk down / up the stops'], ['X', 'Select the focused stop'], ['S', 'Start / complete the focused stop'], ['Enter', 'Grab / drop the focused visit'], ['↑ ↓', 'Reorder a grabbed visit'], ['← →', 'Move a grabbed visit between crews and people'], ['Esc', 'Put a grabbed visit back · cancel a drag · clear selection'], ['Shift+click', 'Select a range']]],
            ] as [string, [string, string][]][]).map(([group, keys]) => (
              <div key={group}>
                <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-1.5">{group}</p>
                <div className="space-y-1">
                  {keys.map(([k, what]) => (
                    <div key={k} className="flex items-center justify-between gap-3">
                      <span className="text-xs text-ink-muted">{what}</span>
                      <Kbd variant="map" className="shrink-0">{k}</Kbd>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Modal>
      )}

      {/* Balance preview */}
      {balancePlan && (
        <BalanceModal
          plan={balancePlan}
          lanes={lanes}
          applying={applyingBalance}
          onApply={applyBalance}
          onClose={() => setBalancePlan(null)}
        />
      )}

      {/* Bulk: who runs these visits. The ONE chooser builds the list, so the
          board can only offer what the assignment model allows — a crew, or one
          person — and each row says what picking it means. Jane appearing under
          Individuals while also being ON a crew is not a duplicate: they are
          different answers. */}
      {assignPickOpen && (
        <Modal open onClose={() => setAssignPickOpen(false)} title={`Assign ${bulk.count} visit${bulk.count !== 1 ? 's' : ''}`} icon={Users} size="sm">
          <div className="space-y-1.5">
            {assignmentOptions({ crews, technicians })
              // Unassigning is its own button on the bulk bar — listing it here
              // among the destinations reads like somewhere to send work.
              .filter(o => o.group !== 'none')
              .map((o, i, all) => {
                const laneId = laneIdOfAssignee(o.assignee)
                const lane = lanes.find(l => l.laneId === laneId)
                const route = laneRoutes[laneId]
                const load = route ? laneLoad(route.workMin, route.capacityMin) : null
                const heading = i === 0 || all[i - 1].group !== o.group ? ASSIGNMENT_GROUP_LABELS[o.group] : null
                return (
                  <div key={o.value}>
                    {heading && (
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint px-1 pt-1.5 pb-1">{heading}</p>
                    )}
                    <button type="button" onClick={() => bulkAssign(o.assignee)} disabled={bulkBusy != null || o.disabled}
                      className="w-full flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5 text-left text-sm hover:border-border-strong hover:bg-bg-tertiary transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                      <span className={cn('w-2 h-2 rounded-full shrink-0', lane?.palette.dot ?? 'bg-ink-faint')} aria-hidden />
                      <span className="min-w-0">
                        <span className="block font-semibold text-ink truncate">{o.label}</span>
                        {o.hint && <span className="block text-[11px] text-ink-faint leading-snug line-clamp-2">{o.hint}</span>}
                      </span>
                      <span className={cn('ml-auto text-[11px] tabular-nums shrink-0',
                        load?.state === 'overloaded' ? 'text-red-400' : load?.state === 'full' ? 'text-amber-400' : 'text-ink-faint')}>
                        {Math.round((route?.workMin ?? 0) / 60 * 10) / 10}h booked{load?.state === 'overloaded' ? ' · over' : ''}
                      </span>
                    </button>
                  </div>
                )
              })}
          </div>
        </Modal>
      )}

      {/* Bulk: reschedule */}
      {reschedOpen && (
        <RescheduleDialog
          open
          count={reschedulable.length}
          notifiableCount={reschedulable.filter(j => j.customers?.id).length}
          fromDate={date}
          busy={bulkBusy === 'reschedule'}
          onClose={() => setReschedOpen(false)}
          onApply={bulkReschedule}
        />
      )}

      <CrewManager
        open={managerOpen}
        onClose={() => setManagerOpen(false)}
        crews={crews}
        technicians={technicians}
        equipment={equipment}
        onChanged={fetchAll}
      />

      {/* Proof of work — the owner's half of the SAME editor the crew uses
          (components/completion). ⛔ Not a completion door: it writes only the
          two record fields, so opening it on a visit that was billed weeks ago
          cannot re-bill it. Held by id so it always reads the freshest row.
          Photos come from the canonical owner uploader; a parallel upload path
          is exactly what must not exist. */}
      {(() => {
        const job = jobs.find(j => j.id === recordingId)
        if (!job) return null
        return (
          <CompletionSheet
            open
            onClose={() => setRecordingId(null)}
            job={job}
            onSave={record => saveCompletionRecord(supabase, job, record)}
            onSaved={fetchAll}
            photos={
              <>
                <JobPhotos
                  propertyId={job.property_id ?? null}
                  jobId={job.id}
                  customerId={job.customer_id ?? null}
                  variant="visit"
                />
                {/* The visit's checklist rides the same sheet — the record of
                    what was required sits beside the record of what was done.
                    The panel owns its own loads/writes; the sheet stays the
                    two-field editor it always was. */}
                <div className="mt-3 pt-3 border-t border-border">
                  <JobFormsPanel job={job} onChanged={fetchAll} />
                </div>
                {/* The customer-facing view of everything recorded above. Only a
                    finished visit has a completion report to preview. */}
                {job.status === 'completed' && (
                  <div className="mt-3 pt-3 border-t border-border">
                    <button
                      type="button"
                      onClick={() => setReportJobId(job.id)}
                      className="text-sm font-medium text-accent hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 tap-target-y"
                    >
                      Preview completion report…
                    </button>
                  </div>
                )}
              </>
            }
          />
        )
      })()}

      {reportJobId && (
        <CompletionReportSheet jobId={reportJobId} onClose={() => setReportJobId(null)} />
      )}
    </div>
  )
}

// ── Crew lane ────────────────────────────────────────────────────────────────
// memo()'d: with the drag ghost off React state, a pointer drag re-renders a
// lane only when its own drop target changes — never per pointer move.
const CrewLaneCard = memo(function CrewLaneCard({
  lane, route, technicians, vehicles, note, crews, roster, crewSpare, nowMin, base, index, conflictBadge, savingsKm, statusVisible,
  isDropTarget, dropOverload, dropAnchor, dragging, kbGrabbedId, flashJobId, selectedSet, onToggleSelect,
  onDragHandleDown, onGripKeyDown, onNudge, onMoveTo, onBestOrder, optimizing, onSetTechStatus, onSaveNote,
  statusBusy, onQuickStart, onQuickComplete, onRecord, onPrintLane, onCopyItinerary, workdayMin,
}: {
  /** Minutes in ONE workday for this business, so a long visit reads "1 day 2h"
   *  rather than "600m". Passed in rather than read here — the settings live on
   *  the page, and this card is memoised. */
  workdayMin: number
  lane: CrewLaneData
  route: LaneRoute | undefined
  /** Who is on THIS lane — a crew's members, or the one person whose lane it is. */
  technicians: Technician[]
  vehicles: AssignableEquipment[]
  note: DispatchNote | null
  crews: Crew[]
  /** The whole roster — the Move-to menu offers individuals as well as crews. */
  roster: Technician[]
  /** crew id → spare minutes today (laneLoad.spareMin) — the Move-to menu's
   *  room labels. Other lanes' loads are otherwise invisible from this card.
   *  Crews only: room comes from a capacity row and a person hasn't got one. */
  crewSpare: Record<string, number>
  nowMin?: number
  base: Coord | null
  index: number
  conflictBadge: { count: number; severity: 'error' | 'warn' | 'info' } | null
  savingsKm: number
  statusVisible: (j: Job) => boolean
  isDropTarget: boolean
  dropOverload: boolean           // dropping the dragged visit here would overbook this crew
  dropAnchor?: string | null      // stop id the drop lands BEFORE (null = end); undefined = not this lane
  dragging: { jobId: string } | null
  kbGrabbedId: string | null
  flashJobId: string | null
  selectedSet: Set<string>
  onToggleSelect: (id: string, shiftKey?: boolean) => void
  onDragHandleDown: (e: React.PointerEvent, job: Job, laneId: string) => void
  onGripKeyDown: (e: React.KeyboardEvent, job: Job, laneId: string) => void
  onNudge: (laneId: string, jobId: string, dir: -1 | 1) => void
  onMoveTo: (jobId: string, to: Assignee) => void
  onBestOrder: (laneId: string) => void
  optimizing: boolean
  onSetTechStatus: (t: Technician, s: TechnicianStatus) => void
  onSaveNote: (laneId: string, body: string) => Promise<string | null>
  statusBusy: Set<string>
  onQuickStart: (j: Job) => void
  onQuickComplete: (j: Job) => void
  /** Open the proof-of-work record for this visit. Writes the two record
   *  fields and nothing else — not a completion door. */
  onRecord: (j: Job) => void
  onPrintLane: (laneId: string) => void
  onCopyItinerary: (laneId: string) => void
}) {
  const seq = route?.seq ?? []
  const visibleSeq = seq.filter(statusVisible)
  const hiddenCount = seq.length - visibleSeq.length
  const load = laneLoad(route?.workMin ?? 0, route?.capacityMin ?? 0)
  const stats: LaneStats | null = route && seq.length > 0
    ? laneStats(route.etas.startMin, route.etas.finishMin, route.workMin, route.capacityMin)
    : null
  const doneCount = seq.filter(j => j.status === 'completed').length
  const hasRunning = seq.some(j => j.status === 'in_progress')
  const etaByJob = new Map((route?.etas.stops ?? []).map(s => [s.jobId, s]))
  const legKmByJob = new Map((route?.ordered ?? []).map(o => [o.jobId, o.legKm]))
  // O(1) stop-number lookups — indexOf per row was quadratic on big days.
  const orderIdx = new Map(seq.map((j, i) => [j.id, i]))
  const isUnassigned = lane.laneId === UNASSIGNED_ID
  // Notes and vehicles belong to a CREW; a person's lane has neither, so the
  // note editor would be a box whose every save fails (dispatch_notes.crew_id
  // cannot hold a person lane's id).
  const isCrewLane = lane.crew != null
  const laneName = laneLabel(lane)
  const cancelledCount = lane.jobs.filter(j => j.status === 'cancelled').length
  // Reorders glide instead of teleporting (FLIP; inert under reduced motion).
  const flipRef = useFlipList<HTMLDivElement>(visibleSeq.map(j => j.id).join(','))
  // Where the crew stands against its own plan — today only.
  const progress = nowMin != null && route && seq.length > 0
    ? laneProgress(nowMin, seq.map(j => ({
        jobId: j.id,
        arrivalMin: etaByJob.get(j.id)?.arrivalMin ?? null,
        durMin: j.duration_minutes || DEFAULT_JOB_MIN,
        status: j.status,
      })))
    : null
  // Drive legs between rows only make sense when no row is filtered out —
  // otherwise the leg would appear to start from a stop that isn't shown.
  const showLegs = hiddenCount === 0
  const sinceMin = (iso: string | null | undefined): number | null =>
    iso ? Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)) : null
  const fmtSince = (m: number) => (m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`)
  // The room a CREW destination carries in the Move-to menu: the job's minutes
  // against that crew's spare, from the same laneLoad the capacity meters draw.
  // "Move to Green — 2.1h free" is an informed reassignment; a bare name list
  // made the owner open other cards to find out. Takes a crew because only a
  // crew HAS spare — a person has no capacity row, and quoting the business
  // default as "their spare" would invent a limit nobody set.
  const crewRoom = (c: Crew): string => {
    const spare = crewSpare[c.id]
    return spare == null ? ''
      : spare < 0 ? ` — over by ${Math.abs(spare)}m`
      : spare >= 60 ? ` — ${Math.round(spare / 60 * 10) / 10}h free`
      : ` — ${spare}m free`
  }

  const timelineStops: TimelineStop[] = seq.map(j => ({
    jobId: j.id,
    name: j.customers?.name || j.title,
    arrivalMin: etaByJob.get(j.id)?.arrivalMin ?? 0,
    durMin: j.duration_minutes || DEFAULT_JOB_MIN,
    status: j.status,
    promisedMin: j.start_time ? timeToMinutes(j.start_time) : null,
  }))

  // Skip an empty unassigned lane UNLESS a drag is looking for a drop target.
  if (isUnassigned && seq.length === 0 && !dragging) return null

  const dropLine = <div className="h-0.5 rounded-full bg-accent shadow-[0_0_6px_rgba(0,0,0,0.3)] my-0.5 animate-fade" aria-hidden />

  return (
    <section
      id={`dispatch-lane-${lane.laneId}`}
      data-lane={lane.laneId}
      aria-label={`${laneName} lane`}
      className={cn(
        'rounded-card border bg-bg-secondary p-4 space-y-3 animate-rise transition-shadow scroll-mt-14',
        index < 6 && `stagger-${index + 1}`,
        isDropTarget
          ? (dropOverload ? 'border-red-400/70 ring-2 ring-red-400/40' : 'border-accent ring-2 ring-accent/40')
          : 'border-border',
        isUnassigned && 'border-dashed',
      )}
    >
      {/* Lane header */}
      <div className="flex items-center gap-2 min-w-0">
        <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', lane.palette.dot)} aria-hidden />
        <h2 className="text-sm font-bold tracking-tight text-ink truncate">{laneName}</h2>
        {hasRunning && (
          <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse shrink-0" title="On a job right now" aria-label="On a job right now" />
        )}
        <span className="text-[11px] text-ink-faint tabular-nums shrink-0">
          {doneCount > 0 ? `${doneCount}/${seq.length} done` : `${seq.length} stop${seq.length !== 1 ? 's' : ''}`}
        </span>
        {conflictBadge && (
          <span
            title={`${conflictBadge.count} conflict${conflictBadge.count !== 1 ? 's' : ''} in this lane`}
            className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold tabular-nums shrink-0',
              conflictBadge.severity === 'error' ? 'border-red-500/40 bg-red-500/10 text-red-400'
                : conflictBadge.severity === 'warn' ? 'border-amber-500/40 bg-amber-500/10 text-amber-400'
                : 'border-sky-500/40 bg-sky-500/10 text-sky-400')}>
            <AlertTriangle className="w-2.5 h-2.5" aria-hidden /> {conflictBadge.count}
          </span>
        )}
        {progress != null && progress.behindMin >= 10 && (
          <span
            title="The clock versus this lane's own ETA chain — the next unfinished stop should have been reached by now."
            className={cn('inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold tabular-nums shrink-0',
              progress.behindMin >= 30 ? 'border-red-500/40 bg-red-500/10 text-red-400' : 'border-amber-500/40 bg-amber-500/10 text-amber-400')}>
            ~{progress.behindMin}m behind
          </span>
        )}
        {route && seq.length > 0 && (
          // Hidden on phones: the crew NAME is the scarce information there, and
          // this chip's shrink-0 was what squeezed it to a few characters. The
          // finish time survives in the RouteTimeline header right below.
          <span className="ml-auto text-[11px] text-ink-muted tabular-nums shrink-0 hidden sm:inline">wraps ~{route.etas.finish}</span>
        )}
      </div>

      {/* The crew's note, surfaced where eyes actually are. The editable NoteBox
          sits at the BOTTOM of the card — below every stop — so on a long lane
          the note a dispatcher most needs ("gate code 4482, dog in yard") was
          reliably below the fold. Read-only here, from the SAVED body only
          (never NoteBox's in-flight draft — that would tangle with its awaited-
          save contract); the editor at the bottom stays the one writer. */}
      {isCrewLane && note?.body?.trim() && (
        <p className="text-[11px] text-amber-300/90 flex items-start gap-1.5 min-w-0" title={note.body.trim()}>
          <StickyNote className="w-3 h-3 shrink-0 mt-0.5" aria-hidden />
          <span className="line-clamp-2 whitespace-pre-wrap break-words">{note.body.trim()}</span>
        </p>
      )}

      {/* Capacity meter */}
      {!isUnassigned && route && (
        <div>
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span className={cn('font-semibold tabular-nums',
              load.state === 'overloaded' ? 'text-red-400' : load.state === 'full' ? 'text-amber-400' : 'text-ink-muted')}>
              {Math.round(route.workMin / 60 * 10) / 10}h of {Math.round(route.capacityMin / 60 * 10) / 10}h
            </span>
            <span className={cn('tabular-nums', load.state === 'overloaded' ? 'text-red-400 font-semibold' : 'text-ink-faint')}>
              {load.state === 'overloaded' ? `over by ${Math.abs(load.spareMin)}m` : `${load.spareMin}m free`}
            </span>
          </div>
          <div className="h-1 rounded-full bg-border overflow-hidden">
            <div className={cn('h-full rounded-full transition-all',
              load.state === 'overloaded' ? 'bg-red-400' : load.state === 'full' ? 'bg-amber-400' : 'bg-accent/80')}
              style={{ width: `${Math.min(100, load.pct)}%` }} />
          </div>
        </div>
      )}

      {/* The route-stats line that used to sit here said work-vs-capacity (the
          meter directly above already draws it), drive minutes (the timeline
          directly below prints them) and "Day used %" — three consecutive
          renderings of the same facts in every lane, costing ~44px each toward
          a first paint where no actual job row was visible at 1280×800. Its one
          non-duplicate fact, N/M done, moved into the lane header. */}

      {/* Roster chips: technicians (status menu) + vehicles */}
      {(technicians.length > 0 || vehicles.length > 0) && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {technicians.map(t => {
            const since = sinceMin(t.status_changed_at)
            const active = t.status === 'en_route' || t.status === 'on_job' || t.status === 'break'
            return (
              <Menu key={t.id} width={200} ariaLabel={`${t.name} actions`}
                items={[
                  ...TECH_STATUSES.map((s): MenuItem => ({
                    key: s, label: TECHNICIAN_STATUS_LABELS[s],
                    onSelect: () => onSetTechStatus(t, s),
                    disabled: s === t.status,
                  })),
                  ...(t.phone ? [
                    { key: 'call', label: `Call ${t.name}`, icon: Phone, onSelect: () => { window.location.href = `tel:${t.phone}` } },
                    { key: 'sms', label: `Text ${t.name}`, icon: MessageSquare, onSelect: () => { window.location.href = `sms:${t.phone}` } },
                  ] as MenuItem[] : []),
                ]}>
                {({ toggle, triggerProps }) => (
                  <button type="button" onClick={toggle} {...triggerProps}
                    title={`${t.name} — ${TECHNICIAN_STATUS_LABELS[t.status]}${since != null ? ` for ${fmtSince(since)}` : ''}`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-1 text-[11px] font-medium text-ink-muted hover:text-ink hover:border-border-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                    <HardHat className="w-3 h-3 text-ink-faint" />
                    <span className="truncate max-w-[9rem]">{t.name}</span>
                    <span className={cn('w-1.5 h-1.5 rounded-full', TECH_STATUS_META[t.status].dot)} aria-hidden />
                    <span className="text-ink-faint tabular-nums">
                      {TECHNICIAN_STATUS_LABELS[t.status]}{active && since != null ? ` · ${fmtSince(since)}` : ''}
                    </span>
                  </button>
                )}
              </Menu>
            )
          })}
          {vehicles.map(v => (
            <span key={v.id} title={v.category} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-1 text-[11px] text-ink-faint">
              <Truck className="w-3 h-3" /> <span className="truncate max-w-[8rem]">{v.name}</span>
            </span>
          ))}
        </div>
      )}

      {/* Timeline — the day drawn as time (shared component, per-lane data) */}
      {route && seq.length > 0 && (
        <RouteTimeline
          startMin={route.etas.startMin}
          finishMin={route.etas.finishMin}
          capacityEndMin={timeToMinutes(route.startHHmm) + route.capacityMin}
          stops={timelineStops}
          nowMin={nowMin}
          onSelectStop={id => document.getElementById(`dispatch-stop-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
        />
      )}

      {/* Stops */}
      {visibleSeq.length === 0 ? (
        <>
          {isDropTarget && dropAnchor === null && dropLine}
          <InlineEmpty icon={Radio} className="py-5">
            {seq.length > 0 ? `All ${seq.length} hidden by filters.`
              : isUnassigned ? 'Nothing unassigned — drop a visit here to pull it off a crew.'
              // Balance only ever fills CREW lanes, so offering it here would
              // point at a button that will never put work on this person.
              : isCrewLane ? 'No visits — drag one in, or Balance the day.'
              : 'No visits — drag one in.'}
          </InlineEmpty>
        </>
      ) : (
        <div ref={flipRef} className="space-y-1.5">
          {visibleSeq.map((job, vi) => {
            const i = orderIdx.get(job.id) ?? 0
            const eta = etaByJob.get(job.id)
            const busy = statusBusy.has(job.id)
            const grabbed = kbGrabbedId === job.id
            const promisedMin = job.start_time ? timeToMinutes(job.start_time) : null
            const late = promisedMin != null && eta != null && eta.arrivalMin > promisedMin + 15
            const isNext = progress?.nextJobId === job.id && job.status !== 'completed'
            const legKm = showLegs ? legKmByJob.get(job.id) ?? null : null
            const legMin = legKm != null ? legMinutes(legKm) : null
            // Where this visit could go instead, from THE chooser: a crew, one
            // person, or nobody — each with the line that says what picking it
            // means, and disabled where the crew is deactivated or the person is
            // off the roster. Unassign sorts last so it can't be misclicked
            // between two destinations.
            const current = assigneeOf(job)
            const destinations = assignmentOptions({ crews, technicians: roster, current })
              .filter(o => !sameAssignee(o.assignee, current))
            const menuItems: MenuItem[] = [
              ...(job.status === 'scheduled' ? [{
                key: 'done', label: 'Mark done (skip check-in)', icon: CheckCircle2, onSelect: () => onQuickComplete(job),
              } as MenuItem] : []),
              // Proof of work. Available at every stage, and it writes nothing
              // but the record — never a status, never an invoice.
              {
                key: 'record',
                label: job.completion_summary || job.completion_issue ? 'Edit what was done' : 'Record what was done',
                icon: NotebookPen,
                onSelect: () => onRecord(job),
              } as MenuItem,
              // Crew destinations carry their room (crewRoom); a person carries
              // the chooser's own line about what picking them means.
              ...[...destinations.filter(o => o.group !== 'none'), ...destinations.filter(o => o.group === 'none')]
                .map((o): MenuItem => {
                  const a = o.assignee
                  const crew = a.kind === 'crew' ? crews.find(c => c.id === a.crewId) : undefined
                  return {
                    key: o.value,
                    label: a.kind === 'unassigned' ? 'Unassign' : `Move to ${o.label}${crew ? crewRoom(crew) : ''}`,
                    description: o.hint ?? undefined,
                    icon: a.kind === 'unassigned' ? UserMinus : a.kind === 'person' ? HardHat : Users,
                    disabled: o.disabled,
                    onSelect: () => onMoveTo(job.id, a),
                  }
                }),
              ...(job.properties?.address || (job.properties?.lat != null) ? [{
                key: 'directions', label: 'Directions', icon: Navigation,
                onSelect: () => window.open(directionsUrl({ lat: job.properties?.lat ?? null, lng: job.properties?.lng ?? null, address: job.properties?.address }, base), '_blank'),
              } as MenuItem] : []),
            ]
            return (
              // content-visibility keeps a 300-stop day scrolling smoothly:
              // offscreen rows skip layout/paint until they approach the viewport.
              <div key={job.id} data-flip-id={job.id} className="[content-visibility:auto] [contain-intrinsic-size:auto_56px]">
                {legMin != null && legMin >= 5 && (
                  <p className="pl-12 pb-1 text-[10px] leading-none text-ink-faint tabular-nums" aria-hidden>
                    ↓ ~{legMin}m {vi === 0 ? 'from base' : 'drive'}
                  </p>
                )}
                {isDropTarget && dropAnchor === job.id && dropLine}
                <div id={`dispatch-stop-${job.id}`} data-stop-row={job.id}
                  className={cn('rounded-lg border bg-surface px-2.5 py-2 flex items-center gap-2 transition-shadow',
                    dragging?.jobId === job.id && 'opacity-40',
                    grabbed ? 'border-accent ring-2 ring-accent/40' : 'border-border',
                    flashJobId === job.id && 'ring-2 ring-accent border-accent',
                    isNext && !grabbed && 'border-l-2 border-l-accent',
                    job.status === 'completed' && 'opacity-60')}>
                  <SelectCheckbox
                    checked={selectedSet.has(job.id)}
                    onToggle={shift => onToggleSelect(job.id, shift)}
                    label={`Select ${job.customers?.name || job.title}`}
                  />
                  <button
                    type="button"
                    id={`dispatch-grip-${job.id}`}
                    onPointerDown={e => onDragHandleDown(e, job, lane.laneId)}
                    onKeyDown={e => onGripKeyDown(e, job, lane.laneId)}
                    aria-pressed={grabbed}
                    aria-keyshortcuts="Enter"
                    className={cn('shrink-0 cursor-grab active:cursor-grabbing touch-none rounded p-0.5 -m-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                      grabbed ? 'text-accent' : 'text-ink-faint hover:text-ink')}
                    title="Drag to move — or press Enter, then use the arrows"
                    aria-label={`Move ${job.customers?.name || job.title}. Press Enter to grab, then arrows to reorder it or move it between crews and people.`}
                  >
                    <GripVertical className="w-4 h-4" />
                  </button>
                  <span className="w-5 h-5 rounded-md bg-bg-tertiary border border-border text-[10px] font-bold text-ink-muted flex items-center justify-center shrink-0 tabular-nums">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <p className="text-xs font-semibold text-ink truncate">{job.customers?.name || job.title}</p>
                      {isNext && (
                        <span className="shrink-0 rounded border border-accent/30 bg-accent/10 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-accent-text" title="First unfinished stop on this route">
                          next
                        </span>
                      )}
                    </div>
                    {/* Which property — a customer can have several; the name alone
                        doesn't say which one this stop is at. */}
                    <VisitAddress address={job.properties?.address} />
                    <p className="text-[11px] text-ink-faint truncate tabular-nums">
                      {/* A checked-in crew has no future arrival: the planned ETA
                          is moot the moment they're on site, and showing it made
                          the running stop read like one still being driven to.
                          What the owner needs there is how long they've been on
                          it, next to the estimate it's burning against. */}
                      {/* nowMin-gated: only today's board ticks a live clock — on a
                          past day a leftover in_progress row would render a huge
                          stale figure that never updates. */}
                      {job.status === 'in_progress' && job.started_at && nowMin != null
                        ? <span className="text-sky-300">on site {Math.max(1, Math.round((Date.now() - new Date(job.started_at).getTime()) / 60000))}m</span>
                        // ⭐ Underway, nobody on the clock — stopped for the day.
                        // Neither "on site" nor an ETA: the crew has been and is
                        // coming back, and an ETA here would be a lie about a
                        // visit that is already part-worked. Says the time
                        // already recorded instead.
                        : job.status === 'in_progress'
                          ? <span className="text-amber-300">
                              stopped{job.actual_minutes ? ` · ${formatWorked(job.actual_minutes)} so far` : ''}
                            </span>
                        : eta ? `ETA ${eta.arrival}` : 'ETA —'}
                      {promisedMin != null && job.status !== 'in_progress' && (
                        <span className={late ? 'text-red-400 font-semibold' : undefined}> · promised {minutesToTime12(promisedMin)}</span>
                      )}
                      {' '}· {formatDuration(job.duration_minutes || DEFAULT_JOB_MIN, workdayMin)}
                      {job.service_type ? ` · ${job.service_type}` : ''}
                    </p>
                    {/* The gate code finally shows up where the truck is. job.notes
                        was loaded (select *) and rendered NOWHERE on this board —
                        access instructions lived one modal away from the person
                        radioing them to a crew. Same line-clamp treatment as the
                        schedule's day board. */}
                    {job.notes?.trim() && (
                      <p className="text-[11px] text-amber-300/90 flex items-start gap-1 min-w-0" title={job.notes.trim()}>
                        <StickyNote className="w-3 h-3 shrink-0 mt-0.5" aria-hidden />
                        <span className="line-clamp-1 whitespace-pre-wrap break-words">{job.notes.trim()}</span>
                      </p>
                    )}
                  </div>
                  {job.status !== 'scheduled' && (
                    <Badge tone={jobStatusTone[job.status]} className="shrink-0 !text-[9px]">{JOB_STATUS_LABELS[job.status]}</Badge>
                  )}
                  {/* One-tap status: ▶ check in, then ✓ complete (invoice + message
                      ride along through the shared seam). */}
                  {(job.status === 'scheduled' || job.status === 'in_progress') && (
                    <button
                      type="button"
                      onClick={() => (job.status === 'scheduled' ? onQuickStart(job) : onQuickComplete(job))}
                      disabled={busy}
                      title={job.status === 'scheduled' ? 'Start this visit (check in)' : 'Complete this visit — drafts the invoice'}
                      aria-label={job.status === 'scheduled'
                        ? `Start ${job.customers?.name || job.title}`
                        : `Complete ${job.customers?.name || job.title}`}
                      className={cn('shrink-0 rounded-md border p-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40',
                        job.status === 'scheduled'
                          ? 'border-border text-ink-faint hover:text-sky-300 hover:border-sky-400/50'
                          : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20')}
                    >
                      {busy
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
                        : job.status === 'scheduled'
                          ? <Play className="w-3.5 h-3.5" aria-hidden />
                          : <Check className="w-3.5 h-3.5" aria-hidden />}
                    </button>
                  )}
                  <div className="flex flex-col shrink-0">
                    {/* Disabled on the VISIBLE index, matching what a nudge now
                        does (hop the visible neighbour). Keying on the full-seq
                        index left the first visible row's up-chevron enabled
                        when everything above it was filtered out — a live
                        button whose click did nothing an owner could see. */}
                    <button type="button" onClick={() => onNudge(lane.laneId, job.id, -1)} disabled={vi === 0}
                      className="text-ink-faint hover:text-ink disabled:opacity-25 rounded p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" aria-label="Move earlier">
                      <ChevronUp className="w-3.5 h-3.5" />
                    </button>
                    <button type="button" onClick={() => onNudge(lane.laneId, job.id, 1)} disabled={vi === visibleSeq.length - 1}
                      className="text-ink-faint hover:text-ink disabled:opacity-25 rounded p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" aria-label="Move later">
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {menuItems.length > 0 && (
                    // Wider than the other menus on purpose: each destination
                    // now carries the line that says what picking it means, and
                    // a clamped hint is a hint nobody reads.
                    <Menu width={280} align="end" ariaLabel="Visit actions" items={menuItems}>
                      {({ toggle, triggerProps }) => (
                        <button type="button" onClick={toggle} {...triggerProps} aria-label="Visit actions"
                          className="shrink-0 text-ink-faint hover:text-ink rounded px-1.5 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"><MoreHorizontal className="w-4 h-4" /></button>
                      )}
                    </Menu>
                  )}
                </div>
              </div>
            )
          })}
          {isDropTarget && dropAnchor === null && dropLine}
        </div>
      )}
      {hiddenCount > 0 && visibleSeq.length > 0 && (
        <p className="text-[11px] text-ink-faint">{hiddenCount} stop{hiddenCount !== 1 ? 's' : ''} hidden by filters — the timeline and totals still count them.</p>
      )}
      {cancelledCount > 0 && (
        // WHO was cancelled, not just how many. laneSequence strips cancelled
        // rows from the route (correctly — they're not driven to), but a bare
        // count made "did the Hendersons' cancellation actually land?" require
        // leaving the board. The identities are already in lane.jobs; name them.
        <p className="text-[11px] text-ink-faint"
          title={lane.jobs.filter(j => j.status === 'cancelled').map(j => j.customers?.name || j.title).join(', ')}>
          Cancelled today: {lane.jobs.filter(j => j.status === 'cancelled').slice(0, 3).map(j => j.customers?.name || j.title).join(', ')}
          {cancelledCount > 3 ? ` +${cancelledCount - 3} more` : ''} — not on the route.
        </p>
      )}

      {/* Lane footer: route actions + note */}
      {!isUnassigned && (
        <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-border">
          <Button variant="ghost" size="sm" onClick={() => onBestOrder(lane.laneId)} loading={optimizing}
            disabled={seq.filter(j => j.status === 'scheduled').length < 2 || !base}
            title={base ? `Reorder ${laneName}’s stops into the best route` : 'Set a base address in Settings first'}>
            <Wand2 className="w-3.5 h-3.5" /> Best order
          </Button>
          {savingsKm > 0 && !optimizing && (
            <button
              type="button"
              onClick={() => onBestOrder(lane.laneId)}
              title="The optimizer's own estimate against the current order — tap to apply Best order."
              className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent-text tabular-nums hover:bg-accent/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 animate-fade"
            >
              save ~{savingsKm} km
            </button>
          )}
          {base && route && route.ordered.some(s => s.lat != null) && (
            <a href={roundTripMapsUrl(base, route.ordered)} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink px-2 py-1 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              <ExternalLink className="w-3.5 h-3.5" /> Maps
            </a>
          )}
          {seq.length > 0 && (
            <>
              <button type="button" onClick={() => onCopyItinerary(lane.laneId)}
                title={`Copy ${laneName}’s itinerary as text — paste it into a message`}
                aria-label={`Copy ${laneName} itinerary`}
                className="inline-flex items-center text-ink-faint hover:text-ink px-1.5 py-1 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <Copy className="w-3.5 h-3.5" />
              </button>
              <button type="button" onClick={() => onPrintLane(lane.laneId)}
                title={`Print ${laneName}’s sheet only`}
                aria-label={`Print ${laneName} sheet`}
                className="inline-flex items-center text-ink-faint hover:text-ink px-1.5 py-1 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <Printer className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          {route && route.totalKm > 0 && (
            <span className="ml-auto text-[11px] text-ink-faint tabular-nums">~{route.totalKm} km</span>
          )}
        </div>
      )}
      {/* Crew lanes only — see isCrewLane. A person's instructions belong on the
          visit itself, which every one of their stops already shows. */}
      {isCrewLane && (
        <NoteBox compact icon={StickyNote} placeholder={`Note for ${laneName}…`}
          value={note?.body ?? ''} updatedAt={note?.updated_at ?? null} onSave={body => onSaveNote(lane.laneId, body)} />
      )}
    </section>
  )
})

// ── Dispatch note ────────────────────────────────────────────────────────────
// One note per (day, crew). Saves ITSELF: 1.5s after the typing pauses (blur and
// Cmd/Ctrl+Enter still flush immediately), then shows a quiet "Saved ✓" — a gate
// code jotted mid-phone-call must not depend on remembering to click away.
// Clearing the text deletes the row. Controlled locally so realtime refreshes
// never eat keystrokes.
//
// ⚠️ "Saved" MEANS SAVED. This used to call onSave() without awaiting it, advance
// lastSaved, and flash the green ✓ in the same tick — so a write that failed still
// showed "Saved", and because lastSaved had already moved to the unsaved text
// nothing ever retried it. A gate code typed for a crew simply never left the
// device while the board said it had. onSave now RETURNS the error (null = landed)
// and every transition waits on it:
//   • in flight        → "Saving…", never ✓
//   • landed           → lastSaved advances, ✓
//   • failed           → 'error' phase, lastSaved does NOT advance, the text stays
//                        in the box, and the next blur/edit retries it for real.
// Leaving lastSaved behind on failure is what makes the re-seed effect below
// correct too: draft !== lastSaved, so an incoming realtime refresh knows the box
// is mid-edit and won't overwrite the words that haven't landed yet.
function NoteBox({ value, onSave, placeholder, compact, icon: Icon, updatedAt, autoFocus }: {
  value: string
  onSave: (body: string) => Promise<string | null>
  placeholder: string
  compact?: boolean
  icon: typeof StickyNote
  updatedAt?: string | null
  /** The collapsed "+ Add a day note" affordance expands INTO this box — focus
   *  must land in the textarea or the tap did nothing visible. */
  autoFocus?: boolean
}) {
  const [draft, setDraft] = useState(value)
  const [phase, setPhase] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle')
  const lastSaved = useRef(value)
  const debounceT = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedT = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The exact text currently in flight. Blur fires while the debounced save is
  // still awaiting, and without this the same note would be written twice.
  const inFlight = useRef<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  useEffect(() => {
    // Adopt remote changes only when the box isn't mid-edit.
    if (value !== lastSaved.current && draft === lastSaved.current) setDraft(value)
    lastSaved.current = value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  useEffect(() => () => {
    if (debounceT.current) clearTimeout(debounceT.current)
    if (savedT.current) clearTimeout(savedT.current)
  }, [])

  const commit = async (text: string) => {
    if (debounceT.current) { clearTimeout(debounceT.current); debounceT.current = null }
    if (text === lastSaved.current) { setPhase(p => (p === 'error' ? p : 'idle')); return }
    if (inFlight.current === text) return          // already writing exactly this
    inFlight.current = text
    setPhase('saving')
    let err: string | null
    try { err = await onSave(text) }
    catch (e) { err = e instanceof Error ? e.message : 'save failed' }
    finally { if (inFlight.current === text) inFlight.current = null }
    if (!alive.current) return
    // Persistence confirmed — only now is the ✓ true and the baseline allowed to move.
    if (err) { setPhase('error'); return }
    lastSaved.current = text
    setPhase('saved')
    if (savedT.current) clearTimeout(savedT.current)
    savedT.current = setTimeout(() => setPhase(p => (p === 'saved' ? 'idle' : p)), 2000)
  }
  const onChange = (text: string) => {
    setDraft(text)
    setPhase('dirty')
    if (debounceT.current) clearTimeout(debounceT.current)
    debounceT.current = setTimeout(() => commit(text), 1500)
  }

  return (
    <div className={cn('flex items-start gap-2', compact ? '' : 'rounded-card border border-border bg-bg-secondary p-3 animate-rise')}>
      <Icon className="w-3.5 h-3.5 text-ink-faint shrink-0 mt-1.5" aria-hidden
        {...(updatedAt ? { 'aria-label': `Note last saved ${new Date(updatedAt).toLocaleString()}` } : {})} />
      <textarea
        value={draft}
        onChange={e => onChange(e.target.value)}
        onBlur={() => { void commit(draft) }}
        onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void commit(draft) } }}
        placeholder={placeholder}
        autoFocus={autoFocus}
        // Grow with the note (to 4 rows) instead of clipping at 2. Gate codes and
        // access instructions are exactly the notes that run several lines, and a
        // resize-none textarea was silently hiding line three of them — the only
        // reading surface these notes have.
        rows={Math.min(4, Math.max(draft.split('\n').length, draft.length > 80 || draft.includes('\n') ? 2 : 1))}
        aria-label={placeholder}
        title={updatedAt ? `Last saved ${new Date(updatedAt).toLocaleString()}` : undefined}
        className="flex-1 resize-none bg-transparent text-xs text-ink placeholder:text-ink-faint outline-none border-b border-transparent focus:border-border-strong transition-colors py-1"
      />
      {phase === 'dirty' && <span className="text-[10px] text-ink-faint shrink-0 mt-1.5 animate-fade">…</span>}
      {phase === 'saving' && (
        <span className="inline-flex items-center gap-0.5 text-[10px] text-ink-faint shrink-0 mt-1.5 animate-fade">
          <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> Saving…
        </span>
      )}
      {/* The crew reads this box for their instructions, so an unsaved note has to
          look unsaved — and say what to do about it — rather than sit there in the
          textarea looking exactly like one that landed. */}
      {phase === 'error' && (
        <span role="status" className="inline-flex items-center gap-0.5 text-[10px] text-red-400 shrink-0 mt-1.5 animate-fade">
          <AlertTriangle className="w-3 h-3" aria-hidden /> Not saved — retry
        </span>
      )}
      {phase === 'saved' && (
        <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-400 shrink-0 mt-1.5 animate-fade">
          <Check className="w-3 h-3" aria-hidden /> Saved
        </span>
      )}
    </div>
  )
}

// ── Balance preview ──────────────────────────────────────────────────────────
function BalanceModal({ plan, lanes, applying, onApply, onClose }: {
  plan: BalancePlan
  lanes: CrewLaneData[]
  applying: boolean
  onApply: () => void
  onClose: () => void
}) {
  const laneName = (id: string) => {
    const lane = lanes.find(l => l.laneId === id)
    return lane ? laneLabel(lane) : 'Unassigned'
  }
  const laneDot = (id: string) => lanes.find(l => l.laneId === id)?.palette.dot ?? 'bg-ink-faint'
  const fmtH = (min: number) => `${Math.round(min / 60 * 10) / 10}h`
  return (
    <Modal open onClose={onClose} title="Balance the day" icon={Scale} size="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={onApply} loading={applying} disabled={plan.moves.length === 0}>
            Apply {plan.moves.length > 0 ? `${plan.moves.length} move${plan.moves.length !== 1 ? 's' : ''}` : ''}
          </Button>
        </div>
      }>
      {plan.moves.length === 0 ? (
        <InlineEmpty icon={Scale}>Already as even as it can get — nothing worth moving.</InlineEmpty>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">
            Evens out booked time across crews (biggest unassigned visits placed first). Time only — after applying, use each lane&apos;s <span className="font-semibold text-ink">Best order</span> to re-route.
          </p>
          <div className="space-y-1.5">
            {plan.moves.map(m => (
              <div key={m.jobId} className="flex items-center gap-2 text-sm rounded-lg border border-border bg-surface px-3 py-2">
                <span className="font-semibold text-ink truncate">{m.title}</span>
                <span className="text-[11px] text-ink-faint tabular-nums shrink-0">{m.minutes}m</span>
                <span className="ml-auto flex items-center gap-1.5 text-xs text-ink-muted shrink-0">
                  <span className={cn('w-1.5 h-1.5 rounded-full', laneDot(m.fromLaneId))} />{laneName(m.fromLaneId)}
                  <ChevronRight className="w-3 h-3 text-ink-faint" />
                  <span className={cn('w-1.5 h-1.5 rounded-full', laneDot(m.toLaneId))} />{laneName(m.toLaneId)}
                </span>
              </div>
            ))}
          </div>
          <div className="rounded-card border border-border bg-bg-tertiary px-3.5 py-2.5 space-y-1">
            {Object.keys(plan.after).filter(id => id !== UNASSIGNED_ID || (plan.before[id] ?? 0) > 0).map(id => (
              <div key={id} className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 text-ink-muted"><span className={cn('w-1.5 h-1.5 rounded-full', laneDot(id))} />{laneName(id)}</span>
                <span className="tabular-nums text-ink">{fmtH(plan.before[id] ?? 0)} → <span className="font-semibold">{fmtH(plan.after[id] ?? 0)}</span></span>
              </div>
            ))}
            <p className="text-[11px] text-ink-faint pt-1 tabular-nums">Spread {fmtH(plan.spreadBefore)} → {fmtH(plan.spreadAfter)} between crews.</p>
          </div>
        </div>
      )}
    </Modal>
  )
}
