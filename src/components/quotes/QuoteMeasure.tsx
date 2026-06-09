'use client'

import { useEffect, useRef, useState } from 'react'
import { loadGoogleMaps } from '@/lib/googleMaps'
import { priceTiers, recommendedJobPrice, DEFAULT_RATE_PER_1000 } from '@/lib/pricing'
import { Button } from '@/components/ui/Button'
import { X, Undo2, Trash2, Plus, Ruler } from 'lucide-react'

const M2_TO_SQFT = 10.7639
const RATE_KEY = 'eq_rate_per_1000' // shared with the property Measurement Tool

interface Props {
  address: string
  travelFee: number
  onApply: (price: number, totalSqft: number, suggested: number) => void
  onClose: () => void
}

export function QuoteMeasure({ address, travelFee, onApply, onClose }: Props) {
  const mapEl = useRef<HTMLDivElement>(null)
  const gmap = useRef<any>(null)
  const committedOverlays = useRef<any[]>([])
  const committedPaths = useRef<any[][]>([])
  const currentOverlay = useRef<any>(null)
  const currentPath = useRef<any[]>([])
  const preview = useRef<any>(null)

  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [totalSqft, setTotalSqft] = useState(0)
  const [points, setPoints] = useState(0)
  const [shapes, setShapes] = useState(0)
  const [ratePer1000, setRatePer1000] = useState(DEFAULT_RATE_PER_1000)
  const [overgrowth, setOvergrowth] = useState(1)

  // Seed/remember the rate locally so it matches the property Measurement Tool.
  useEffect(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(RATE_KEY) : null
    if (stored) setRatePer1000(Number(stored) || DEFAULT_RATE_PER_1000)
  }, [])
  function updateRate(v: number) {
    setRatePer1000(v)
    if (typeof window !== 'undefined') window.localStorage.setItem(RATE_KEY, String(v))
  }

  function areaOf(p: any[]): number {
    const g = window.google
    return p.length >= 3 ? g.maps.geometry.spherical.computeArea(p) * M2_TO_SQFT : 0
  }

  function recompute() {
    let total = 0
    for (const p of committedPaths.current) total += areaOf(p)
    total += areaOf(currentPath.current)
    setTotalSqft(Math.round(total))
    setPoints(currentPath.current.length)
    setShapes(committedPaths.current.length)
  }

  function redrawCurrent() {
    const g = window.google
    if (currentOverlay.current) { currentOverlay.current.setMap(null); currentOverlay.current = null }
    if (currentPath.current.length === 0) return
    currentOverlay.current = new g.maps.Polygon({
      paths: currentPath.current, strokeColor: '#00C896', strokeWeight: 2,
      fillColor: '#00C896', fillOpacity: 0.3, map: gmap.current,
      clickable: false, // never intercept a click meant to place the next point
    })
  }

  // Instant "click registered" pulse at the exact spot (zoom-independent).
  function flashClick(latLng: any) {
    const g = window.google
    if (!gmap.current) return
    const pulse = new g.maps.Marker({
      position: latLng, map: gmap.current, clickable: false, zIndex: 3000,
      icon: { path: g.maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#00C896', fillOpacity: 0.45, strokeColor: '#FFFFFF', strokeWeight: 2 },
    })
    let frame = 0
    const FRAMES = 18
    const tick = () => {
      frame++
      const t = frame / FRAMES
      pulse.setIcon({
        path: g.maps.SymbolPath.CIRCLE, scale: 7 + t * 18,
        fillColor: '#00C896', fillOpacity: 0.4 * (1 - t),
        strokeColor: '#FFFFFF', strokeOpacity: 1 - t, strokeWeight: 2,
      })
      if (frame < FRAMES) requestAnimationFrame(tick)
      else pulse.setMap(null)
    }
    requestAnimationFrame(tick)
  }

  function updatePreview(cursor: any) {
    const g = window.google
    if (currentPath.current.length === 0 || !cursor) {
      if (preview.current) { preview.current.setMap(null); preview.current = null }
      return
    }
    const last = currentPath.current[currentPath.current.length - 1]
    const pts = currentPath.current.length >= 2
      ? [last, cursor, currentPath.current[0]]
      : [last, cursor]
    if (!preview.current) {
      preview.current = new g.maps.Polyline({
        path: pts, strokeColor: '#00C896', strokeOpacity: 0.7, strokeWeight: 2,
        icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 }, offset: '0', repeat: '10px' }],
        map: gmap.current, clickable: false,
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

        let center: { lat: number; lng: number } | null = null
        if (address) {
          try {
            const res = await fetch('/api/geocode', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ address }),
            })
            const data = await res.json()
            if (res.ok && typeof data.lat === 'number') center = { lat: data.lat, lng: data.lng }
          } catch { /* ignore */ }
        }
        if (!center) center = { lat: 51.0447, lng: -114.0719 }
        // Re-check after the geocode await — the modal may have been closed.
        if (cancelled || !mapEl.current) return

        gmap.current = new Map(mapEl.current, {
          center, zoom: 20, mapTypeId: 'satellite', tilt: 0,
          streetViewControl: false, fullscreenControl: false, mapTypeControl: false,
          draggableCursor: 'crosshair',
          // Reliable single-click placement (see MeasureTool for the rationale).
          disableDoubleClickZoom: true, clickableIcons: false, gestureHandling: 'greedy',
        })
        gmap.current.addListener('click', (e: any) => {
          flashClick(e.latLng)
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
    return () => {
      cancelled = true
      // This modal mounts/unmounts on every open — tear down the map so we don't
      // leak a Map instance + listeners each time.
      const g = window.google
      if (g?.maps?.event && gmap.current) g.maps.event.clearInstanceListeners(gmap.current)
      committedOverlays.current.forEach(o => o.setMap(null)); committedOverlays.current = []
      currentOverlay.current?.setMap(null); currentOverlay.current = null
      preview.current?.setMap(null); preview.current = null
      gmap.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function addArea() {
    if (currentPath.current.length < 3) return
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

  function clearAll() {
    committedOverlays.current.forEach(o => o.setMap(null))
    committedOverlays.current = []
    committedPaths.current = []
    if (currentOverlay.current) { currentOverlay.current.setMap(null); currentOverlay.current = null }
    if (preview.current) { preview.current.setMap(null); preview.current = null }
    currentPath.current = []
    setTotalSqft(0); setPoints(0); setShapes(0)
  }

  const tiers = priceTiers({ sqft: totalSqft, ratePer1000, overgrowth })

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="w-full sm:max-w-3xl bg-bg-secondary border border-border sm:rounded-card max-h-[95vh] overflow-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border sticky top-0 bg-bg-secondary">
          <h2 className="text-sm font-semibold text-ink">Measure & Price</h2>
          <button onClick={onClose} className="text-ink-faint hover:text-ink"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-4 space-y-4">
          {loadError ? (
            <div className="text-sm text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 space-y-1">
              <p>The map couldn&apos;t load. Error detail:</p>
              <p className="font-mono text-xs text-amber-300 break-words">{loadError}</p>
            </div>
          ) : (
            <>
              <div className="relative rounded-card overflow-hidden border border-border">
                <div ref={mapEl} className="w-full h-[45vh] min-h-[300px] bg-bg-tertiary" />
                {!ready && (
                  <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-muted bg-bg-tertiary/80">
                    Loading satellite map...
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <Button variant="secondary" size="sm" onClick={addArea} disabled={points < 3}>
                  <Plus className="w-3.5 h-3.5" /> Add another area
                </Button>
                <Button variant="secondary" size="sm" onClick={undo} disabled={points === 0 && shapes === 0}>
                  <Undo2 className="w-3.5 h-3.5" /> Undo
                </Button>
                <Button variant="secondary" size="sm" onClick={clearAll} disabled={points === 0 && shapes === 0}>
                  <Trash2 className="w-3.5 h-3.5" /> Clear
                </Button>
              </div>

              <div className="bg-bg-tertiary border border-border rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div className="flex items-center gap-2">
                    <Ruler className="w-4 h-4 text-accent" />
                    <span className="text-sm text-ink-muted">Total area:</span>
                    <span className="text-lg font-bold text-ink">{totalSqft.toLocaleString()} sq ft</span>
                    {shapes > 0 && <span className="text-xs text-ink-faint">({shapes} + current)</span>}
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1.5 text-xs text-ink-muted">
                      <input
                        type="number" min="0" step="1" placeholder="0"
                        value={ratePer1000 || ''}
                        onChange={e => updateRate(Number(e.target.value) || 0)}
                        className="w-20 bg-bg border border-border-strong rounded-lg px-2.5 py-2 text-base sm:text-sm text-ink outline-none focus:border-accent"
                      />
                      $ / 1,000 ft²
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-ink-muted">
                      <input
                        type="number" min="0" step="0.05"
                        value={overgrowth}
                        onChange={e => setOvergrowth(Number(e.target.value) || 1)}
                        className="w-16 bg-bg border border-border-strong rounded-lg px-2.5 py-2 text-base sm:text-sm text-ink outline-none focus:border-accent"
                      />
                      Condition
                    </label>
                  </div>
                </div>

                {ratePer1000 > 0 && totalSqft > 0 ? (
                  <div className="border-t border-border pt-3">
                    <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">Suggested job price{Number(travelFee || 0) > 0 ? ` · $${Number(travelFee).toLocaleString()} travel stays on the quote` : ''}</p>
                    <div className="grid grid-cols-2 gap-2">
                      {tiers.map(t => (
                        <button
                          key={t.tier}
                          type="button"
                          onClick={() => onApply(t.amount, totalSqft, t.amount + Number(travelFee || 0))}
                          className={`text-left rounded-xl border px-3 py-2.5 transition-all hover:border-accent ${t.recommended ? 'border-accent/40 bg-accent/5' : 'border-border'}`}
                        >
                          <p className="text-[11px] uppercase tracking-wide text-ink-faint flex items-center gap-1">{t.label}{t.recommended && <span className="text-accent">★</span>}</p>
                          <p className="text-lg font-bold text-ink">${t.amount.toLocaleString()}</p>
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-ink-faint mt-2">Tap a price to use it on the quote.</p>
                  </div>
                ) : (
                  <div className="border-t border-border pt-3 text-xs text-ink-faint">
                    Enter your $ / 1,000 sq ft rate to see suggested prices.
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                {ratePer1000 > 0 && totalSqft > 0 && (
                  <Button onClick={() => {
                    const rec = recommendedJobPrice({ sqft: totalSqft, ratePer1000, overgrowth })
                    onApply(rec, totalSqft, rec + Number(travelFee || 0))
                  }}>
                    Use recommended
                  </Button>
                )}
              </div>

              <p className="text-xs text-ink-faint">
                Tap each corner of the lawn to trace it. For front + back, trace one, tap <span className="text-ink font-medium">Add another area</span>, then trace the next — they add up. The price is your rate × area, plus the travel fee from the quote.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}