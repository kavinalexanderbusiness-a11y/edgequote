'use client'

import { useEffect, useRef, useState } from 'react'
import { loadGoogleMaps } from '@/lib/googleMaps'
import { Button } from '@/components/ui/Button'
import { X, Undo2, Trash2, Plus, Ruler } from 'lucide-react'

const M2_TO_SQFT = 10.7639

interface Props {
  address: string
  travelFee: number
  onApply: (price: number, totalSqft: number) => void
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
  const [ratePer1000, setRatePer1000] = useState(0)

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
    })
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

  const areaPrice = (totalSqft / 1000) * ratePer1000
  const total = areaPrice + Number(travelFee || 0)

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
                  <div className="flex items-center gap-2">
                    <input
                      type="number" min="0" step="1" placeholder="0"
                      value={ratePer1000 || ''}
                      onChange={e => setRatePer1000(Number(e.target.value) || 0)}
                      className="w-24 bg-bg border border-border-strong rounded-lg px-2.5 py-2 text-base sm:text-sm text-ink outline-none focus:border-accent"
                    />
                    <span className="text-xs text-ink-muted">$ / 1,000 sq ft</span>
                  </div>
                </div>

                <div className="border-t border-border pt-3 space-y-1.5 text-sm">
                  <div className="flex justify-between"><span className="text-ink-muted">Area price</span><span className="text-ink font-medium">${areaPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></div>
                  <div className="flex justify-between"><span className="text-ink-muted">Travel fee</span><span className="text-ink font-medium">${Number(travelFee || 0).toLocaleString()}</span></div>
                  <div className="flex justify-between pt-1.5 border-t border-border"><span className="font-semibold text-ink">Suggested total</span><span className="text-xl font-bold text-accent">${total.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button onClick={() => onApply(Math.round(total), totalSqft)} disabled={total <= 0}>
                  Use this price
                </Button>
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