'use client'

import { useState } from 'react'
import { Job } from '@/types'
import { cn } from '@/lib/utils'
import { DayStatusRow, dayStatusMeta, dayCrew, dayWorkHours, dayLaborHours, dayStartTime, dayEndTime, hasCapacityOverride } from '@/lib/dayStatus'
import { Button } from '@/components/ui/Button'
import {
  Users, Clock, Gauge, Minus, Plus, RotateCcw, CalendarX2, AlertTriangle, ChevronDown,
} from 'lucide-react'

interface Props {
  date: string
  jobs: Job[]                    // the day's jobs
  row: DayStatusRow | null       // this day's override / status (if any)
  defaultCrew: number            // business default crew size
  capacityHours: number          // business daily LABOR-hours
  workStartTime: string          // 'HH:mm'
  busy?: boolean
  onSetCapacity: (patch: { crewSize?: number | null; startsAt?: string | null; endsAt?: string | null }) => void
  onResetCapacity: () => void
  onToggleDisable: () => void
}

const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':'); return Number(h) * 60 + Number(m || '0') }
const to12 = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); const ap = h < 12 ? 'AM' : 'PM'; const hr = h % 12 || 12; return `${hr}:${String(m).padStart(2, '0')} ${ap}` }
const round1 = (n: number) => Math.round(n * 10) / 10

// Day View capacity controls: per-day crew + working-hours overrides, live
// capacity, and smart warnings. This is CONFIGURATION, not dispatch — it opens
// as a one-line summary so the route board and first stop stay above the fold,
// and expands only when the owner wants to change the day. The override applies
// ONLY to this day; the optimizer, Weather Ops and capacity all read it via the
// ONE engine (lib/dayStatus). Weather Ops / Optimize / Add Job live in the page
// header and the day board — no duplicates here.
export function DaySettingsBar({
  date, jobs, row, defaultCrew, capacityHours, workStartTime, busy,
  onSetCapacity, onResetCapacity, onToggleDisable,
}: Props) {
  const [open, setOpen] = useState(false)
  const blocked = !!row?.blocks
  // ONE capacity engine (lib/dayStatus) — the Day Ops panel, optimizer and Weather
  // Ops all read these same helpers, so this bar never drifts from the rest of the
  // day. Business default per-crew work-hours = daily_capacity_hours ÷ default crew.
  const def = { crew: defaultCrew > 0 ? defaultCrew : 1, hours: (capacityHours > 0 ? capacityHours : 8) / (defaultCrew > 0 ? defaultCrew : 1) }

  const crew = dayCrew(row, def)
  const start = dayStartTime(row, workStartTime)
  const end = dayEndTime(row, def, workStartTime)
  const defaultEnd = dayEndTime(null, def, start)                 // end if hours weren't overridden
  const workHours = dayWorkHours(row, def)
  const available = round1(dayLaborHours(row, def))               // labor-hours (0 when blocked)
  const bookedMin = jobs.filter(j => j.status !== 'cancelled').reduce((s, j) => s + (j.duration_minutes || 0), 0)
  const booked = round1(bookedMin / 60)
  const remaining = round1(available - booked)
  const util = available > 0 ? Math.round((booked / available) * 100) : (booked > 0 ? 999 : 0)
  const hasOverride = hasCapacityOverride(row)

  const setCrew = (n: number) => onSetCapacity({ crewSize: Math.max(1, n) })

  // Smart warnings.
  const warnings: string[] = []
  if (!blocked) {
    if (toMin(end) < toMin(defaultEnd) - 1) warnings.push(`Capacity reduced — you finish at ${to12(end)}.`)
    if (booked > available) warnings.push(`Schedule exceeds today's capacity by ${round1(booked - available)} h.`)
    else if (remaining > 0 && remaining < 2.5) warnings.push(`Only ${remaining} h remain.`)
  }

  return (
    <div className="rounded-card border border-border bg-bg-secondary mb-4">
      {/* One-line summary — always visible; tap to configure the day. */}
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 text-left">
        <p className="text-xs font-bold text-ink uppercase tracking-wide flex items-center gap-1.5 min-w-0">
          <Gauge className="w-3.5 h-3.5 text-accent-text shrink-0" /> Day Settings
          {hasOverride && <span className="text-[10px] font-medium text-accent-text normal-case tracking-normal">· override</span>}
          {blocked && row && <span className={cn('text-[10px] px-1.5 py-0.5 rounded border font-semibold normal-case tracking-normal', dayStatusMeta(row.status).badge)}>{dayStatusMeta(row.status).emoji} {dayStatusMeta(row.status).label}</span>}
        </p>
        <span className="flex items-center gap-3 text-xs text-ink-muted shrink-0">
          {blocked ? (
            <span className="text-ink-faint">Day off</span>
          ) : (
            <>
              <span className="flex items-center gap-1"><Users className="w-3 h-3" /> {crew}</span>
              <span className="hidden sm:flex items-center gap-1"><Clock className="w-3 h-3" /> {to12(start)}–{to12(end)}</span>
              <span className={cn('font-semibold tabular-nums', remaining < 0 ? 'text-red-400' : remaining < 2.5 ? 'text-amber-400' : 'text-emerald-400')}>
                {remaining < 0 ? `${round1(-remaining)}h over` : `${remaining}h free`}
              </span>
            </>
          )}
          <ChevronDown className={cn('w-4 h-4 transition-transform', open && 'rotate-180')} />
        </span>
      </button>

      {/* Capacity warnings stay visible even when collapsed — they're safety info. */}
      {!open && warnings.length > 0 && (
        <div className="px-3.5 pb-2.5 space-y-1 -mt-1">
          {warnings.map((w, i) => (
            <p key={i} className="text-[11px] text-amber-300 flex items-center gap-1.5"><AlertTriangle className="w-3 h-3 shrink-0 text-amber-400" /> {w}</p>
          ))}
        </div>
      )}

      {open && (
        <div className="px-3.5 pb-3.5 space-y-3 border-t border-border pt-3">
          <div className="grid grid-cols-1 sm:grid-cols-[auto_auto_1fr] gap-3 items-start">
            {/* Crew */}
            <div className="min-w-0">
              <p className="text-[10px] font-semibold text-ink-faint uppercase tracking-wide mb-1 flex items-center gap-1"><Users className="w-3 h-3" /> Crew</p>
              <div className="flex items-center gap-1.5">
                <button onClick={() => setCrew(crew - 1)} disabled={busy || blocked || crew <= 1} aria-label="Decrease crew size" className="w-9 h-9 sm:w-7 sm:h-7 rounded-lg border border-border-strong text-ink-muted hover:text-ink disabled:opacity-40 flex items-center justify-center"><Minus className="w-3.5 h-3.5" /></button>
                <span className="w-9 text-center text-sm font-bold text-ink tabular-nums">{crew}</span>
                <button onClick={() => setCrew(crew + 1)} disabled={busy || blocked} aria-label="Increase crew size" className="w-9 h-9 sm:w-7 sm:h-7 rounded-lg border border-border-strong text-ink-muted hover:text-ink disabled:opacity-40 flex items-center justify-center"><Plus className="w-3.5 h-3.5" /></button>
                <span className="text-[11px] text-ink-faint ml-0.5">{crew === 1 ? 'person' : 'people'}</span>
              </div>
            </div>

            {/* Working hours */}
            <div className="min-w-0">
              <p className="text-[10px] font-semibold text-ink-faint uppercase tracking-wide mb-1 flex items-center gap-1"><Clock className="w-3 h-3" /> Working hours</p>
              <div className="flex items-center gap-1.5">
                <input type="time" value={start} disabled={busy || blocked} aria-label="Working hours start"
                  onChange={e => onSetCapacity({ startsAt: e.target.value || null, endsAt: end })}
                  className="bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1 text-xs text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50" />
                <span className="text-ink-faint text-xs" aria-hidden="true">–</span>
                <input type="time" value={end} disabled={busy || blocked} aria-label="Working hours end"
                  onChange={e => onSetCapacity({ startsAt: start, endsAt: e.target.value || null })}
                  className="bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1 text-xs text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50" />
              </div>
            </div>

            {/* Capacity panel */}
            <div className="rounded-xl border border-border bg-surface/40 px-3 py-2 grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1.5">
              <Stat label="Available" value={blocked ? '0 h' : `${available} h`} sub={blocked ? 'blocked' : `${crew}×${round1(workHours)}h`} />
              <Stat label="Booked" value={`${booked} h`} />
              <Stat label="Remaining" value={`${remaining} h`} tone={remaining < 0 ? 'text-red-400' : remaining < 2.5 ? 'text-amber-400' : 'text-emerald-400'} />
              <Stat label="Utilization" value={util > 998 ? 'over' : `${util}%`} tone={util > 100 ? 'text-red-400' : util >= 85 ? 'text-amber-400' : 'text-ink'} />
            </div>
          </div>

          {warnings.length > 0 && (
            <div className="space-y-1">
              {warnings.map((w, i) => (
                <p key={i} className="text-[11px] text-amber-300 flex items-center gap-1.5"><AlertTriangle className="w-3 h-3 shrink-0 text-amber-400" /> {w}</p>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <Action onClick={onToggleDisable} disabled={busy} icon={CalendarX2} label={blocked ? 'Enable day' : 'Disable day'} primary={blocked} />
            {hasOverride && (
              <button onClick={onResetCapacity} disabled={busy} className="text-[11px] text-ink-faint hover:text-ink flex items-center gap-1 disabled:opacity-50 px-1.5">
                <RotateCcw className="w-3 h-3" /> Reset to default
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold text-ink-faint uppercase tracking-wide leading-none">{label}</p>
      <p className={cn('text-sm font-bold leading-tight mt-0.5 tabular-nums', tone || 'text-ink')}>{value}</p>
      {sub && <p className="text-[10px] text-ink-faint leading-none">{sub}</p>}
    </div>
  )
}

function Action({ onClick, disabled, icon: Icon, label, primary }: { onClick: () => void; disabled?: boolean; icon: typeof Gauge; label: string; primary?: boolean }) {
  return (
    <Button size="sm" variant={primary ? 'primary' : 'secondary'} onClick={onClick} disabled={disabled}>
      <Icon className="w-3.5 h-3.5" /> {label}
    </Button>
  )
}
