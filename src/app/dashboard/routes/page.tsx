'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Job, BusinessSettings } from '@/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { format } from 'date-fns'
import { MapPin, Navigation, AlertTriangle, ExternalLink, Route as RouteIcon, Home } from 'lucide-react'

interface Coord { lat: number; lng: number }

interface Stop {
  jobId: string
  title: string
  address: string
  propertyId: string | null
  lat: number | null
  lng: number | null
  order: number
  legKm: number | null
}

// Haversine straight-line distance in km
function haversineKm(a: Coord, b: Coord): number {
  const R = 6371
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const lat1 = a.lat * Math.PI / 180
  const lat2 = b.lat * Math.PI / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

export default function RoutesPage() {
  const supabase = createClient()
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [jobs, setJobs] = useState<Job[]>([])
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [orderedStops, setOrderedStops] = useState<Stop[] | null>(null)
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

  async function geocodeAddress(address: string): Promise<Coord | null> {
    const res = await fetch('/api/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    })
    const data = await res.json()
    if (res.ok && typeof data.lat === 'number' && typeof data.lng === 'number') {
      return { lat: data.lat, lng: data.lng }
    }
    return null
  }

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

      // 2) Build stops, geocoding any property that is missing coordinates
      const stops: Stop[] = []
      let geocodedCount = 0
      for (const job of jobs) {
        const prop = job.properties
        let lat = prop?.lat ?? null
        let lng = prop?.lng ?? null
        const address = prop?.address || job.title

        if ((lat == null || lng == null) && address) {
          const c = await geocodeAddress(address)
          if (c) {
            lat = c.lat
            lng = c.lng
            geocodedCount++
            // Save back to the property so we don't re-geocode next time
            if (prop?.id) {
              await supabase.from('properties').update({ lat: c.lat, lng: c.lng }).eq('id', prop.id)
            }
          }
        }

        stops.push({
          jobId: job.id,
          title: job.title,
          address,
          propertyId: prop?.id ?? null,
          lat, lng,
          order: 0,
          legKm: null,
        })
      }

      const located = stops.filter(s => s.lat != null && s.lng != null)
      const missing = stops.filter(s => s.lat == null || s.lng == null)

      if (located.length === 0) {
        setMsg('None of today\u2019s jobs have a locatable address yet. Add proper addresses to the properties.')
        setWorking(false)
        return
      }

      // 3) Nearest-neighbour ordering starting from base
      const remaining = [...located]
      const ordered: Stop[] = []
      let current: Coord = baseCoord
      let total = 0
      while (remaining.length > 0) {
        let bestIdx = 0
        let bestDist = Infinity
        for (let i = 0; i < remaining.length; i++) {
          const d = haversineKm(current, { lat: remaining[i].lat!, lng: remaining[i].lng! })
          if (d < bestDist) { bestDist = d; bestIdx = i }
        }
        const next = remaining.splice(bestIdx, 1)[0]
        next.legKm = Math.round(bestDist * 10) / 10
        total += bestDist
        ordered.push(next)
        current = { lat: next.lat!, lng: next.lng! }
      }
      ordered.forEach((s, i) => { s.order = i + 1 })

      // 4) Build a Google Maps multi-stop directions URL
      const originParam = `${baseCoord.lat},${baseCoord.lng}`
      const stopCoords = ordered.map(s => `${s.lat},${s.lng}`)
      const destinationParam = stopCoords[stopCoords.length - 1]
      const waypoints = stopCoords.slice(0, -1).join('|')
      const u = new URL('https://www.google.com/maps/dir/')
      u.searchParams.set('api', '1')
      u.searchParams.set('origin', originParam)
      u.searchParams.set('destination', destinationParam)
      if (waypoints) u.searchParams.set('waypoints', waypoints)
      u.searchParams.set('travelmode', 'driving')

      setOrderedStops(ordered)
      setTotalKm(Math.round(total * 10) / 10)
      setMapsUrl(u.toString())

      let info = `Optimized ${ordered.length} stop${ordered.length !== 1 ? 's' : ''}.`
      if (geocodedCount > 0) info += ` Located ${geocodedCount} new address${geocodedCount !== 1 ? 'es' : ''}.`
      if (missing.length > 0) info += ` ${missing.length} job(s) skipped (no locatable address).`
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

      <div className="flex items-center gap-3">
        <div className="w-48">
          <Input label="Day" type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div className="flex items-center gap-2 text-xs text-ink-muted mt-5">
          <Home className="w-3.5 h-3.5" />
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
          <div className="px-6 py-4 border-b border-border flex items-center justify-between bg-gradient-to-r from-accent/5 to-transparent">
            <div className="flex items-center gap-2">
              <RouteIcon className="w-4 h-4 text-accent" />
              <span className="text-sm font-semibold text-ink">
                {orderedStops.length} stops · ~{totalKm} km total
              </span>
            </div>
            {mapsUrl && (
              <a href={mapsUrl} target="_blank" rel="noopener noreferrer">
                <Button size="sm">
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