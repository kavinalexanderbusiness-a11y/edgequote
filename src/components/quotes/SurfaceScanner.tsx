'use client'

import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { growSurfaceRegion, combineSurfaceMasks, scaledSurfaceArea, type ScanPoint, type ScanBounds, type SurfaceMask } from '@/lib/surfaceScan'
import { M_TO_FT } from '@/lib/measure/geometry'
import { readRasterDimensions, MAX_RASTER_BYTES, MAX_RASTER_PIXELS, MAX_RASTER_SIDE } from '@/lib/imageDimensions'

export interface ScannedArea {
  sqft: number
  pixelCount: number
  referencePixels: number
  referenceFeet: number
  imageWidth: number
  imageHeight: number
}

type Mode = 'scale' | 'bounds' | 'select' | 'erase'

/** Local image selection only: no imagery provider, upload, storage or automatic semantic-class claim. */
export function SurfaceScanner({ onUse, onClose, canApply = true }: { onUse: (area: ScannedArea) => boolean | void; onClose: () => void; canApply?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const generation = useRef(0)
  const applied = useRef(false)
  const erasing = useRef(false)
  const [image, setImage] = useState<ImageData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<Mode>('scale')
  const [scale, setScale] = useState<ScanPoint[]>([])
  const [corners, setCorners] = useState<ScanPoint[]>([])
  const [bounds, setBounds] = useState<ScanBounds | null>(null)
  const [distance, setDistance] = useState('')
  const [unit, setUnit] = useState<'ft' | 'm'>('ft')
  const [distanceUnit, setDistanceUnit] = useState<'ft' | 'm'>('ft')
  const [tolerance, setTolerance] = useState(35)
  const [brush, setBrush] = useState(12)
  const [selection, setSelection] = useState<SurfaceMask | null>(null)
  const currentMask = useRef<SurfaceMask | null>(null)
  const [undo, setUndo] = useState<SurfaceMask | null>(null)
  const [reviewed, setReviewed] = useState(false)
  const [edge, setEdge] = useState(false)
  const [cursor, setCursor] = useState<ScanPoint | null>(null)

  useEffect(() => () => { generation.current++ }, [])

  const updateSelection = (next: SurfaceMask | null) => {
    currentMask.current = next
    setSelection(next)
    setReviewed(false)
  }
  const clearSelection = () => { updateSelection(null); setUndo(null); setEdge(false) }

  async function loadImage(file?: File) {
    const token = ++generation.current
    applied.current = false
    setImage(null); clearSelection(); setScale([]); setBounds(null); setCorners([])
    setDistance(''); setDistanceUnit(unit); setCursor(null); setMode('scale'); setError(''); setLoading(!!file)
    if (!file) return
    let bitmap: ImageBitmap | null = null
    try {
      if (file.size > MAX_RASTER_BYTES) throw new Error('Choose an image smaller than 12 MB.')
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (token !== generation.current) return
      const dimensions = readRasterDimensions(bytes)
      if (!dimensions) throw new Error('Choose a valid, still PNG, JPEG or WebP image, up to 40 megapixels and 20,000 pixels per side.')
      bitmap = await createImageBitmap(file)
      if (token !== generation.current) return
      if (!bitmap.width || !bitmap.height || bitmap.width > MAX_RASTER_SIDE || bitmap.height > MAX_RASTER_SIDE
        || bitmap.width * bitmap.height > MAX_RASTER_PIXELS
        || !((bitmap.width === dimensions.width && bitmap.height === dimensions.height)
          || (bitmap.width === dimensions.height && bitmap.height === dimensions.width))) throw new Error('The image size could not be verified. Choose another image.')
      const factor = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height))
      const buffer = document.createElement('canvas')
      buffer.width = Math.max(1, Math.round(bitmap.width * factor))
      buffer.height = Math.max(1, Math.round(bitmap.height * factor))
      const ctx = buffer.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('This browser could not open the image. You can still enter measurements manually.')
      ctx.drawImage(bitmap, 0, 0, buffer.width, buffer.height)
      setImage(ctx.getImageData(0, 0, buffer.width, buffer.height))
      setCursor({ x: Math.floor(buffer.width / 2), y: Math.floor(buffer.height / 2) })
    } catch (reason) {
      if (token === generation.current) setError(reason instanceof Error ? reason.message : 'Could not open this image. Try another file.')
    } finally {
      bitmap?.close()
      if (token === generation.current) setLoading(false)
    }
  }

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx || !image) return
    const rendered = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height)
    if (selection) for (let i = 0; i < selection.mask.length; i++) if (selection.mask[i]) {
      rendered.data[i * 4] *= 0.35
      rendered.data[i * 4 + 1] = rendered.data[i * 4 + 1] * 0.35 + 220 * 0.65
      rendered.data[i * 4 + 2] = rendered.data[i * 4 + 2] * 0.35 + 180 * 0.65
    }
    ctx.putImageData(rendered, 0, 0)
    ctx.lineWidth = Math.max(2, image.width / 300)
    if (bounds) {
      ctx.strokeStyle = '#ffb84d'; ctx.setLineDash([8, 5])
      ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height); ctx.setLineDash([])
    }
    if (scale.length) {
      ctx.strokeStyle = '#ffee55'; ctx.fillStyle = '#ffee55'
      ctx.beginPath(); ctx.moveTo(scale[0].x, scale[0].y)
      if (scale[1]) ctx.lineTo(scale[1].x, scale[1].y)
      ctx.stroke()
      for (const point of scale) { ctx.beginPath(); ctx.arc(point.x, point.y, Math.max(4, image.width / 110), 0, Math.PI * 2); ctx.fill() }
    }
    if (corners.length === 1) {
      ctx.fillStyle = '#ffb84d'; ctx.fillRect(corners[0].x - 4, corners[0].y - 4, 8, 8)
    }
    if (cursor) {
      ctx.strokeStyle = '#fff'; ctx.beginPath()
      ctx.arc(cursor.x, cursor.y, mode === 'erase' ? brush : Math.max(5, image.width / 100), 0, Math.PI * 2); ctx.stroke()
    }
  }, [image, selection, scale, bounds, corners, cursor, mode, brush])

  function changeMode(next: Mode) {
    setMode(next); erasing.current = false; setReviewed(false); setCorners([])
    if (next === 'scale') setScale([])
    if (next === 'bounds') { setCorners([]); setBounds(null); clearSelection() }
  }

  function erase(point: ScanPoint) {
    const previous = currentMask.current
    if (!image || !previous) return
    const mask = new Uint8Array(previous.mask)
    let pixelCount = previous.pixelCount
    for (let y = Math.max(0, point.y - brush); y <= Math.min(image.height - 1, point.y + brush); y++) {
      for (let x = Math.max(0, point.x - brush); x <= Math.min(image.width - 1, point.x + brush); x++) {
        if ((x - point.x) ** 2 + (y - point.y) ** 2 <= brush ** 2 && mask[y * image.width + x]) { mask[y * image.width + x] = 0; pixelCount-- }
      }
    }
    updateSelection({ mask, pixelCount })
  }

  function place(point: ScanPoint) {
    if (!image) return
    setCursor(point); setReviewed(false); setError('')
    if (mode === 'scale') {
      const next = scale.length === 1 ? [...scale, point] : [point]
      setScale(next)
      if (next.length === 2) setMode(bounds ? 'select' : 'bounds')
    } else if (mode === 'bounds') {
      if (corners.length !== 1) { setCorners([point]); setBounds(null); clearSelection() }
      else {
        const first = corners[0]
        setBounds({ x: Math.min(first.x, point.x), y: Math.min(first.y, point.y), width: Math.abs(first.x - point.x) + 1, height: Math.abs(first.y - point.y) + 1 })
        setCorners([]); clearSelection(); setMode('select')
      }
    } else if (mode === 'erase') { setUndo(currentMask.current); erase(point) }
    else {
      if (!bounds) { setError('Set the scan bounds before selecting a surface.'); return }
      const region = growSurfaceRegion(image, point, bounds, tolerance)
      if (!region || !region.pixelCount) { setError('Choose a visible point inside the scan bounds.'); return }
      const previous = currentMask.current ?? { mask: new Uint8Array(image.width * image.height), pixelCount: 0 }
      const combined = combineSurfaceMasks(previous.mask, region.mask, 'add')
      if (!combined) return
      setUndo(previous); updateSelection(combined); setEdge(current => current || region.touchesBoundary)
    }
  }

  function pointerPoint(event: PointerEvent<HTMLCanvasElement>): ScanPoint | null {
    if (!image || !event.isPrimary) return null
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    return { x: Math.max(0, Math.min(image.width - 1, Math.floor((event.clientX - rect.left) * image.width / rect.width))),
      y: Math.max(0, Math.min(image.height - 1, Math.floor((event.clientY - rect.top) * image.height / rect.height))) }
  }

  const referencePixels = scale.length === 2 ? Math.hypot(scale[1].x - scale[0].x, scale[1].y - scale[0].y) : 0
  const referenceFeet = Number(distance) * (distanceUnit === 'm' ? M_TO_FT : 1)
  const displayedDistance = unit === distanceUnit || !Number.isFinite(Number(distance)) || !distance.trim()
    ? distance : String(Number((unit === 'm' ? referenceFeet / M_TO_FT : referenceFeet).toPrecision(12)))
  const sqft = selection && scale.length === 2 && referencePixels >= 8
    ? scaledSurfaceArea(selection.pixelCount, scale[0], scale[1], Number(distance), distanceUnit) : null
  const instructions = mode === 'scale' ? `Tap two ends of a distance you know (${scale.length}/2 points).`
    : mode === 'bounds' ? `Tap two opposite corners around the area to scan (${corners.length}/2 corners).`
      : mode === 'erase' ? 'Tap or drag over anything that should not be included.'
        : 'Tap the lawn or driveway. Similar connected pixels are selected; tap more patches to add them.'

  return <section className="rounded-xl border border-accent/30 bg-bg-tertiary p-4 space-y-4" aria-label="Image scanner">
    <div className="flex items-start justify-between gap-3">
      <div><h3 className="font-semibold text-ink">Scan your own image</h3><p className="text-xs text-ink-muted mt-1">Assisted selection · image stays in this browser</p></div>
      <Button variant="ghost" onClick={onClose}>Close</Button>
    </div>
    <p className="text-xs text-ink-muted">Use an overhead image you own or have permission to measure. A known distance and a flat, straight-down view are needed; angled photos, shadows and hidden areas can give a wrong estimate.</p>
    <Input label="Overhead image" type="file" accept="image/png,image/jpeg,image/webp" hint="PNG, JPEG or WebP · up to 12 MB. Nothing is uploaded or saved."
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void loadImage(file) }} />
    {loading && <p className="text-sm text-ink-muted" role="status">Opening image…</p>}
    {error && <p className="text-sm text-amber-400" role="alert">{error}</p>}
    {image && <>
      <div className="flex flex-wrap gap-2">{([['scale', '1. Scale'], ['bounds', '2. Bounds'], ['select', '3. Select'], ['erase', 'Erase']] as const).map(([key, text]) =>
        <Button key={key} variant={mode === key ? 'primary' : 'secondary'} size="sm" aria-pressed={mode === key} onClick={() => changeMode(key)}>{text}</Button>)}</div>
      <p className="text-sm text-ink" id="scanner-instructions">{instructions}</p>
      <div className="overflow-hidden rounded-lg ring-1 ring-border">
        <canvas ref={canvas} width={image.width} height={image.height} className="block w-full h-auto touch-none cursor-crosshair" tabIndex={0}
          aria-label="Property image. Arrow keys move the point; Enter places it." aria-describedby="scanner-instructions"
          onPointerDown={event => { const point = pointerPoint(event); if (!point) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); erasing.current = mode === 'erase'; place(point) }}
          onPointerMove={event => { if (!erasing.current || !event.buttons) return; const point = pointerPoint(event); if (point) { setCursor(point); erase(point) } }}
          onPointerUp={() => { erasing.current = false }} onPointerCancel={() => { erasing.current = false }}
          onKeyDown={event => {
            if (!cursor) return
            const steps: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
            const direction = steps[event.key]
            if (direction) { event.preventDefault(); const step = event.shiftKey ? 10 : 1; setCursor({ x: Math.max(0, Math.min(image.width - 1, cursor.x + direction[0] * step)), y: Math.max(0, Math.min(image.height - 1, cursor.y + direction[1] * step)) }) }
            else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); place(cursor) }
          }} />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_100px] gap-3">
        <Input label="Known distance between yellow points" type="number" min="0" step="any" value={displayedDistance} onChange={event => { setDistance(event.target.value); setDistanceUnit(unit); setReviewed(false) }} />
        <Select label="Unit" value={unit} options={[{ value: 'ft', label: 'Feet' }, { value: 'm', label: 'Metres' }]}
          onChange={event => { setUnit(event.target.value as 'ft' | 'm'); setReviewed(false) }} />
      </div>
      {scale.length === 2 && referencePixels < 8 && <p className="text-xs text-amber-400">Choose scale points farther apart for a usable reference.</p>}
      <Input label={`Selection sensitivity · ${tolerance}`} type="range" min="0" max="120" value={tolerance}
        onChange={event => { setTolerance(Number(event.target.value)); clearSelection() }} hint="Higher values include more colour variation. Changing this clears the selection." />
      {mode === 'erase' && <Input label={`Eraser size · ${brush} pixels`} type="range" min="3" max="40" value={brush} onChange={event => setBrush(Number(event.target.value))} />}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={!undo} onClick={() => { updateSelection(undo); setUndo(null) }}>Undo selection</Button>
        <Button variant="ghost" disabled={!selection?.pixelCount} onClick={clearSelection}>Clear selection</Button>
      </div>
      {edge && !!selection?.pixelCount && <p className="text-xs text-ink-muted">The selection reaches the scan bounds. Check that neighbouring areas are excluded.</p>}
      <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
        <p className="font-semibold text-ink">{sqft === null ? 'Set a scale and select the surface' : `${sqft.toLocaleString('en-CA', { maximumFractionDigits: 2 })} sq ft selected`}</p>
        <p className="text-xs text-ink-muted">This selects similar colours, not verified lawn or driveway boundaries. Correct the highlight and check your reference distance before using the area.</p>
        <label className="flex items-start gap-2 text-sm text-ink-muted"><input className="mt-1 accent-accent" type="checkbox" checked={reviewed} disabled={sqft === null}
          onChange={event => setReviewed(event.target.checked)} />I checked the selected area and the image scale.</label>
        {!canApply && <p className="text-xs text-amber-400" role="status">Remove a section below to use this area. Up to 20 sections per estimate.</p>}
        <Button disabled={sqft === null || !reviewed || !canApply} onClick={() => {
          if (sqft === null || !reviewed || !selection || applied.current || !canApply) return
          const accepted = onUse({ sqft, pixelCount: selection.pixelCount, referencePixels, referenceFeet, imageWidth: image.width, imageHeight: image.height })
          if (accepted === false) return
          applied.current = true
          setReviewed(false)
        }}>Use reviewed area</Button>
      </div>
    </>}
  </section>
}
