// ── Dispatch operations seam (v2) ────────────────────────────────────────────
// Pure derivations OVER the existing engines — nothing here re-computes a route,
// an ETA or a capacity. Inputs are the numbers lib/route (computeDayEtas) and
// lib/crews (laneLoad / crewCapacityMinutes) already produced; this file only
// reads them back out as dispatcher-facing facts:
//   • laneStats      — drive/on-site/utilization/finish for one crew lane
//   • detectDayConflicts — overbooked crews, late arrivals, overlapping
//     appointments, missing rosters … every "this day won't survive contact"
//     signal in ONE place so the panel, lane badges and print sheet agree
//   • DispatchSheet  — one data model for the daily crew sheet, rendered two
//     ways (CSV via lib/csv, print via sheetPrintHtml) so they can never drift
//
// No React, no supabase — mirrors lib/crews.

import { CsvColumn } from '@/lib/csv'
import { laneLoad } from '@/lib/crews'
import {
  minutesToTime12, timeToMinutes, nearestNeighborRoute, sequenceRoute, computeDayEtas, RouteStop,
} from '@/lib/route'
import { Coord } from '@/lib/geo'

// ── Lane statistics ──────────────────────────────────────────────────────────
// All four numbers fall out of the ETA chain the timeline already draws:
// drive = span − on-site, utilization = span vs capacity. Same arithmetic
// RouteTimeline does per-segment, stated once as totals.
export interface LaneStats {
  driveMin: number        // legs the ETA chain charged (incl. fallback legs)
  workMin: number         // booked on-site minutes (the capacity numerator)
  busyMin: number         // start → estimated wrap
  utilizationPct: number | null   // busy vs capacity; null when capacity is 0
  finishMin: number
  overMin: number         // minutes past the lane's capacity end (0 = fits)
}

export function laneStats(startMin: number, finishMin: number, workMin: number, capacityMin: number): LaneStats {
  const busyMin = Math.max(0, Math.round(finishMin - startMin))
  const driveMin = Math.max(0, busyMin - Math.round(workMin))
  return {
    driveMin,
    workMin: Math.round(workMin),
    busyMin,
    utilizationPct: capacityMin > 0 ? Math.round((busyMin / capacityMin) * 100) : null,
    finishMin,
    overMin: Math.max(0, Math.round(finishMin - (startMin + capacityMin))),
  }
}

// ── Live progress (today only) ───────────────────────────────────────────────
// Where the crew stands against its own ETA chain RIGHT NOW. "Behind" is the
// clock versus the plan the engine drew: the first unfinished stop should have
// been reached (or, if it's running, finished) by now. Pure read — no new
// timing model, just the ETA chain held up against the wall clock.
export interface LaneProgress {
  nextJobId: string | null   // first stop that isn't done yet
  behindMin: number          // 0 = on time or ahead
}

export function laneProgress(
  nowMin: number,
  stops: { jobId: string; arrivalMin: number | null; durMin: number; status: string }[],
): LaneProgress {
  const next = stops.find(s => s.status !== 'completed' && s.status !== 'cancelled')
  if (!next || next.arrivalMin == null) return { nextJobId: next?.jobId ?? null, behindMin: 0 }
  // A running stop is judged by its planned finish; a pending one by its arrival.
  const due = next.status === 'in_progress' ? next.arrivalMin + next.durMin : next.arrivalMin
  return { nextJobId: next.jobId, behindMin: Math.max(0, Math.round(nowMin - due)) }
}

// ── Optimizer savings hint ───────────────────────────────────────────────────
// How much shorter the ONE optimizer's order would be than the current manual
// order — same nearest-neighbour + 2-opt estimator the engine itself falls back
// to, so the hint can never promise what "Best order" won't deliver. Returns 0
// when the gain is noise (< 1 km or < 12%).
export function bestOrderSavingsKm(base: { lat: number; lng: number }, stops: RouteStop[], currentKm: number): number {
  const located = stops.filter(s => s.lat != null && s.lng != null)
  if (located.length < 3 || currentKm <= 0) return 0
  const best = nearestNeighborRoute(base, located).totalKm
  const saved = Math.round((currentKm - best) * 10) / 10
  return saved >= 1 && saved / currentKm >= 0.12 ? saved : 0
}

// ── Conflict detection ───────────────────────────────────────────────────────
export type ConflictKind =
  | 'blocked_day'          // work still scheduled on a blocked day
  | 'overloaded'           // booked minutes exceed the crew's capacity
  | 'overrun'              // route (work + drive) wraps past the day window
  | 'near_capacity'        // fits, but with <1h to spare — one surprise from over
  | 'late_arrival'         // ETA lands after a promised appointment time
  | 'appointment_overlap'  // two timed visits in the same lane collide
  | 'no_roster'            // a crew has stops but nobody available to run them
  | 'unassigned_work'      // visits without a crew while crews exist

export type ConflictSeverity = 'error' | 'warn' | 'info'

export interface DispatchConflict {
  kind: ConflictKind
  severity: ConflictSeverity
  laneId: string
  laneName: string
  jobId?: string
  message: string
}

export interface ConflictStopInput {
  jobId: string
  title: string
  startTime: string | null   // explicit appointment (HH:mm) or null
  durMin: number
  arrivalMin: number | null  // from computeDayEtas; null if not in the chain
  status: string
}

export interface ConflictLaneInput {
  laneId: string
  laneName: string
  isUnassigned: boolean
  startMin: number
  finishMin: number
  capacityMin: number
  workMin: number
  stops: ConflictStopInput[]
  availableTechs: number     // active techs on the crew not marked 'off'
  rosteredTechs: number      // active techs on the crew, any status
}

// A visit is "late" once the ETA slips this far past the promised time.
const LATE_GRACE_MIN = 15

const SEVERITY_ORDER: Record<ConflictSeverity, number> = { error: 0, warn: 1, info: 2 }

export function detectDayConflicts(
  lanes: ConflictLaneInput[],
  opts: { dayBlocked: boolean; activeCrewCount: number },
): DispatchConflict[] {
  const out: DispatchConflict[] = []
  const fmtH = (min: number) => `${Math.round(min / 60 * 10) / 10}h`

  for (const lane of lanes) {
    const n = lane.stops.length
    if (n === 0) continue

    if (opts.dayBlocked) {
      out.push({
        kind: 'blocked_day', severity: 'error', laneId: lane.laneId, laneName: lane.laneName,
        message: `${lane.laneName}: ${n} visit${n !== 1 ? 's' : ''} still scheduled on a blocked day.`,
      })
      // A blocked day zeroes capacity — every load signal below would just
      // restate the same fact, so report the root cause and move on.
      continue
    }

    if (!lane.isUnassigned) {
      // Load — the SAME laneLoad the capacity meter shows, so panel and meter
      // can never disagree about whether a lane is over.
      const load = laneLoad(lane.workMin, lane.capacityMin)
      if (load.state === 'overloaded') {
        out.push({
          kind: 'overloaded', severity: 'error', laneId: lane.laneId, laneName: lane.laneName,
          message: `${lane.laneName} is overbooked — ${fmtH(lane.workMin)} of work against ${fmtH(lane.capacityMin)} of capacity.`,
        })
      } else {
        const stats = laneStats(lane.startMin, lane.finishMin, lane.workMin, lane.capacityMin)
        if (stats.overMin > 0) {
          out.push({
            kind: 'overrun', severity: 'warn', laneId: lane.laneId, laneName: lane.laneName,
            message: `${lane.laneName}'s route wraps ~${minutesToTime12(lane.finishMin)}, ${fmtH(stats.overMin)} past its day.`,
          })
        } else if (load.state === 'full') {
          out.push({
            kind: 'near_capacity', severity: 'info', laneId: lane.laneId, laneName: lane.laneName,
            message: `${lane.laneName} is nearly full — ${load.spareMin}m to spare.`,
          })
        }
      }

      // Roster — work with nobody to do it is a dispatch problem, not a data quirk.
      if (lane.rosteredTechs === 0) {
        out.push({
          kind: 'no_roster', severity: 'warn', laneId: lane.laneId, laneName: lane.laneName,
          message: `${lane.laneName} has ${n} stop${n !== 1 ? 's' : ''} but no technicians on the crew.`,
        })
      } else if (lane.availableTechs === 0) {
        out.push({
          kind: 'no_roster', severity: 'warn', laneId: lane.laneId, laneName: lane.laneName,
          message: `${lane.laneName} has ${n} stop${n !== 1 ? 's' : ''} but everyone on the crew is marked off.`,
        })
      }
    }

    // Appointments — promised times checked against the ETA chain and each other.
    const timed = lane.stops
      .filter(s => s.startTime)
      .map(s => ({ ...s, promiseMin: timeToMinutes(s.startTime) }))
      .sort((a, b) => a.promiseMin - b.promiseMin)

    for (const s of timed) {
      if (s.arrivalMin != null && s.arrivalMin > s.promiseMin + LATE_GRACE_MIN) {
        out.push({
          kind: 'late_arrival', severity: 'error', laneId: lane.laneId, laneName: lane.laneName, jobId: s.jobId,
          message: `${s.title} is promised for ${minutesToTime12(s.promiseMin)} but the route arrives ~${minutesToTime12(s.arrivalMin)}.`,
        })
      }
    }
    for (let i = 1; i < timed.length; i++) {
      const prev = timed[i - 1]
      const cur = timed[i]
      if (cur.promiseMin < prev.promiseMin + prev.durMin) {
        out.push({
          kind: 'appointment_overlap', severity: 'warn', laneId: lane.laneId, laneName: lane.laneName, jobId: cur.jobId,
          message: `${prev.title} (${minutesToTime12(prev.promiseMin)}, ${prev.durMin}m) and ${cur.title} (${minutesToTime12(cur.promiseMin)}) overlap in ${lane.laneName}.`,
        })
      }
    }

    if (lane.isUnassigned && opts.activeCrewCount > 0 && !opts.dayBlocked) {
      out.push({
        kind: 'unassigned_work', severity: 'info', laneId: lane.laneId, laneName: lane.laneName,
        message: `${n} visit${n !== 1 ? 's' : ''} without a crew — assign or Balance before the day starts.`,
      })
    }
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

// Per-lane rollup for the lane header badge (worst severity + count).
export function laneConflictSummary(conflicts: DispatchConflict[], laneId: string): { count: number; severity: ConflictSeverity } | null {
  const mine = conflicts.filter(c => c.laneId === laneId)
  if (mine.length === 0) return null
  return { count: mine.length, severity: mine.reduce((worst, c) => (SEVERITY_ORDER[c.severity] < SEVERITY_ORDER[worst] ? c.severity : worst), 'info' as ConflictSeverity) }
}

// ── Day KPIs ─────────────────────────────────────────────────────────────────
// The whole operation's day in five numbers, every one an aggregate of what the
// lanes already computed — nothing here re-times a route. All inputs are the
// SAME ConflictLaneInput rows conflict detection reads, so the tiles, the
// conflicts and the lane meters can never tell three different stories.
export interface DayKpis {
  total: number
  done: number
  running: number
  behindLanes: number          // today only (0 when nowMin is absent)
  utilizationPct: number | null   // Σ(start→wrap) vs Σcapacity, crew lanes with work
  driveSharePct: number | null    // Σdrive vs Σ(start→wrap)
  latestFinishMin: number | null
}

export function dayKpis(lanes: ConflictLaneInput[], nowMin?: number): DayKpis {
  let total = 0, done = 0, running = 0, behind = 0
  let busySum = 0, capSum = 0, driveSum = 0
  let latest: number | null = null
  for (const lane of lanes) {
    total += lane.stops.length
    for (const s of lane.stops) {
      if (s.status === 'completed') done++
      else if (s.status === 'in_progress') running++
    }
    if (lane.stops.length === 0) continue
    if (!lane.isUnassigned) {
      const stats = laneStats(lane.startMin, lane.finishMin, lane.workMin, lane.capacityMin)
      busySum += stats.busyMin
      capSum += lane.capacityMin
      driveSum += stats.driveMin
      if (nowMin != null && laneProgress(nowMin, lane.stops).behindMin >= 10) behind++
    }
    latest = latest == null ? lane.finishMin : Math.max(latest, lane.finishMin)
  }
  return {
    total, done, running, behindLanes: behind,
    utilizationPct: capSum > 0 ? Math.round((busySum / capSum) * 100) : null,
    driveSharePct: busySum > 0 ? Math.round((driveSum / busySum) * 100) : null,
    latestFinishMin: latest,
  }
}

// ── Promise-order suggestion ─────────────────────────────────────────────────
// When a promised time is being missed, try the cheapest honest candidate:
// keep every SLOT of the current route where it is, but let the timed visits
// swap among their own slots into promise order (the 9 AM appointment stops
// queuing behind the 1 PM one). The candidate is then judged by the SAME
// engines (sequenceRoute → computeDayEtas); it is only suggested when it
// strictly reduces the number of late promises.
export interface PromiseOrderSuggestion {
  ids: string[]
  lateBefore: number
  lateAfter: number
}

const PROMISE_GRACE_MIN = 15

function countLate(
  base: Coord | null,
  stops: RouteStop[],
  ids: string[],
  startHHmm: string,
  durations: Record<string, number>,
  promises: Record<string, number>,
): number {
  const ordered = base
    ? sequenceRoute(base, stops, ids).ordered
    : ids.map((id, i) => ({ ...(stops.find(s => s.jobId === id) as RouteStop), order: i + 1, legKm: null }))
  const etas = computeDayEtas(startHHmm, ordered, durations)
  let late = 0
  for (const s of etas.stops) {
    const promise = promises[s.jobId]
    if (promise != null && s.arrivalMin > promise + PROMISE_GRACE_MIN) late++
  }
  return late
}

export function suggestPromiseOrder(
  base: Coord | null,
  stops: RouteStop[],
  currentIds: string[],
  startHHmm: string,
  durations: Record<string, number>,
  promises: Record<string, number>,   // jobId → promised minutes-since-midnight
): PromiseOrderSuggestion | null {
  const timedSlots = currentIds.map((id, i) => ({ id, i })).filter(x => promises[x.id] != null)
  if (timedSlots.length < 2) return null
  const byPromise = [...timedSlots].sort((a, b) => promises[a.id] - promises[b.id])
  const ids = [...currentIds]
  timedSlots.forEach((slot, k) => { ids[slot.i] = byPromise[k].id })
  if (ids.join() === currentIds.join()) return null
  const lateBefore = countLate(base, stops, currentIds, startHHmm, durations, promises)
  const lateAfter = countLate(base, stops, ids, startHHmm, durations, promises)
  return lateAfter < lateBefore ? { ids, lateBefore, lateAfter } : null
}

// ── Activity feed ────────────────────────────────────────────────────────────
// Today's movement, derived from timestamps the day's rows already carry
// (started_at / completed_at / on_my_way_at, technician status_changed_at,
// note updated_at). No event table, no polling — the board's own realtime
// refresh keeps it live.
export interface ActivityItem {
  atISO: string
  kind: 'completed' | 'started' | 'on_my_way' | 'tech_status' | 'note'
  text: string
  jobId?: string
  laneId?: string
}

export function buildActivityFeed(
  jobs: {
    id: string; title: string; customerName: string | null; laneId: string
    started_at: string | null; completed_at: string | null; on_my_way_at?: string | null
  }[],
  techs: { name: string; statusLabel: string; status_changed_at: string | null; laneId: string | null }[],
  notes: { crewName: string | null; updated_at: string; created_at: string; laneId: string | null }[],
  limit = 50,
): ActivityItem[] {
  const out: ActivityItem[] = []
  for (const j of jobs) {
    const who = j.customerName || j.title
    if (j.completed_at) out.push({ atISO: j.completed_at, kind: 'completed', text: `${who} completed`, jobId: j.id, laneId: j.laneId })
    if (j.started_at) out.push({ atISO: j.started_at, kind: 'started', text: `${who} started`, jobId: j.id, laneId: j.laneId })
    if (j.on_my_way_at) out.push({ atISO: j.on_my_way_at, kind: 'on_my_way', text: `On-my-way sent for ${who}`, jobId: j.id, laneId: j.laneId })
  }
  for (const t of techs) {
    if (t.status_changed_at) out.push({ atISO: t.status_changed_at, kind: 'tech_status', text: `${t.name} → ${t.statusLabel}`, laneId: t.laneId ?? undefined })
  }
  for (const n of notes) {
    out.push({
      atISO: n.updated_at, kind: 'note',
      text: n.updated_at === n.created_at
        ? `Note added${n.crewName ? ` for ${n.crewName}` : ''}`
        : `Note updated${n.crewName ? ` for ${n.crewName}` : ''}`,
      laneId: n.laneId ?? undefined,
    })
  }
  return out.sort((a, b) => b.atISO.localeCompare(a.atISO)).slice(0, limit)
}

// ── Itinerary text ───────────────────────────────────────────────────────────
// One crew's route as paste-anywhere plain text (SMS to the crew lead, a note,
// a group chat). Reads the SAME SheetLane rows print and CSV use.
export function itineraryText(lane: SheetLane, dateLabel: string): string {
  const lines: string[] = [
    `${lane.name} — ${dateLabel}`,
    `Start ${lane.startLabel}${lane.finishLabel ? ` · wraps ~${lane.finishLabel}` : ''}${lane.driveMin > 0 ? ` · ~${lane.driveMin}m driving` : ''}`,
  ]
  for (const s of lane.stops) {
    lines.push(
      `${s.order}. ${s.eta ?? '—'} — ${s.customer}${s.address ? ` — ${s.address}` : ''}` +
      `${s.promised ? ` (promised ${s.promised})` : ''}${s.phone ? ` — ${s.phone}` : ''}`,
    )
  }
  if (lane.note) lines.push(`Note: ${lane.note}`)
  return lines.join('\n')
}

// ── The daily dispatch sheet ─────────────────────────────────────────────────
// One data model, two renderings (CSV + print). The page maps its lanes/routes
// into this shape once; both outputs read the SAME rows.
export interface SheetStop {
  order: number
  eta: string | null        // "8:25 AM" from the ETA chain
  promised: string | null   // explicit appointment, if any
  customer: string
  address: string
  phone: string
  service: string
  durMin: number
  status: string            // human label
}

export interface SheetLane {
  name: string
  hex: string               // crew identity colour (print keeps it)
  techs: string[]
  vehicles: string[]
  note: string | null
  startLabel: string
  finishLabel: string | null
  driveMin: number
  workMin: number
  stops: SheetStop[]
}

export interface DispatchSheet {
  dateLabel: string         // "Wednesday, Jul 15"
  dateISO: string
  dayNote: string | null
  lanes: SheetLane[]        // only lanes with stops
}

export interface SheetCsvRow {
  crew: string
  order: number
  eta: string
  promised: string
  customer: string
  address: string
  phone: string
  service: string
  durMin: number
  status: string
  note: string
}

export function sheetCsvRows(sheet: DispatchSheet): SheetCsvRow[] {
  return sheet.lanes.flatMap(lane => lane.stops.map(s => ({
    crew: lane.name,
    order: s.order,
    eta: s.eta ?? '',
    promised: s.promised ?? '',
    customer: s.customer,
    address: s.address,
    phone: s.phone,
    service: s.service,
    durMin: s.durMin,
    status: s.status,
    note: lane.note ?? '',
  })))
}

export const SHEET_CSV_COLUMNS: CsvColumn<SheetCsvRow>[] = [
  { label: 'Crew', value: r => r.crew },
  { label: 'Stop', value: r => r.order },
  { label: 'ETA', value: r => r.eta },
  { label: 'Promised time', value: r => r.promised },
  { label: 'Customer', value: r => r.customer },
  { label: 'Address', value: r => r.address },
  { label: 'Phone', value: r => r.phone },
  { label: 'Service', value: r => r.service },
  { label: 'Minutes', value: r => r.durMin },
  { label: 'Status', value: r => r.status },
  { label: 'Crew note', value: r => r.note },
]

// ── Print rendering ──────────────────────────────────────────────────────────
// A self-contained HTML document (opened in its own window → window.print()).
// Deliberately plain — black on white, one table per crew, a tick column wide
// enough for a pen — because this page's job is a clipboard in a truck.
function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, ch => (
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
  ))
}

export function sheetPrintHtml(sheet: DispatchSheet): string {
  const laneHtml = sheet.lanes.map(lane => `
    <section class="lane">
      <h2><span class="dot" style="background:${esc(lane.hex)}"></span>${esc(lane.name)}
        <span class="meta">${esc(lane.startLabel)}${lane.finishLabel ? ` → ~${esc(lane.finishLabel)}` : ''} · ${lane.stops.length} stop${lane.stops.length !== 1 ? 's' : ''} · ${Math.round(lane.workMin / 60 * 10) / 10}h on-site${lane.driveMin > 0 ? ` · ~${lane.driveMin}m driving` : ''}</span>
      </h2>
      ${lane.techs.length || lane.vehicles.length ? `<p class="roster">${esc([lane.techs.join(', '), lane.vehicles.join(', ')].filter(Boolean).join('  ·  '))}</p>` : ''}
      ${lane.note ? `<p class="note">${esc(lane.note)}</p>` : ''}
      <table>
        <thead><tr><th class="tick">✓</th><th>#</th><th>ETA</th><th>Customer</th><th>Address</th><th>Phone</th><th>Service</th><th class="num">Min</th></tr></thead>
        <tbody>
          ${lane.stops.map(s => `
          <tr>
            <td class="tick"><span class="box"></span></td>
            <td class="num">${s.order}</td>
            <td>${esc(s.eta ?? '—')}${s.promised ? `<div class="promised">promised ${esc(s.promised)}</div>` : ''}</td>
            <td class="strong">${esc(s.customer)}${s.status !== 'Scheduled' ? `<div class="promised">${esc(s.status)}</div>` : ''}</td>
            <td>${esc(s.address || '—')}</td>
            <td>${esc(s.phone || '—')}</td>
            <td>${esc(s.service || '—')}</td>
            <td class="num">${s.durMin}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </section>`).join('')

  return `<!doctype html><html><head><meta charset="utf-8"><title>Dispatch — ${esc(sheet.dateLabel)}</title>
<style>
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font: 12px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .sub { color: #555; margin: 0 0 14px; font-size: 12px; }
  .daynote { border: 1px solid #bbb; border-left: 4px solid #555; padding: 6px 10px; margin: 0 0 14px; white-space: pre-wrap; }
  .lane { break-inside: avoid; page-break-inside: avoid; margin-bottom: 18px; }
  .lane h2 { font-size: 14px; margin: 0 0 2px; display: flex; align-items: baseline; gap: 8px; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; align-self: center; }
  .meta { font-weight: 400; font-size: 11px; color: #555; }
  .roster { margin: 0 0 4px; font-size: 11px; color: #333; }
  .note { margin: 0 0 6px; font-size: 11px; border: 1px dashed #999; padding: 4px 8px; white-space: pre-wrap; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f2f2f2; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
  .tick { width: 26px; text-align: center; }
  .box { display: inline-block; width: 14px; height: 14px; border: 1.5px solid #444; border-radius: 3px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; width: 34px; }
  .strong { font-weight: 600; }
  .promised { font-weight: 400; font-size: 10px; color: #555; }
  footer { margin-top: 18px; font-size: 10px; color: #777; display: flex; justify-content: space-between; }
  .sig { border-top: 1px solid #999; width: 220px; padding-top: 3px; }
  @page { margin: 14mm; }
</style></head><body>
  <h1>Dispatch sheet — ${esc(sheet.dateLabel)}</h1>
  <p class="sub">${sheet.lanes.length} crew${sheet.lanes.length !== 1 ? 's' : ''} · ${sheet.lanes.reduce((s, l) => s + l.stops.length, 0)} visits</p>
  ${sheet.dayNote ? `<p class="daynote">${esc(sheet.dayNote)}</p>` : ''}
  ${laneHtml}
  <footer><span class="sig">Completed by / time in</span><span>EdgeQuote dispatch · ${esc(sheet.dateISO)}</span></footer>
  <script>window.onload = function () { window.print() }</script>
</body></html>`
}

// Open the sheet in its own window and hand it to the print dialog. Returns
// false when a popup blocker ate the window so the caller can say so.
export function openPrintSheet(sheet: DispatchSheet): boolean {
  if (typeof window === 'undefined') return false
  // No 'noopener' — we must reach w.document to write the sheet into it.
  const w = window.open('', '_blank', 'width=900,height=1100')
  if (!w) return false
  w.document.write(sheetPrintHtml(sheet))
  w.document.close()
  return true
}
