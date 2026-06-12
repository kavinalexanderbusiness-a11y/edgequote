'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { format } from 'date-fns'
import { Coord, geocodeAddress } from '@/lib/geo'
import { RouteStop, OrderedRouteStop, geocodeMissingStops, optimizeRoute, routeStats, computeDayEtas, DEFAULT_JOB_MIN } from '@/lib/route'
import {
  ProfitJob, ProfitQuote, ProfitContext, RecInfo, Grade, GRADE_COLORS,
  dayProfitability, jobValue, improvementSuggestions,
} from '@/lib/profitability'
import { RouteMap, RouteMapStop } from '@/components/routes/RouteMap'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { Home, ExternalLink, Navigation, Lightbulb, Layers, AlertTriangle, MapPin } from 'lucide-react'

type DayJob = ProfitJob & { title: string; address: string; propertyId: string | null }

interface RouteState {
  ordered: OrderedRouteStop[]
  totalKm: number
  mapsUrl: string | null
  usedGoogle: boolean
  missing: RouteStop[]
}

const EMPTY_CTX: ProfitContext = { quotesById: {}, recById: {}, base: null, today: format(new Date(), 'yyyy-MM-dd') }

export default function RoutesPage() {
  const supabase = createClient()
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [loading, setLoading] = useState(true)
  const [dayJobs, setDayJobs] = useState<DayJob[]>([])
  const [ctx, setCtx] = useState<ProfitContext>(EMPTY_CTX)
  const [route, setRoute] = useState<RouteState | null>(null)
  const [workStart, setWorkStart] = useState('08:00')

  const load = useCallback(async () => {
    setLoading(true)
    setRoute(null)
    const { data: { user } } = await supabase.auth.getUser()
    const [jRes, qRes, rRes, sRes] = await Promise.all([
      supabase.from('jobs')
        .select('id, title, scheduled_date, status, service_type, quote_id, recurrence_id, duration_minutes, actual_minutes, price, customer_id, properties(id, address, lat, lng, city, postal_code, neighborhood)')
        .eq('user_id', user!.id)
        .eq('scheduled_date', date)
        .in('status', ['scheduled', 'in_progress', 'completed'])
        .order('start_time', { nullsFirst: true }),
      supabase.from('quotes').select('id, total, initial_price, weekly_price, biweekly_price, monthly_price').eq('user_id', user!.id),
      supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', user!.id),
      supabase.from('business_settings').select('base_lat, base_lng, base_address, work_start_time').eq('user_id', user!.id).maybeSingle(),
    ])

    const quotesById: Record<string, ProfitQuote> = {}
    for (const q of (qRes.data as (ProfitQuote & { id: string })[]) || []) quotesById[q.id] = q
    const recById: Record<string, RecInfo> = {}
    for (const r of (rRes.data as (RecInfo & { id: string })[]) || []) recById[r.id] = { freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count }

    const rows: DayJob[] = ((jRes.data as unknown as Array<Record<string, any>>) || []).map(j => ({
      id: j.id, title: j.title, scheduled_date: j.scheduled_date, status: j.status, service_type: j.service_type,
      quote_id: j.quote_id, recurrence_id: j.recurrence_id, duration_minutes: j.duration_minutes,
      actual_minutes: j.actual_minutes, price: j.price, customer_id: j.customer_id,
      lat: j.properties?.lat ?? null, lng: j.properties?.lng ?? null,
      city: j.properties?.city ?? null, postal_code: j.properties?.postal_code ?? null,
      neighborhood: j.properties?.neighborhood ?? null,
      address: j.properties?.address || j.title, propertyId: j.properties?.id ?? null,
    }))

    // Resolve base (geocode once, cache back to settings).
    const s = sRes.data as { base_lat: number | null; base_lng: number | null; base_address: string | null; work_start_time: string | null } | null
    setWorkStart(s?.work_start_time || '08:00')
    let base: Coord | null = s?.base_lat != null && s?.base_lng != null ? { lat: s.base_lat, lng: s.base_lng } : null
    if (!base && s?.base_address) {
      const c = await geocodeAddress(s.base_address)
      if (c) { base = c; await supabase.from('business_settings').update({ base_lat: c.lat, base_lng: c.lng }).eq('user_id', user!.id) }
    }

    // Locate any stop missing coords (shared engine; writes back to the property).
    const stops: RouteStop[] = rows.filter(j => j.status !== 'cancelled').map(j => ({
      jobId: j.id, title: j.title, address: j.address, propertyId: j.propertyId, lat: j.lat, lng: j.lng,
    }))
    await geocodeMissingStops(supabase, stops)
    // Patch freshly-located coords back onto the rows so profit + map agree.
    const byId = new Map(stops.map(st => [st.jobId, st]))
    for (const r of rows) { const st = byId.get(r.id); if (st) { r.lat = st.lat; r.lng = st.lng } }

    setDayJobs(rows)
    setCtx({ quotesById, recById, base, today: format(new Date(), 'yyyy-MM-dd') })

    // Optimize the day's route for the map (real roads when available).
    if (base && stops.some(st => st.lat != null && st.lng != null)) {
      const r = await optimizeRoute(base, stops)
      setRoute({ ordered: r.ordered, totalKm: r.totalKm, mapsUrl: r.mapsUrl, usedGoogle: r.usedGoogle, missing: r.missing })
    } else {
      setRoute({ ordered: [], totalKm: 0, mapsUrl: null, usedGoogle: false, missing: stops })
    }
    setLoading(false)
  }, [supabase, date])

  useEffect(() => { load() }, [load])

  // Profitability of this day's route — the SAME engine the Profitability page
  // uses, so the numbers match exactly.
  const profit = useMemo(() => dayProfitability(date, dayJobs, ctx), [date, dayJobs, ctx])
  const valueByJob = useMemo(() => {
    const m: Record<string, number> = {}
    for (const j of dayJobs) m[j.id] = jobValue(j, ctx)
    return m
  }, [dayJobs, ctx])
  const clusters = useMemo(() => {
    const located = dayJobs.filter(j => j.status !== 'cancelled' && j.lat != null && j.lng != null)
      .map(j => ({ lat: j.lat as number, lng: j.lng as number }))
    return routeStats(located, profit.driveKm).clusters
  }, [dayJobs, profit.driveKm])

  const mapStops = useMemo<RouteMapStop[]>(
    () => (route?.ordered || []).map(s => ({ lat: s.lat as number, lng: s.lng as number, order: s.order, title: s.title })),
    [route],
  )
  // Arrival time per stop + day finish, from the shared timing engine.
  const etas = useMemo(() => {
    if (!route || route.ordered.length === 0) return null
    const dur: Record<string, number> = {}
    for (const j of dayJobs) dur[j.id] = j.duration_minutes || DEFAULT_JOB_MIN
    return computeDayEtas(workStart, route.ordered, dur)
  }, [route, dayJobs, workStart])
  const etaByJob = useMemo(() => Object.fromEntries((etas?.stops || []).map(s => [s.jobId, s.arrival])), [etas])
  const titleById = useMemo(() => Object.fromEntries(dayJobs.map(j => [j.id, j.title])), [dayJobs])
  const hasBase = !!ctx.base
  const activeCount = dayJobs.filter(j => j.status !== 'cancelled').length
  const tips = improvementSuggestions(profit)

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Route Analysis"
        description="Visualize and analyze a day's route — distance, density, and profit per hour"
      />

      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="w-full sm:w-48">
          <Input label="Day" type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div className="flex items-start gap-2 text-xs text-ink-muted sm:pb-2.5">
          <Home className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          {hasBase ? <span>Base set — route measured as a round trip from base.</span>
            : <span className="text-amber-400">No base address set — add one in Settings for drive distance &amp; grade.</span>}
        </div>
      </div>

      <p className="text-xs text-ink-faint -mt-2">
        This is the planning &amp; analysis view. Run the day from the <span className="text-ink-muted font-medium">Schedule → Day Operations</span> panel.
      </p>

      {loading ? (
        <div className="text-center py-20 text-sm text-ink-muted">Analyzing route…</div>
      ) : activeCount === 0 ? (
        <Card><CardBody className="text-center py-16 text-sm text-ink-muted">
          No jobs scheduled for {format(new Date(date + 'T00:00:00'), 'EEEE, MMMM d')}. Schedule jobs first, then analyze the route.
        </CardBody></Card>
      ) : (
        <div className="space-y-5">
          {/* Summary + map */}
          <Card className="overflow-hidden">
            <div className="px-4 sm:px-5 py-3.5 border-b border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-gradient-to-r from-accent/5 to-transparent">
              <div className="flex items-center gap-3 min-w-0">
                <GradeBadge grade={profit.grade} />
                <div className="min-w-0">
                  <p className="text-sm font-bold text-ink flex items-center gap-2">
                    {formatDate(date)}
                    {profit.future && <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-400 border border-blue-500/30 rounded px-1.5 py-0.5">Booked</span>}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {profit.stops} stop{profit.stops !== 1 ? 's' : ''}
                    {route && route.ordered.length > 0 && ` · ~${route.totalKm} km ${route.usedGoogle ? 'real-road' : 'est.'} round trip`}
                    {etas && <span className="text-accent font-medium"> · done ~{etas.finish}</span>}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <p className="text-xl font-bold text-accent">{formatCurrency(profit.revenue)}</p>
                {route?.mapsUrl && (
                  <a href={route.mapsUrl} target="_blank" rel="noopener noreferrer">
                    <Button size="sm" variant="secondary"><ExternalLink className="w-3.5 h-3.5" /> Maps</Button>
                  </a>
                )}
              </div>
            </div>

            {mapStops.length > 0 ? (
              <RouteMap base={ctx.base} stops={mapStops} grade={profit.grade} />
            ) : (
              <div className="px-5 py-10 text-center text-sm text-ink-muted">
                <MapPin className="w-5 h-5 mx-auto mb-2 text-ink-faint" />
                {hasBase ? 'No stop on this day has a locatable address yet — add proper addresses to the properties.'
                  : 'Set a base address in Settings to plot and measure the route.'}
              </div>
            )}
          </Card>

          {/* Profitability + density metrics */}
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2.5">
            <Metric label={profit.hasDriveData ? '$/hour' : '$/hour*'} value={`$${profit.revPerHour}`} accent />
            <Metric label="$/km" value={profit.hasDriveData ? `$${profit.revPerKm}` : '—'} />
            <Metric label="$/stop" value={`$${profit.revPerStop}`} />
            <Metric label="Drive" value={profit.hasDriveData ? `${profit.driveKm} km` : '—'} />
            <Metric label="Drive time" value={profit.hasDriveData ? `${profit.driveMinutes} min` : '—'} />
            <Metric label="On-site" value={`${Math.round(profit.laborMinutes / 60 * 10) / 10}h`} />
            <Metric label="Min/stop" value={profit.stops > 0 ? `${Math.round(profit.laborMinutes / profit.stops)}m` : '—'} />
            <Metric label="Total hours" value={`${profit.totalHours}h`} />
            <Metric label="Avg leg" value={profit.hasDriveData ? `${profit.avgLegKm} km` : '—'} />
            <Metric label="Clusters" value={String(clusters)} />
            <Metric label="Stops" value={String(profit.stops)} />
            <Metric label="Located" value={`${profit.locatedStops}/${profit.stops}`} />
            <Metric label={profit.future ? 'Status' : 'Done'} value={profit.future ? 'Booked' : `${profit.completionPct}%`} />
          </div>

          {!profit.hasDriveData && (
            <p className="text-[11px] text-ink-faint flex items-center gap-1.5">
              <AlertTriangle className="w-3 h-3 text-amber-400" />
              * No drive data yet — $/hour excludes travel and the grade is capped at C until base + stop locations exist.
            </p>
          )}

          {/* Cluster read-out */}
          <Card>
            <CardBody className="flex items-start gap-3">
              <Layers className="w-4 h-4 text-accent shrink-0 mt-0.5" />
              <p className="text-sm text-ink-muted">
                {clusters <= 1 && profit.locatedStops > 1
                  ? <>All {profit.locatedStops} located stops fall in <span className="text-ink font-medium">one tight cluster</span> — dense and efficient to service.</>
                  : <>Stops spread across <span className="text-ink font-medium">{clusters} cluster{clusters !== 1 ? 's' : ''}</span>{profit.hasDriveData && <> averaging <span className="text-ink font-medium">{profit.avgLegKm} km</span> between stops</>}. Fewer, tighter clusters lower drive cost.</>}
              </p>
            </CardBody>
          </Card>

          {/* Improvement suggestions */}
          {tips.length > 0 && (
            <div className="rounded-card border border-amber-500/20 bg-amber-500/5 px-4 py-3 space-y-1.5">
              <p className="text-[11px] font-semibold text-amber-400 flex items-center gap-1 uppercase tracking-wide"><Lightbulb className="w-3 h-3" /> Ways to improve this route</p>
              {tips.map((t, i) => <p key={i} className="text-sm text-ink-muted">• {t}</p>)}
            </div>
          )}

          {/* Ordered route breakdown */}
          {route && route.ordered.length > 0 && (
            <Card>
              <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                <Navigation className="w-4 h-4 text-accent" />
                <h2 className="text-sm font-semibold text-ink">Route breakdown</h2>
                <span className="ml-auto text-xs text-ink-faint">arrival · value · leg</span>
              </div>
              <CardBody className="space-y-2">
                <div className="flex items-center gap-3 p-2.5 rounded-xl bg-surface border border-border">
                  <div className="w-7 h-7 rounded-full bg-ink-faint/20 text-ink-muted flex items-center justify-center shrink-0">
                    <Home className="w-3.5 h-3.5" />
                  </div>
                  <p className="text-sm font-medium text-ink">Start — Base</p>
                </div>
                {route.ordered.map(stop => {
                  const v = valueByJob[stop.jobId] || 0
                  return (
                    <div key={stop.jobId} className="flex items-center gap-3 p-2.5 rounded-xl border border-border">
                      <div className="w-7 h-7 rounded-full text-black flex items-center justify-center text-xs font-bold shrink-0" style={{ background: GRADE_COLORS[profit.grade] }}>
                        {stop.order}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-ink truncate">{titleById[stop.jobId] || stop.title}</p>
                        <p className="text-xs text-ink-muted truncate">{stop.address}</p>
                      </div>
                      <div className="text-right shrink-0">
                        {etaByJob[stop.jobId] && <p className="text-[11px] text-accent font-semibold">{etaByJob[stop.jobId]}</p>}
                        <p className="text-sm font-semibold text-ink">{v > 0 ? formatCurrency(v) : '—'}</p>
                        {stop.legKm != null && <p className="text-[11px] text-ink-faint">{stop.legKm} km leg</p>}
                      </div>
                    </div>
                  )
                })}
              </CardBody>
            </Card>
          )}

          {/* Un-located jobs */}
          {route && route.missing.length > 0 && (
            <div className="rounded-card border border-amber-500/20 bg-amber-500/5 px-4 py-3">
              <p className="text-[11px] font-semibold text-amber-400 flex items-center gap-1 uppercase tracking-wide mb-1.5">
                <AlertTriangle className="w-3 h-3" /> {route.missing.length} stop{route.missing.length !== 1 ? 's' : ''} not on the map
              </p>
              {route.missing.map(m => (
                <p key={m.jobId} className="text-xs text-ink-muted truncate">• {titleById[m.jobId] || m.title} — {m.address || 'no address'}</p>
              ))}
              <p className="text-[11px] text-ink-faint mt-1.5">Add a proper street address to these properties so they can be located and routed.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function GradeBadge({ grade }: { grade: Grade }) {
  return (
    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-black shrink-0"
      style={{ backgroundColor: GRADE_COLORS[grade] + '22', color: GRADE_COLORS[grade], border: `1px solid ${GRADE_COLORS[grade]}55` }}>
      {grade}
    </div>
  )
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-bg-tertiary px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={cn('text-sm font-bold mt-0.5', accent ? 'text-accent' : 'text-ink')}>{value}</p>
    </div>
  )
}
