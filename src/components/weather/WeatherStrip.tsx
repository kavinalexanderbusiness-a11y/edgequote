'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { format, parseISO } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { loadWeatherImpact, WeatherImpactReport } from '@/lib/weatherImpact'
import { formatCurrency, cn } from '@/lib/utils'
import { CloudRain, CloudOff, ArrowRight } from 'lucide-react'

// Compact weather + rain-risk strip. Renders nothing until there's something
// worth showing, so it never clutters a clear week.
//
// Pass `report` when the caller has ALREADY loaded the impact engine (the
// dashboard loads it server-side, so the strip paints with the page instead of
// popping in). Omit it and the strip loads its own data — the self-contained
// drop-in the Schedule page uses.
export function WeatherStrip({ report }: { report?: WeatherImpactReport | null }) {
  const supabase = useMemo(() => createClient(), [])
  const [fetched, setFetched] = useState<WeatherImpactReport | null>(null)
  // Guard on the REPORT, not on "was a prop passed". `null !== undefined`, so
  // keying off presence meant a server report that failed/timed out ALSO disabled
  // this fallback — switching off self-healing in the one case that needed it.
  const [tried, setTried] = useState(false)

  useEffect(() => {
    if (report) return // the caller already paid for this — don't fetch it twice
    let active = true
    loadWeatherImpact(supabase)
      .then(x => { if (active) setFetched(x) })
      .finally(() => { if (active) setTried(true) })
    return () => { active = false }
  }, [supabase, report])

  const r = report ?? fetched

  // No base location = genuinely nothing to say. Stay silent.
  if (r && !r.hasBase) return null

  // We could NOT read the forecast. This must not render as silence: on a clear
  // week this strip says "No rain risk to booked work this week", so the owner
  // reads the strip's absence as "no risk" — when it actually means "unknown".
  // Rain risk is the one signal where unknown must never look like fine.
  if (!r || r.forecast.length === 0) {
    if (!report && !tried) return null // still loading its own copy — say nothing yet
    return (
      <Link href="/dashboard/weather"
        className="flex items-center gap-2 rounded-card border border-border bg-bg-secondary px-4 py-2.5 transition-colors hover:border-accent/30">
        <CloudOff className="w-3.5 h-3.5 text-ink-faint shrink-0" />
        <p className="text-xs text-ink-muted">Couldn&rsquo;t check the forecast — rain risk unknown</p>
        <span className="ml-auto text-[11px] font-medium text-accent-text flex items-center gap-1 shrink-0">Weather <ArrowRight className="w-3 h-3" /></span>
      </Link>
    )
  }
  const atRisk = r.totals.days > 0

  return (
    <Link href="/dashboard/weather"
      className={cn('flex items-center gap-3 rounded-card border px-4 py-2.5 transition-colors',
        atRisk ? 'border-blue-500/30 bg-blue-500/[0.05] hover:border-blue-500/50' : 'border-border bg-bg-secondary hover:border-accent/30')}>
      <div className="flex items-center gap-2 text-sm">
        {r.today && <span title="Today">{r.today.emoji} <span className="text-ink-muted">{r.today.precipProbability}%</span></span>}
        {r.tomorrow && <span className="text-ink-faint" title={format(parseISO(r.tomorrow.date + 'T00:00:00'), 'EEE')}>· {r.tomorrow.emoji} {r.tomorrow.precipProbability}%</span>}
      </div>
      {atRisk ? (
        <p className="text-xs font-semibold text-blue-400 flex items-center gap-1.5 min-w-0">
          <CloudRain className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{r.totals.jobs} job{r.totals.jobs !== 1 ? 's' : ''} · {r.totals.laborHours}h · {formatCurrency(r.totals.revenue)} at rain risk</span>
        </p>
      ) : (
        <p className="text-xs text-ink-muted">No rain risk to booked work this week</p>
      )}
      <span className="ml-auto text-[11px] font-medium text-accent-text flex items-center gap-1 shrink-0">Weather <ArrowRight className="w-3 h-3" /></span>
    </Link>
  )
}