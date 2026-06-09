'use client'

import { useEffect, useRef, useState } from 'react'
import { loadGoogleMaps } from '@/lib/googleMaps'
import { Grade, GRADE_COLORS } from '@/lib/profitability'

export interface ProfitPoint { lat: number; lng: number; grade: Grade; title: string }

// Reuses the shared Google Maps loader — no second mapping system. Each stop is
// coloured by its route's profitability grade (green = strong, red = weak).
export function ProfitMap({ points }: { points: ProfitPoint[] }) {
  const mapEl = useRef<HTMLDivElement>(null)
  const gmap = useRef<any>(null)
  const markers = useRef<any[]>([])
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
        const center = points.length ? { lat: points[0].lat, lng: points[0].lng } : { lat: 51.0447, lng: -114.0719 }
        gmap.current = new Map(mapEl.current, {
          center, zoom: 11, mapTypeId: 'roadmap',
          streetViewControl: false, fullscreenControl: false, mapTypeControl: false,
        })
        setReady(true)
      } catch (e) { if (!cancelled) setErr(e instanceof Error ? e.message : 'Map failed to load') }
    }
    init()
    return () => {
      cancelled = true
      markers.current.forEach(m => m.setMap(null)); markers.current = []
      gmap.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!ready || !gmap.current) return
    const g = window.google
    markers.current.forEach(m => m.setMap(null)); markers.current = []
    const bounds = new g.maps.LatLngBounds()
    for (const p of points) {
      markers.current.push(new g.maps.Marker({
        position: { lat: p.lat, lng: p.lng }, map: gmap.current, title: `${p.title} · ${p.grade}`,
        icon: { path: g.maps.SymbolPath.CIRCLE, scale: 7, fillColor: GRADE_COLORS[p.grade], fillOpacity: 0.9, strokeColor: '#0B0B0B', strokeWeight: 1 },
      }))
      bounds.extend({ lat: p.lat, lng: p.lng })
    }
    if (points.length) gmap.current.fitBounds(bounds)
  }, [ready, points])

  if (err) {
    return <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3">{err}</div>
  }
  return (
    <div className="relative rounded-card overflow-hidden border border-border">
      <div ref={mapEl} className="w-full h-[360px] bg-bg-secondary" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-muted bg-bg-secondary/80">Loading map…</div>
      )}
      <div className="absolute bottom-2 left-2 flex items-center gap-2.5 bg-bg-secondary/90 border border-border rounded-lg px-2.5 py-1.5 text-[10px] text-ink-muted">
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: GRADE_COLORS.A }} />Strong</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: GRADE_COLORS.C }} />Average</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: GRADE_COLORS.F }} />Weak</span>
      </div>
    </div>
  )
}
