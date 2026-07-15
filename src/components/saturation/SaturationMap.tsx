'use client'

import { useEffect, useRef, useState } from 'react'
import { loadGoogleMaps } from '@/lib/googleMaps'
import { Coord } from '@/lib/geo'
import { Banner } from '@/components/ui/Banner'

// One mapping system: this is a third VIEW on the shared Google Maps loader
// (like ProfitMap = portfolio heatmap, RouteMap = one route). It renders the
// saturation layers the page computes — it does no math of its own.

export type SatLayer = 'customers' | 'recurring' | 'quotes' | 'accepted' | 'revenue' | 'hoods' | 'opportunity'

export interface SatPoint {
  lat: number
  lng: number
  title: string
  sub?: string
  kind: 'customer' | 'recurring' | 'quote' | 'accepted'
  revenue: number // booked value — drives the revenue-bubble layer
}

export interface SatHood {
  key: string
  lat: number
  lng: number
  revenue: number
  customers: number
  jobs: number
  color: string      // grade colour from the shared profitability engine
  opportunity: boolean
}

const KIND_COLORS: Record<SatPoint['kind'], string> = {
  customer: '#60A5FA',  // blue
  recurring: '#10B981', // emerald
  quote: '#F59E0B',     // amber — pending demand
  accepted: '#22D3EE',  // cyan — won, being scheduled
}

// Names/addresses go into InfoWindow HTML — escape them ('D&M Lawns <North>').
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function SaturationMap({
  points, hoods, layers, base, height = 480,
}: { points: SatPoint[]; hoods: SatHood[]; layers: Record<SatLayer, boolean>; base: Coord | null; height?: number }) {
  const mapEl = useRef<HTMLDivElement>(null)
  const gmap = useRef<any>(null)
  const overlays = useRef<any[]>([])
  const info = useRef<any>(null)
  const didFit = useRef(false) // fit bounds once — layer toggles must not reset the user's zoom
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
        const center = base ?? (points[0] ? { lat: points[0].lat, lng: points[0].lng } : { lat: 51.0447, lng: -114.0719 })
        gmap.current = new Map(mapEl.current, {
          center, zoom: 11, mapTypeId: 'roadmap',
          streetViewControl: false, fullscreenControl: true, mapTypeControl: false,
        })
        info.current = new g.maps.InfoWindow()
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
    let any = false

    // Neighborhood saturation circles (route/revenue density per area).
    if (layers.hoods) {
      for (const h of hoods) {
        const radius = Math.min(1600, 500 + Math.sqrt(Math.max(0, h.revenue)) * 12)
        overlays.current.push(new g.maps.Circle({
          map: gmap.current, center: { lat: h.lat, lng: h.lng }, radius,
          fillColor: h.color, fillOpacity: 0.14, strokeColor: h.color, strokeOpacity: 0.5, strokeWeight: 1.5,
          clickable: false,
        }))
        bounds.extend({ lat: h.lat, lng: h.lng }); any = true
      }
    }

    // Expansion-opportunity rings — dashed look via a thin second circle.
    if (layers.opportunity) {
      for (const h of hoods.filter(x => x.opportunity)) {
        overlays.current.push(new g.maps.Circle({
          map: gmap.current, center: { lat: h.lat, lng: h.lng }, radius: 1900,
          fillOpacity: 0, strokeColor: '#A78BFA', strokeOpacity: 0.9, strokeWeight: 2,
          clickable: false,
        }))
        bounds.extend({ lat: h.lat, lng: h.lng }); any = true
      }
    }

    const show = (p: SatPoint) =>
      (p.kind === 'customer' && layers.customers) ||
      (p.kind === 'recurring' && layers.recurring) ||
      (p.kind === 'quote' && layers.quotes) ||
      (p.kind === 'accepted' && layers.accepted)

    for (const p of points) {
      if (!show(p)) continue
      // Revenue layer scales the dot by booked value; otherwise uniform dots.
      const scale = layers.revenue && p.revenue > 0 ? Math.min(16, 6 + Math.sqrt(p.revenue) / 4) : 7
      const m = new g.maps.Marker({
        position: { lat: p.lat, lng: p.lng }, map: gmap.current, title: p.title,
        icon: { path: g.maps.SymbolPath.CIRCLE, scale, fillColor: KIND_COLORS[p.kind], fillOpacity: 0.9, strokeColor: '#0B0B0B', strokeWeight: 1 },
      })
      m.addListener('click', () => {
        info.current?.setContent(`<div style="color:#111;font-size:12px;font-weight:600">${esc(p.title)}</div><div style="color:#444;font-size:11px">${esc(p.sub || '')}</div>`)
        info.current?.open({ map: gmap.current, anchor: m })
      })
      overlays.current.push(m)
      bounds.extend({ lat: p.lat, lng: p.lng }); any = true
    }

    if (base) {
      overlays.current.push(new g.maps.Marker({
        position: base, map: gmap.current, title: 'Base', zIndex: 999,
        icon: { path: g.maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#E5E7EB', fillOpacity: 1, strokeColor: '#0B0B0B', strokeWeight: 2 },
      }))
      bounds.extend(base); any = true
    }
    if (any && !didFit.current) { gmap.current.fitBounds(bounds, 48); didFit.current = true }
  }, [ready, points, hoods, layers, base])

  if (err) {
    return <Banner tone="warn">{err}</Banner>
  }
  return (
    <div className="relative rounded-card overflow-hidden border border-border">
      <div ref={mapEl} style={{ height }} className="w-full bg-bg-secondary" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-muted bg-bg-secondary/80">Loading map…</div>
      )}
      <div className="absolute bottom-2 left-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 bg-bg-secondary/90 border border-border rounded-lg px-2.5 py-1.5 text-[10px] text-ink-muted max-w-[calc(100%-1rem)]">
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: KIND_COLORS.customer }} />Customer</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: KIND_COLORS.recurring }} />Recurring</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: KIND_COLORS.quote }} />Quote</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: KIND_COLORS.accepted }} />Accepted</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full border-2" style={{ borderColor: '#A78BFA' }} />Opportunity</span>
      </div>
    </div>
  )
}
