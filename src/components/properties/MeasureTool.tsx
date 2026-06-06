'use client'

import { useEffect, useRef, useState } from 'react'
import { loadGoogleMaps } from '@/lib/googleMaps'
import { createClient } from '@/lib/supabase/client'
import { Property } from '@/types'
import { Button } from '@/components/ui/Button'
import { Undo2, Trash2, Check, Ruler, Plus } from 'lucide-react'

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
  const committedOverlays = useRef<any[]>([])
  const committedPaths = useRef<any[][]>([])
  const currentOverlay = useRef<any>(null)
  const currentPath = useRef<any[]>([])
  const preview = useRef<any>(null)
  const activeRef = useRef<MeasureType>('lawn')

  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [active, setActive] = useState<MeasureType>('lawn')
  const [measurement, setMeasurement] = useState(0)
  const [shapes, setShapes] = useState(0)
  const [points, setPoints] = useState(0)
  const [pricePerUnit, setPricePerUnit] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<Record<string, number | null>>({
    lawn_sqft: property.lawn_sqft,
    fence_length: property.fence_length,
    mulch_area: property.mulch_area,
    rock_area: property.rock_area,
    driveway_area: property.driveway_area,
  })

  const activeDef = TYPES.find(t => t.key === active)!

  function measureOf(p: any[], mode: 'area' | 'length'): number {
    const g = window.google
    if (mode === 'area') return p.length >= 3 ? g.maps.geometry.spherical.computeArea(p) * M2_TO_SQFT : 0
    return p.length >= 2 ? g.maps.geometry.spherical.computeLength(p) * M_TO_FT : 0
  }

  function recompute() {
    const def = TYPES.find(t => t.key === activeRef.current)!
    let total = 0
    for (const p of committedPaths.current) total += measureOf(p, def.mode)
    total += measureOf(currentPath.current, def.mode)
    setMeasurement(Math.round(total))
    setPoints(currentPath.current.length)
    setShapes(committedPaths.current.length)
  }

  function redrawCurrent() {
    const g = window.google
    if (currentOverlay.current) { currentOverlay.current.setMap(null); currentOverlay.current = null }
    const def = TYPES.find(t => t.key === activeRef.current)!
    if (currentPath.current.length === 0) return
    if (def.mode === 'area') {
      currentOverlay.current = new g.maps.Polygon({
        paths: currentPath.current, strokeColor: def.color, strokeWeight: 2,
        fillColor: def.color, fillOpacity: 0.3, map: gmap.current,
      })
    } else {
      currentOverlay.current = new g.maps.Polyline({
        path: currentPath.current, strokeColor: def.color, strokeWeight: 4, map: gmap.current,
      })
    }
  }

  function updatePreview(cursor: any) {
    const g = window.google
    const def = TYPES.find(t => t.key === activeRef.current)!
    if (currentPath.current.length === 0 || !cursor) {
      if (preview.current) { preview.current.setMap(null); preview.current = null }
      return
    }
    const last = currentPath.current[currentPath.current.length - 1]
    const pts = def.mode === 'area' && currentPath.current.length >= 2
      ? [last, cursor, currentPath.current[0]]
      : [last, cursor]
    if (!preview.current) {
      preview.current = new g.maps.Polyline({
        path: pts, strokeColor: def.color, strokeOpacity: 0.7, strokeWeight: 2,
        icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 }, offset: '0', repeat: '10px' }],
        map: gmap.current,
      })
    } else {
      preview.current.setPath(pts)
    }
  }

  useEffect(() => {
    let cancelled = false
    async function init() {
      try {
        await loadGoogleMaps()
        const g = window.google
        const { Map } = await g.maps.importLibrary('maps')
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

        gmap.current = new Map(mapEl.current, {
          center, zoom: 20, mapTypeId: 'satellite', tilt: 0,
          streetViewControl: false, fullscreenControl: false, mapTypeControl: false,
        })
        gmap.current.addListener('click', (e: any) => {
          currentPath.current = [...currentPath.current, e.latLng]
          redrawCurrent(); recompute()
        })
        gmap.current.addListener('mousemove', (e: any) => updatePreview(e.latLng))
        setReady(true)
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Map failed to load')
      }
    }
    init()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function selectType(t: MeasureType) {
    setActive(t)
    activeRef.current = t
    setPricePerUnit(0)
    clearAll()
  }

  function clearAll() {
    committedOverlays.current.forEach(o => o.setMap(null))
    committedOverlays.current = []
    committedPaths.current = []
    if (currentOverlay.current) { currentOverlay.current.setMap(null); currentOverlay.current = null }
    if (preview.current) { preview.current.setMap(null); preview.current = null }
    currentPath.current = []
    setMeasurement(0); setPoints(0); setShapes(0)
  }

  function addArea() {
    const def = TYPES.find(t => t.key === activeRef.current)!
    const min = def.mode === 'area' ? 3 : 2
    if (currentPath.current.length < min) return
    if (currentOverlay.current) { committedOverlays.current.push(currentOverlay.current); currentOverlay.current = null }
    committedPaths.current.push(currentPath.current)
    currentPath.current = []
    if (preview.current) { preview.current.setMap(null); preview.current = null }
    recompute()
  }

  function undo() {
    if (currentPath.current.length > 0) {
      currentPath.current = currentPath.current.slice(0, -1)
      redrawCurrent()
    } else if (committedPaths.current.length > 0) {
      const ov = committedOverlays.current.pop()
      if (ov) ov.setMap(null)
      committedPaths.current.pop()
    }
    recompute()
  }

  async function save() {
    if (measurement <= 0) return
    setSaving(true)
    const def = TYPES.find(t => t.key === activeRef.current)!
    await supabase.from('properties').update({ [def.column]: measurement }).eq('id', property.id)
    setSaved(prev => ({ ...prev, [def.column]: measurement }))
    setSaving(false)
    clearAll()
  }

  const unit = activeDef.mode === 'area' ? 'sq ft' : 'ft'
  const priceLabel = activeDef.mode === 'area' ? '$ per 1,000 sq ft' : '$ per ft'
  const estPrice = activeDef.mode === 'area'
    ? (measurement / 1000) * pricePerUnit
    : measurement * pricePerUnit

  if (loadError) {
    return (
      <div className="text-sm text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 space-y-1">
        <p>The map couldn&apos;t load. Error detail:</p>
        <p className="font-mono text-xs text-amber-300 break-words">{loadError}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Type selector */}
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

      {/* Map */}
      <div className="relative rounded-card overflow-hidden border border-border">
        <div ref={mapEl} className="w-full h-[55vh] min-h-[320px] bg-bg-secondary" />
        {!ready && !loadError && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-muted bg-bg-secondary/80">
            Loading satellite map...
          </div>
        )}
      </div>

      {/* Readout + price */}
      <div className="bg-bg-secondary border border-border rounded-xl px-4 py-3 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <Ruler className="w-4 h-4 text-accent" />
            <span className="text-sm text-ink-muted">{activeDef.label} total:</span>
            <span className="text-lg font-bold text-ink">
              {measurement > 0 ? `${measurement.toLocaleString()} ${unit}` : '—'}
            </span>
            {shapes > 0 && (
              <span className="text-xs text-ink-faint">({shapes} area{shapes !== 1 ? 's' : ''} + current)</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number" min="0" step="1" placeholder="0"
              value={pricePerUnit || ''}
              onChange={e => setPricePerUnit(Number(e.target.value) || 0)}
              className="w-24 bg-bg-tertiary border border-border-strong rounded-lg px-2.5 py-2 text-base sm:text-sm text-ink outline-none focus:border-accent"
            />
            <span className="text-xs text-ink-muted">{priceLabel}</span>
          </div>
        </div>
        {pricePerUnit > 0 && measurement > 0 && (
          <p className="text-sm text-ink">
            Suggested price: <span className="font-bold text-accent">${estPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
          </p>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="secondary" size="sm" onClick={addArea} disabled={points < (activeDef.mode === 'area' ? 3 : 2)}>
            <Plus className="w-3.5 h-3.5" /> Add another area
          </Button>
          <Button variant="secondary" size="sm" onClick={undo} disabled={points === 0 && shapes === 0}>
            <Undo2 className="w-3.5 h-3.5" /> Undo
          </Button>
          <Button variant="secondary" size="sm" onClick={clearAll} disabled={points === 0 && shapes === 0}>
            <Trash2 className="w-3.5 h-3.5" /> Clear
          </Button>
          <Button size="sm" onClick={save} loading={saving} disabled={measurement <= 0}>
            <Check className="w-3.5 h-3.5" /> Save {activeDef.label}
          </Button>
        </div>
      </div>

      <p className="text-xs text-ink-faint">
        Tap each corner to trace the {activeDef.label.toLowerCase()}. For a separate front and back {activeDef.label.toLowerCase()},
        trace one, tap <span className="text-ink font-medium">Add another area</span>, then trace the next — they add up. Tap Save when done.
      </p>
    </div>
  )
}