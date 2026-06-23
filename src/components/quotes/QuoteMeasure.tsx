'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { loadGoogleMaps } from '@/lib/googleMaps'
import { pricingPackage, estimateVisitMinutes, PricingConfig, CadenceKey } from '@/lib/pricing'
import { Coord } from '@/lib/geo'
import { ProspectContext, loadProspectContext, assessProspect } from '@/lib/prospect'
import { PricePackagePanel, CadenceSelection } from '@/components/pricing/PricePackagePanel'
import { DecisionSummary } from '@/components/pricing/DecisionSummary'
import { AutoMeasureBanner } from '@/components/measure/AutoMeasureBanner'
import { recordMeasurement, neighborhoodOf, AutoMeasureResult } from '@/lib/autoMeasure'
import { DEFAULT_CREW_COST, crewCostPerHour as resolveCrewCost } from '@/lib/economics'
import { Button } from '@/components/ui/Button'
import { X, Undo2, Trash2, Plus, Ruler } from 'lucide-react'

const M2_TO_SQFT = 10.7639

// Everything the builder needs to fill the quote's pricing structure in one tap.
export interface MeasureApplyPayload {
  cadence: CadenceKey
  price: number       // the selected cadence's per-visit price
  oneTime: number
  weekly: number
  biweekly: number
  monthly: number
  totalSqft: number
  suggested: number   // one-time + travel (pricing-analysis provenance)
}

interface Props {
  address: string
  travelFee: number
  cfg: PricingConfig
  onApply: (sel: MeasureApplyPayload) => void
  onClose: () => void
}

export function QuoteMeasure({ address, travelFee, cfg, onApply, onClose }: Props) {
  const supabase = createClient()
  const [center, setCenter] = useState<Coord | null>(null)
  const [hoodName, setHoodName] = useState<string | null>(null)
  const [prospect, setProspect] = useState<ProspectContext | null>(null)
  // Loaded crew cost ($/hr) from Settings — the basis for expected profit.
  const [crewCost, setCrewCost] = useState<number>(DEFAULT_CREW_COST)

  // Business context for the recommendation + verdict (same engines as the
  // travel-density discount and neighborhood analytics).
  useEffect(() => {
    if (!center) return
    let active = true
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || !center) return
      const [ctx, settingsRes] = await Promise.all([
        loadProspectContext(supabase, user.id, center),
        supabase.from('business_settings').select('crew_cost_per_hour').eq('user_id', user.id).maybeSingle(),
      ])
      if (!active) return
      setProspect(ctx)
      setCrewCost(resolveCrewCost((settingsRes.data as { crew_cost_per_hour: number | null } | null)?.crew_cost_per_hour))
    }
    load()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center])
  const mapEl = useRef<HTMLDivElement>(null)
  const gmap = useRef<any>(null)
  const committedOverlays = useRef<any[]>([])
  const committedPaths = useRef<any[][]>([])
  const currentOverlay = useRef<any>(null)
  const currentPath = useRef<any[]>([])
  const preview = useRef<any>(null)
  const overrideRef = useRef(0)
  const autoRef = useRef<AutoMeasureResult | null>(null)

  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [totalSqft, setTotalSqft] = useState(0)
  const [points, setPoints] = useState(0)
  const [shapes, setShapes] = useState(0)
  // Raw string so '0.5' is typeable — coercing each keystroke with `|| 1` made
  // sub-1 multipliers impossible and could turn '.5' keystrokes into 15×.
  const [overgrowthRaw, setOvergrowthRaw] = useState('1')
  const ogParsed = parseFloat(overgrowthRaw)
  const overgrowth = Number.isFinite(ogParsed) && ogParsed > 0 ? ogParsed : 1

  function areaOf(p: any[]): number {
    const g = window.google
    return p.length >= 3 ? g.maps.geometry.spherical.computeArea(p) * M2_TO_SQFT : 0
  }

  function recompute() {
    let total = 0
    for (const p of committedPaths.current) total += areaOf(p)
    total += areaOf(currentPath.current)
    // Traced shapes win; otherwise fall back to the auto/accepted override.
    setTotalSqft(total > 0 ? Math.round(total) : Math.round(overrideRef.current || 0))
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
            if (res.ok && typeof data.lat === 'number') {
              center = { lat: data.lat, lng: data.lng }
              if (typeof data.neighborhood === 'string') setHoodName(data.neighborhood)
            }
          } catch { /* ignore */ }
        }
        if (center) setCenter(center) // route-density context for the pricing package
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

  // The complete recommendation package — same engine the property MeasureTool
  // and travel-density discount use; nearby = located upcoming jobs within range.
  // Pass 1: base package → Pass 2: grade-adjusted recurring pricing, so recurring
  // prices reflect the customer's business value (route grade), not just lawn size.
  const nearby = prospect?.nearbyJobs ?? 0
  const basePkg = totalSqft > 0 ? pricingPackage(totalSqft, cfg, { overgrowth, nearbyCount: nearby, neighborhoodName: hoodName }) : null
  const assessment = basePkg && prospect
    ? assessProspect(basePkg, prospect, {
        distanceKm: null, travelFee: Number(travelFee) || 0, neighborhoodName: hoodName,
        estimatedMinutes: estimateVisitMinutes(totalSqft, prospect.observedMinPer1000),
        timedJobs: prospect.timedJobs, crewCostPerHour: crewCost,
      })
    : null
  const pkg = totalSqft > 0
    ? pricingPackage(totalSqft, cfg, { overgrowth, nearbyCount: nearby, neighborhoodName: hoodName, valueGrade: assessment?.score ?? null })
    : null

  function applySelection(sel: CadenceSelection) {
    if (!pkg) return
    // Record auto vs accepted so the estimate self-calibrates (best-effort).
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) recordMeasurement(supabase, {
        userId: user.id, context: 'quote', lat: center?.lat ?? null, lng: center?.lng ?? null,
        neighborhood: neighborhoodOf(null, null, hoodName), auto: autoRef.current, acceptedSqft: totalSqft,
      }).catch(() => {})
    })()
    onApply({
      cadence: sel.cadence,
      price: sel.price,
      oneTime: pkg.oneTime,
      weekly: pkg.options[0].price,
      biweekly: pkg.options[1].price,
      monthly: pkg.options[2].price,
      totalSqft,
      suggested: pkg.oneTime + Number(travelFee || 0),
    })
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="w-full sm:max-w-3xl bg-bg-secondary border border-border sm:rounded-card max-h-[95vh] overflow-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border sticky top-0 bg-bg-secondary">
          <h2 className="text-sm font-semibold text-ink">Measure & Price</h2>
          <button onClick={onClose} className="text-ink-faint hover:text-ink"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-4 space-y-4">
          {center && (
            <AutoMeasureBanner lat={center.lat} lng={center.lng}
              neighborhood={neighborhoodOf(null, null, hoodName)}
              onAuto={r => { autoRef.current = r }}
              onUse={n => { overrideRef.current = n; setTotalSqft(n) }} />
          )}
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
                  <label className="flex items-center gap-1.5 text-xs text-ink-muted">
                    <input
                      type="number" min="0" step="0.05"
                      value={overgrowthRaw}
                      onChange={e => setOvergrowthRaw(e.target.value)}
                      className="w-16 bg-bg border border-border-strong rounded-lg px-2.5 py-2 text-base sm:text-sm text-ink outline-none focus:border-accent"
                    />
                    Condition
                  </label>
                </div>

                {pkg ? (
                  <div className="border-t border-border pt-3 space-y-3">
                    <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">
                      Pricing recommendation{Number(travelFee || 0) > 0 ? ` · $${Number(travelFee).toLocaleString()} travel stays on the quote` : ''}
                    </p>
                    {assessment ? (
                      <DecisionSummary a={assessment} pkg={pkg} onUse={applySelection} />
                    ) : (
                      <PricePackagePanel pkg={pkg} onUse={applySelection} />
                    )}
                  </div>
                ) : (
                  <div className="border-t border-border pt-3 text-xs text-ink-faint">
                    Trace the lawn to see the full pricing recommendation (set rates in Settings).
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                {pkg && (
                  <Button onClick={() => applySelection({ cadence: pkg.recommended.cadence, price: pkg.recommended.cadence === 'weekly' ? pkg.options[0].price : pkg.recommended.cadence === 'biweekly' ? pkg.options[1].price : pkg.recommended.cadence === 'monthly' ? pkg.options[2].price : pkg.oneTime })}>
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