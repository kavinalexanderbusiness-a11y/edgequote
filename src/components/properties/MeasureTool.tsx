'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { loadGoogleMaps } from '@/lib/googleMaps'
import { createClient } from '@/lib/supabase/client'
import { Property, BusinessSettings, TravelFeeTier, MeasurementSnapshot, LawnSections, PricingConfidence, CONFIDENCE_LABELS, CONFIDENCE_COLORS } from '@/types'
import { priceTiers, routeDensityTravel, pricingConfidence, DEFAULT_RATE_PER_1000, PriceTier } from '@/lib/pricing'
import { formatCurrency, formatDate, suggestTravelFee } from '@/lib/utils'
import { Coord, haversineKm, nearbyJobCount, fetchLocatedUpcomingJobs } from '@/lib/geo'
import { Button } from '@/components/ui/Button'
import { Undo2, Trash2, Check, Ruler, Plus, ZoomIn, ZoomOut, RotateCcw, FileText, Car, ShieldCheck, History, Move } from 'lucide-react'

const M2_TO_SQFT = 10.7639
const RATE_KEY = 'eq_rate_per_1000'
const SNAP_PX = 16 // closing snap threshold in screen pixels

const SECTIONS = [
  { key: 'front',     label: 'Front Lawn', color: '#00C896' },
  { key: 'back',      label: 'Back Lawn',  color: '#3B82F6' },
  { key: 'left',      label: 'Left Side',  color: '#F59E0B' },
  { key: 'right',     label: 'Right Side', color: '#A855F7' },
  { key: 'boulevard', label: 'Boulevard',  color: '#EF4444' },
  { key: 'other',     label: 'Other',      color: '#94A3B8' },
] as const
type SectionKey = typeof SECTIONS[number]['key']
const sectionDef = (k: SectionKey) => SECTIONS.find(s => s.key === k)!

type Shape = { id: number; section: SectionKey; polygon: any }

export function MeasureTool({ property }: { property: Property }) {
  const supabase = createClient()
  const router = useRouter()
  const mapEl = useRef<HTMLDivElement>(null)
  const gmap = useRef<any>(null)
  const projection = useRef<any>(null)
  const shapes = useRef<Shape[]>([])
  const currentPath = useRef<any[]>([])
  const currentOverlay = useRef<any>(null)
  const preview = useRef<any>(null)
  const vertexMarkers = useRef<any[]>([])
  const snapActive = useRef(false)
  const activeRef = useRef<SectionKey>('front')
  const shapeId = useRef(0)
  const targetCoord = useRef<Coord | null>(null)
  const rafPending = useRef(false)
  // 'draw' = clicks add points (overlays inert). 'adjust' = drag/tap points to
  // edit/delete (map clicks do nothing). Ref mirrors state for the map closures.
  const modeRef = useRef<'draw' | 'adjust'>('draw')
  // History tracked in a ref so concurrent saves append synchronously and never
  // drop a snapshot (React state updates are async).
  const historyRef = useRef<MeasurementSnapshot[]>(
    Array.isArray(property.measurement_history) ? property.measurement_history : []
  )

  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [active, setActive] = useState<SectionKey>('front')
  const [mode, setMode] = useState<'draw' | 'adjust'>('draw')
  const [breakdown, setBreakdown] = useState<Record<SectionKey, number>>({ front: 0, back: 0, left: 0, right: 0, boulevard: 0, other: 0 })
  const [totalSqft, setTotalSqft] = useState(0)
  const [pointsInCurrent, setPointsInCurrent] = useState(0)
  const [ratePer1000, setRatePer1000] = useState(DEFAULT_RATE_PER_1000)
  const [overgrowth, setOvergrowth] = useState(1)
  const [selectedTier, setSelectedTier] = useState<PriceTier>('recommended')
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [savedSqft, setSavedSqft] = useState<number | null>(property.lawn_sqft)

  // Travel + route density (pulled from Settings + your existing jobs).
  const [distanceKm, setDistanceKm] = useState<number | null>(null)
  const [baseTravelFee, setBaseTravelFee] = useState(0)
  const [travelIsCustom, setTravelIsCustom] = useState(false)
  const [nearbyCount, setNearbyCount] = useState(0)
  const [includeTravel, setIncludeTravel] = useState(true)

  // Versioned measurement history for this property (never overwritten).
  const [history, setHistory] = useState<MeasurementSnapshot[]>(
    Array.isArray(property.measurement_history) ? property.measurement_history : []
  )

  // Remember the rate locally so it's typed once, ever.
  useEffect(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(RATE_KEY) : null
    if (stored) setRatePer1000(Number(stored) || DEFAULT_RATE_PER_1000)
  }, [])
  function updateRate(v: number) {
    setRatePer1000(v)
    if (typeof window !== 'undefined') window.localStorage.setItem(RATE_KEY, String(v))
  }

  function areaOfPath(path: any): number {
    const g = window.google
    const arr = Array.isArray(path) ? path : path.getArray()
    return arr.length >= 3 ? g.maps.geometry.spherical.computeArea(arr) * M2_TO_SQFT : 0
  }

  function recompute() {
    const bd: Record<SectionKey, number> = { front: 0, back: 0, left: 0, right: 0, boulevard: 0, other: 0 }
    for (const s of shapes.current) bd[s.section] += areaOfPath(s.polygon.getPath())
    const cur = areaOfPath(currentPath.current)
    bd[activeRef.current] += cur
    setBreakdown(bd)
    setPointsInCurrent(currentPath.current.length)
    setTotalSqft(Math.round(Object.values(bd).reduce((a, b) => a + b, 0)))
  }

  // Coalesce the burst of set_at events fired while dragging a vertex into at
  // most one recompute per animation frame.
  function scheduleRecompute() {
    if (rafPending.current) return
    rafPending.current = true
    requestAnimationFrame(() => { rafPending.current = false; recompute() })
  }

  function redrawCurrent() {
    const g = window.google
    if (currentOverlay.current) { currentOverlay.current.setMap(null); currentOverlay.current = null }
    if (currentPath.current.length === 0) return
    const color = sectionDef(activeRef.current).color
    currentOverlay.current = new g.maps.Polygon({
      paths: currentPath.current, strokeColor: color, strokeWeight: 2,
      fillColor: color, fillOpacity: 0.3, map: gmap.current,
      clickable: false, // never intercept clicks meant to place the next point
    })
  }

  // Screen-pixel position of a LatLng (via the map's overlay projection).
  function toPixel(latLng: any): { x: number; y: number } | null {
    const proj = projection.current?.getProjection?.()
    if (!proj) return null
    const p = proj.fromLatLngToContainerPixel(latLng)
    return p ? { x: p.x, y: p.y } : null
  }

  // Numbered, color-coded vertex handles for the in-progress shape. The last
  // point is "selected", and the first point lights up green when the cursor is
  // close enough to close the polygon (snap-to-first).
  function vertexIcon(opts: { selected?: boolean; snap?: boolean; hover?: boolean }) {
    const g = window.google
    const color = sectionDef(activeRef.current).color
    const r = opts.snap || opts.hover ? 12 : opts.selected ? 10 : 8
    return {
      path: g.maps.SymbolPath.CIRCLE,
      scale: r,
      fillColor: opts.snap ? '#10B981' : opts.selected ? color : '#FFFFFF',
      fillOpacity: 1,
      strokeColor: opts.snap ? '#10B981' : color,
      strokeWeight: 2.5,
    }
  }

  function redrawVertexMarkers() {
    const g = window.google
    vertexMarkers.current.forEach(m => m.setMap(null))
    vertexMarkers.current = []
    const pts = currentPath.current
    const color = sectionDef(activeRef.current).color
    pts.forEach((pt, i) => {
      const isLast = i === pts.length - 1
      const isFirstSnap = i === 0 && snapActive.current && pts.length >= 3
      // clickable:false is critical — a clickable marker sitting on the previous
      // point swallows the click meant to place the NEXT point. These are now
      // purely visual; closing happens via the map's snap-click or Finish button.
      const marker = new g.maps.Marker({
        position: pt,
        map: gmap.current,
        clickable: false,
        icon: vertexIcon({ selected: isLast, snap: isFirstSnap }),
        label: { text: String(i + 1), color: isFirstSnap || isLast ? '#0B0B0B' : color, fontSize: '11px', fontWeight: '700' },
        zIndex: 1000 + i,
      })
      vertexMarkers.current.push(marker)
    })
  }

  // Instant "click registered" confirmation — a quick pulse at the exact spot,
  // zoom-independent, purely cosmetic and never clickable.
  function flashClick(latLng: any) {
    const g = window.google
    if (!gmap.current) return
    const color = sectionDef(activeRef.current).color
    const pulse = new g.maps.Marker({
      position: latLng, map: gmap.current, clickable: false, zIndex: 3000,
      icon: { path: g.maps.SymbolPath.CIRCLE, scale: 7, fillColor: color, fillOpacity: 0.45, strokeColor: '#FFFFFF', strokeWeight: 2 },
    })
    let frame = 0
    const FRAMES = 18
    const tick = () => {
      frame++
      const t = frame / FRAMES
      pulse.setIcon({
        path: g.maps.SymbolPath.CIRCLE,
        scale: 7 + t * 18,
        fillColor: color, fillOpacity: 0.4 * (1 - t),
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
    const pts = currentPath.current.length >= 2 ? [last, cursor, currentPath.current[0]] : [last, cursor]
    if (!preview.current) {
      preview.current = new g.maps.Polyline({
        path: pts, strokeColor: sectionDef(activeRef.current).color, strokeOpacity: 0.7, strokeWeight: 2,
        icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 }, offset: '0', repeat: '10px' }],
        map: gmap.current, clickable: false,
      })
    } else {
      preview.current.setPath(pts)
    }
  }

  function onMouseMove(cursor: any) {
    const pts = currentPath.current
    // Snap-to-first detection (only once a closable shape exists).
    if (pts.length >= 3) {
      const a = toPixel(pts[0]); const b = toPixel(cursor)
      const near = !!(a && b) && Math.hypot(a.x - b.x, a.y - b.y) <= SNAP_PX
      if (near !== snapActive.current) { snapActive.current = near; redrawVertexMarkers() }
      updatePreview(near ? pts[0] : cursor)
    } else {
      if (snapActive.current) { snapActive.current = false; redrawVertexMarkers() }
      updatePreview(cursor)
    }
  }

  // Commit the in-progress shape into a section-tagged polygon. It's created
  // INERT (editable+clickable false) so it can never eat a draw-mode click; the
  // Adjust toggle flips it editable when the user wants to fine-tune.
  function commitCurrent(section: SectionKey) {
    if (currentPath.current.length < 3) return
    const g = window.google
    const color = sectionDef(section).color
    if (currentOverlay.current) { currentOverlay.current.setMap(null); currentOverlay.current = null }
    const adjust = modeRef.current === 'adjust'
    const polygon = new g.maps.Polygon({
      paths: currentPath.current, strokeColor: color, strokeWeight: 2,
      fillColor: color, fillOpacity: 0.32, editable: adjust, clickable: adjust, map: gmap.current,
    })
    const path = polygon.getPath()
    // Live area while dragging vertices (throttled to one recompute per frame).
    ;['set_at', 'insert_at', 'remove_at'].forEach(ev => path.addListener(ev, scheduleRecompute))
    // Tap/click a vertex to delete it — touch-friendly, only active in Adjust
    // mode (the polygon is only clickable then). Keeps a triangle minimum.
    polygon.addListener('click', (e: any) => {
      if (modeRef.current !== 'adjust') return
      if (e.vertex != null && path.getLength() > 3) { path.removeAt(e.vertex); recompute() }
    })
    shapes.current.push({ id: ++shapeId.current, section, polygon })
    currentPath.current = []
    snapActive.current = false
    if (preview.current) { preview.current.setMap(null); preview.current = null }
    redrawVertexMarkers()
    recompute()
  }

  // Flip every finished section between inert (draw) and editable (adjust).
  function setShapesInteractive(on: boolean) {
    shapes.current.forEach(s => s.polygon.setOptions({ editable: on, clickable: on }))
  }

  function enterDrawMode() {
    if (modeRef.current === 'draw') return
    modeRef.current = 'draw'; setMode('draw')
    setShapesInteractive(false)
  }

  function toggleAdjust() {
    if (modeRef.current === 'draw') {
      // Park any in-progress shape, then make finished sections editable.
      if (currentPath.current.length >= 3) commitCurrent(activeRef.current)
      else resetCurrent()
      modeRef.current = 'adjust'; setMode('adjust')
      setShapesInteractive(true)
    } else {
      enterDrawMode()
    }
  }

  function selectSection(k: SectionKey) {
    // Picking a section means you're drawing — leave Adjust mode.
    enterDrawMode()
    // Auto-commit an in-progress shape to the section it was drawn in.
    if (currentPath.current.length >= 3) commitCurrent(activeRef.current)
    setActive(k)
    activeRef.current = k
    redrawCurrent()
    redrawVertexMarkers()
    recompute()
  }

  // Resolve travel distance (base → property) and the matching travel tier fee,
  // then count nearby existing jobs to drive the route-density discount.
  async function loadTravelAndDensity(target: Coord | null) {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const [settingsRes, tiersRes, located] = await Promise.all([
      supabase.from('business_settings').select('*').eq('user_id', user.id).maybeSingle(),
      supabase.from('travel_fee_tiers').select('*').eq('user_id', user.id).order('sort_order'),
      fetchLocatedUpcomingJobs(supabase, user.id),
    ])
    const settings = settingsRes.data as BusinessSettings | null
    const tiers = (tiersRes.data as TravelFeeTier[]) || []

    // Distance: prefer driving distance (matches Quote Builder), fall back to straight-line.
    let km: number | null = null
    if (settings?.base_address && property.address) {
      try {
        const res = await fetch('/api/distance', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ origin: settings.base_address, destination: property.address }),
        })
        const data = await res.json()
        if (res.ok && typeof data.km === 'number') km = data.km
      } catch { /* ignore */ }
    }
    if (km == null && settings?.base_lat != null && settings?.base_lng != null && target) {
      km = Math.round(haversineKm({ lat: settings.base_lat, lng: settings.base_lng }, target) * 10) / 10
    }
    setDistanceKm(km)
    if (km != null && tiers.length) {
      const sugg = suggestTravelFee(km, tiers)
      setTravelIsCustom(sugg.isCustom)
      setBaseTravelFee(sugg.isCustom ? 0 : (sugg.fee ?? 0))
    }

    // Route density — how many located jobs sit near this property.
    if (target) setNearbyCount(nearbyJobCount(target, located).count)
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
          ? { lat: property.lat, lng: property.lng } : null
        if (!center) {
          try {
            const res = await fetch('/api/geocode', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
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
        targetCoord.current = center
        // Re-check after the geocode await — the component may have unmounted.
        if (cancelled || !mapEl.current) return

        gmap.current = new Map(mapEl.current, {
          center, zoom: 20, mapTypeId: 'satellite', tilt: 0,
          streetViewControl: false, fullscreenControl: false, mapTypeControl: false,
          zoomControl: false, draggableCursor: 'crosshair', draggingCursor: 'grabbing',
          // Reliable single-click point placement: don't let a fast 2nd click
          // become a zoom, don't let Google POI pins eat clicks, and keep all
          // gestures inside the map so a tap always registers as a click.
          disableDoubleClickZoom: true, clickableIcons: false, gestureHandling: 'greedy',
        })
        // Overlay used purely to expose the pixel projection for snap detection.
        const ov = new g.maps.OverlayView()
        ov.onAdd = () => {}
        ov.draw = () => {}
        ov.onRemove = () => {}
        ov.setMap(gmap.current)
        projection.current = ov

        gmap.current.addListener('click', (e: any) => {
          // In Adjust mode the map is for editing points, not adding them.
          if (modeRef.current === 'adjust') return
          // Confirm every registered click immediately, before anything else.
          flashClick(e.latLng)
          if (snapActive.current && currentPath.current.length >= 3) {
            commitCurrent(activeRef.current)
            return
          }
          currentPath.current = [...currentPath.current, e.latLng]
          redrawCurrent(); redrawVertexMarkers(); recompute()
        })
        gmap.current.addListener('mousemove', (e: any) => {
          if (modeRef.current === 'adjust') return
          onMouseMove(e.latLng)
        })
        setReady(true)
        loadTravelAndDensity(center)
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Map failed to load')
      }
    }
    init()
    return () => {
      cancelled = true
      // Detach every Maps listener/overlay so the orphaned map can be GC'd.
      const g = window.google
      if (g?.maps?.event && gmap.current) g.maps.event.clearInstanceListeners(gmap.current)
      vertexMarkers.current.forEach(m => m.setMap(null)); vertexMarkers.current = []
      shapes.current.forEach(s => s.polygon.setMap(null)); shapes.current = []
      currentOverlay.current?.setMap(null); currentOverlay.current = null
      preview.current?.setMap(null); preview.current = null
      projection.current?.setMap(null); projection.current = null
      gmap.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function undo() {
    if (currentPath.current.length > 0) {
      currentPath.current = currentPath.current.slice(0, -1)
      snapActive.current = false
      redrawCurrent(); redrawVertexMarkers()
    } else if (shapes.current.length > 0) {
      const s = shapes.current.pop()
      s?.polygon.setMap(null)
    }
    recompute()
  }

  function resetCurrent() {
    currentPath.current = []
    snapActive.current = false
    if (currentOverlay.current) { currentOverlay.current.setMap(null); currentOverlay.current = null }
    if (preview.current) { preview.current.setMap(null); preview.current = null }
    redrawVertexMarkers()
    recompute()
  }

  function clearAll() {
    shapes.current.forEach(s => s.polygon.setMap(null))
    shapes.current = []
    resetCurrent()
  }

  function zoom(dir: 1 | -1) {
    if (gmap.current) gmap.current.setZoom((gmap.current.getZoom() || 20) + dir)
  }

  function currentSections(): LawnSections {
    const bd: Record<SectionKey, number> = { front: 0, back: 0, left: 0, right: 0, boulevard: 0, other: 0 }
    for (const s of shapes.current) bd[s.section] += areaOfPath(s.polygon.getPath())
    return {
      front: Math.round(bd.front), back: Math.round(bd.back), left: Math.round(bd.left),
      right: Math.round(bd.right), boulevard: Math.round(bd.boulevard), other: Math.round(bd.other),
    }
  }

  // Persist the total + append a versioned snapshot to history (never overwrite).
  async function persistMeasurement(): Promise<{ total: number; sections: LawnSections }> {
    if (currentPath.current.length >= 3) commitCurrent(activeRef.current)
    const sections = currentSections()
    const total = Math.round(Object.values(sections).reduce((a, b) => a + b, 0))
    const snapshot: MeasurementSnapshot = {
      date: new Date().toISOString(),
      total_sqft: total,
      sections,
      rate_per_1000: ratePer1000,
    }
    // Append from the ref (synchronous) so back-to-back saves can't drop a
    // snapshot; keep the baseline + most recent 20 so the blob stays bounded.
    const appended = [...historyRef.current, snapshot]
    const nextHistory = appended.length > 21 ? [appended[0], ...appended.slice(-20)] : appended
    historyRef.current = nextHistory
    await supabase.from('properties').update({ lawn_sqft: total, measurement_history: nextHistory }).eq('id', property.id)
    setHistory(nextHistory)
    setSavedSqft(total)
    return { total, sections }
  }

  async function save() {
    if (totalSqft <= 0) return
    setSaving(true)
    await persistMeasurement()
    setSaving(false)
  }

  async function createQuote() {
    if (totalSqft <= 0) return
    setCreating(true)
    const { total, sections } = await persistMeasurement()
    // Price off the SAME (per-section-rounded) total we persist, so jobPrice,
    // measured_sqft and suggested_price are all derived from one area figure.
    const tiersForTotal = priceTiers({ sqft: total, ratePer1000, overgrowth })
    const chosen = tiersForTotal.find(t => t.tier === selectedTier) ?? tiersForTotal.find(t => t.recommended)!
    const payload = {
      customerId: property.customer_id,
      propertyId: property.id,
      address: property.address,
      sqft: total,
      sections,
      jobPrice: chosen.amount,
      travelFee: effectiveTravel,
      includeTravel,
      travelIsCustom,
      travelDistanceKm: distanceKm,
      // "Suggested" = the tool's number for the tier the rep actually picked, so
      // a later manual edit in the builder is what surfaces as a difference.
      suggestedPrice: chosen.amount + effectiveTravel,
      ratePer1000,
      overgrowth,
      confidence,
    }
    if (typeof window !== 'undefined') window.sessionStorage.setItem('eq_measurement', JSON.stringify(payload))
    router.push('/dashboard/quotes/new?from=measurement')
  }

  const tierList = priceTiers({ sqft: totalSqft, ratePer1000, overgrowth })
  const travelComp = routeDensityTravel(baseTravelFee, nearbyCount)
  const effectiveTravel = includeTravel ? travelComp.fee : 0
  const chosenJob = (tierList.find(t => t.tier === selectedTier) ?? tierList.find(t => t.recommended))?.amount ?? 0
  const chosenTotal = chosenJob + effectiveTravel
  const confidence: PricingConfidence = pricingConfidence({ hasMeasurement: totalSqft > 0, nearbyComparables: nearbyCount })
  const activeColor = sectionDef(active).color
  const lastMeasured = history.length ? history[history.length - 1] : null

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
      {/* Section selector — color-coded, large touch targets */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {SECTIONS.map(s => (
          <button
            key={s.key}
            onClick={() => selectSection(s.key)}
            className={`shrink-0 flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-sm font-medium border transition-all ${
              active === s.key ? 'border-2 bg-bg-tertiary' : 'border-border text-ink-muted hover:text-ink'
            }`}
            style={active === s.key ? { borderColor: s.color, color: s.color } : undefined}
          >
            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: s.color }} />
            {s.label}
            {breakdown[s.key] > 0 && <span className="text-[11px] opacity-80">{Math.round(breakdown[s.key]).toLocaleString()}</span>}
          </button>
        ))}
      </div>

      {/* Map with overlaid zoom controls */}
      <div className="relative rounded-card overflow-hidden border border-border">
        <div ref={mapEl} className="w-full h-[55vh] min-h-[340px] bg-bg-secondary" style={{ cursor: 'crosshair' }} />
        {!ready && !loadError && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-muted bg-bg-secondary/80">
            Loading satellite map...
          </div>
        )}
        {ready && (
          <div className="absolute top-3 right-3 flex flex-col gap-1.5">
            <button onClick={() => zoom(1)} aria-label="Zoom in" className="w-11 h-11 rounded-xl bg-bg-secondary/90 border border-border-strong text-ink flex items-center justify-center hover:bg-bg-tertiary shadow-lg"><ZoomIn className="w-5 h-5" /></button>
            <button onClick={() => zoom(-1)} aria-label="Zoom out" className="w-11 h-11 rounded-xl bg-bg-secondary/90 border border-border-strong text-ink flex items-center justify-center hover:bg-bg-tertiary shadow-lg"><ZoomOut className="w-5 h-5" /></button>
          </div>
        )}
        {/* Active-section pill */}
        {ready && (
          <div className="absolute top-3 left-3 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-bg-secondary/90 border border-border-strong text-xs font-medium" style={{ color: mode === 'adjust' ? '#F59E0B' : activeColor }}>
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: mode === 'adjust' ? '#F59E0B' : activeColor }} />
            {mode === 'adjust'
              ? 'Adjusting — drag a point to move, tap to delete'
              : <>Tracing: {sectionDef(active).label}{pointsInCurrent >= 3 && <span className="text-ink-faint"> · tap point 1 to close</span>}</>}
          </div>
        )}
      </div>

      {/* Drawing controls — large targets */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Button variant="secondary" onClick={() => commitCurrent(active)} disabled={mode === 'adjust' || pointsInCurrent < 3} className="h-11">
          <Plus className="w-4 h-4" /> Finish section
        </Button>
        <Button variant="secondary" onClick={undo} disabled={mode === 'adjust' || (pointsInCurrent === 0 && shapes.current.length === 0)} className="h-11">
          <Undo2 className="w-4 h-4" /> Undo point
        </Button>
        <Button variant="secondary" onClick={resetCurrent} disabled={mode === 'adjust' || pointsInCurrent === 0} className="h-11">
          <RotateCcw className="w-4 h-4" /> Reset shape
        </Button>
        <Button variant="secondary" onClick={clearAll} disabled={pointsInCurrent === 0 && shapes.current.length === 0} className="h-11">
          <Trash2 className="w-4 h-4" /> Clear all
        </Button>
      </div>

      {/* Adjust mode — touch-friendly point editing (drag to move, tap to delete) */}
      {shapes.current.length > 0 && (
        <button
          type="button"
          onClick={toggleAdjust}
          className={`w-full h-11 rounded-xl border text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
            mode === 'adjust' ? 'border-amber-500/50 bg-amber-500/10 text-amber-400' : 'border-border text-ink-muted hover:text-ink'
          }`}
        >
          <Move className="w-4 h-4" />
          {mode === 'adjust' ? 'Done adjusting — back to drawing' : 'Adjust points · drag to move, tap to delete'}
        </button>
      )}

      {/* Live breakdown + total */}
      <div className="bg-bg-secondary border border-border rounded-xl px-4 py-3 space-y-2">
        <div className="flex items-center gap-2 mb-1">
          <Ruler className="w-4 h-4 text-accent" />
          <span className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Measurement</span>
        </div>
        {SECTIONS.filter(s => breakdown[s.key] > 0).map(s => (
          <div key={s.key} className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 text-ink-muted"><span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: s.color }} />{s.label}</span>
            <span className="text-ink font-medium">{Math.round(breakdown[s.key]).toLocaleString()} sq ft</span>
          </div>
        ))}
        <div className="flex items-center justify-between pt-2 border-t border-border">
          <span className="text-sm font-semibold text-ink">Total</span>
          <span className="text-xl font-bold text-accent">{totalSqft > 0 ? `${totalSqft.toLocaleString()} sq ft` : '—'}</span>
        </div>
      </div>

      {/* Auto pricing tiers (job only) */}
      <div className="bg-bg-secondary border border-border rounded-xl px-4 py-3 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <span className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Suggested job price</span>
          <div className="flex items-center gap-3 text-xs">
            <label className="flex items-center gap-1.5 text-ink-muted">$/1,000ft²
              <input type="number" min="0" step="1" value={ratePer1000 || ''} onChange={e => updateRate(Number(e.target.value) || 0)}
                className="w-16 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none focus:border-accent" />
            </label>
            <label className="flex items-center gap-1.5 text-ink-muted">Condition
              <input type="number" min="0" step="0.05" value={overgrowth} onChange={e => setOvergrowth(Number(e.target.value) || 1)}
                className="w-16 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none focus:border-accent" />
            </label>
          </div>
        </div>
        {totalSqft > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {tierList.map(t => (
              <button
                key={t.tier}
                onClick={() => setSelectedTier(t.tier)}
                className={`text-left rounded-xl border px-3 py-2.5 transition-all ${
                  selectedTier === t.tier ? 'border-accent ring-1 ring-accent/40 bg-accent/5'
                  : t.recommended ? 'border-accent/40 bg-accent/5' : 'border-border hover:border-border-strong'
                }`}
              >
                <p className="text-[10px] uppercase tracking-wide text-ink-faint flex items-center gap-1">{t.label}{t.recommended && <span className="text-accent">★</span>}</p>
                <p className="text-lg font-bold text-ink">${t.amount.toLocaleString()}</p>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-ink-faint">Trace a section to see suggested prices. Recommended is highlighted.</p>
        )}
      </div>

      {/* Travel — distance, route-density discount, toggle */}
      {totalSqft > 0 && (
        <div className="bg-bg-secondary border border-border rounded-xl px-4 py-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-xs font-semibold text-ink-muted uppercase tracking-wide"><Car className="w-3.5 h-3.5" /> Travel</span>
            <button
              type="button"
              onClick={() => setIncludeTravel(v => !v)}
              className={`text-xs font-medium px-2.5 py-1 rounded-lg border transition-colors ${includeTravel ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-ink-muted'}`}
            >
              {includeTravel ? 'Charging travel' : 'Travel off'}
            </button>
          </div>
          {travelIsCustom ? (
            <p className="text-xs text-amber-400">Beyond your furthest travel tier — set a custom travel fee on the quote.</p>
          ) : (
            <div className="space-y-1 text-sm">
              <div className="flex items-center justify-between text-ink-muted">
                <span>Distance from base</span>
                <span className="text-ink">{distanceKm != null ? `${distanceKm} km` : '—'}</span>
              </div>
              <div className="flex items-center justify-between text-ink-muted">
                <span>Base travel fee</span>
                <span className="text-ink">{formatCurrency(travelComp.baseFee)}</span>
              </div>
              {travelComp.discountPct > 0 && includeTravel && (
                <div className="flex items-center justify-between text-emerald-400">
                  <span>Route density discount ({nearbyCount} nearby job{nearbyCount !== 1 ? 's' : ''})</span>
                  <span>−{Math.round(travelComp.discountPct * 100)}%</span>
                </div>
              )}
              <div className="flex items-center justify-between pt-1 border-t border-border">
                <span className="text-ink-muted">Travel applied</span>
                <span className="font-semibold text-ink">{formatCurrency(effectiveTravel)}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Fast quote — recommended total + confidence + one click */}
      {totalSqft > 0 && (
        <div className="bg-bg-secondary border border-accent/30 rounded-xl px-4 py-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-xs font-semibold text-ink-muted uppercase tracking-wide">{TIER_LABEL(selectedTier)} total</span>
            <span className={`inline-flex items-center gap-1 text-[11px] font-semibold border rounded-full px-2 py-0.5 ${CONFIDENCE_COLORS[confidence]}`}>
              <ShieldCheck className="w-3 h-3" /> {CONFIDENCE_LABELS[confidence]}
            </span>
          </div>
          <div className="space-y-1 text-sm">
            <div className="flex items-center justify-between"><span className="text-ink-muted">Job price</span><span className="text-ink font-medium">{formatCurrency(chosenJob)}</span></div>
            <div className="flex items-center justify-between"><span className="text-ink-muted">Travel</span><span className="text-ink font-medium">{formatCurrency(effectiveTravel)}</span></div>
            <div className="flex items-center justify-between pt-1.5 border-t border-border">
              <span className="text-sm font-semibold text-ink">Recommended total</span>
              <span className="text-2xl font-bold text-accent">{formatCurrency(chosenTotal)}</span>
            </div>
          </div>
          <Button onClick={createQuote} loading={creating} size="lg" className="w-full">
            <FileText className="w-4 h-4" /> Create Quote — {formatCurrency(chosenTotal)}
          </Button>
          <div className="flex items-center justify-center gap-3">
            <Button variant="ghost" onClick={save} loading={saving} className="h-9">
              <Check className="w-4 h-4" /> Save measurement only
            </Button>
            {savedSqft != null && <span className="text-xs text-ink-faint">Saved: {savedSqft.toLocaleString()} sq ft</span>}
          </div>
        </div>
      )}

      {/* Measurement history (versioned, never overwritten) */}
      {history.length > 0 && (
        <div className="bg-bg-secondary border border-border rounded-xl px-4 py-3 space-y-2">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-ink-muted" />
            <span className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Measurement history</span>
          </div>
          {lastMeasured && (
            <p className="text-xs text-ink-faint">
              Last measured {formatDate(lastMeasured.date)} · <span className="text-ink font-medium">{(lastMeasured.total_sqft ?? lastMeasured.lawn_sqft ?? 0).toLocaleString()} sq ft</span>
            </p>
          )}
          <div className="space-y-1">
            {[...history].reverse().slice(0, 6).map((h, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="text-ink-muted">{formatDate(h.date)}</span>
                <span className="text-ink font-medium">{(h.total_sqft ?? h.lawn_sqft ?? 0).toLocaleString()} sq ft</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-ink-faint">
        Pick a section, tap each corner to trace it. Each tap pulses to confirm it registered, and points are numbered.
        On desktop the first dot turns <span className="text-emerald-400 font-medium">green</span> when you&apos;re close enough to close —
        tap to finish (or use <span className="text-ink font-medium">Finish section</span> anytime). To fix a finished section, tap
        <span className="text-amber-400 font-medium"> Adjust points</span> — then drag a point to move it or tap a point to delete it
        (works on touch). Pick a section again to go back to drawing.
      </p>
    </div>
  )
}

// Small label helper so the fast-quote header reads naturally.
function TIER_LABEL(tier: PriceTier): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1)
}
