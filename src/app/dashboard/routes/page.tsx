'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Job, BusinessSettings } from '@/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { format } from 'date-fns'
import { Coord, geocodeAddress } from '@/lib/geo'
import { RouteStop, OrderedRouteStop, geocodeMissingStops, optimizeRoute } from '@/lib/route'
import { MapPin, Navigation, AlertTriangle, ExternalLink, Route as RouteIcon, Home } from 'lucide-react'

export default function RoutesPage() {
  const supabase = createClient()
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [jobs, setJobs] = useState<Job[]>([])
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [orderedStops, setOrderedStops] = useState<OrderedRouteStop[] | null>(null)
  const [totalKm, setTotalKm] = useState<number | null>(null)
  const [mapsUrl, setMapsUrl] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    const [jRes, sRes] = await Promise.all([
      supabase
        .from('jobs')
        .select('*, properties(id, address, lat, lng)')
        .eq('user_id', user!.id)
        .eq('scheduled_date', date)
        .in('status', ['scheduled', 'in_progress'])
        .order('start_time', { nullsFirst: true }),
      supabase.from('business_settings').select('*').eq('user_id', user!.id).maybeSingle(),
    ])
    setJobs((jRes.data as Job[]) || [])
    setSettings(sRes.data as BusinessSettings | null)
    setOrderedStops(null)
    setTotalKm(null)
    setMapsUrl(null)
    setMsg(null)
    setLoading(false)
  }, [supabase, date])

  useEffect(() => { fetchData() }, [fetchData])

  async function optimize() {
    setWorking(true)
    setMsg(null)
    try {
      const { data: { user } } = await supabase.auth.getUser()

      // 1) Ensure we have a base coordinate
      let baseCoord: Coord | null =
        settings?.base_lat != null && settings?.base_lng != null
          ? { lat: settings.base_lat, lng: settings.base_lng }
          : null

      if (!baseCoord) {
        if (!settings?.base_address) {
          setMsg('Set your base address in Settings first, then try again.')
          setWorking(false)
          return
        }
        const c = await geocodeAddress(settings.base_address)
        if (!c) { setMsg('Could not geocode your base address. Check it in Settings.'); setWorking(false); return }
        baseCoord = c
        await supabase.from('business_settings').update({ base_lat: c.lat, base_lng: c.lng }).eq('user_id', user!.id)
      }

      // 2) Build stops + geocode any missing coords (shared engine).
      const stops: RouteStop[] = jobs.map(job => ({
        jobId: job.id,
        title: job.title,
        address: job.properties?.address || job.title,
        propertyId: job.properties?.id ?? null,
        lat: job.properties?.lat ?? null,
        lng: job.properties?.lng ?? null,
      }))
      const geocodedCount = await geocodeMissingStops(supabase, stops)

      // 3) Order the stops via the shared optimization engine.
      const result = await optimizeRoute(baseCoord, stops)

      if (result.ordered.length === 0) {
        setMsg('None of today\u2019s jobs have a locatable address yet. Add proper addresses to the properties.')
        setWorking(false)
        return
      }

      setOrderedStops(result.ordered)
      setTotalKm(result.totalKm)
      setMapsUrl(result.mapsUrl)

      let info = result.usedGoogle
        ? `Optimized ${result.ordered.length} stop${result.ordered.length !== 1 ? 's' : ''} by driving distance (round trip).`
        : `Ordered ${result.ordered.length} stop${result.ordered.length !== 1 ? 's' : ''} (estimate — enable Directions API for real roads).`
      if (geocodedCount > 0) info += ` Located ${geocodedCount} new address${geocodedCount !== 1 ? 'es' : ''}.`
      if (result.missing.length > 0) info += ` ${result.missing.length} job(s) skipped (no locatable address).`
      setMsg(info)
    } catch {
      setMsg('Something went wrong while optimizing. Please try again.')
    } finally {
      setWorking(false)
    }
  }

  const hasBase = !!(settings?.base_address || (settings?.base_lat != null && settings?.base_lng != null))

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="Route Planner"
        description="Order a day's jobs into an efficient driving route"
        action={
          <Button onClick={optimize} loading={working} disabled={loading || jobs.length === 0}>
            <Navigation className="w-4 h-4" /> Optimize Route
          </Button>
        }
      />

      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="w-full sm:w-48">
          <Input label="Day" type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div className="flex items-start gap-2 text-xs text-ink-muted sm:mt-5">
          <Home className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          {hasBase ? (
            <span>Base: {settings?.base_address || `${settings?.base_lat}, ${settings?.base_lng}`}</span>
          ) : (
            <span className="text-amber-400">No base address set — add one in Settings</span>
          )}
        </div>
      </div>

      {msg && (
        <div className="text-sm text-ink bg-accent/10 border border-accent/20 rounded-xl px-4 py-2.5">{msg}</div>
      )}

      {loading ? (
        <div className="text-center py-16 text-sm text-ink-muted">Loading jobs...</div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-16 text-sm text-ink-muted">
          No scheduled jobs for {format(new Date(date + 'T00:00:00'), 'EEEE, MMMM d')}. Schedule jobs first, then plan the route.
        </div>
      ) : !orderedStops ? (
        <Card>
          <CardBody className="space-y-2">
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">
              {jobs.length} job{jobs.length !== 1 ? 's' : ''} scheduled this day
            </p>
            {jobs.map(job => (
              <div key={job.id} className="flex items-center gap-3 p-2.5 rounded-xl border border-border">
                <MapPin className="w-4 h-4 text-ink-faint shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink truncate">{job.title}</p>
                  <p className="text-xs text-ink-muted truncate">{job.properties?.address || 'No address on property'}</p>
                </div>
                {(job.properties?.lat == null) && (
                  <span className="ml-auto text-[10px] text-amber-400 flex items-center gap-1 shrink-0">
                    <AlertTriangle className="w-3 h-3" /> needs location
                  </span>
                )}
              </div>
            ))}
            <p className="text-xs text-ink-faint pt-2">
              Click <span className="font-medium text-ink">Optimize Route</span> — any address without coordinates will be located automatically and saved.
            </p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <div className="px-4 sm:px-6 py-4 border-b border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-gradient-to-r from-accent/5 to-transparent">
            <div className="flex items-center gap-2">
              <RouteIcon className="w-4 h-4 text-accent" />
              <span className="text-sm font-semibold text-ink">
                {orderedStops.length} stops · ~{totalKm} km round trip
              </span>
            </div>
            {mapsUrl && (
              <a href={mapsUrl} target="_blank" rel="noopener noreferrer">
                <Button size="sm" className="w-full sm:w-auto">
                  <ExternalLink className="w-3.5 h-3.5" /> Open in Google Maps
                </Button>
              </a>
            )}
          </div>
          <CardBody className="space-y-2">
            <div className="flex items-center gap-3 p-2.5 rounded-xl bg-surface border border-border">
              <div className="w-7 h-7 rounded-full bg-ink-faint/20 text-ink-muted flex items-center justify-center text-xs font-bold shrink-0">
                <Home className="w-3.5 h-3.5" />
              </div>
              <p className="text-sm font-medium text-ink">Start — Base</p>
            </div>
            {orderedStops.map(stop => (
              <div key={stop.jobId} className="flex items-center gap-3 p-2.5 rounded-xl border border-border">
                <div className="w-7 h-7 rounded-full bg-accent text-black flex items-center justify-center text-xs font-bold shrink-0">
                  {stop.order}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink truncate">{stop.title}</p>
                  <p className="text-xs text-ink-muted truncate">{stop.address}</p>
                </div>
                {stop.legKm != null && (
                  <span className="ml-auto text-xs text-ink-faint shrink-0">{stop.legKm} km</span>
                )}
              </div>
            ))}
          </CardBody>
        </Card>
      )}
    </div>
  )
}