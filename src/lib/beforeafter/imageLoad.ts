// ── Canvas image helpers ────────────────────────────────────────────────────
// Loading photos for a <canvas> we then export has one hard requirement: the
// canvas must stay UNtainted or toBlob() throws. Rather than depend on every
// bucket sending the right CORS headers, we fetch the bytes ourselves and draw
// from a same-origin object URL — that can never taint the canvas. All the
// geometry/exposure math the renderer needs lives here too, so layouts.ts stays
// about composition.

const cache = new Map<string, Promise<HTMLImageElement>>()

// Load (and decode) an image as a same-origin blob URL. Cached per source URL so
// switching layouts/sizes never re-downloads. Object URLs are intentionally kept
// for the session — the photos are already downscaled (~1600px) and few.
export function loadImage(src: string): Promise<HTMLImageElement> {
  const hit = cache.get(src)
  if (hit) return hit
  const p = (async () => {
    let objectUrl: string | null = null
    try {
      const res = await fetch(src, { mode: 'cors' })
      if (res.ok) {
        const blob = await res.blob()
        objectUrl = URL.createObjectURL(blob)
      }
    } catch {
      objectUrl = null
    }
    const img = new Image()
    if (!objectUrl) img.crossOrigin = 'anonymous' // best-effort direct load fallback
    img.src = objectUrl || src
    try {
      await img.decode()
    } catch {
      // decode() can reject in older engines; fall back to load event.
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('image load failed'))
      })
    }
    return img
  })()
  cache.set(src, p)
  // Drop failed loads from the cache so a retry can succeed.
  p.catch(() => cache.delete(src))
  return p
}

export interface CropRect { sx: number; sy: number; sw: number; sh: number }

// object-fit: cover — the largest centered (or focal-point) crop of the source
// that fills a cell of cellW×cellH. focusX/focusY in 0..1 bias which part shows.
export function coverCrop(imgW: number, imgH: number, cellW: number, cellH: number, focusX = 0.5, focusY = 0.5): CropRect {
  if (imgW <= 0 || imgH <= 0 || cellW <= 0 || cellH <= 0) return { sx: 0, sy: 0, sw: imgW, sh: imgH }
  const imgAspect = imgW / imgH
  const cellAspect = cellW / cellH
  let sw: number, sh: number
  if (imgAspect > cellAspect) {
    // image wider than cell → crop the sides
    sh = imgH
    sw = imgH * cellAspect
  } else {
    sw = imgW
    sh = imgW / cellAspect
  }
  const sx = clamp((imgW - sw) * focusX, 0, Math.max(0, imgW - sw))
  const sy = clamp((imgH - sh) * focusY, 0, Math.max(0, imgH - sh))
  return { sx, sy, sw, sh }
}

// Average perceived luminance (0..1) sampled from a tiny offscreen copy. Used to
// gently balance exposure between a dim "before" and a bright "after" so the pair
// reads as one consistent shot. Returns 0.5 (no-op) if the canvas isn't readable.
const lumCache = new Map<string, number>()
export function averageLuminance(img: HTMLImageElement, key: string): number {
  const cached = lumCache.get(key)
  if (cached != null) return cached
  let lum = 0.5
  try {
    const N = 24
    const c = document.createElement('canvas')
    c.width = N
    c.height = N
    const ctx = c.getContext('2d')
    if (ctx) {
      ctx.drawImage(img, 0, 0, N, N)
      const { data } = ctx.getImageData(0, 0, N, N)
      let sum = 0
      let count = 0
      for (let i = 0; i < data.length; i += 4) {
        // Rec. 601 luma, normalized
        sum += (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255
        count++
      }
      if (count) lum = sum / count
    }
  } catch {
    lum = 0.5
  }
  lumCache.set(key, lum)
  return lum
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
