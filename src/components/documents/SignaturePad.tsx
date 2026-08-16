'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Eraser } from 'lucide-react'

// ── The signature control ────────────────────────────────────────────────────
//
// A phone is the primary device here: the customer is standing in their driveway
// signing a work authorization. Three things make that work, and each one is a
// bug if it is missing:
//
//   1. POINTER EVENTS, not mouse or touch events. One code path covers finger,
//      stylus and mouse, and `setPointerCapture` keeps the stroke attached to the
//      pad when the finger slides past its edge mid-signature.
//   2. `touch-action: none`. Without it the browser claims the gesture for
//      scrolling and the customer drags the page instead of drawing a line —
//      the single most common way a signature pad fails on a phone.
//   3. DEVICE PIXEL RATIO backing store. A canvas sized in CSS pixels on a 3×
//      phone renders a soft, blocky mark. The bitmap is allocated at the real
//      device resolution and the context is scaled once to match.
//
// The pad reports emptiness rather than guessing: `onChange(null)` until an
// actual stroke exists, so a caller can refuse to submit a blank acknowledgement
// instead of recording a signature nobody made.

export function SignaturePad({
  onChange,
  disabled = false,
  label = 'Sign here',
}: {
  onChange: (dataUrl: string | null) => void
  disabled?: boolean
  label?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const hasInk = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  const [empty, setEmpty] = useState(true)

  /** Re-allocate the backing store for the element's real size and DPR, then
   *  restore the drawing context. Called on mount and on every resize —
   *  a phone rotating is a resize, and so is the keyboard opening. */
  const fit = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    // Preserve what is already drawn across a resize — losing a half-finished
    // signature to a rotation would be its own small betrayal.
    const previous = hasInk.current ? canvas.toDataURL('image/png') : null

    canvas.width = Math.round(rect.width * dpr)
    canvas.height = Math.round(rect.height * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    // Read the ink colour from the theme so the mark is legible in both themes.
    ctx.strokeStyle = getComputedStyle(canvas).color || '#0f172a'

    if (previous) {
      const img = new Image()
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height)
      img.src = previous
    }
  }, [])

  useEffect(() => {
    fit()
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', fit)
      return () => window.removeEventListener('resize', fit)
    }
    const ro = new ResizeObserver(fit)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [fit])

  function pointOf(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return
    e.preventDefault()
    // Keeps the stroke with this element even if the finger leaves the pad.
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing.current = true
    last.current = pointOf(e)
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || disabled) return
    e.preventDefault()
    const ctx = e.currentTarget.getContext('2d')
    if (!ctx || !last.current) return
    const p = pointOf(e)
    ctx.beginPath()
    ctx.moveTo(last.current.x, last.current.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    last.current = p
    if (!hasInk.current) {
      hasInk.current = true
      setEmpty(false)
    }
  }

  function up(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return
    drawing.current = false
    last.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    // Report only on stroke end: emitting a data URL on every pointermove would
    // re-encode the whole bitmap dozens of times a second on a phone.
    emit()
  }

  function emit() {
    const canvas = canvasRef.current
    if (!canvas) return
    onChange(hasInk.current ? canvas.toDataURL('image/png') : null)
  }

  function clear() {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    hasInk.current = false
    setEmpty(true)
    onChange(null)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5 gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{label}</p>
        <Button size="sm" variant="ghost" onClick={clear} disabled={disabled || empty} type="button">
          <Eraser className="w-3.5 h-3.5" /> Clear
        </Button>
      </div>
      <div className="relative rounded-lg border border-border bg-surface overflow-hidden">
        <canvas
          ref={canvasRef}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onPointerLeave={up}
          aria-label={label}
          role="img"
          // ⭐ touch-action:none is load-bearing — without it a finger scrolls
          // the page instead of drawing. h-40 gives a comfortable signing box at
          // 375px without pushing the confirm button below the fold.
          className="block w-full h-40 text-ink touch-none cursor-crosshair disabled:opacity-50"
          style={{ touchAction: 'none' }}
        />
        {empty && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="text-xs text-ink-faint">Draw your signature with a finger or mouse</span>
          </div>
        )}
        {/* The baseline sits under the ink, so it reads as a place to sign
            rather than as part of the signature itself. */}
        <div className="pointer-events-none absolute left-4 right-4 bottom-7 border-b border-border" />
      </div>
    </div>
  )
}
