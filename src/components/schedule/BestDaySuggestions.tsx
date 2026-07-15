'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Coord, DaySuggestion, LocatedJob, geocodeAddress, suggestBestDays, fetchLocatedUpcomingJobs, todayLocalISO } from '@/lib/geo'
import { loadTravelModel, DEFAULT_TRAVEL_MODEL, type TravelModel } from '@/lib/travelLearning'
import { Button } from '@/components/ui/Button'
import { Sparkles, MapPin, Clock, Navigation, Loader2 } from 'lucide-react'

interface Props {
  coord?: Coord | null      // resolved coordinate for the target property, if known
  address?: string | null   // fallback — geocoded on demand when coord is absent
  excludeJobId?: string      // ignore this job when scoring (edit mode)
  onPick?: (date: string, s: DaySuggestion) => void   // omit for read-only display
  onTop?: (s: DaySuggestion | null) => void           // report #1 pick for telemetry
}

// "Where should I schedule this to save the most driving?" — surfaces the days
// that already have jobs clustered near this property. Shared route math lives
// in lib/geo so this never diverges from the Route Planner.
export function BestDaySuggestions({ coord, address, excludeJobId, onPick, onTop }: Props) {
  const supabase = createClient()
  const [target, setTarget] = useState<Coord | null>(coord ?? null)
  const [jobs, setJobs] = useState<LocatedJob[]>([])
  const [travel, setTravel] = useState<TravelModel>(DEFAULT_TRAVEL_MODEL)
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

  // Load this user's located, upcoming scheduled jobs once.
  useEffect(() => {
    let active = true
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      const [rows, travelM] = await Promise.all([
        fetchLocatedUpcomingJobs(supabase, user!.id),
        loadTravelModel(supabase),
      ])
      if (!active) return
      setJobs(rows)
      setTravel(travelM)
      setLoading(false)
    }
    load()
    return () => { active = false }
  }, [supabase])

  const suggestions = target
    ? suggestBestDays(target, jobs.filter(j => j.id !== excludeJobId), { fromISO: todayLocalISO(), minPerKm: travel.minPerKm, overheadMin: travel.overheadMin })
    : []

  // Report the top suggestion upward for telemetry whenever it changes.
  useEffect(() => {
    onTopRef.current?.(suggestions[0] ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestions[0]?.date, suggestions[0]?.nearbyCount])

  if (loading || geocoding) {
    return <p className="text-xs text-ink-faint flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Analyzing your schedule for nearby jobs…</p>
  }
  if (!target) {
    return <p className="text-xs text-ink-faint">Add a located address to see the best days to schedule near existing jobs.</p>
  }
  if (suggestions.length === 0) {
    return <p className="text-xs text-ink-faint">No nearby jobs scheduled in the next 3 weeks — this would start a new area.</p>
  }

  const [best, ...alts] = suggestions

  return (
    <div className="space-y-2.5">
      {onPick && (
        <p className="text-xs text-ink-faint">Recommended based on nearby jobs — you can still pick any date.</p>
      )}

      {/* Recommended (suggestion only — applies via the explicit button) */}
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
      </div>

      {/* Alternatives */}
      {alts.length > 0 && (
        <div className="space-y-1.5">
          {alts.map(s => (
            <button
              key={s.date}
              type="button"
              disabled={!onPick}
              onClick={() => onPick?.(s.date, s)}
              className={`w-full flex items-center justify-between rounded-lg border border-border px-3 py-2 text-xs ${onPick ? 'hover:border-border-strong transition-colors cursor-pointer' : 'cursor-default'}`}
            >
              <span className="text-ink font-medium">{s.weekday}</span>
              <span className="text-ink-muted">{s.nearbyCount} nearby · +{s.addedDriveMin} min</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
