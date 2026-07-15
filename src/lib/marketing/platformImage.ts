// ── Per-platform image cropping (the ONE marketing image sizer) ──────────────────
// Every network wants a different aspect ratio, and the owner should NEVER crop by
// hand. Given a source photo we compute a smart focal point (keep the subject, not
// the empty sky) and produce the platform's recommended size — reusing the existing
// browser-canvas primitives from Before/After (loadImage keeps the canvas untainted;
// coverCrop is object-fit: cover with a focal point). No new image engine, no sharp,
// no bucket work.

import type { MarketingChannel } from './types'
import { loadImage, coverCrop } from '@/lib/beforeafter/imageLoad'
import { clamp } from '@/lib/utils'

export interface PlatformImageSpec { w: number; h: number; label: string }

// Recommended feed sizes per network. Landscape where the platform favours it,
// portrait/square where that wins the most real estate.
export const PLATFORM_IMAGE: Record<MarketingChannel, PlatformImageSpec> = {
  facebook:  { w: 1200, h: 630,  label: 'Landscape · 1.91:1' },
  instagram: { w: 1080, h: 1350, label: 'Portrait · 4:5' },
  threads:   { w: 1080, h: 1350, label: 'Portrait · 4:5' },
  gbp:       { w: 1200, h: 900,  label: 'Landscape · 4:3' },
  nextdoor:  { w: 1080, h: 1080, label: 'Square · 1:1' },
  linkedin:  { w: 1200, h: 627,  label: 'Landscape · 1.91:1' },
}

// Smart focal point (0..1). Samples a tiny offscreen copy and finds the centroid of
// visual "interest" — local contrast, with a mild preference for mid-tones so blown-
// out sky and deep shadow don't pull the crop. Biased gently toward centre (never a
// hard edge crop) and slightly downward, which suits lawn/exterior work. Falls back
// to a lawn-friendly lower-centre if the canvas can't be read.
export function computeSmartFocus(img: HTMLImageElement): { x: number; y: number } {
  const FALLBACK = { x: 0.5, y: 0.56 }
  try {
    const N = 32
    const c = document.createElement('canvas')
    c.width = N; c.height = N
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return FALLBACK
    ctx.drawImage(img, 0, 0, N, N)
    const { data } = ctx.getImageData(0, 0, N, N)
    const lum = (x: number, y: number) => {
      const i = (y * N + x) * 4
      return (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255
    }
    let sumW = 0, sx = 0, sy = 0
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const l = lum(x, y)
        const lr = x + 1 < N ? lum(x + 1, y) : l
        const ld = y + 1 < N ? lum(x, y + 1) : l
        const grad = Math.abs(l - lr) + Math.abs(l - ld)   // local detail/contrast
        const midness = Math.max(0, 1 - Math.abs(l - 0.5) * 1.4) // de-weight sky/shadow
        const w = grad * 2 + midness * 0.15
        if (w > 0) { sumW += w; sx += w * (x + 0.5); sy += w * (y + 0.5) }
      }
    }
    if (sumW <= 0) return FALLBACK
    const fx = 0.5 + ((sx / sumW / N) - 0.5) * 0.6
    const fy = 0.5 + ((sy / sumW / N) - 0.5) * 0.6
    return { x: clamp(fx, 0.2, 0.8), y: clamp(fy, 0.25, 0.85) }
  } catch {
    return FALLBACK
  }
}

// Draw the source (already loaded) cropped + recentred for a platform into a canvas.
export function drawForPlatform(canvas: HTMLCanvasElement, img: HTMLImageElement, ch: MarketingChannel): void {
  const spec = PLATFORM_IMAGE[ch]
  canvas.width = spec.w; canvas.height = spec.h
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const iw = img.naturalWidth || img.width
  const ih = img.naturalHeight || img.height
  const focus = computeSmartFocus(img)
  const { sx, sy, sw, sh } = coverCrop(iw, ih, spec.w, spec.h, focus.x, focus.y)
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, spec.w, spec.h)
}

// Render the source URL cropped+recentred for a platform → a JPEG Blob.
export async function renderForPlatform(src: string, ch: MarketingChannel): Promise<Blob | null> {
  const img = await loadImage(src)
  const canvas = document.createElement('canvas')
  drawForPlatform(canvas, img, ch)
  return new Promise<Blob | null>(resolve => canvas.toBlob(b => resolve(b), 'image/jpeg', 0.92))
}

// Save the platform-cropped image to the owner's device (the manual "Save photo").
export async function downloadForPlatform(src: string, ch: MarketingChannel, filename: string): Promise<boolean> {
  try {
    const blob = await renderForPlatform(src, ch)
    if (!blob) return false
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return true
  } catch {
    return false
  }
}
