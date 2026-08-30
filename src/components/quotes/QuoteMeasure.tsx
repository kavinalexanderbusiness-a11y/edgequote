'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { confirm as confirmDialog } from '@/lib/confirm'
import { loadGoogleMaps, addPropertyPin, flashRing, onMapsUnavailable, describeMapsError, type MapsUnavailable, type PropertyPinHandle } from '@/lib/googleMaps'
import { MapUnavailable } from '@/components/maps/MapUnavailable'
import { pricingPackage, estimateVisitMinutes, PricingConfig, CadenceKey } from '@/lib/pricing'
import { Coord } from '@/lib/geo'
import { ProspectContext, loadProspectContext, gradedProspectPricing } from '@/lib/prospect'
import { PricePackagePanel, CadenceSelection } from '@/components/pricing/PricePackagePanel'
import { DecisionSummary } from '@/components/pricing/DecisionSummary'
import { AutoMeasureBanner } from '@/components/measure/AutoMeasureBanner'
import { recordMeasurement, neighborhoodOf, AutoMeasureResult } from '@/lib/autoMeasure'
import type { ServicePricingKind } from '@/lib/servicePricing'
import type { ServiceTemplate, ServicePricingPlanRow } from '@/types'
import {
  measurementTypeFor, unitLabel, formatMeasured, pricePlans, defaultPlan, pricedOnly,
  formatPlanPrice, unpricedReason, UNPRICED_COPY, buildMeasurementSnapshot,
  type PricedPlan, type MeasurementSnapshotV2,
} from '@/lib/measurePricing'
import { toPricingPlans } from '@/lib/servicePlans'
import { MAX_QUOTE_OPTIONS, MIN_QUOTE_OPTIONS } from '@/lib/quoteOptions'
import { AUDIENCE_COPY } from '@/lib/noteScope'
import { Textarea } from '@/components/ui/Textarea'
import { DEFAULT_CREW_COST, crewCostPerHour as resolveCrewCost } from '@/lib/economics'
import { Button } from '@/components/ui/Button'
import { X, Undo2, Trash2, Plus, Ruler, Loader2 } from 'lucide-react'

// THE conversion now lives in lib/measure — this file had its own copy, as did
// three others, and four constants can drift apart silently.
import { M2_TO_SQFT } from '@/lib/measure'
const SNAP_PX = 24 // "click near the starting point to finish" threshold (generous for touch)

// A serialized in-progress trace, persisted per property so an accidental
// refresh / navigation never loses field work ("Resume previous measurement").
interface MeasureDraft {
  committed: { lat: number; lng: number }[][]
  current: { lat: number; lng: number }[]
  ts: number
}

// Everything the builder needs to fill the quote's pricing structure in one tap.
export interface MeasureApplyPayload {
  cadence: CadenceKey
  // ⭐ `number | null` on the four money fields. lib/measurePricing returns
  // `price: null` for a plan with no rate configured ("measure to price"), and
  // this payload used to spend that null on a 0 — which the builder then wrote
  // into the quote as a real price of nothing. Unknown travels the whole way to
  // the field now, where it renders blank.
  price: number | null       // the selected cadence's per-visit price
  oneTime: number | null
  weekly: number | null
  biweekly: number | null
  monthly: number | null
  totalSqft: number
  suggested: number | null   // one-time + travel (pricing-analysis provenance); null when unpriced
  // ADR-002 · the derived state that priced these numbers. THIS BOUNDARY WAS THE LEAK:
  // gradedProspectPricing ALWAYS prices with the grade, then the payload dropped it, so
  // the builder received a grade-curved price with no way to know a grade was involved
  // — and no column to record it in. Carrying it without persisting it would be worse
  // than useless (it would fix the first render and silently re-break on reload), which
  // is why it lands on the quote row in the same change.
  valueGrade: string | null
  nearbyCount: number

  // ── Measure & Price V2 (Session 107) ───────────────────────────────────────
  /** The frozen record of what was measured and what priced it. null when the
   *  owner applied a bare measurement with no plan behind it. */
  measurement: MeasurementSnapshotV2 | null
  /** The single commercial offer the owner chose, or null. */
  plan: PricedPlan | null
  /** ⭐ Non-null ONLY when the owner pressed "Offer these plans" — the builder
   *  then writes quote_options rows and lets the CUSTOMER choose. Reusing Quote
   *  Options rather than inventing a second option-selection engine is the whole
   *  point; `null` means "one price, chosen by me". */
  offerPlans: PricedPlan[] | null
  /** Edited in the modal, applied to the SAME two canonical quote fields the
   *  builder already owns. null when the owner didn't open the notes section. */
  notes: { customer: string; internal: string } | null
}

interface Props {
  address: string
  travelFee: number
  cfg: PricingConfig
  serviceType?: string | null   // the selected service — pricing/duration learn from THIS service only
  /** Which pricing structure the selected service uses — resolved by the ONE seam
   *  (lib/servicePricing's servicePricingKind) and passed in from the Quote
   *  Builder rather than recomputed, so the modal and the builder can never
   *  disagree about what a service is. Only 'lawn_recurring' has a cadence engine
   *  behind this map. */
  pricingKind: ServicePricingKind
  propertyId?: string | null
  customerId?: string | null
  services?: string[]           // selectable service names (so the service is chosen BEFORE measuring)
  onServiceChange?: (name: string) => void
  onApply: (sel: MeasureApplyPayload) => void
  onClose: () => void

  // ── Measure & Price V2 (Session 107) ───────────────────────────────────────
  /** The owner's OWN catalogue row for the selected service. This is what makes
   *  the tool universal: how the service is measured and the ways it is sold come
   *  from here, never from its name. null = free-text service with no template. */
  template?: ServiceTemplate | null
  /** That service's `service_pricing_plans` rows. Empty is a real answer —
   *  "pricing not configured" — and is rendered as such, never as $0. */
  plans?: ServicePricingPlanRow[]
  /** The quote's current notes, so the modal edits the SAME two canonical fields
   *  rather than becoming a third place notes can live. */
  quoteNotes?: { customer: string; internal: string }
}

export function QuoteMeasure({ address, travelFee, cfg, serviceType, pricingKind, propertyId, customerId, services, onServiceChange, onApply, onClose, template, plans, quoteNotes }: Props) {
  // Does the cadence engine behind this map actually speak for the chosen service?
  // pricingPackage() and gradedProspectPricing() take (sqft, cfg, …) and NO service
  // — they are the residential lawn engine and cannot be anything else. So their
  // output is only shown when the service is a lawn-cadence one. For every other
  // trade the map still measures (area is a fact about the property), but the
  // prices are withheld and said so, rather than rendered as this service's price.
  const lawnPricing = pricingKind === 'lawn_recurring'

  // ── Measure & Price V2 ─────────────────────────────────────────────────────
  // ⭐ THE REPLACEMENT FOR THE GATE ABOVE. `lawnPricing` still decides whether the
  // CADENCE engine speaks, because that engine really is lawn-only. What it must
  // no longer decide is whether the owner sees a price at all: that now comes from
  // the owner's own catalogue row, which knows nothing about grass.
  //
  // ⛔ Neither of these reads the service NAME. measurementTypeFor() reads the
  // template's measured_by (falling back to its pricing display type), and the
  // plans are rows the owner ticked. A snow contractor and a floor cleaner reach
  // this same code and get their own numbers.
  const measurementType = measurementTypeFor(template)
  const enginePlans = useMemo(() => toPricingPlans(plans), [plans])

  // ⭐⭐ WHEN THE OWNER HAS SPOKEN, THE OWNER WINS.
  // `lawnPricing` used to decide the whole pricing panel on its own, so a service
  // whose name matched /mow|grass cut|lawn cut/ got the residential cadence engine
  // NO MATTER WHAT the owner had configured. Once the Price Book could express
  // "Weekly Mowing: one-time $0.04/ft², weekly $0.03/ft², monthly $180 flat",
  // that was no longer a defensible default — it silently discarded the owner's
  // own plans in favour of an engine that never saw them, for one class of trade,
  // decided by a regex on a name. That is precisely the assumption this session
  // exists to remove.
  //
  // So the Price Book speaks first, for EVERY trade. The lawn cadence engine
  // remains the fallback for services with no configured plans, which is every
  // service on every existing install today — so nothing anyone currently relies
  // on changes until they choose to configure plans. Pinned by verify:measure-price.
  const priceBookSpeaks = enginePlans.length > 0
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
  const projection = useRef<any>(null) // pixel projection for snap-to-first closing
  const committedOverlays = useRef<any[]>([])
  const committedPaths = useRef<any[][]>([])
  const currentOverlay = useRef<any>(null)
  const currentPath = useRef<any[]>([])
  const preview = useRef<any>(null)
  const overrideRef = useRef(0)
  const autoRef = useRef<AutoMeasureResult | null>(null)
  // The branded "Selected Property" pin (click-through; survives the whole trace).
  const setCenterMarker = useRef<PropertyPinHandle | null>(null)
  // 'located' = rooftop-accurate pin · 'approx' = low-confidence geocode (amber pin
  // + warning, never silent) · 'failed' = no pin, owner must verify visually.
  const [geoStatus, setGeoStatus] = useState<'none' | 'located' | 'approx' | 'failed'>('none')

  const [ready, setReady] = useState(false)
  // Why there is no map, or null. Not a string: the reason carries a customer-safe
  // sentence AND an owner-only diagnostic, and only MapUnavailable may separate them.
  const [unavailable, setUnavailable] = useState<MapsUnavailable | null>(null)
  // The typed figure when there is no map. Held as a STRING so an empty box is
  // distinguishable from a zero — Number('') is 0, and "0 sq ft" is a claim.
  const [manualEntry, setManualEntry] = useState('')
  const [totalSqft, setTotalSqft] = useState(0)
  const [points, setPoints] = useState(0)
  const [shapes, setShapes] = useState(0)
  // An unfinished trace saved on a previous open — offered as "Resume".
  const [draft, setDraft] = useState<MeasureDraft | null>(null)

  // ── Per-area breakdown ─────────────────────────────────────────────────────
  // Each closed shape, with its own figure and a label the owner can type. The
  // label is FREE TEXT and defaults to "Area 1/2/3", never to a trade's
  // vocabulary: "Driveway" and "Front walkway" are what a snow contractor types,
  // "Bay 3" is what a warehouse cleaner types, and hardcoding either would be the
  // lawn-sections mistake (front/back/left/right/boulevard) all over again — that
  // fixed six-part enum could only ever describe a residential lot.
  const [areaSqfts, setAreaSqfts] = useState<number[]>([])
  const [areaLabels, setAreaLabels] = useState<string[]>([])
  const areaLabelsRef = useRef<string[]>([])
  areaLabelsRef.current = areaLabels
  const labelFor = (i: number) => areaLabels[i]?.trim() || `Area ${i + 1}`

  // ── The commercial choice ──────────────────────────────────────────────────
  // Which plan the owner has landed on, by term. Null until the plans exist and
  // one is defaulted; never pre-selects a plan that has no price.
  const [chosenTerm, setChosenTerm] = useState<string | null>(null)

  // ── Notes, edited HERE but living in the quote's own two fields ────────────
  // ⛔ Not a third notes system. These are quotes.notes and quotes.internal_notes
  // — the exact pair the Quote Builder already registers — carried in and back
  // out so the owner can write "steep section near the garage" at the moment they
  // are looking at the steep section, instead of remembering it two screens later.
  const [notesOpen, setNotesOpen] = useState(false)
  const [customerNote, setCustomerNote] = useState(quoteNotes?.customer ?? '')
  const [internalNote, setInternalNote] = useState(quoteNotes?.internal ?? '')
  // Raw string so '0.5' is typeable — coercing each keystroke with `|| 1` made
  // sub-1 multipliers impossible and could turn '.5' keystrokes into 15×.
  const [overgrowthRaw, setOvergrowthRaw] = useState('1')
  const ogParsed = parseFloat(overgrowthRaw)
  const overgrowth = Number.isFinite(ogParsed) && ogParsed > 0 ? ogParsed : 1

  function areaOf(p: any[]): number {
    const g = window.google
    return p.length >= 3 ? g.maps.geometry.spherical.computeArea(p) * M2_TO_SQFT : 0
  }

  // ── Unfinished-measurement persistence ── keyed per property (falls back to the
  // address) so reopening the tool can offer "Resume previous measurement" after an
  // accidental close, refresh, or navigation. Cleared on apply/discard.
  const draftKey = `eq_measure_draft:${propertyId || address || 'unknown'}`
  function saveDraft() {
    if (typeof window === 'undefined') return
    try {
      const committed = committedPaths.current.map(p => p.map((ll: any) => ({ lat: ll.lat(), lng: ll.lng() })))
      const current = currentPath.current.map((ll: any) => ({ lat: ll.lat(), lng: ll.lng() }))
      if (committed.length === 0 && current.length === 0) { window.localStorage.removeItem(draftKey); return }
      window.localStorage.setItem(draftKey, JSON.stringify({ committed, current, ts: Date.now() } satisfies MeasureDraft))
    } catch { /* storage blocked/full — resume just won't be offered */ }
  }
  function clearDraft() {
    try { if (typeof window !== 'undefined') window.localStorage.removeItem(draftKey) } catch { /* ignore */ }
  }

  // Screen-pixel position of a LatLng (via the map's overlay projection) — powers
  // "click near the starting point to finish" on both mouse and touch.
  function toPixel(latLng: any): { x: number; y: number } | null {
    const proj = projection.current?.getProjection?.()
    if (!proj) return null
    const p = proj.fromLatLngToContainerPixel(latLng)
    return p ? { x: p.x, y: p.y } : null
  }

  // Auto-fit the view to everything traced so a completed polygon is fully
  // visible (padded), instead of half off-screen at the tracing zoom.
  function fitToTrace() {
    const g = window.google
    if (!gmap.current) return
    const bounds = new g.maps.LatLngBounds()
    committedPaths.current.forEach(p => p.forEach((ll: any) => bounds.extend(ll)))
    currentPath.current.forEach((ll: any) => bounds.extend(ll))
    if (!bounds.isEmpty()) gmap.current.fitBounds(bounds, 56)
  }

  function recompute() {
    // Each closed shape keeps its own figure so the owner can read
    // "Driveway 1,180 · Front walkway 172" and check the total against the lot,
    // rather than being handed one number to trust.
    const per = committedPaths.current.map(p => Math.round(areaOf(p)))
    let total = per.reduce((s, n) => s + n, 0)
    total += areaOf(currentPath.current)
    // Traced shapes win; otherwise fall back to the auto/accepted override.
    setTotalSqft(total > 0 ? Math.round(total) : Math.round(overrideRef.current || 0))
    setPoints(currentPath.current.length)
    setShapes(committedPaths.current.length)
    setAreaSqfts(per)
    // Labels are positional, so trim (undo/clear) rather than leaving a stale
    // name that would re-attach itself to the NEXT shape traced.
    setAreaLabels(prev => prev.slice(0, per.length))
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
    if (gmap.current) flashRing(gmap.current, latLng)
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

  // Google can reject the key AFTER the loader resolved — referrer, billing
  // and API-disabled errors surface asynchronously inside the Map and only
  // announce themselves via gm_authFailure. Without this, the modal renders
  // "Click around the edge…" over Google's own dead-map overlay (shipped to
  // production exactly that way when the domain moved).
  // Subscribing, not awaiting: onMapsUnavailable also fires IMMEDIATELY when the
  // refusal already happened before this modal opened, so the second map of a
  // session is exactly as honest as the first.
  useEffect(() => onMapsUnavailable(u => { setUnavailable(u); setReady(false) }), [])

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
        let precise = false

        // ⭐ THE CANONICAL SERVICE LOCATION FIRST. A property EdgeHQ already knows
        // carries its own lat/lng, saved when the address was resolved. Asking
        // Google to re-resolve the same address on every open was a round trip to
        // re-learn a fact we had already stored — slower, billed, and the single
        // point of failure that put the whole tool out of action on 2026-08-23
        // when the SERVER key (GOOGLE_MAPS_API_KEY, a different credential from
        // the browser one) was revoked and /api/geocode began answering
        //   422 {"error":"Google: REQUEST_DENIED — The provided API key is invalid."}
        // Every measured property centred on downtown Calgary as a result.
        //
        // ⛔ This is NOT a fallback that hides that fault. Geocoding is still the
        // ONLY path for an address with no property row, its failure is still
        // reported honestly below, and nothing invents coordinates. It is simply
        // that the owner's own saved location outranks a re-derivation of it.
        if (propertyId) {
          const { data: { user } } = await supabase.auth.getUser()
          if (user) {
            const { data: prop } = await supabase
              .from('properties')
              .select('lat, lng')
              .eq('id', propertyId)
              .eq('user_id', user.id)   // tenancy, stated rather than assumed
              .maybeSingle()
            const pLat = (prop as { lat: number | null; lng: number | null } | null)?.lat
            const pLng = (prop as { lat: number | null; lng: number | null } | null)?.lng
            if (typeof pLat === 'number' && typeof pLng === 'number') {
              center = { lat: pLat, lng: pLng }
              // A stored fix is the address the owner accepted for this property,
              // not a guess we just made — so it pins as located.
              precise = true
            }
          }
        }

        if (!center && address) {
          try {
            const res = await fetch('/api/geocode', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ address }),
            })
            const data = await res.json()
            if (res.ok && typeof data.lat === 'number') {
              center = { lat: data.lat, lng: data.lng }
              precise = data.precise !== false // older API shape (no flag) = trust it
              if (typeof data.neighborhood === 'string') setHoodName(data.neighborhood)
            }
          } catch { /* ignore */ }
        }
        if (center) setCenter(center) // route-density context for the pricing package
        setGeoStatus(center ? (precise ? 'located' : 'approx') : (address ? 'failed' : 'none'))
        const hadFix = !!center // pin only where the geocoder actually landed — never on the city fallback
        if (!center) center = { lat: 51.0447, lng: -114.0719 }
        // Re-check after the geocode await — the modal may have been closed.
        if (cancelled || !mapEl.current) return

        gmap.current = new Map(mapEl.current, {
          // Lot zoom ONLY when we actually have this property's location. Opening
          // at 20 over the city fallback framed a stranger's rooftop as if it were
          // the lot being quoted — the warning said "couldn't locate this address"
          // while the map showed something perfectly plausible to trace. A wide
          // frame reads as "this is not your property" without needing the words.
          center, zoom: hadFix ? 20 : 12, mapTypeId: 'satellite', tilt: 0,
          streetViewControl: false, fullscreenControl: false, mapTypeControl: false,
          draggableCursor: 'crosshair',
          // Reliable single-click placement (see MeasureTool for the rationale).
          disableDoubleClickZoom: true, clickableIcons: false, gestureHandling: 'greedy',
        })

        // ── THE branded property pin (shared engine) — instantly obvious WHICH
        // lot is being quoted; pulses on open; skipped when geocoding failed so
        // a meaningless city-center pin can never masquerade as the lot.
        setCenterMarker.current?.remove(); setCenterMarker.current = null
        if (address && hadFix && gmap.current) {
          setCenterMarker.current = addPropertyPin(gmap.current, center, precise)
          setCenterMarker.current?.pulse()
        }
        // Overlay used purely to expose the pixel projection for snap detection.
        const ov = new g.maps.OverlayView()
        ov.onAdd = () => {}
        ov.draw = () => {}
        ov.onRemove = () => {}
        ov.setMap(gmap.current)
        projection.current = ov

        gmap.current.addListener('click', (e: any) => {
          flashClick(e.latLng)
          // "Click near the starting point to finish" — commit the shape when the
          // tap lands within SNAP_PX of point 1 (works on touch, no hover needed).
          const pts = currentPath.current
          if (pts.length >= 3) {
            const a = toPixel(pts[0]); const b = toPixel(e.latLng)
            if (a && b && Math.hypot(a.x - b.x, a.y - b.y) <= SNAP_PX) { addArea(); return }
          }
          currentPath.current = [...pts, e.latLng]
          redrawCurrent(); recompute(); saveDraft()
        })
        gmap.current.addListener('mousemove', (e: any) => updatePreview(e.latLng))
        setReady(true)

        // Offer to resume an unfinished trace saved on a previous open.
        try {
          const raw = window.localStorage.getItem(draftKey)
          if (raw) {
            const d = JSON.parse(raw) as MeasureDraft
            if ((Array.isArray(d?.committed) && d.committed.length > 0) || (Array.isArray(d?.current) && d.current.length > 0)) setDraft(d)
            else window.localStorage.removeItem(draftKey)
          }
        } catch { /* unreadable draft — ignore */ }
      } catch (e) {
        if (!cancelled) setUnavailable(describeMapsError(e))
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
      setCenterMarker.current?.remove(); setCenterMarker.current = null
      preview.current?.setMap(null); preview.current = null
      projection.current?.setMap(null); projection.current = null
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
    saveDraft()
    fitToTrace() // show the completed polygon in full, padded
  }

  // Undo ONLY steps the trace back — last point first, then a whole committed
  // area. It never closes the tool; at zero points you simply stay in measuring
  // mode ready to start again.
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
    saveDraft()
  }

  function clearAll() {
    committedOverlays.current.forEach(o => o.setMap(null))
    committedOverlays.current = []
    committedPaths.current = []
    if (currentOverlay.current) { currentOverlay.current.setMap(null); currentOverlay.current = null }
    if (preview.current) { preview.current.setMap(null); preview.current = null }
    currentPath.current = []
    setTotalSqft(0); setPoints(0); setShapes(0)
    setAreaSqfts([]); setAreaLabels([])
    saveDraft() // empty trace → removes the stored draft
  }

  // Rebuild the saved unfinished trace (committed areas + in-progress points).
  function resumeDraft() {
    const g = window.google
    if (!draft || !gmap.current) return
    for (const ring of draft.committed) {
      if (!Array.isArray(ring) || ring.length < 3) continue
      const path = ring.map(pt => new g.maps.LatLng(pt.lat, pt.lng))
      const poly = new g.maps.Polygon({
        paths: path, strokeColor: '#00C896', strokeWeight: 2,
        fillColor: '#00C896', fillOpacity: 0.3, map: gmap.current, clickable: false,
      })
      committedOverlays.current.push(poly)
      committedPaths.current.push(path)
    }
    currentPath.current = (draft.current || []).map(pt => new g.maps.LatLng(pt.lat, pt.lng))
    redrawCurrent()
    recompute()
    fitToTrace()
    setDraft(null)
  }

  // Closing is ONLY ever explicit (Cancel / X / Use recommended). With traced
  // work still on the map, confirm before throwing it away.
  async function requestClose() {
    if (points > 0 || shapes > 0) {
      const discard = await confirmDialog({
        title: 'Discard this measurement?',
        message: 'You have an unfinished measurement on the map.',
        confirmLabel: 'Discard measurement',
        cancelLabel: 'Continue measuring',
        destructive: true,
      })
      if (!discard) return
      clearDraft()
    }
    onClose()
  }

  // Escape routes through the same guarded close as Cancel/X — never a silent
  // discard. Ref keeps one stable listener over the per-render closure.
  const requestCloseRef = useRef<() => void>(() => {})
  requestCloseRef.current = requestClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') requestCloseRef.current() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // The complete recommendation package — same engine the property MeasureTool
  // and travel-density discount use; nearby = located upcoming jobs within range.
  // ONE composed result (lib/prospect.gradedProspectPricing): the assessment is
  // re-run against the grade-adjusted package, so the hero recommendation, CTA,
  // Pricing Details, Pricing Guidance and "Use recommended" all show the SAME
  // number — never a $65 hero over $70 details.
  const nearby = prospect?.nearbyJobs ?? 0
  const graded = totalSqft > 0 && prospect
    ? gradedProspectPricing(totalSqft, cfg, { overgrowth, nearbyCount: nearby, neighborhoodName: hoodName }, prospect, {
        distanceKm: null, travelFee: Number(travelFee) || 0, neighborhoodName: hoodName,
        estimatedMinutes: estimateVisitMinutes(totalSqft, prospect.observedMinPer1000) ?? undefined,
        timedJobs: prospect.timedJobs, crewCostPerHour: crewCost,
      })
    : null
  const assessment = graded?.assessment ?? null
  const pkg = graded?.pkg
    ?? (totalSqft > 0 ? pricingPackage(totalSqft, cfg, { overgrowth, nearbyCount: nearby, neighborhoodName: hoodName }) : null)

  // ── The owner's own plans, priced against what was just traced ─────────────
  // ⭐ THE WHOLE FEATURE, in four lines. Every number below comes from a rate the
  // owner typed into their Price Book times a polygon they drew. Nothing infers a
  // price from the trade, and `priced` may legitimately be empty — that is an
  // ANSWER ("pricing not configured"), rendered as a sentence and never as $0.
  const measuredValue = totalSqft > 0 ? totalSqft : null
  const plansPriced = useMemo(
    () => pricePlans(enginePlans, measuredValue, measurementType),
    [enginePlans, measuredValue, measurementType],
  )
  const priced = pricedOnly(plansPriced)
  const noPriceReason = unpricedReason(template, enginePlans, measuredValue)
  // Land on the owner's recommended plan, but only among plans that actually
  // carry a number — defaulting to a priceless row would put an empty price in
  // front of them with no way to tell why.
  const chosen = priced.find(p => p.term === chosenTerm) ?? defaultPlan(priced)
  // Quote Options is the existing engine for "customer picks one", and it refuses
  // fewer than two. So the second button only exists when there really is a choice.
  const canOfferOptions = priced.length >= MIN_QUOTE_OPTIONS
  const offerable = priced.slice(0, MAX_QUOTE_OPTIONS)

  // Record auto vs accepted so the estimate self-calibrates (best-effort).
  //
  // propertyId/customerId are forwarded because a measurement is a fact about an
  // ADDRESS, not about a quote. They were already props, already destructured and
  // already used a few lines above (draftKey) — they just weren't passed here, so
  // every measurement taken inside the quote builder wrote property_id = null.
  // Measured: 30 of 31 rows. It stayed invisible because recordMeasurement's
  // propertyId is optional and defaults to null, so tsc had nothing to object to.
  // This is what made "Property measured" almost absent from property timelines.
  function recordMeasure() {
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) recordMeasurement(supabase, {
        userId: user.id, context: 'quote', lat: center?.lat ?? null, lng: center?.lng ?? null,
        neighborhood: neighborhoodOf(null, null, hoodName), auto: autoRef.current, acceptedSqft: totalSqft,
        propertyId: propertyId ?? null, customerId: customerId ?? null,
      }).catch(() => {})
    })()
  }

  /**
   * The frozen record, built from what is on the map RIGHT NOW.
   *
   * Rings are read off the committed paths rather than re-derived later, because
   * "what did we agree to clear?" is unanswerable six months on without them —
   * and a rate change next winter must not be able to alter the answer.
   */
  function snapshotNow(plan: PricedPlan | null): MeasurementSnapshotV2 | null {
    if (measurementType === 'none' || totalSqft <= 0) return null
    const parts = committedPaths.current.map((p, i) => ({
      label: areaLabelsRef.current[i]?.trim() || null,
      value: Math.round(areaOf(p)),
      ring: p.map((ll: any) => ({ lat: ll.lat(), lng: ll.lng() })),
    }))
    return buildMeasurementSnapshot({
      type: measurementType,
      value: totalSqft,
      // A single unclosed trace still measures; record it as one unlabelled part
      // rather than dropping the geometry that produced the number.
      parts: parts.length ? parts : [{ label: null, value: totalSqft }],
      measuredAt: new Date().toISOString(),
      serviceTemplateId: template?.id ?? null,
      serviceName: template?.name ?? serviceType ?? null,
      plan,
    })
  }

  const notesOut = () => ({ customer: customerNote, internal: internalNote })

  /**
   * Apply ONE chosen plan. The measurement and the notes always travel; the money
   * only travels when a plan actually carries a number.
   */
  function applyPlan(plan: PricedPlan | null, offer: PricedPlan[] | null) {
    recordMeasure()
    clearDraft()
    onApply({
      // The cadence engine's fields stay at their neutral values — this path is
      // not the lawn cadence engine and must not pretend to be. The builder reads
      // `plan`/`offerPlans` here, not `cadence`.
      // ⛔ WAS `?? 0` on all three. A plan with no configured rate arrived at the
      // builder as a $0 price. It now arrives as "not priced", which is what
      // measurePricing said in the first place.
      cadence: 'one_time', price: plan?.price ?? null,
      oneTime: plan?.price ?? null, weekly: null, biweekly: null, monthly: null,
      totalSqft,
      // The provenance figure is only meaningful when there IS a price to add
      // travel to. Unknown + travel is not "just the travel fee".
      suggested: plan?.price == null ? null : plan.price + Number(travelFee || 0),
      valueGrade: null, nearbyCount: nearby,
      measurement: snapshotNow(offer ? null : plan),
      plan: offer ? null : plan,
      offerPlans: offer,
      notes: notesOut(),
    })
  }

  function applySelection(sel: CadenceSelection) {
    if (!pkg) return
    recordMeasure()
    clearDraft() // the measurement was used — nothing unfinished to resume
    onApply({
      cadence: sel.cadence,
      price: sel.price,
      oneTime: pkg.oneTime,
      weekly: pkg.options[0].price,
      biweekly: pkg.options[1].price,
      monthly: pkg.options[2].price,
      totalSqft,
      suggested: pkg.oneTime + Number(travelFee || 0),
      // The grade that actually priced these numbers. `assessment` is null when there
      // is no prospect context, and then `pkg` came from the NEUTRAL curve — so null
      // here is the truthful record of "no grade was applied", not a missing value.
      valueGrade: assessment?.score ?? null,
      nearbyCount: nearby,
      // The cadence engine priced this, not a Price Book plan — so there is no
      // plan and no offer. The measurement is still recorded (it is a fact about
      // the property either way), with the cadence price as its frozen figure.
      measurement: snapshotNow(null),
      plan: null,
      offerPlans: null,
      notes: notesOut(),
    })
  }

  return (
    <div className="fixed inset-0 z-overlay bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div role="dialog" aria-modal="true" aria-label="Measure & Price" className="w-full sm:max-w-3xl bg-bg-secondary border border-border sm:rounded-card max-h-[95vh] overflow-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border sticky top-0 bg-bg-secondary z-10">
          <h2 className="text-sm font-semibold text-ink">Measure & Price</h2>
          <button type="button" onClick={requestClose} aria-label="Close" className="h-7 w-7 rounded-lg flex items-center justify-center text-ink-faint hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-4 space-y-4">
          {/* Service FIRST — measurement, pricing, duration & profitability are all
              specific to this service (req: auto-select the service before measuring). */}
          {services && services.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap rounded-xl border border-accent/20 bg-accent/[0.04] px-3 py-2">
              <Ruler className="w-3.5 h-3.5 text-accent-text shrink-0" />
              <span className="text-xs font-medium text-ink">Service</span>
              <select
                value={serviceType ?? ''}
                aria-label="Service to measure"
                onChange={e => onServiceChange?.(e.target.value)}
                className="bg-bg border border-border-strong rounded-lg px-2.5 py-1.5 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20">
                <option value="">Select a service…</option>
                {services.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              {/* This read "Pricing & duration are specific to this service" for
                  every service — above an engine that takes no service argument, so
                  the same polygon produced byte-identical prices for Lawn Mowing and
                  Pressure Washing. Say what is actually true of the service picked. */}
              {/* This used to read "Measures area only — this service isn't priced
                  by lawn cadence", which told a snow contractor that their trade
                  was the exception. It now says what the OWNER configured: how the
                  service is measured, and how many ways they sell it. */}
              <span className="text-[11px] text-ink-faint">
                {!serviceType
                  ? 'Pick a service — pricing depends on it'
                  : measurementType === 'none'
                    ? 'Not measured — set a measurement type in the Price Book to price it from the map'
                    : `Measured by ${measurementType === 'count' ? 'count' : unitLabel(measurementType)}${
                        enginePlans.length
                          ? ` · ${enginePlans.length} pricing ${enginePlans.length === 1 ? 'plan' : 'plans'}`
                          : ' · no pricing configured'
                      }`}
              </span>
            </div>
          )}
          {/* Auto-measure is a LAWN estimator, not a generic one: autoMeasureLawn()
              is building footprint × DEFAULT_LAWN_RATIO (2.3) calibrated per
              neighbourhood — a number that means nothing for a roof (ratio ≈1) or a
              driveway (unrelated to footprint). Offering it on a roofing quote would
              put an invented figure in the measured-area field under the word
              "measured". Note its copy is deliberately NOT de-lawned: the estimate
              really is of a lawn, so the honest fix is to show it only where that's
              true, not to rename it "area" and let a lawn-ratio guess pass for a
              measurement of something else. Tracing still works for every trade. */}
          {center && lawnPricing && !priceBookSpeaks && (
            <AutoMeasureBanner lat={center.lat} lng={center.lng}
              neighborhood={neighborhoodOf(null, null, hoodName)}
              onAuto={r => { autoRef.current = r }}
              onUse={n => { overrideRef.current = n; setTotalSqft(n) }} />
          )}
          {unavailable ? (
            /* The map DIV is not rendered at all in this branch — leaving it
               mounted is what let Google paint its grey "Oops!" panel and sit
               there. One owner-facing panel instead, diagnostic collapsed. */
            <>
              <MapUnavailable unavailable={unavailable} audience="owner" />
              {/* ⭐ THE PROMISE THE PANEL MAKES, KEPT. "You can enter measurements
                  by hand" has to be true where it is said, and a measurement is a
                  number about a property — tracing is only the nicest way to
                  arrive at it. With this, a Maps outage costs the owner the
                  satellite view and nothing else: the plans still price, the notes
                  still save, and the quote still gets its snapshot.
                  ⛔ Recorded as source 'manual' downstream, never as 'traced' —
                  a typed figure must never wear a traced measurement's confidence. */}
              <label className="block rounded-card border border-border bg-bg-tertiary p-4">
                <span className="text-sm font-medium text-ink">
                  {measurementType === 'count' ? 'Enter the count' : `Enter the measurement (${unitLabel(measurementType) || 'sq ft'})`}
                </span>
                <span className="mt-1 block text-xs text-ink-muted">
                  Typed by hand, so it is recorded as an estimate rather than a trace.
                </span>
                <input
                  type="number" min="0" step="1" inputMode="decimal"
                  value={manualEntry}
                  onChange={e => {
                    setManualEntry(e.target.value)
                    const n = parseFloat(e.target.value)
                    const v = Number.isFinite(n) && n > 0 ? n : 0
                    overrideRef.current = v
                    setTotalSqft(v)
                  }}
                  placeholder="0"
                  className="mt-3 w-full h-12 bg-bg border border-border-strong rounded-lg px-3 text-base text-ink tabular-nums outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
              </label>
            </>
          ) : (
            <>
              {/* Geocoding honesty — say when the pin is approximate or missing
                  instead of silently measuring the wrong lot. */}
              {ready && geoStatus === 'approx' && (
                <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2">
                  Approximate location — the amber pin may not be the exact lot. Verify before quoting.
                </p>
              )}
              {ready && geoStatus === 'failed' && (
                <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2">
                  Couldn&apos;t locate this address — showing the general area with no property pin. Check the address on the quote.
                </p>
              )}
              {/* Resume an unfinished trace saved on a previous open. */}
              {ready && draft && (
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-xl border border-accent/30 bg-accent/[0.06] px-3.5 py-3">
                  <p className="text-xs text-ink">
                    <span className="font-semibold">Resume previous measurement?</span>{' '}
                    <span className="text-ink-muted">An unfinished trace was saved for this property.</span>
                  </p>
                  <div className="flex gap-2 shrink-0">
                    <Button type="button" size="sm" onClick={resumeDraft}>Resume</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => { clearDraft(); setDraft(null) }}>Start fresh</Button>
                  </div>
                </div>
              )}
              <div className="relative rounded-card overflow-hidden border border-border">
                <div ref={mapEl} className="w-full h-[45vh] min-h-[300px] bg-bg-tertiary" />
                {!ready && (
                  <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-ink-muted bg-bg-tertiary/80 animate-pulse">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading satellite map…
                  </div>
                )}
                {/* Step-by-step drawing guidance — follows the trace as it grows. */}
                {ready && (
                  <div className="absolute top-3 left-3 max-w-[75%] px-3 py-1.5 rounded-lg bg-bg-secondary/90 border border-border-strong text-xs font-medium text-ink pointer-events-none">
                    {points === 0
                      ? (shapes > 0 ? 'Click around the edge of the next area.' : 'Click around the edge of the area.')
                      : points < 3
                        ? 'Continue clicking to outline the property.'
                        : 'Click near the starting point to finish.'}
                  </div>
                )}
              </div>

              {/* Drawing controls — large, thumb-friendly targets */}
              <div className="grid grid-cols-3 gap-2">
                <Button type="button" variant="secondary" onClick={addArea} disabled={points < 3} className="h-12">
                  <Plus className="w-4 h-4" /> Add area
                </Button>
                <Button type="button" variant="secondary" onClick={undo} disabled={points === 0 && shapes === 0} className="h-12">
                  <Undo2 className="w-4 h-4" /> Undo
                </Button>
                <Button type="button" variant="danger" onClick={clearAll} disabled={points === 0 && shapes === 0} className="h-12">
                  <Trash2 className="w-4 h-4" /> Clear
                </Button>
              </div>
            </>
          )}

          {/* ⭐ EVERYTHING BELOW IS SHARED WITH THE NO-MAP STATE, ON PURPOSE.
              It used to live inside the "we have a map" branch, so a Maps outage
              hid the total, the plans, the notes and the Use button along with
              the map — and the panel above cheerfully said "everything else on
              this page still works", which was then simply untrue.
              Measuring is the part that needs Google. Pricing a measurement,
              writing the notes and putting it on the quote are ours, and they
              keep working whether or not Google will talk to us. */}
          <div className="bg-bg-tertiary border border-border rounded-card p-4 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div className="flex items-center gap-2">
                    <Ruler className="w-4 h-4 text-accent-text" />
                    <span className="text-sm text-ink-muted">{measurementType === 'count' ? 'Total:' : 'Total area:'}</span>
                    {/* One formatter (lib/measure's) so a length service reads
                        "86 linear ft" here and everywhere else, not "86 sq ft". */}
                    <span className="text-lg font-bold text-ink tabular-nums">
                      {measurementType === 'none' ? `${totalSqft.toLocaleString()} sq ft` : formatMeasured(totalSqft, measurementType)}
                    </span>
                    {shapes > 0 && points > 0 && <span className="text-xs text-ink-faint">({shapes} + current)</span>}
                  </div>
                  {/* Same field order + hint as the Measure page — the two surfaces read identically.
                      Lawn only, because this control feeds NOTHING else: `overgrowth` is
                      an input to pricingPackage() and is not carried on
                      MeasureApplyPayload. With the cadence prices withheld for a
                      non-lawn service, it was a dead input whose own label promised
                      "×1.25 applied to prices" against prices that aren't on screen.
                      (The de-lawned tooltip title below arrived independently from the
                      trades session — same conclusion, kept as theirs.) */}
                  {lawnPricing && !priceBookSpeaks && (
                  <label className="flex items-center gap-1.5 text-xs text-ink-muted" title="Condition multiplier — 0.75 easy, 1.0 standard, 1.25 overgrown">
                    <span>
                      Condition<span className="block text-[10px] text-ink-faint">1.0 standard · 1.25 overgrown</span>
                      {overgrowth !== 1 && <span className="block text-[10px] font-semibold text-accent-text">×{overgrowth} applied to prices</span>}
                    </span>
                    <input
                      type="number" min="0" step="0.05"
                      value={overgrowthRaw}
                      onChange={e => setOvergrowthRaw(e.target.value)}
                      className="w-16 bg-bg border border-border-strong rounded-lg px-2.5 py-2 text-base sm:text-sm text-ink tabular-nums outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20"
                    />
                  </label>
                  )}
                </div>

                {/* ── Each area, named and counted ──────────────────────────────
                    "Driveway 1,180 · Front walkway 172 · TOTAL 1,352". The names
                    are free text with an "Area N" default — a snow contractor
                    types Driveway, a warehouse cleaner types Bay 3, and neither is
                    a vocabulary this file had to know in advance. */}
                {areaSqfts.length > 0 && (
                  <div className="border-t border-border pt-3 space-y-1.5">
                    {areaSqfts.map((sq, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          type="text"
                          value={areaLabels[i] ?? ''}
                          placeholder={`Area ${i + 1}`}
                          aria-label={`Name for area ${i + 1}`}
                          onChange={e => setAreaLabels(prev => {
                            const next = [...prev]
                            while (next.length < areaSqfts.length) next.push('')
                            next[i] = e.target.value
                            return next
                          })}
                          className="flex-1 min-w-0 h-11 bg-bg border border-border-strong rounded-lg px-2.5 text-base sm:text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20"
                        />
                        <span className="text-sm text-ink tabular-nums shrink-0 w-28 text-right">
                          {measurementType === 'none' ? `${sq.toLocaleString()} sq ft` : formatMeasured(sq, measurementType)}
                        </span>
                      </div>
                    ))}
                    {areaSqfts.length > 1 && (
                      <div className="flex items-center justify-between pt-1.5 border-t border-border">
                        <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Total</span>
                        <span className="text-sm font-bold text-ink tabular-nums w-28 text-right">
                          {measurementType === 'none' ? `${totalSqft.toLocaleString()} sq ft` : formatMeasured(totalSqft, measurementType)}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* ── The owner's own plans, priced from the trace ──────────────
                    Replaces the block that told every non-lawn trade EdgeQuote had
                    no engine for them. It had an engine; it just wasn't wired to
                    anything but grass. */}
                {(!lawnPricing || priceBookSpeaks) ? (
                  <div className="border-t border-border pt-3 animate-fade space-y-2.5">
                    <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">
                      Pricing options
                    </p>

                    {priced.length > 0 ? (
                      <>
                        <div role="radiogroup" aria-label="Pricing plan" className="space-y-2">
                          {priced.map(p => {
                            const active = chosen?.term === p.term
                            return (
                              <button
                                key={p.term}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                onClick={() => setChosenTerm(p.term)}
                                className={`w-full min-h-[52px] flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                                  active ? 'border-accent bg-accent/[0.08]' : 'border-border-strong bg-bg hover:border-accent/40'
                                }`}
                              >
                                <span className="min-w-0">
                                  <span className="flex items-center gap-1.5">
                                    <span className="text-sm font-semibold text-ink">{p.label}</span>
                                    {p.isRecommended && (
                                      <span className="text-[10px] font-bold uppercase tracking-wide text-accent-text bg-accent/15 rounded px-1.5 py-0.5">
                                        Recommended
                                      </span>
                                    )}
                                  </span>
                                  {/* Provenance, always beside the number: the owner
                                      can see it is their own rate times their own trace. */}
                                  <span className="block text-[11px] text-ink-faint truncate">{p.basisText}</span>
                                </span>
                                <span className="text-sm font-bold text-ink tabular-nums shrink-0">
                                  {formatPlanPrice(p)}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                        {/* ⛔ The distinction the brief calls load-bearing, said out
                            loud where the owner is choosing. Picking Monthly prices
                            the work; it does not schedule anything. */}
                        <p className="text-[11px] text-ink-faint">
                          This sets how the work is priced and billed. Visits are still scheduled separately.
                        </p>
                      </>
                    ) : (
                      /* ⭐ UNKNOWN IS NOT ZERO. No plan carries a number, so no
                         number is shown — a sentence and a way to fix it instead. */
                      <div className="space-y-2">
                        <p className="text-[11px] text-ink-muted">
                          {noPriceReason ? UNPRICED_COPY[noPriceReason] : UNPRICED_COPY.no_plans}
                        </p>
                        {(noPriceReason === 'no_plans' || noPriceReason === 'no_rates' || noPriceReason === 'not_measured') && (
                          <a
                            href="/dashboard/settings/templates"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center min-h-[44px] px-3 rounded-xl border border-border-strong text-xs font-medium text-ink hover:border-accent/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                          >
                            Configure pricing
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                ) : pkg ? (
                  <div className="border-t border-border pt-3 space-y-3 animate-fade">
                    <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">
                      Pricing recommendation{Number(travelFee || 0) > 0 ? ` · $${Number(travelFee).toLocaleString()} travel stays on the quote` : ''}
                    </p>
                    {prospect == null && !assessment && (
                      <p className="text-[11px] text-ink-faint flex items-center gap-1.5 animate-pulse">
                        <Loader2 className="w-3 h-3 animate-spin" /> Analyzing route fit &amp; customer value…
                      </p>
                    )}
                    {assessment ? (
                      <DecisionSummary a={assessment} pkg={pkg} onUse={applySelection} />
                    ) : (
                      <PricePackagePanel pkg={pkg} onUse={applySelection} />
                    )}
                    {/* Pricing Intelligence intentionally NOT repeated here — it is the
                        PRIMARY recommendation card in the Quote Builder itself, so the
                        modal keeps ONE decision surface (verdict + accept) instead of
                        three competing CTAs. */}
                  </div>
                ) : (
                  <div className="border-t border-border pt-3 text-xs text-ink-faint">
                    Trace the area to see the full pricing recommendation (set rates in Settings).
                  </div>
                )}
              </div>

              {/* ── Notes, written where the evidence is ──────────────────────
                  ⛔ NOT a second notes system. These two textareas are bound to
                  quotes.notes and quotes.internal_notes — the same canonical pair
                  the Quote Builder registers, carrying the same AUDIENCE_COPY, so
                  the promise printed under each field is byte-identical on both
                  screens. The value is timing: "steep section near the garage" is
                  obvious while looking at the garage and forgotten two screens later.
                  Collapsed by default so the measuring path stays fast. */}
              <div className="rounded-card border border-border">
                <button
                  type="button"
                  onClick={() => setNotesOpen(o => !o)}
                  aria-expanded={notesOpen}
                  className="w-full min-h-[44px] flex items-center justify-between px-3.5 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-card"
                >
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Notes</span>
                  <span className="text-[11px] text-ink-faint">
                    {[customerNote.trim() && 'customer', internalNote.trim() && 'internal'].filter(Boolean).join(' · ') || 'Add'}
                  </span>
                </button>
                {notesOpen && (
                  <div className="px-3.5 pb-3.5 space-y-3 animate-fade">
                    <Textarea
                      label={AUDIENCE_COPY.customer.label}
                      hint={AUDIENCE_COPY.customer.help}
                      placeholder="Includes driveway and front walkway"
                      rows={2}
                      value={customerNote}
                      onChange={e => setCustomerNote(e.target.value)}
                    />
                    <Textarea
                      label={AUDIENCE_COPY.internal.label}
                      hint={AUDIENCE_COPY.internal.help}
                      placeholder="Steep section near the garage — allow extra time after heavy snowfall"
                      rows={2}
                      value={internalNote}
                      onChange={e => setInternalNote(e.target.value)}
                    />
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button type="button" variant="ghost" onClick={requestClose}>Cancel</Button>
                {/* For a non-lawn service this said "Use recommended" and applied a
                    mowing price. There is no recommendation to use — the honest
                    action is to keep the measurement, which the builder applies
                    without touching the price. */}
                {(!lawnPricing || priceBookSpeaks)
                  ? totalSqft > 0 && (
                    <>
                      {/* ⭐ REUSING QUOTE OPTIONS, not building a second chooser.
                          Only offered when there are genuinely ≥2 priced plans —
                          quote_options refuses fewer, because one alternative is
                          not a choice. Capped at MAX_QUOTE_OPTIONS by the same rule. */}
                      {canOfferOptions && (
                        <Button type="button" variant="secondary" className="h-11"
                          onClick={() => applyPlan(null, offerable)}>
                          Offer these {offerable.length} plans
                        </Button>
                      )}
                      <Button type="button" className="h-11" onClick={() => applyPlan(chosen ?? null, null)}>
                        {chosen
                          ? `Use ${chosen.label} — ${formatPlanPrice(chosen)}`
                          : `Use measurement (${measurementType === 'none' ? `${Math.round(totalSqft).toLocaleString()} sq ft` : formatMeasured(totalSqft, measurementType)})`}
                      </Button>
                    </>
                  )
                  : pkg && (
                    <Button type="button" onClick={() => applySelection({ cadence: pkg.recommended.cadence, price: pkg.recommended.cadence === 'weekly' ? pkg.options[0].price : pkg.recommended.cadence === 'biweekly' ? pkg.options[1].price : pkg.recommended.cadence === 'monthly' ? pkg.options[2].price : pkg.oneTime })}>
                      Use recommended
                    </Button>
                  )}
              </div>

          {!unavailable && (
            <p className="text-xs text-ink-faint">
              Tap each corner of the area to trace it — tap near your starting point (or <span className="text-ink font-medium">Add area</span>) to close the shape. Close one area, then trace the next — they add up.{lawnPricing ? ' The price is your rate × area, plus the travel fee from the quote.' : ''}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}