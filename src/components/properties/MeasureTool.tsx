'use client'

import { useEffect, useRef, useState } from 'react'
import { loadGoogleMaps } from '@/lib/googleMaps'
import { createClient } from '@/lib/supabase/client'
import { Property } from '@/types'
import { Button } from '@/components/ui/Button'
import { Undo2, Trash2, Check, Ruler } from 'lucide-react'

const M2_TO_SQFT = 10.7639
const M_TO_FT = 3.28084

type MeasureType = 'lawn' | 'fence' | 'mulch' | 'rock' | 'driveway'

interface TypeDef {
  key: MeasureType
  label: string
  column: 'lawn_sqft' | 'fence_length' | 'mulch_area' | 'rock_area' | 'driveway_area'
  mode: 'area' | 'length'
  color: string
}

const TYPES: TypeDef[] = [
  { key: 'lawn',     label: 'Lawn',     column: 'lawn_sqft',     mode: 'area',   color: '#00C896' },
  { key: 'fence',    label: 'Fence',    column: 'fence_length',  mode: 'length', color: '#F59E0B' },
  { key: 'mulch',    label: 'Mulch',    column: 'mulch_area',    mode: 'area',   color: '#B45309' },
  { key: 'rock',     label: 'Rock',     column: 'rock_area',     mode: 'area',   color: '#94A3B8' },
  { key: 'driveway', label: 'Driveway', column: 'driveway_area', mode: 'area',   color: '#475569' },
]

export function MeasureTool({ property }: { property: Property }) {
  const supabase = createClient()
  const mapEl = useRef<HTMLDivElement>(null)
  const gmap = useRef<any>(null)
  const overlay = useRef<any>(null)
  const path = useRef<any[]>([])
  const activeRef = useRef<MeasureType>('lawn')

  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [active, setActive] = useState<MeasureType>('lawn')
  const [measurement, setMeasurement] = useState(0)
  const [points, setPoints] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<Record<string, number | null>>({
    lawn_sqft: property.lawn_sqft,
    fence_length: property.fence_length,
    mulch_area: property.mulch_area,
    rock_area: property.rock_area,
    driveway_area: property.driveway_area,
  })

  const activeDef = TYPES.find(t => t.key === active)!

  function recompute() {
    const g = window.google
    const def = TYPES.find(t => t.key === activeRef.current)!
    const pts = path.current
    setPoints(pts.length)
    if (def.mode === 'area') {
      if (pts.length >= 3) {
        const area = g.maps.geometry.spherical.computeArea(pts)
        setMeasurement(Math.round(area * M2_TO_SQFT))
      } else setMeasurement(0)
    } else {
      if (pts.length >= 2) {
        const len = g.maps.geometry.spherical.computeLength(pts)
        setMeasurement(Math.round(len * M_TO_FT))
      } else setMeasurement(0)
    }
  }

  function redraw() {
    const g = window.google
    if (overlay.current) { overlay.current.setMap(null); overlay.current = null }
    const def = TYPES.find(t => t.key === activeRef.current)!
    if (path.current.length === 0) return
    if (def.mode === 'area') {
      overlay.current = new g.maps.Polygon({
        paths: path.current, strokeColor: def.color, strokeWeight: 2,
        fillColor: def.color, fillOpacity: 0.3, map: gmap.current,
      })
    } else {
      overlay.current = new g.maps.Polyline({
        path: path.current, strokeColor: def.color, strokeWeight: 4, map: gmap.current,
      })
    }
  }

  useEffect(() => {
    let cancelled = false
    async function init() {
      try {
        await loadGoogleMaps()
        const g = window.google
        await g.maps.importLibrary('maps')
        await g.maps.importLibrary('geometry')
        if (cancelled || !mapEl.current) return

        let center = property.lat != null && property.lng != null
          ? { lat: property.lat, lng: property.lng }
          : null
        if (!center) {
          try {
            const res = await fetch('/api/geocode', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ address: property.address }),
            })
            const data = await res.json()
            if (res.ok && typeof data.lat === 'number') {
              center = { lat: data.lat, lng: data.lng }
              supabase.from('properties').update({ lat: data.lat, lng: data.lng }).eq('id', property.id)
            }
          } catch { /* ignore */ }
        }
        if (!center) center = { lat: 51.0447, lng: -114.0719 }

        gmap.current = new g.maps.Map(mapEl.current, {
          center, zoom: 20, mapTypeId: 'satellite', tilt: 0,
          streetViewControl: false, fullscreenControl: false, mapTypeControl: false,
        })
        gmap.current.addListener('click', (e: any) => {
          path.current = [...path.current, e.latLng]
          redraw(); recompute()
        })
        setReady(true)
      } catch {
        if (!cancelled) setLoadError(true)
      }
    }
    init()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function selectType(t: MeasureType) {
    setActive(t)
    activeRef.current = t
    clearDrawing()
  }

  function clearDrawing() {
    path.current = []
    if (overlay.current) { overlay.current.setMap(null); overlay.current = null }
    setMeasurement(0)
    setPoints(0)
  }

  function undo() {
    path.current = path.current.slice(0, -1)
    redraw(); recompute()
  }

  async function save() {
    if (measurement <= 0) return
    setSaving(true)
    const def = TYPES.find(t => t.key === activeRef.current)!
    await supabase.from('properties').update({ [def.column]: measurement }).eq('id', property.id)
    setSaved(prev => ({ ...prev, [def.column]: measurement }))
    setSaving(false)
    clearDrawing()
  }

  const unit = activeDef.mode === 'area' ? 'sq ft' : 'ft'
  const minPoints = activeDef.mode === 'area' ? 3 : 2

  if (loadError) {
    return (
      <div className="text-sm text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3">
        Couldn&apos;t load the map. Make sure the Maps JavaScript API is enabled on your browser key.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {TYPES.map(t => (
          <button
            key={t.key}
            onClick={() => selectType(t.key)}
            className={`shrink-0 px-3.5 py-2 rounded-xl text-sm font-medium border transition-all ${
              active === t.key
                ? 'bg-accent/10 text-accent border-accent/30'
                : 'text-ink-muted border-border hover:text-ink'
            }`}
          >
            {t.label}
            {saved[t.column] != null && (
              <span className="ml-1.5 text-[10px] text-ink-faint">
                {saved[t.column]}{t.mode === 'area' ? ' ft²' : ' ft'}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="relative rounded-card overflow-hidden border border-border">
        <div ref={mapEl} className="w-full h-[55vh] min-h-[320px] bg-bg-secondary" />
        {!ready && !loadError && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-muted bg-bg-secondary/80">
            Loading satellite map...
          </div>
        )}
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3 bg-bg-secondary border border-border rounded-xl px-4 py-3">
        <div className="flex items-center gap-2">
          <Ruler className="w-4 h-4 text-accent" />
          <span className="text-sm text-ink-muted">
            {activeDef.label} {activeDef.mode === 'area' ? 'area' : 'length'}:
          </span>
          <span className="text-lg font-bold text-ink">
            {measurement > 0 ? `${measurement.toLocaleString()} ${unit}` : '—'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={undo} disabled={points === 0}>
            <Undo2 className="w-3.5 h-3.5" /> Undo
          </Button>
          <Button variant="secondary" size="sm" onClick={clearDrawing} disabled={points === 0}>
            <Trash2 className="w-3.5 h-3.5" /> Clear
          </Button>
          <Button size="sm" onClick={save} loading={saving} disabled={measurement <= 0}>
            <Check className="w-3.5 h-3.5" /> Save {activeDef.label}
          </Button>
        </div>
      </div>

      <p className="text-xs text-ink-faint">
        Tap each corner of the {activeDef.label.toLowerCase()} on the map
        {activeDef.mode === 'area' ? ' to trace its outline' : ' along the fence line'}.
        You need at least {minPoints} points. The measurement updates as you go — tap Save when it looks right.
      </p>
    </div>
  )
}