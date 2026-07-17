'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadGoogleMaps } from '@/lib/googleMaps'
import {
  MEASUREMENT_KINDS, kindDef, formatMeasurement, measureShapes, usableShapes,
  readMeasurements, canAutoMeasure,
  type MeasurementKind, type MeasurementShape, type Measurement, type LatLng,
} from '@/lib/measure'
import { loadMeasurements, saveTraced, saveManual, deleteMeasurement } from '@/lib/measure/data'
import { ConfidenceBadge } from '@/components/measure/AutoMeasureBanner'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Banner } from '@/components/ui/Banner'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { toast as notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { formatDate } from '@/lib/utils'
import {
  Ruler, Undo2, Trash2, Check, Pencil, History, Info, AlertTriangle, Loader2, MapPin,
} from 'lucide-react'

// ── THE measurement workflow ─────────────────────────────────────────────────
// One panel, nine kinds, three capture modes. Every number it produces comes from
// lib/measure; this file draws and persists, and computes nothing itself.
//
// WHAT IT IS NOT: a pricing surface. The two tools that exist today —
// properties/MeasureTool and quotes/QuoteMeasure — are both Measure-AND-Price:
// each fuses a map to PricingConfig, crew cost, prospect grading and a tier
// picker. That fusion is why "measure a fence" was impossible: the map existed
// only in service of the lawn cadence engine, so it only ever produced ft² of
// grass. This panel measures. Pricing consumes lib/measure's API later (Quote V2),
// which is why no pricing code is touched here.
//
// CAPTURE MODE FOLLOWS THE KIND, and that is the whole point:
//   area  -> polygon   (lawn, mulch, gravel, rock, concrete, snow)
//   line  -> polyline  (fencing, hedges)   — a fence is a length, not an outline
//   point -> markers   (trees)             — a tree is a count
// The old tools had one tool: polygon. Everything was an area, so everything was
// square feet.

interface Props {
  supabase: SupabaseClient
  userId: string
  propertyId: string
  center: LatLng | null
  /** Called after any save/delete so a parent can refresh. Never passes pricing. */
  onChanged?: () => void
}

interface HistoryRow {
  id: string; seq: number; kind: MeasurementKind; unit: string; value: number
  source: string; confidence: string; confidence_reason: string; action: string
  measured_at: string; created_at: string
}

export function MeasurePanel({ supabase, userId, propertyId, center, onChanged }: Props) {
  const [kind, setKind] = useState<MeasurementKind>('lawn')
  const [rows, setRows] = useState<Measurement[]>([])
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  const [manual, setManual] = useState('')
  const [drawnCount, setDrawnCount] = useState(0)

  const mapEl = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  // Live overlays for the ACTIVE kind only. Kept in a ref, not state: the Maps
  // SDK mutates these objects and re-rendering on every vertex drag would fight it.
  const overlays = useRef<{ id: string; obj: any }[]>([])
  const kindRef = useRef<MeasurementKind>(kind)
  kindRef.current = kind

  const def = kindDef(kind)
  const measured = useMemo(() => readMeasurements(rows), [rows])
  const current = measured.get(kind)

  // ── load ──
  const refresh = useCallback(async () => {
    const m = await loadMeasurements(supabase, userId, propertyId)
    setRows(m.all)
    const { data } = await supabase
      .from('property_measurement_events')
      .select('id, seq, kind, unit, value, source, confidence, confidence_reason, action, measured_at, created_at')
      .eq('property_id', propertyId).order('seq', { ascending: false }).limit(40)
    setHistory((data as HistoryRow[]) ?? [])
    setLoading(false)
  }, [supabase, userId, propertyId])

  useEffect(() => { refresh() }, [refresh])

  // ── map ──
  useEffect(() => {
    let dead = false
    if (!center) { setLoading(false); return }
    loadGoogleMaps().then(() => {
      if (dead || !mapEl.current) return
      const g = (window as any).google
      mapRef.current = new g.maps.Map(mapEl.current, {
        center, zoom: 20, mapTypeId: 'satellite', tilt: 0,
        disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy',
      })
      setMapReady(true)
    }).catch(() => setMapReady(false))
    return () => { dead = true }
  }, [center])

  // Redraw overlays whenever the kind changes: only the active kind is editable,
  // so the map never shows a fence you can accidentally drag while tracing a lawn.
  useEffect(() => {
    if (!mapReady) return
    clearOverlays()
    const saved = rows.find(r => r.kind === kind)
    if (saved) for (const s of saved.shapes) addOverlay(s, false)
    setDrawnCount(overlays.current.length)
    setManual(saved && saved.source === 'manual' ? String(saved.value) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, mapReady, rows])

  function clearOverlays() {
    for (const o of overlays.current) o.obj.setMap(null)
    overlays.current = []
  }

  function styleFor(k: MeasurementKind) {
    const d = kindDef(k)
    return { strokeColor: d.color, strokeWeight: 3, strokeOpacity: 0.95, fillColor: d.color, fillOpacity: 0.28 }
  }

  /** Put one stored shape on the map, editable so the owner can adjust it. */
  function addOverlay(shape: MeasurementShape, isNew: boolean) {
    const g = (window as any).google
    const d = kindDef(kindRef.current)
    let obj: any
    if (d.capture === 'area' && shape.ring?.length) {
      obj = new g.maps.Polygon({ paths: shape.ring, editable: true, draggable: false, ...styleFor(kindRef.current) })
    } else if (d.capture === 'line' && shape.path?.length) {
      obj = new g.maps.Polyline({ path: shape.path, editable: true, ...styleFor(kindRef.current), fillOpacity: 0 })
    } else if (d.capture === 'point' && shape.point) {
      obj = new g.maps.Marker({ position: shape.point, draggable: true })
    } else return
    obj.setMap(mapRef.current)
    // Editing a vertex must move the number immediately — a shape that no longer
    // matches its figure is exactly the "confirmed but wrong" problem.
    const bump = () => setDrawnCount(c => c + 0.0001)
    if (obj.getPath) {
      const p = obj.getPath()
      g.maps.event.addListener(p, 'set_at', bump)
      g.maps.event.addListener(p, 'insert_at', bump)
      g.maps.event.addListener(p, 'remove_at', bump)
    } else {
      g.maps.event.addListener(obj, 'dragend', bump)
    }
    overlays.current.push({ id: shape.id, obj })
    if (isNew) setDrawnCount(overlays.current.length)
  }

  /** Read the live overlays back into engine shapes. The map is the draft. */
  function readOverlays(): MeasurementShape[] {
    const d = kindDef(kindRef.current)
    return overlays.current.map(({ id, obj }) => {
      if (d.capture === 'point') {
        const p = obj.getPosition()
        return { id, label: null, point: { lat: p.lat(), lng: p.lng() } }
      }
      const pts: LatLng[] = obj.getPath().getArray().map((p: any) => ({ lat: p.lat(), lng: p.lng() }))
      return d.capture === 'area' ? { id, label: null, ring: pts } : { id, label: null, path: pts }
    })
  }

  // Live value from whatever is currently on the map — recomputed on every drag.
  const liveShapes = mapReady ? readOverlays() : []
  const liveValue = mapReady ? measureShapes(kind, liveShapes) : 0
  const hasDrawing = usableShapes(kind, liveShapes).length > 0

  // ── drawing ──
  // Click-to-trace by hand, deliberately: loadGoogleMaps requests only
  // `places,geometry`, so `google.maps.drawing.DrawingManager` does not exist at
  // runtime — reaching for it would throw. Both existing tools trace by click for
  // the same reason, and widening the shared loader would add a library (and
  // bundle weight) to every map in the app to save this one file some work.
  const [drawing, setDrawing] = useState(false)
  const draftPts = useRef<LatLng[]>([])
  const draftObj = useRef<any>(null)
  const clickL = useRef<any>(null)

  function stopDrawing() {
    const g = (window as any).google
    if (clickL.current) { g?.maps.event.removeListener(clickL.current); clickL.current = null }
    if (draftObj.current) { draftObj.current.setMap(null); draftObj.current = null }
    draftPts.current = []
    setDrawing(false)
  }

  function startDrawing() {
    const g = (window as any).google
    if (!g || !mapRef.current) return
    const d = kindDef(kindRef.current)

    if (d.capture === 'point') {
      // A tree is one click.
      setDrawing(true)
      clickL.current = g.maps.event.addListenerOnce(mapRef.current, 'click', (e: any) => {
        addOverlay({ id: `s${Date.now()}`, label: null, point: { lat: e.latLng.lat(), lng: e.latLng.lng() } }, true)
        stopDrawing()
      })
      return
    }

    setDrawing(true)
    draftPts.current = []
    draftObj.current = d.capture === 'area'
      ? new g.maps.Polygon({ paths: [], ...styleFor(kindRef.current) })
      : new g.maps.Polyline({ path: [], ...styleFor(kindRef.current), fillOpacity: 0 })
    draftObj.current.setMap(mapRef.current)

    clickL.current = g.maps.event.addListener(mapRef.current, 'click', (e: any) => {
      draftPts.current.push({ lat: e.latLng.lat(), lng: e.latLng.lng() })
      if (d.capture === 'area') draftObj.current.setPaths([draftPts.current])
      else draftObj.current.setPath(draftPts.current)
      setDrawnCount(c => c + 0.0001)   // nudge the live figure
    })
  }

  /** Finish the run being traced and hand it to the engine. */
  function finishDrawing() {
    const d = kindDef(kindRef.current)
    const pts = [...draftPts.current]
    const enough = d.capture === 'area' ? pts.length >= 3 : pts.length >= 2
    stopDrawing()
    if (!enough) {
      notify.error(d.capture === 'area' ? 'An area needs at least 3 points.' : 'A run needs at least 2 points.')
      return
    }
    addOverlay(
      d.capture === 'area'
        ? { id: `s${Date.now()}`, label: null, ring: pts }
        : { id: `s${Date.now()}`, label: null, path: pts },
      true,
    )
  }

  // Never leave a listener attached to a map that's going away.
  useEffect(() => () => stopDrawing(), [])

  function undoLast() {
    const last = overlays.current.pop()
    if (last) last.obj.setMap(null)
    setDrawnCount(overlays.current.length)
  }
  function clearAll() {
    clearOverlays()
    setDrawnCount(0)
  }

  // ── save ──
  async function saveShapes() {
    setSaving(true)
    const res = await saveTraced(supabase, { userId, propertyId, kind, shapes: readOverlays() })
    setSaving(false)
    if (!res.ok) { notify.error(res.error); return }
    notify.success(`${def.label}: ${formatMeasurement(res.measurement.value, kind)} saved.`)
    await refresh(); onChanged?.()
  }

  async function saveTyped() {
    const v = Number(manual)
    setSaving(true)
    const res = await saveManual(supabase, { userId, propertyId, kind, value: v })
    setSaving(false)
    if (!res.ok) { notify.error(res.error); return }
    notify.success(`${def.label}: ${formatMeasurement(res.measurement.value, kind)} recorded.`)
    await refresh(); onChanged?.()
  }

  async function removeCurrent() {
    if (!current) return
    const res = await deleteMeasurement(supabase, current.id)
    if (!res.ok) { notify.error(res.error); return }
    clearAll()
    notify.success(`${def.label} measurement removed.`)
    await refresh(); onChanged?.()
  }

  const autoGate = canAutoMeasure(kind)
  const kindHistory = history.filter(h => h.kind === kind)

  return (
    <div className="space-y-3">
      {/* ── Kind picker: the workflow is the same for all nine ── */}
      <div className="flex flex-wrap gap-1.5">
        {MEASUREMENT_KINDS.map(k => {
          const has = measured.get(k.key)
          return (
            <button key={k.key} type="button" onClick={() => setKind(k.key)}
              className={cn('inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border transition-all active:scale-[0.97]',
                kind === k.key ? 'border-accent bg-accent/10 text-ink' : 'border-border bg-surface text-ink-muted hover:text-ink')}>
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: k.color }} />
              {k.label}
              {has && <span className="text-[10px] text-ink-faint tabular-nums">{formatMeasurement(has.value, k.key)}</span>}
            </button>
          )
        })}
      </div>

      <Banner tone="info" icon={Info}>
        <span className="font-semibold">{def.label}</span> — {def.hint}{' '}
        {def.unit === 'linear_ft' && <span className="text-ink-faint">Measured as a length, not an area.</span>}
        {def.unit === 'count' && <span className="text-ink-faint">Counted, not measured.</span>}
      </Banner>

      {/* ── Map ── */}
      {!center ? (
        <InlineEmpty icon={MapPin}>This property has no map location yet, so it can’t be traced. You can still enter a number below.</InlineEmpty>
      ) : (
        <div className="relative rounded-xl overflow-hidden border border-border">
          <div ref={mapEl} className="w-full h-[420px] bg-bg-tertiary" />
          {!mapReady && (
            <div className="absolute inset-0 grid place-items-center bg-bg-tertiary">
              <Loader2 className="w-5 h-5 animate-spin text-ink-faint" />
            </div>
          )}
          {/* Live figure — moves as vertices are dragged. */}
          <div className="absolute top-2 left-2 rounded-lg bg-black/70 px-3 py-1.5 backdrop-blur">
            <p className="text-sm font-bold text-white tabular-nums">
              {hasDrawing ? formatMeasurement(liveValue, kind) : `No ${def.noun} traced`}
            </p>
          </div>
        </div>
      )}

      {/* ── Drawing controls ── */}
      {center && (
        <div className="flex flex-wrap items-center gap-2">
          {!drawing ? (
            <Button size="sm" onClick={startDrawing} disabled={!mapReady}>
              <Ruler className="w-3.5 h-3.5" />
              {def.capture === 'point' ? 'Drop a pin' : def.capture === 'line' ? 'Trace a run' : 'Trace an area'}
            </Button>
          ) : def.capture === 'point' ? (
            <Button size="sm" variant="secondary" onClick={stopDrawing}>Cancel — tap the tree on the map</Button>
          ) : (
            <>
              <Button size="sm" onClick={finishDrawing}>
                <Check className="w-3.5 h-3.5" /> Finish {def.capture === 'line' ? 'run' : 'shape'}
              </Button>
              <Button size="sm" variant="ghost" onClick={stopDrawing}>Cancel</Button>
            </>
          )}
          <Button size="sm" variant="secondary" onClick={undoLast} disabled={drawing || !overlays.current.length}>
            <Undo2 className="w-3.5 h-3.5" /> Undo
          </Button>
          <Button size="sm" variant="secondary" onClick={clearAll} disabled={drawing || !overlays.current.length}>Clear</Button>
          <Button size="sm" onClick={saveShapes} loading={saving} disabled={drawing || !hasDrawing} className="ml-auto">
            <Check className="w-3.5 h-3.5" /> Save {def.label.toLowerCase()}
          </Button>
        </div>
      )}
      {center && (
        <p className="text-[11px] text-ink-faint">
          {drawing
            ? def.capture === 'point'
              ? 'Tap the tree on the map.'
              : `Tap each corner, then Finish ${def.capture === 'line' ? 'run' : 'shape'}.`
            : `Drag any point to adjust a saved shape — the figure updates as you move it. Trace more than once to add ${def.capture === 'point' ? 'more pins' : 'separate areas'}; they add up.`}
        </p>
      )}

      {/* ── Auto-measure: offered only where it's honest ── */}
      {!autoGate.ok && (
        <Banner tone="neutral" icon={Info}>
          <span className="text-ink-faint">{autoGate.reason}</span>
        </Banner>
      )}

      {/* ── Manual adjustment ── */}
      <div className="rounded-xl border border-border bg-surface p-3.5 space-y-2">
        <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Or enter it yourself</p>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Input fieldSize="sm" type="number" min="0" step={def.unit === 'count' ? '1' : '1'}
              value={manual} onChange={e => setManual(e.target.value)}
              placeholder={def.unit === 'count' ? 'e.g. 3' : 'e.g. 1200'}
              hint={def.unit === 'count' ? 'How many' : `In ${def.unit === 'sqft' ? 'square feet' : 'linear feet'}`} />
          </div>
          <Button size="sm" variant="secondary" onClick={saveTyped} loading={saving}
            disabled={manual.trim() === '' || !Number.isFinite(Number(manual)) || Number(manual) < 0}>
            <Pencil className="w-3.5 h-3.5" /> Use this number
          </Button>
        </div>
        <p className="text-[11px] text-ink-faint">
          Recorded as your figure, not an EdgeQuote estimate — it replaces any traced shape for {def.noun}.
        </p>
      </div>

      {/* ── What's recorded, and how much to trust it ── */}
      <div className="rounded-xl border border-border bg-surface">
        <div className="px-3.5 py-2.5 border-b border-border flex items-center justify-between">
          <p className="text-xs font-semibold text-ink">On this property</p>
          {history.length > 0 && (
            <button type="button" onClick={() => setShowHistory(v => !v)}
              className="text-[11px] text-ink-faint hover:text-ink flex items-center gap-1">
              <History className="w-3 h-3" /> {showHistory ? 'Hide' : 'History'}
            </button>
          )}
        </div>

        {loading ? (
          <div className="p-4"><Loader2 className="w-4 h-4 animate-spin text-ink-faint" /></div>
        ) : measured.all.length === 0 ? (
          <InlineEmpty icon={Ruler}>Nothing measured yet.</InlineEmpty>
        ) : (
          <div className="divide-y divide-border">
            {measured.all.map(m => (
              <div key={m.id} className="px-3.5 py-2.5 flex items-center gap-3">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: kindDef(m.kind).color }} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">
                    <span className="font-semibold tabular-nums">{formatMeasurement(m.value, m.kind)}</span>
                    <span className="text-ink-faint"> {kindDef(m.kind).noun}</span>
                  </p>
                  {/* The reason, always — a badge alone tells nobody whether to look. */}
                  <p className="text-[11px] text-ink-faint">{m.confidence_reason}</p>
                </div>
                <ConfidenceBadge confidence={m.confidence} />
                {m.kind === kind && (
                  <Button variant="ghost" size="sm" onClick={removeCurrent} className="hover:text-red-400 shrink-0" title="Remove">
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {measured.needingReview.length > 0 && (
          <div className="px-3.5 py-2.5 border-t border-border">
            <p className="text-[11px] text-amber-400 flex items-start gap-1.5">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              {measured.needingReview.map(m => kindDef(m.kind).noun).join(', ')} {measured.needingReview.length === 1 ? 'is' : 'are'} worth
              checking before you quote off {measured.needingReview.length === 1 ? 'it' : 'them'}.
            </p>
          </div>
        )}

        {/* ── History ── */}
        {showHistory && (
          <div className="border-t border-border">
            <p className="px-3.5 pt-2.5 text-[11px] text-ink-faint">
              Every version of {def.noun}, newest first. History is append-only — it can’t be rewritten.
            </p>
            {kindHistory.length === 0 ? (
              <InlineEmpty icon={History}>No history for {def.noun} yet.</InlineEmpty>
            ) : (
              <div className="divide-y divide-border">
                {kindHistory.map(h => (
                  <div key={h.id} className="px-3.5 py-2 flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-ink tabular-nums">
                        {h.action === 'removed'
                          ? <span className="text-ink-faint line-through">{formatMeasurement(Number(h.value), h.kind)}</span>
                          : formatMeasurement(Number(h.value), h.kind)}
                        <span className="text-ink-faint"> · {h.source}</span>
                        {h.action === 'removed' && <span className="text-ink-faint"> · removed</span>}
                      </p>
                      <p className="text-[10px] text-ink-faint">{formatDate(h.created_at)}</p>
                    </div>
                    <ConfidenceBadge confidence={h.confidence} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
