'use client'

import { useEffect, useRef, useState } from 'react'
import { parseISO, format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { Coord, SchedJob, geocodeAddress, fetchUpcomingSchedulingJobs, todayLocalISO } from '@/lib/geo'
import { recommendScheduleDays, DayPlan } from '@/lib/route'
import { loadTravelModel, DEFAULT_TRAVEL_MODEL, type TravelModel } from '@/lib/travelLearning'
import { dayFit, fitReason, firstFittingDay, resolveDuration, type CandidateWork } from '@/lib/dayFit'
import { loadDayFitContext, type DayFitContext } from '@/lib/dayFitLoad'
import { formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Trophy, Scale, DollarSign, Loader2, AlertTriangle } from 'lucide-react'

const DEFAULT_WORK_DAYS = [5, 6, 0] // Fri/Sat/Sun

interface Props {
  coord?: Coord | null
  address?: string | null
  excludeJobId?: string
  // The job being placed — all three feed the day-fit engine (Session 46).
  // durationMinutes NULL means UNKNOWN and is passed through as unknown; the
  // old prop coerced it to 45 minutes on the way in, which is how a job nobody
  // had sized got a confident "fits" recommendation.
  durationMinutes?: number | null
  crewSize?: number | null
  serviceType?: string | null
  targetValue?: number   // per-visit revenue of the job being placed
  // Resolved customer scheduling preferences (customer default + property override),
  // so the best-day picker boosts preferred weekdays and excludes avoided ones.
  customerPreferredDays?: number[]
  customerAvoidDays?: number[]
  onPick?: (date: string, plan: DayPlan) => void
}

// Optimizes the WHOLE work week, not one job in isolation: scores every preferred
// work day and recommends the best under three lenses (density / balance / revenue)
// so routes naturally cluster across days. Reuses lib/geo + lib/route — and, since
// Session 46, every lens answers to lib/dayFit: a day without realistic capacity
// for THIS job (duration × crew vs committed work + workers available) can win no
// lens, however rich or tightly clustered it looks.
export function WeeklyScheduler({ coord, address, excludeJobId, durationMinutes, crewSize, serviceType, targetValue, customerPreferredDays, customerAvoidDays, onPick }: Props) {
  const supabase = createClient()
  const [target, setTarget] = useState<Coord | null>(coord ?? null)
  const [jobs, setJobs] = useState<SchedJob[]>([])
  const [base, setBase] = useState<Coord | null>(null)
  const [workDays, setWorkDays] = useState<number[]>(DEFAULT_WORK_DAYS)
  const [travel, setTravel] = useState<TravelModel>(DEFAULT_TRAVEL_MODEL)
  // null while loading; 'unavailable' when the capacity reads failed — which is
  // reported, never treated as an empty calendar (a failed read is not free
  // capacity).
  const [fitCtx, setFitCtx] = useState<DayFitContext | 'unavailable' | null>(null)
  const [loading, setLoading] = useState(true)
  const [geocoding, setGeocoding] = useState(false)
  const lastGeocoded = useRef<string | null>(null)

  useEffect(() => {
    if (coord) { setTarget(coord); return }
    if (!address) { setTarget(null); return }
    if (lastGeocoded.current === address) return
    let active = true
    setGeocoding(true)
    geocodeAddress(address).then(c => { if (!active) return; lastGeocoded.current = address; setTarget(c); setGeocoding(false) })
    return () => { active = false }
  }, [coord, address])

  useEffect(() => {
    let active = true
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      const [rows, sRes, travelM, fitLoad] = await Promise.all([
        fetchUpcomingSchedulingJobs(supabase, user!.id),
        supabase.from('business_settings').select('base_lat, base_lng, base_address, preferred_work_days').eq('user_id', user!.id).maybeSingle(),
        loadTravelModel(supabase),
        loadDayFitContext(supabase, user!.id, { fromISO: todayLocalISO() }),
      ])
      if (!active) return
      setTravel(travelM)
      setJobs(rows.filter(r => r.id !== excludeJobId))
      setFitCtx(fitLoad.outcome === 'ok' ? fitLoad.ctx : 'unavailable')
      const s = sRes.data as { base_lat: number | null; base_lng: number | null; base_address: string | null; preferred_work_days: number[] | null } | null
      let b: Coord | null = s?.base_lat != null && s?.base_lng != null ? { lat: s.base_lat, lng: s.base_lng } : null
      if (!b && s?.base_address) b = await geocodeAddress(s.base_address)
      if (!active) return
      setBase(b)
      setWorkDays(s?.preferred_work_days?.length ? s.preferred_work_days : DEFAULT_WORK_DAYS)
      setLoading(false)
    }
    load()
    return () => { active = false }
  }, [supabase, excludeJobId])

  if (loading || geocoding) return <p className="text-xs text-ink-faint flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Planning your work week…</p>
  if (!target) return <p className="text-xs text-ink-faint">Add a located address to plan the best day across your week.</p>

  // The candidate: its own estimate first, established service history second,
  // honestly unknown third — never a default minute count (lib/dayFit precedence).
  const ctx = fitCtx !== 'unavailable' ? fitCtx : null
  const resolved = resolveDuration(durationMinutes, ctx?.historyFor(serviceType ?? null) ?? null)
  const candidate: CandidateWork = { minutes: resolved.minutes, source: resolved.source, crewSize: crewSize ?? null }

  const modes = recommendScheduleDays(target, jobs, {
    fromISO: todayLocalISO(),
    preferredDays: workDays,
    base,
    // Display maths only (the balanced lens's "planned hours"). Unknown adds
    // NOTHING rather than a pretend 45 minutes; the fit verdict carries the
    // unknown-ness to the owner.
    targetHours: resolved.minutes != null ? resolved.minutes / 60 : 0,
    targetValue,
    customerPreferredDays,
    customerAvoidDays,
    speed: travel,
    fitFor: ctx ? (date => dayFit(candidate, ctx.dayInput(date))) : undefined,
  })
  if (!modes.days.length) return <p className="text-xs text-ink-faint">No upcoming work days in range — set your Preferred Work Days in Settings.</p>

  // Nothing in range has the room: say so, and name the first day that does
  // (project days beyond the lens horizon included) instead of going quiet.
  if (!modes.density && !modes.balanced && !modes.revenue) {
    const alt = ctx
      ? firstFittingDay(candidate, ctx.horizonDates
          .filter(d => !workDays.length || workDays.includes(parseISO(d + 'T00:00:00').getDay()))
          .map(date => ({ date, input: ctx.dayInput(date) })))
      : null
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
        <p className="text-xs text-amber-300 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span>No work day in the next 4 weeks has room for this job{resolved.minutes != null ? ` (~${Math.round(resolved.minutes / 60 * 10) / 10}h${(candidate.crewSize ?? 1) > 1 ? ` × ${candidate.crewSize} workers` : ''})` : ''}.</span>
        </p>
        {alt && (
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-ink-muted">{format(parseISO(alt.date + 'T00:00:00'), 'EEEE, MMM d')} — {fitReason(alt.fit, candidate)}</p>
            {onPick && (
              <Button size="sm" variant="secondary" className="shrink-0" onClick={() => onPick(alt.date, { date: alt.date, weekday: format(parseISO(alt.date + 'T00:00:00'), 'EEEE'), weekdayIdx: parseISO(alt.date + 'T00:00:00').getDay(), isPreferred: true, jobCount: 0, plannedHours: 0, scheduledRevenue: 0, nearbyCount: 0, addedDriveMin: 0, customerPreferred: false, fit: alt.fit })}>
                Use {format(parseISO(alt.date + 'T00:00:00'), 'EEE')}
              </Button>
            )}
          </div>
        )}
        <p className="text-[11px] text-ink-faint">You can still pick any date by hand — this is what the calendar can absorb, not a rule.</p>
      </div>
    )
  }

  const cards: { key: string; Icon: typeof Trophy; accent: string; title: string; plan: DayPlan | null; stat: (p: DayPlan) => string }[] = [
    // Same lens vocabulary as the schedule optimizer (Max Density / Balanced
    // Workload / Max Profit) — one concept, one name, everywhere.
    { key: 'density', Icon: Trophy, accent: 'text-amber-400', title: 'Max Density', plan: modes.density, stat: p => `${p.nearbyCount} nearby job${p.nearbyCount !== 1 ? 's' : ''} · +${p.addedDriveMin} min driving` },
    { key: 'balanced', Icon: Scale, accent: 'text-sky-400', title: 'Balanced Workload', plan: modes.balanced, stat: p => `${p.jobCount} job${p.jobCount !== 1 ? 's' : ''} · ${p.plannedHours} planned hours` },
    { key: 'revenue', Icon: DollarSign, accent: 'text-emerald-400', title: 'Max Profit', plan: modes.revenue, stat: p => `${formatCurrency(p.scheduledRevenue)} scheduled revenue` },
  ]

  return (
    <div className="space-y-2.5">
      <p className="text-xs text-ink-faint">Three ways to place this job’s visits across your work week — pick one.</p>
      {resolved.source === 'unknown' && (
        <p className="text-xs text-amber-400 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> Duration unknown — days are ranked by driving only. Review before scheduling.
        </p>
      )}
      {fitCtx === 'unavailable' && (
        <p className="text-xs text-amber-400 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> Couldn’t check day capacity — recommendations show driving only.
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-3">
        {cards.map(({ key, Icon, accent, title, plan, stat }) => {
          if (!plan) return null
          return (
            <div key={key} className="rounded-xl border border-border bg-bg-tertiary p-3 flex flex-col">
              <div className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${accent}`}>
                <Icon className="w-3.5 h-3.5" /> {title}
              </div>
              <p className="text-base font-bold text-ink mt-1 leading-tight">{plan.weekday}</p>
              <p className="text-[11px] text-ink-faint">{format(parseISO(plan.date + 'T00:00:00'), 'MMM d')}</p>
              <p className="text-[11px] text-ink-muted mt-1">{stat(plan)}</p>
              {/* The fit line: the one sentence that makes the pick defensible. */}
              {plan.fit && resolved.source !== 'unknown' && (
                <p className={`text-[11px] mt-0.5 flex-1 ${plan.fit.verdict === 'tight' ? 'text-amber-400' : 'text-ink-faint'}`}>
                  {fitReason(plan.fit, candidate)}
                </p>
              )}
              {onPick && (
                <Button size="sm" variant="secondary" className="mt-2" onClick={() => onPick(plan.date, plan)}>
                  Use {plan.weekday}
                </Button>
              )}
            </div>
          )
        })}
      </div>
      {!base && <p className="text-[11px] text-amber-400">Set a base address in Settings for accurate driving estimates.</p>}
    </div>
  )
}
