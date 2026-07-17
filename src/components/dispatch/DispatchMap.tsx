'use client'

import { useEffect, useRef, useState } from 'react'
import { loadGoogleMaps } from '@/lib/googleMaps'
import { Coord } from '@/lib/geo'
import { Banner } from '@/components/ui/Banner'
import { cn } from '@/lib/utils'

export interface DispatchMapStop {
  lat: number
  lng: number
  order: number
  title: string
  jobId?: string          // lets a marker click land on the board's stop card
  eta?: string | null     // shown in the marker tooltip — plan, not promise
}
export interface DispatchMapLane {
  id: string
  name: string
  hex: string            // crew palette hex — Maps styling can't read CSS vars
  stops: DispatchMapStop[]
}

// Multi-crew day map. Same shared Google Maps loader as RouteMap/ProfitMap (one
// mapping system) — but ONE numbered pin set + polyline PER CREW, coloured by
// the crew's palette hex, so the whole day's dispatch reads at a glance.
// Route math happens upstream (sequenceRoute/optimizeRoute); this only draws.
// The legend is the layer control: tap a crew to hide/show its route, so one
// crew's day can be read without the other four on top of it.
export function DispatchMap({
  base, lanes, height = 480, onSelectStop,
}: { base: Coord | null; lanes: DispatchMapLane[]; height?: number; onSelectStop?: (jobId: string) => void }) {
  const mapEl = useRef<HTMLDivElement>(null)
  const gmap = useRef<any>(null)
  const overlays = useRef<any[]>([])
  const [ready, setReady] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  // Marker click handlers are attached once per draw; read the callback through
  // a ref so a re-render can't strand them on a stale closure.
  const selectRef = useRef(onSelectStop)
  selectRef.current = onSelectStop

  useEffect(() => {
    let cancelled = false
    async function init() {
      try {
        await loadGoogleMaps()
        const g = window.google
        const { Map } = await g.maps.importLibrary('maps')
        if (cancelled || !mapEl.current) return
        const first = lanes.flatMap(l => l.stops)[0]
        const center = base ?? (first ? { lat: first.lat, lng: first.lng } : { lat: 51.0447, lng: -114.0719 })
        gmap.current = new Map(mapEl.current, {
          center, zoom: 11, mapTypeId: 'roadmap',
          streetViewControl: false, fullscreenControl: true, mapTypeControl: false,
        })
        setReady(true)
      } catch (e) { if (!cancelled) setErr(e instanceof Error ? e.message : 'Map failed to load') }
    }
    init()
    return () => {
      cancelled = true
      overlays.current.forEach(o => o.setMap(null)); overlays.current = []
      gmap.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!ready || !gmap.current) return
    const g = window.google
    overlays.current.forEach(o => o.setMap(null)); overlays.current = []
    const bounds = new g.maps.LatLngBounds()

    if (base) {
      const bpos = { lat: base.lat, lng: base.lng }
      bounds.extend(bpos)
      overlays.current.push(new g.maps.Marker({
        position: bpos, map: gmap.current, title: 'Base — start & end', zIndex: 999,
        icon: { path: g.maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#E5E7EB', fillOpacity: 1, strokeColor: '#0B0B0B', strokeWeight: 2 },
      }))
    }

    for (const lane of lanes) {
      if (lane.stops.length === 0 || hidden.has(lane.id)) continue
      const path: { lat: number; lng: number }[] = base ? [{ lat: base.lat, lng: base.lng }] : []
      for (const s of lane.stops) {
        const pos = { lat: s.lat, lng: s.lng }
        path.push(pos); bounds.extend(pos)
        const marker = new g.maps.Marker({
          position: pos, map: gmap.current,
          title: `${lane.name} — ${s.order}. ${s.title}${s.eta ? ` · ETA ${s.eta}` : ''}${s.jobId ? ' (click to open on the board)' : ''}`,
          label: { text: String(s.order), color: '#0B0B0B', fontSize: '11px', fontWeight: '700' },
          icon: { path: g.maps.SymbolPath.CIRCLE, scale: 12, fillColor: lane.hex, fillOpacity: 1, strokeColor: '#0B0B0B', strokeWeight: 1 },
        })
        if (s.jobId) {
          const id = s.jobId
          marker.addListener('click', () => selectRef.current?.(id))
        }
        overlays.current.push(marker)
      }
      if (base) path.push({ lat: base.lat, lng: base.lng }) // each crew closes its own loop
      if (path.length > 1) {
        overlays.current.push(new g.maps.Polyline({
          path, map: gmap.current, geodesic: true,
          strokeColor: lane.hex, strokeOpacity: 0.85, strokeWeight: 3,
        }))
      }
    }
    if (base || lanes.some(l => l.stops.length && !hidden.has(l.id))) gmap.current.fitBounds(bounds, 56)
  }, [ready, lanes, base, hidden])

  if (err) {
    return <Banner tone="warn">{err}</Banner>
  }
  const legend = lanes.filter(l => l.stops.length > 0)
  return (
    <div className="relative rounded-card overflow-hidden border border-border">
      <div ref={mapEl} style={{ height }} className="w-full bg-bg-secondary" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-muted bg-bg-secondary/80">Loading map…</div>
      )}
      <div className="absolute bottom-2 left-2 flex items-center gap-1 flex-wrap max-w-[calc(100%-1rem)] bg-bg-secondary/90 border border-border rounded-lg px-1.5 py-1 text-[10px] text-ink-muted">
        {base && (
          <span className="flex items-center gap-1 px-1 py-0.5"><span className="w-2.5 h-2.5 rounded-full border border-black/60" style={{ background: '#E5E7EB' }} />Base</span>
        )}
        {legend.map(l => {
          const off = hidden.has(l.id)
          return (
            <button
              key={l.id}
              type="button"
              aria-pressed={!off}
              title={off ? `Show ${l.name}` : `Hide ${l.name}`}
              onClick={() => setHidden(prev => {
                const n = new Set(prev)
                if (n.has(l.id)) n.delete(l.id); else n.add(l.id)
                return n
              })}
              className={cn(
                'flex items-center gap-1 rounded-md px-1 py-0.5 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 hover:bg-black/10',
                off && 'opacity-40 line-through',
              )}
            >
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: l.hex }} />
              {l.name} <span className="tabular-nums opacity-70">({l.stops.length})</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
