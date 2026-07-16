'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { format, parseISO, addDays } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { Job, Crew, Technician, DispatchNote, TechnicianStatus, TECHNICIAN_STATUS_LABELS, JOB_STATUS_LABELS } from '@/types'
import {
  partitionByCrew, laneSequence, laneWorkMinutes, laneLoad, crewCapacityMinutes, crewDayStart,
  balanceDay, BalancePlan, UNASSIGNED_ID, CrewLaneData,
  loadCrews, loadTechnicians, loadDispatchNotes, saveDispatchNote, setTechnicianStatus, assignJobCrew,
  TECH_STATUS_META, TECH_STATUSES,
} from '@/lib/crews'
import {
  RouteStop, OrderedRouteStop, sequenceRoute, optimizeRoute, geocodeMissingStops,
  computeDayEtas, DayEtas, timeToMinutes, minutesToTime12, roundTripMapsUrl, directionsUrl,
  DEFAULT_JOB_MIN, DEFAULT_WORK_START,
} from '@/lib/route'
import { DayStatusRow, DAY_STATUS_SELECT, dayStatusLabel } from '@/lib/dayStatus'
import { Coord } from '@/lib/geo'
import { RouteTimeline, TimelineStop } from '@/components/schedule/RouteTimeline'
import { DispatchMap, DispatchMapLane } from '@/components/dispatch/DispatchMap'
import { CrewManager, AssignableEquipment } from '@/components/dispatch/CrewManager'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { StatTile } from '@/components/ui/StatTile'
import { FilterPill } from '@/components/ui/FilterPill'
import { Badge, jobStatusTone } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Menu, MenuItem } from '@/components/ui/Menu'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonTiles, SkeletonRows } from '@/components/ui/Skeleton'
import { Modal } from '@/components/ui/Modal'
import { toast as notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  Radio, Users, MapIcon, LayoutGrid, ChevronLeft, ChevronRight, Scale, GripVertical,
  ChevronUp, ChevronDown, Wand2, ExternalLink, Truck, StickyNote, HardHat, Navigation,
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
  const [managerOpen, setManagerOpen] = useState(false)
  const [balancePlan, setBalancePlan] = useState<BalancePlan | null>(null)
  const [applyingBalance, setApplyingBalance] = useState(false)
  const [optimizingLane, setOptimizingLane] = useState<string | null>(null)
  const geocodedFor = useRef<string | null>(null)
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
        supabase.from('business_settings').select('base_lat, base_lng, work_start_time, daily_capacity_hours').eq('user_id', user.id).maybeSingle(),
        loadDispatchNotes(supabase, user.id, date),
      ])
      if (jRes.error) { setLoadError('Could not load the day: ' + jRes.error.message); return }
      setLoadError(null)
      setJobs((jRes.data as Job[]) || [])
      setCrews(cRes)
      setTechnicians(tRes)
      setEquipment((eRes.data as AssignableEquipment[] | null) || [])
      setDayRow((dRes.data as DayStatusRow | null) ?? null)
      const s = sRes.data as { base_lat: number | null; base_lng: number | null; work_start_time: string | null; daily_capacity_hours: number | null } | null
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
  const lanes = useMemo(() => partitionByCrew(jobs, crews), [jobs, crews])
  const activeCrewCount = crews.filter(c => c.is_active).length

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

  const activeJobs = useMemo(() => jobs.filter(j => j.status !== 'cancelled'), [jobs])
  const assignedCount = activeJobs.filter(j => j.crew_id && crews.some(c => c.id === j.crew_id && c.is_active)).length
  const isToday = date === todayISO()
  const nowMin = isToday ? new Date().getHours() * 60 + new Date().getMinutes() : undefined
  const latestFinish = useMemo(() => {
    const fins = lanes.filter(l => laneRoutes[l.laneId]?.seq.length).map(l => laneRoutes[l.laneId].etas.finishMin)
    return fins.length ? Math.max(...fins) : null
  }, [lanes, laneRoutes])
  const totalKm = useMemo(() =>
    Math.round(lanes.reduce((s, l) => s + (laneRoutes[l.laneId]?.totalKm ?? 0), 0) * 10) / 10,
  [lanes, laneRoutes])

  const mapLanes: DispatchMapLane[] = useMemo(() => lanes.map(lane => ({
    id: lane.laneId,
    name: lane.crew?.name ?? 'Unassigned',
    hex: lane.palette.hex,
    stops: (laneRoutes[lane.laneId]?.ordered ?? [])
      .filter(s => s.lat != null && s.lng != null)
      .map(s => ({ lat: s.lat as number, lng: s.lng as number, order: s.order, title: s.title })),
  })), [lanes, laneRoutes])

  // ── Actions ──
  const moveJob = useCallback(async (jobId: string, toCrewId: string | null) => {
    const job = jobs.find(j => j.id === jobId)
    if (!job || (job.crew_id ?? null) === toCrewId) return
    const prev = { crew_id: job.crew_id ?? null, route_order: job.route_order ?? null }
    setJobs(cur => cur.map(j => j.id === jobId ? { ...j, crew_id: toCrewId, route_order: null } : j))
    const err = await assignJobCrew(supabase, jobId, toCrewId)
    if (err) {
      setJobs(cur => cur.map(j => j.id === jobId ? { ...j, ...prev } : j))
      notify.error('Could not move the job: ' + err)
      return
    }
    const toName = toCrewId ? crews.find(c => c.id === toCrewId)?.name ?? 'crew' : 'Unassigned'
    notify(`${job.customers?.name || job.title} → ${toName}`, {
      undo: async () => { await supabase.from('jobs').update(prev).eq('id', jobId); fetchAll() },
    })
  }, [jobs, crews, supabase, fetchAll])

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

  const nudgeJob = useCallback((laneId: string, jobId: string, dir: -1 | 1) => {
    const seq = laneRoutes[laneId]?.seq.map(j => j.id) ?? []
    const i = seq.indexOf(jobId)
    const target = i + dir
    if (i < 0 || target < 0 || target >= seq.length) return
    const next = [...seq]
    ;[next[i], next[target]] = [next[target], next[i]]
    applyLaneOrder(next)
  }, [laneRoutes, applyLaneOrder])

  // Per-lane route optimization: the SAME optimizeRoute (real-road first,
  // haversine fallback) the schedule uses, persisted as this lane's order.
  const bestOrderLane = useCallback(async (laneId: string) => {
    const route = laneRoutes[laneId]
    if (!route || !settings.base) return
    setOptimizingLane(laneId)
    try {
      const stops = route.seq.map(jobStop)
      await geocodeMissingStops(supabase, stops)
      const r = await optimizeRoute(settings.base, stops)
      if (r.ordered.length === 0) { notify('No located stops to order in this lane.'); return }
      const orderedIds = r.ordered.map(s => s.jobId)
      const rest = route.seq.map(j => j.id).filter(id => !orderedIds.includes(id))
      applyLaneOrder([...orderedIds, ...rest])
      notify.success(`Route ordered — ~${r.totalKm} km${r.usedGoogle ? ' by road' : ''}${rest.length ? ` · ${rest.length} without an address kept at the end` : ''}`)
    } finally {
      setOptimizingLane(null)
    }
  }, [laneRoutes, settings.base, supabase, applyLaneOrder])

  const openBalance = useCallback(() => {
    setBalancePlan(balanceDay(lanes.map(l => ({
      laneId: l.laneId, jobs: l.jobs, capacityMin: laneRoutes[l.laneId]?.capacityMin ?? 0,
    }))))
  }, [lanes, laneRoutes])

  const applyBalance = useCallback(async () => {
    if (!balancePlan || balancePlan.moves.length === 0) { setBalancePlan(null); return }
    setApplyingBalance(true)
    const snapshot = balancePlan.moves.map(m => {
      const j = jobs.find(x => x.id === m.jobId)
      return { id: m.jobId, crew_id: j?.crew_id ?? null, route_order: j?.route_order ?? null }
    })
    const results = await Promise.all(balancePlan.moves.map(m =>
      supabase.from('jobs').update({ crew_id: m.toLaneId === UNASSIGNED_ID ? null : m.toLaneId, route_order: null }).eq('id', m.jobId),
    ))
    setApplyingBalance(false)
    setBalancePlan(null)
    const failed = results.find(r => r.error)
    if (failed?.error) { notify.error('Some moves failed: ' + failed.error.message); fetchAll(); return }
    fetchAll()
    notify(`Balanced — ${balancePlan.moves.length} visit${balancePlan.moves.length !== 1 ? 's' : ''} moved.`, {
      undo: async () => {
        await Promise.all(snapshot.map(s => supabase.from('jobs').update({ crew_id: s.crew_id, route_order: s.route_order }).eq('id', s.id)))
        fetchAll()
      },
    })
  }, [balancePlan, jobs, supabase, fetchAll])

  // ── Cross-lane drag (pointer events — the Calendar's touch-safe engine) ──
  const dragRef = useRef<{ jobId: string; fromLane: string; title: string; started: boolean; sx: number; sy: number } | null>(null)
  const [dragging, setDragging] = useState<{ jobId: string; title: string } | null>(null)
  const [overLane, setOverLane] = useState<string | null>(null)
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null)

  const onDragHandleDown = useCallback((e: React.PointerEvent, job: Job, laneId: string) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    dragRef.current = { jobId: job.id, fromLane: laneId, title: job.customers?.name || job.title, started: false, sx: e.clientX, sy: e.clientY }
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      if (!d.started) {
        if (Math.abs(ev.clientX - d.sx) + Math.abs(ev.clientY - d.sy) < 6) return
        d.started = true
        setDragging({ jobId: d.jobId, title: d.title })
      }
      ev.preventDefault()
      setGhost({ x: ev.clientX, y: ev.clientY })
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      setOverLane((el?.closest('[data-lane]') as HTMLElement | null)?.dataset.lane ?? null)
    }
    const finish = (ev: PointerEvent) => {
      const d = dragRef.current
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointercancel', finish)
      if (d?.started) {
        const el = document.elementFromPoint(ev.clientX, ev.clientY)
        const target = (el?.closest('[data-lane]') as HTMLElement | null)?.dataset.lane
        if (ev.type === 'pointerup' && target && target !== d.fromLane) {
          moveJob(d.jobId, target === UNASSIGNED_ID ? null : target)
        }
      }
      dragRef.current = null
      setDragging(null); setOverLane(null); setGhost(null)
    }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
  }, [moveJob])

  // ── Render ──
  const dateLabel = format(parseISO(date + 'T00:00:00'), 'EEEE, MMM d')
  const dayNote = notes.find(n => n.crew_id === null)

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
      <PageHeader
        title="Dispatch"
        description={`${dateLabel} · ${activeJobs.length} visit${activeJobs.length !== 1 ? 's' : ''}`}
        action={
          <Button variant="secondary" size="sm" onClick={() => setManagerOpen(true)}>
            <Users className="w-3.5 h-3.5" /> Crews & roster
          </Button>
        }
      />

      {loadError && (
        <Banner tone="danger" action={<Button size="sm" variant="secondary" onClick={() => { setLoading(true); fetchAll() }}>Retry</Button>}>
          {loadError}
        </Banner>
      )}

      {dayRow?.blocks && (
        <Banner tone="warn">
          This day is marked {dayStatusLabel(dayRow)} — capacity is zero. Anything still scheduled needs a new day or an explicit exception.
        </Banner>
      )}

      {/* Toolbar: date nav · view · balance */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setDate(d => format(addDays(parseISO(d + 'T00:00:00'), -1), 'yyyy-MM-dd'))} aria-label="Previous day">
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDate(d => format(addDays(parseISO(d + 'T00:00:00'), 1), 'yyyy-MM-dd'))} aria-label="Next day">
            <ChevronRight className="w-4 h-4" />
          </Button>
          {!isToday && (
            <Button variant="secondary" size="sm" onClick={() => setDate(todayISO())}>Today</Button>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <FilterPill active={view === 'board'} onClick={() => setView('board')}><LayoutGrid className="w-3.5 h-3.5" /> Board</FilterPill>
          <FilterPill active={view === 'map'} onClick={() => setView('map')}><MapIcon className="w-3.5 h-3.5" /> Map</FilterPill>
          <Button variant="secondary" size="sm" onClick={openBalance} disabled={activeCrewCount < 1 || activeJobs.length === 0}
            title="Even out the day's booked minutes across crews">
            <Scale className="w-3.5 h-3.5" /> Balance
          </Button>
        </div>
      </div>

      {/* Day pulse */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 animate-rise">
        <StatTile label="Visits" value={activeJobs.length} icon={Radio} />
        <StatTile label="Assigned" value={activeCrewCount ? `${assignedCount}/${activeJobs.length}` : '—'}
          sub={activeCrewCount ? (assignedCount < activeJobs.length ? 'Balance can place the rest' : 'Everything has a crew') : 'Create crews to assign work'} />
        <StatTile label="Day finish" value={latestFinish != null ? minutesToTime12(latestFinish) : '—'} sub={latestFinish != null ? 'latest crew, est.' : undefined} />
        <StatTile label="Drive" value={settings.base ? `~${totalKm} km` : '—'}
          sub={settings.base ? 'all crews, straight-line est.' : 'Set a base address in Settings'} />
      </div>

      {activeCrewCount === 0 && activeJobs.length > 0 && (
        <Banner tone="accent" icon={Users}
          action={<Button size="sm" onClick={() => setManagerOpen(true)}>Create a crew</Button>}>
          The whole day is one route today. Create crews to dispatch it across teams.
        </Banner>
      )}

      {view === 'map' ? (
        <div className="animate-rise">
          <DispatchMap base={settings.base} lanes={mapLanes} height={560} />
          {!settings.base && (
            <p className="text-[11px] text-ink-faint mt-2">No base address set — routes can’t anchor to a start point. Set it in Settings → Business.</p>
          )}
        </div>
      ) : activeJobs.length === 0 ? (
        <EmptyState icon={Radio} title="Nothing scheduled this day"
          description="Visits land here from the Schedule. Once a day has work, dispatch it across crews." />
      ) : (
        <>
          {/* Day-level note */}
          <NoteBox
            icon={StickyNote}
            placeholder="Day note for the whole operation — gate codes, yard reminders, weather calls…"
            value={dayNote?.body ?? ''}
            onSave={async body => {
              if (!uid) return
              const err = await saveDispatchNote(supabase, uid, date, null, body)
              if (err) notify.error('Could not save the note: ' + err); else fetchAll()
            }}
          />

          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3 items-start">
            {lanes.map((lane, i) => (
              <CrewLaneCard
                key={lane.laneId}
                lane={lane}
                route={laneRoutes[lane.laneId]}
                technicians={technicians.filter(t => t.is_active && (lane.crew ? t.crew_id === lane.crew.id : t.crew_id === null))}
                vehicles={equipment.filter(e => (lane.crew ? e.crew_id === lane.crew.id : false))}
                note={notes.find(n => n.crew_id === lane.laneId) ?? null}
                crews={crews}
                nowMin={nowMin}
                base={settings.base}
                index={i}
                isDropTarget={overLane === lane.laneId && dragging != null && dragRef.current?.fromLane !== lane.laneId}
                dragging={dragging}
                onDragHandleDown={onDragHandleDown}
                onNudge={nudgeJob}
                onMoveTo={moveJob}
                onBestOrder={bestOrderLane}
                optimizing={optimizingLane === lane.laneId}
                onSetTechStatus={async (t, status) => {
                  const err = await setTechnicianStatus(supabase, t.id, status)
                  if (err) notify.error('Could not update status: ' + err); else fetchAll()
                }}
                onSaveNote={async body => {
                  if (!uid) return
                  const err = await saveDispatchNote(supabase, uid, date, lane.laneId === UNASSIGNED_ID ? null : lane.laneId, body)
                  if (err) notify.error('Could not save the note: ' + err); else fetchAll()
                }}
              />
            ))}
          </div>
        </>
      )}

      {/* Drag ghost */}
      {dragging && ghost && (
        <div className="fixed z-[300] pointer-events-none -translate-x-1/2 -translate-y-full rounded-lg border border-accent/40 bg-bg-secondary shadow-2xl px-3 py-1.5 text-xs font-semibold text-ink"
          style={{ left: ghost.x, top: ghost.y - 8 }}>
          {dragging.title}
        </div>
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

      <CrewManager
        open={managerOpen}
        onClose={() => setManagerOpen(false)}
        crews={crews}
        technicians={technicians}
        equipment={equipment}
        onChanged={fetchAll}
      />
    </div>
  )
}

// ── Crew lane ────────────────────────────────────────────────────────────────
function CrewLaneCard({
  lane, route, technicians, vehicles, note, crews, nowMin, base, index,
  isDropTarget, dragging, onDragHandleDown, onNudge, onMoveTo, onBestOrder, optimizing, onSetTechStatus, onSaveNote,
}: {
  lane: CrewLaneData
  route: LaneRoute | undefined
  technicians: Technician[]
  vehicles: AssignableEquipment[]
  note: DispatchNote | null
  crews: Crew[]
  nowMin?: number
  base: Coord | null
  index: number
  isDropTarget: boolean
  dragging: { jobId: string } | null
  onDragHandleDown: (e: React.PointerEvent, job: Job, laneId: string) => void
  onNudge: (laneId: string, jobId: string, dir: -1 | 1) => void
  onMoveTo: (jobId: string, crewId: string | null) => void
  onBestOrder: (laneId: string) => void
  optimizing: boolean
  onSetTechStatus: (t: Technician, s: TechnicianStatus) => void
  onSaveNote: (body: string) => void
}) {
  const seq = route?.seq ?? []
  const load = laneLoad(route?.workMin ?? 0, route?.capacityMin ?? 0)
  const etaByJob = new Map((route?.etas.stops ?? []).map(s => [s.jobId, s]))
  const isUnassigned = lane.laneId === UNASSIGNED_ID
  const cancelledCount = lane.jobs.filter(j => j.status === 'cancelled').length

  const timelineStops: TimelineStop[] = seq.map(j => ({
    jobId: j.id,
    name: j.customers?.name || j.title,
    arrivalMin: etaByJob.get(j.id)?.arrivalMin ?? 0,
    durMin: j.duration_minutes || DEFAULT_JOB_MIN,
    status: j.status,
  }))

  // Skip an empty unassigned lane UNLESS a drag is looking for a drop target.
  if (isUnassigned && seq.length === 0 && !dragging) return null

  return (
    <section
      data-lane={lane.laneId}
      aria-label={`${lane.crew?.name ?? 'Unassigned'} lane`}
      className={cn(
        'rounded-card border bg-bg-secondary p-4 space-y-3 animate-rise transition-shadow',
        index < 6 && `stagger-${index + 1}`,
        isDropTarget ? 'border-accent ring-2 ring-accent/40' : 'border-border',
        isUnassigned && 'border-dashed',
      )}
    >
      {/* Lane header */}
      <div className="flex items-center gap-2 min-w-0">
        <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', lane.palette.dot)} aria-hidden />
        <h2 className="text-sm font-bold tracking-tight text-ink truncate">{lane.crew?.name ?? 'Unassigned'}</h2>
        <span className="text-[11px] text-ink-faint tabular-nums shrink-0">{seq.length} stop{seq.length !== 1 ? 's' : ''}</span>
        {route && seq.length > 0 && (
          <span className="ml-auto text-[11px] text-ink-muted tabular-nums shrink-0">wraps ~{route.etas.finish}</span>
        )}
      </div>

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

      {/* Roster chips: technicians (status menu) + vehicles */}
      {(technicians.length > 0 || vehicles.length > 0) && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {technicians.map(t => (
            <Menu key={t.id} width={200} ariaLabel={`${t.name} status`}
              items={TECH_STATUSES.map((s): MenuItem => ({
                key: s, label: TECHNICIAN_STATUS_LABELS[s],
                onSelect: () => onSetTechStatus(t, s),
                disabled: s === t.status,
              }))}>
              {({ toggle, triggerProps }) => (
                <button type="button" onClick={toggle} {...triggerProps}
                  title={`${t.name} — ${TECHNICIAN_STATUS_LABELS[t.status]}`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-muted hover:text-ink hover:border-border-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                  <HardHat className="w-3 h-3 text-ink-faint" />
                  <span className="truncate max-w-[9rem]">{t.name}</span>
                  <span className={cn('w-1.5 h-1.5 rounded-full', TECH_STATUS_META[t.status].dot)} aria-hidden />
                  <span className="text-ink-faint">{TECHNICIAN_STATUS_LABELS[t.status]}</span>
                </button>
              )}
            </Menu>
          ))}
          {vehicles.map(v => (
            <span key={v.id} title={v.category} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-ink-faint">
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
      {seq.length === 0 ? (
        <InlineEmpty icon={Radio} className="py-5">
          {isUnassigned ? 'Nothing unassigned — drop a visit here to pull it off a crew.' : 'No visits — drag one in, or Balance the day.'}
        </InlineEmpty>
      ) : (
        <div className="space-y-1.5">
          {seq.map((job, i) => {
            const eta = etaByJob.get(job.id)
            const menuItems: MenuItem[] = [
              ...crews.filter(c => c.is_active && c.id !== job.crew_id).map((c): MenuItem => ({
                key: c.id, label: `Move to ${c.name}`, icon: Users, onSelect: () => onMoveTo(job.id, c.id),
              })),
              ...(job.crew_id ? [{ key: 'unassign', label: 'Unassign', icon: Radio, onSelect: () => onMoveTo(job.id, null) } as MenuItem] : []),
              ...(job.properties?.address || (job.properties?.lat != null) ? [{
                key: 'directions', label: 'Directions', icon: Navigation,
                onSelect: () => window.open(directionsUrl({ lat: job.properties?.lat ?? null, lng: job.properties?.lng ?? null, address: job.properties?.address }, base), '_blank'),
              } as MenuItem] : []),
            ]
            return (
              <div key={job.id} id={`dispatch-stop-${job.id}`}
                className={cn('rounded-lg border border-border bg-surface px-2.5 py-2 flex items-center gap-2',
                  dragging?.jobId === job.id && 'opacity-40',
                  job.status === 'completed' && 'opacity-60')}>
                <button
                  type="button"
                  onPointerDown={e => onDragHandleDown(e, job, lane.laneId)}
                  className="shrink-0 cursor-grab active:cursor-grabbing text-ink-faint hover:text-ink touch-none rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  title="Drag to another crew"
                  aria-label={`Drag ${job.customers?.name || job.title} to another crew`}
                >
                  <GripVertical className="w-4 h-4" />
                </button>
                <span className="w-5 h-5 rounded-md bg-bg-tertiary border border-border text-[10px] font-bold text-ink-muted flex items-center justify-center shrink-0 tabular-nums">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-ink truncate">{job.customers?.name || job.title}</p>
                  <p className="text-[11px] text-ink-faint truncate tabular-nums">
                    {eta ? `ETA ${eta.arrival}` : 'ETA —'} · {job.duration_minutes || DEFAULT_JOB_MIN}m
                    {job.service_type ? ` · ${job.service_type}` : ''}
                  </p>
                </div>
                {job.status !== 'scheduled' && (
                  <Badge tone={jobStatusTone[job.status]} className="shrink-0 !text-[9px]">{JOB_STATUS_LABELS[job.status]}</Badge>
                )}
                <div className="flex flex-col shrink-0">
                  <button type="button" onClick={() => onNudge(lane.laneId, job.id, -1)} disabled={i === 0}
                    className="text-ink-faint hover:text-ink disabled:opacity-25 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" aria-label="Move earlier">
                    <ChevronUp className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" onClick={() => onNudge(lane.laneId, job.id, 1)} disabled={i === seq.length - 1}
                    className="text-ink-faint hover:text-ink disabled:opacity-25 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" aria-label="Move later">
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                </div>
                {menuItems.length > 0 && (
                  <Menu width={220} align="end" ariaLabel="Visit actions" items={menuItems}>
                    {({ toggle, triggerProps }) => (
                      <button type="button" onClick={toggle} {...triggerProps} aria-label="Visit actions"
                        className="shrink-0 text-ink-faint hover:text-ink rounded px-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">⋯</button>
                    )}
                  </Menu>
                )}
              </div>
            )
          })}
        </div>
      )}
      {cancelledCount > 0 && (
        <p className="text-[11px] text-ink-faint">{cancelledCount} cancelled visit{cancelledCount !== 1 ? 's' : ''} hidden.</p>
      )}

      {/* Lane footer: route actions + note */}
      {!isUnassigned && (
        <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-border">
          <Button variant="ghost" size="sm" onClick={() => onBestOrder(lane.laneId)} loading={optimizing}
            disabled={seq.filter(j => j.status === 'scheduled').length < 2 || !base}
            title={base ? 'Reorder this crew’s stops into the best route' : 'Set a base address in Settings first'}>
            <Wand2 className="w-3.5 h-3.5" /> Best order
          </Button>
          {base && route && route.ordered.some(s => s.lat != null) && (
            <a href={roundTripMapsUrl(base, route.ordered)} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink px-2 py-1 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              <ExternalLink className="w-3.5 h-3.5" /> Maps
            </a>
          )}
          {route && route.totalKm > 0 && (
            <span className="ml-auto text-[11px] text-ink-faint tabular-nums">~{route.totalKm} km</span>
          )}
        </div>
      )}
      {!isUnassigned && (
        <NoteBox compact icon={StickyNote} placeholder={`Note for ${lane.crew?.name ?? 'this crew'}…`}
          value={note?.body ?? ''} onSave={onSaveNote} />
      )}
    </section>
  )
}

// ── Dispatch note ────────────────────────────────────────────────────────────
// One note per (day, crew): type, blur (or Cmd/Ctrl+Enter) saves; clearing it
// deletes the row. Controlled locally so realtime refreshes never eat keystrokes.
function NoteBox({ value, onSave, placeholder, compact, icon: Icon }: {
  value: string
  onSave: (body: string) => void
  placeholder: string
  compact?: boolean
  icon: typeof StickyNote
}) {
  const [draft, setDraft] = useState(value)
  const lastSaved = useRef(value)
  useEffect(() => {
    // Adopt remote changes only when the box isn't mid-edit.
    if (value !== lastSaved.current && draft === lastSaved.current) setDraft(value)
    lastSaved.current = value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  const dirty = draft !== value
  const save = () => { if (dirty) { onSave(draft); lastSaved.current = draft } }
  return (
    <div className={cn('flex items-start gap-2', compact ? '' : 'rounded-card border border-border bg-bg-secondary p-3 animate-rise')}>
      <Icon className="w-3.5 h-3.5 text-ink-faint shrink-0 mt-1.5" aria-hidden />
      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save() } }}
        placeholder={placeholder}
        rows={draft.length > 80 || draft.includes('\n') ? 2 : 1}
        aria-label={placeholder}
        className="flex-1 resize-none bg-transparent text-xs text-ink placeholder:text-ink-faint outline-none border-b border-transparent focus:border-border-strong transition-colors py-1"
      />
      {dirty && <span className="text-[10px] text-amber-400 shrink-0 mt-1.5">unsaved</span>}
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
  const laneName = (id: string) => lanes.find(l => l.laneId === id)?.crew?.name ?? 'Unassigned'
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
