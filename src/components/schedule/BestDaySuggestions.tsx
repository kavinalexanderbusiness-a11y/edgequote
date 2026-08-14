'use client'

import { useEffect, useRef, useState } from 'react'
import { parseISO, format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { Coord, DaySuggestion, LocatedJob, geocodeAddress, suggestBestDays, fetchLocatedUpcomingJobs, todayLocalISO } from '@/lib/geo'
import { loadTravelModel, DEFAULT_TRAVEL_MODEL, type TravelModel } from '@/lib/travelLearning'
import { dayFit, fitReason, firstFittingDay, resolveDuration, type CandidateWork, type DayFit } from '@/lib/dayFit'
import { loadDayFitContext, type DayFitContext } from '@/lib/dayFitLoad'
import { Button } from '@/components/ui/Button'
import { Sparkles, MapPin, Clock, Navigation, Loader2, AlertTriangle } from 'lucide-react'

interface Props {
  coord?: Coord | null      // resolved coordinate for the target property, if known
  address?: string | null   // fallback — geocoded on demand when coord is absent
  excludeJobId?: string      // ignore this job when scoring (edit mode)
  // The work being placed (Session 46). Duration NULL = unknown — the engine
  // resolves it against established service history or says so honestly; it is
  // never defaulted into a "fits" claim. Crew multiplies labour demand.
  durationMinutes?: number | null
  crewSize?: number | null
  serviceType?: string | null
  onPick?: (date: string, s: DaySuggestion) => void   // omit for read-only display
  onTop?: (s: DaySuggestion | null) => void           // report #1 pick for telemetry
}

// "Where should I schedule this to save the most driving — AND does it actually
// fit there?" Route math is shared with the Route Planner (lib/geo); realistic
// capacity is lib/dayFit — nearby stops rank the days, but a day without room
// for THIS job's duration × crew can never be the recommendation. A big job that
// fits nowhere near its neighbours is pointed at the first day with room instead
// of being wedged into a full route.
export function BestDaySuggestions({ coord, address, excludeJobId, durationMinutes, crewSize, serviceType, onPick, onTop }: Props) {
  const supabase = createClient()
  const [target, setTarget] = useState<Coord | null>(coord ?? null)
  const [jobs, setJobs] = useState<LocatedJob[]>([])
  const [travel, setTravel] = useState<TravelModel>(DEFAULT_TRAVEL_MODEL)
  // 'unavailable' = the capacity reads failed. Reported beside driving-only
  // suggestions — never silently treated as an empty calendar.
  const [fitCtx, setFitCtx] = useState<DayFitContext | 'unavailable' | null>(null)
  const [loading, setLoading] = useState(true)
  const [geocoding, setGeocoding] = useState(false)
  const lastGeocoded = useRef<string | null>(null)
  const onTopRef = useRef(onTop)
  onTopRef.current = onTop

  // Resolve the target coordinate: prefer the passed coord, else geocode address.
  useEffect(() => {
    if (coord) { setTarget(coord); return }
    if (!address) { setTarget(null); return }
    if (lastGeocoded.current === address) return
    let active = true
    setGeocoding(true)
    geocodeAddress(address).then(c => {
      if (!active) return
      lastGeocoded.current = address
      setTarget(c)
      setGeocoding(false)
    })
    return () => { active = false }
  }, [coord, address])

  // Load this user's located, upcoming scheduled jobs + the day-fit context once.
  useEffect(() => {
    let active = true
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      const [rows, travelM, fitLoad] = await Promise.all([
        fetchLocatedUpcomingJobs(supabase, user!.id),
        loadTravelModel(supabase),
        loadDayFitContext(supabase, user!.id, { fromISO: todayLocalISO() }),
      ])
      if (!active) return
      setJobs(rows)
      setTravel(travelM)
      setFitCtx(fitLoad.outcome === 'ok' ? fitLoad.ctx : 'unavailable')
      setLoading(false)
    }
    load()
    return () => { active = false }
  }, [supabase])

  const ctx = fitCtx !== 'unavailable' ? fitCtx : null
  const resolved = resolveDuration(durationMinutes, ctx?.historyFor(serviceType ?? null) ?? null)
  const candidate: CandidateWork = { minutes: resolved.minutes, source: resolved.source, crewSize: crewSize ?? null }

  const proximity = target
    ? suggestBestDays(target, jobs.filter(j => j.id !== excludeJobId), { fromISO: todayLocalISO(), minPerKm: travel.minPerKm, overheadMin: travel.overheadMin })
    : []

  // Annotate every proximity day with its capacity verdict, then RANK BY FIT
  // FIRST: fits > tight > unknown > over, proximity order within each band. An
  // open-looking space is not capacity; a day with no room cannot be the
  // recommendation however many neighbours it has.
  const band = (f: DayFit | null) => f == null ? 2 : f.verdict === 'fits' ? 0 : f.verdict === 'tight' ? 1 : f.verdict === 'unknown' ? 2 : 3
  const annotated = proximity
    .map(s => ({ s, fit: ctx ? dayFit(candidate, ctx.dayInput(s.date)) : null }))
    .sort((a, b) => band(a.fit) - band(b.fit))
  const suggestions = annotated.map(a => a.s)

  // When nothing near the neighbours has room (or there are no nearby days at
  // all) but the job is sized, find the first day with genuine room — an empty
  // "project day" the proximity scan can't see, because it only looks at days
  // that already have jobs.
  const noRoomNearby = annotated.length > 0 && annotated.every(a => a.fit?.verdict === 'over')
  const altDay = ctx && resolved.minutes != null && (noRoomNearby || annotated.length === 0)
    ? firstFittingDay(candidate, ctx.horizonDates
        .filter(d => !ctx.preferredWorkDays.length || ctx.preferredWorkDays.includes(parseISO(d + 'T00:00:00').getDay()))
        .map(date => ({ date, input: ctx.dayInput(date) })))
    : null

  // Report the top suggestion upward for telemetry whenever it changes.
  const top = annotated.find(a => band(a.fit) < 3)?.s ?? null
  useEffect(() => {
    onTopRef.current?.(top ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [top?.date, top?.nearbyCount])

  if (loading || geocoding) {
    return <p className="text-xs text-ink-faint flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Analyzing your schedule for nearby visits…</p>
  }
  if (!target) {
    return <p className="text-xs text-ink-faint">Add a located address to see the best days to schedule near existing visits.</p>
  }

  const altPick = (date: string) => onPick?.(date, { date, weekday: format(parseISO(date + 'T00:00:00'), 'EEEE'), nearbyCount: 0, avgKm: 0, nearestKm: 0, addedDriveMin: 0 })

  if (suggestions.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-ink-faint">No nearby visits scheduled in the next 3 weeks — this would start a new area.</p>
        {altDay && (
          <div className="w-full rounded-xl border border-border bg-bg-tertiary p-3 flex items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-ink">{format(parseISO(altDay.date + 'T00:00:00'), 'EEEE, MMM d')}</p>
              <p className="text-xs text-ink-muted mt-0.5">{fitReason(altDay.fit, candidate)}</p>
            </div>
            {onPick && <Button size="sm" variant="secondary" className="shrink-0" onClick={() => altPick(altDay.date)}>Use {format(parseISO(altDay.date + 'T00:00:00'), 'EEE')}</Button>}
          </div>
        )}
      </div>
    )
  }

  const [bestA, ...alts] = annotated
  const best = bestA.s
  const bestUsable = band(bestA.fit) < 3

  return (
    <div className="space-y-2.5">
      {onPick && (
        <p className="text-xs text-ink-faint">Recommended based on nearby visits and day capacity — you can still pick any date.</p>
      )}
      {resolved.source === 'unknown' && (
        <p className="text-xs text-amber-400 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> Duration unknown — review before scheduling.
        </p>
      )}
      {fitCtx === 'unavailable' && (
        <p className="text-xs text-amber-400 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> Couldn’t check day capacity — showing driving only.
        </p>
      )}

      {bestUsable ? (
        /* Recommended (suggestion only — applies via the explicit button) */
        <div className="w-full rounded-xl border border-accent/40 bg-accent/10 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Sparkles className="w-3.5 h-3.5 text-accent-text" /> Recommended: {best.weekday}
            </span>
            {onPick && (
              <Button size="sm" className="shrink-0" onClick={() => onPick(best.date, best)}>
                Use {best.weekday}
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-xs text-ink-muted">
            <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {best.nearbyCount} nearby job{best.nearbyCount !== 1 ? 's' : ''}</span>
            <span className="flex items-center gap-1"><Navigation className="w-3 h-3" /> ~{best.avgKm} km avg</span>
            <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> +{best.addedDriveMin} min drive</span>
          </div>
          {bestA.fit && resolved.source !== 'unknown' && (
            <p className={`text-[11px] mt-1.5 ${bestA.fit.verdict === 'tight' ? 'text-amber-400' : 'text-ink-muted'}`}>{fitReason(bestA.fit, candidate)}</p>
          )}
        </div>
      ) : (
        /* Every nearby day is full — the honest headline, then the day with room. */
        <div className="w-full rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 space-y-1.5">
          <p className="text-xs text-amber-300 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>{bestA.fit ? fitReason(bestA.fit, candidate) : 'No nearby day has the room.'} — {best.weekday}’s route is the closest but it doesn’t have the room.</span>
          </p>
          {altDay && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-ink">
                <span className="font-semibold">{format(parseISO(altDay.date + 'T00:00:00'), 'EEEE, MMM d')}</span>
                <span className="text-ink-muted"> — {fitReason(altDay.fit, candidate)}</span>
              </p>
              {onPick && <Button size="sm" variant="secondary" className="shrink-0" onClick={() => altPick(altDay.date)}>Use {format(parseISO(altDay.date + 'T00:00:00'), 'EEE')}</Button>}
            </div>
          )}
        </div>
      )}

      {/* Alternatives — fit-banded; a full day says so instead of hiding it. */}
      {alts.length > 0 && (
        <div className="space-y-1.5">
          {alts.map(({ s, fit }) => (
            <button
              key={s.date}
              type="button"
              disabled={!onPick}
              onClick={() => onPick?.(s.date, s)}
              className={`w-full flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-xs ${onPick ? 'hover:border-border-strong transition-colors cursor-pointer' : 'cursor-default'}`}
            >
              <span className="text-ink font-medium shrink-0">{s.weekday}</span>
              <span className={`truncate text-right ${fit?.verdict === 'over' ? 'text-amber-400' : 'text-ink-muted'}`}>
                {fit && resolved.source !== 'unknown'
                  ? (fit.verdict === 'over' ? 'No room' : fit.verdict === 'tight' ? 'Tight fit' : 'Fits')
                  : null}
                {fit && resolved.source !== 'unknown' ? ' · ' : ''}{s.nearbyCount} nearby · +{s.addedDriveMin} min
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
