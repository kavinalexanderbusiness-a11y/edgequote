'use client'

import { useEffect, useRef, useState } from 'react'
import { loadGoogleMaps } from '@/lib/googleMaps'
import { Grade, GRADE_COLORS } from '@/lib/profitability'
import { Coord } from '@/lib/geo'

export interface RouteMapStop { lat: number; lng: number; order: number; title: string }

// Single-route visualization. Reuses the shared Google Maps loader (one mapping
// system) — draws the optimized order as a polyline from base → stops → base,
// numbered markers, coloured by the route's profitability grade. Distinct from
// ProfitMap (a portfolio heatmap of every stop), so neither re-implements maps.
export function RouteMap({
  base, stops, grade, height = 480,
}: { base: Coord | null; stops: RouteMapStop[]; grade: Grade; height?: number }) {
  const mapEl = useRef<HTMLDivElement>(null)
  const gmap = useRef<any>(null)
  const overlays = useRef<any[]>([])
  const [ready, setReady] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function init() {
      try {
        await loadGoogleMaps()
        const g = window.google
        const { Map } = await g.maps.importLibrary('maps')
        if (cancelled || !mapEl.current) return
        const center = base ?? (stops[0] ? { lat: stops[0].lat, lng: stops[0].lng } : { lat: 51.0447, lng: -114.0719 })
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
    const color = GRADE_COLORS[grade]
    const bounds = new g.maps.LatLngBounds()
    const path: { lat: number; lng: number }[] = []

    if (base) {
      const bpos = { lat: base.lat, lng: base.lng }
      path.push(bpos); bounds.extend(bpos)
      overlays.current.push(new g.maps.Marker({
        position: bpos, map: gmap.current, title: 'Base — start & end', zIndex: 999,
        icon: { path: g.maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#E5E7EB', fillOpacity: 1, strokeColor: '#0B0B0B', strokeWeight: 2 },
      }))
    }
    for (const s of stops) {
      const pos = { lat: s.lat, lng: s.lng }
      path.push(pos); bounds.extend(pos)
      overlays.current.push(new g.maps.Marker({
        position: pos, map: gmap.current, title: `${s.order}. ${s.title}`,
        label: { text: String(s.order), color: '#0B0B0B', fontSize: '11px', fontWeight: '700' },
        icon: { path: g.maps.SymbolPath.CIRCLE, scale: 12, fillColor: color, fillOpacity: 1, strokeColor: '#0B0B0B', strokeWeight: 1 },
      }))
    }
    if (base) path.push({ lat: base.lat, lng: base.lng }) // close the loop back to base

    if (path.length > 1) {
      overlays.current.push(new g.maps.Polyline({
        path, map: gmap.current, geodesic: true,
        strokeColor: color, strokeOpacity: 0.85, strokeWeight: 3,
      }))
    }
    if (stops.length || base) gmap.current.fitBounds(bounds, 56)
  }, [ready, stops, grade, base])

  if (err) {
    return <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3">{err}</div>
  }
  return (
    <div className="relative rounded-card overflow-hidden border border-border">
      <div ref={mapEl} style={{ height }} className="w-full bg-bg-secondary" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-muted bg-bg-secondary/80">Loading map…</div>
      )}
      <div className="absolute bottom-2 left-2 flex items-center gap-2.5 bg-bg-secondary/90 border border-border rounded-lg px-2.5 py-1.5 text-[10px] text-ink-muted">
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full border border-black/60" style={{ background: '#E5E7EB' }} />Base</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: GRADE_COLORS[grade] }} />Route grade {grade}</span>
      </div>
    </div>
  )
}
