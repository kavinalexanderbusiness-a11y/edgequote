// ── Image quality + "best photo" ranking (the ONE reusable photo-ranking engine) ──
// Deterministic, pixel-based photo assessment for ranking before/after pairs — and
// reusable anywhere EdgeQuote needs "the best photo". Pure canvas math over the SAME
// untainted loader Before/After already uses (lib/beforeafter/imageLoad). It reads a
// tiny downscaled sample (never the full image) so it's cheap; scores are RELATIVE,
// so they only need to rank consistently, not be physically exact.
//
// Signals (per the owner's brief): sharpness, brightness/exposure, "landscaping
// visibility" (healthy-lawn green in frame), framing (detail spread across the
// frame, not a big blank sky), and after-vs-before visible improvement. This is the
// deterministic floor; AI Vision refines it via blendPairScore when available. The
// owner can always override the pick manually.

import { loadImage } from './imageLoad'

export interface ImageMetrics {
  sharpness: number    // 0..1 — edge energy (variance of Laplacian), normalized
  brightness: number   // 0..1 — mean luminance
  exposure: number     // 0..1 — how well-exposed (1 = ideal mid-tones, low = too dark/blown)
  greenness: number    // 0..1 — share of healthy-lawn green pixels (landscaping visibility)
  framing: number      // 0..1 — detail spread across the frame (penalises big flat/blown areas)
}

export interface PairImageScore {
  score: number        // 0..100 deterministic image-quality score for the pair
  improvement: number  // 0..1 — after clearer/greener/better-exposed than before
  reasons: string[]
  before: ImageMetrics
  after: ImageMetrics
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

interface Sample { N: number; gray: Float32Array; r: Uint8ClampedArray; g: Uint8ClampedArray; b: Uint8ClampedArray }

// Draw the image into an N×N offscreen canvas and read the pixels once.
function sample(img: HTMLImageElement, N = 48): Sample | null {
  try {
    const c = document.createElement('canvas')
    c.width = N; c.height = N
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, N, N)
    const { data } = ctx.getImageData(0, 0, N, N)
    const gray = new Float32Array(N * N)
    const r = new Uint8ClampedArray(N * N), g = new Uint8ClampedArray(N * N), b = new Uint8ClampedArray(N * N)
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      r[p] = data[i]; g[p] = data[i + 1]; b[p] = data[i + 2]
      gray[p] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255
    }
    return { N, gray, r, g, b }
  } catch {
    return null
  }
}

function metricsFrom(s: Sample): ImageMetrics {
  const { N, gray, r, g, b } = s
  // Mean luminance → brightness; exposure peaks at mid-tones, falls off toward
  // pure black / pure white.
  let sum = 0
  for (let i = 0; i < gray.length; i++) sum += gray[i]
  const brightness = sum / gray.length
  const exposure = clamp01(1 - Math.abs(brightness - 0.5) * 1.8)

  // Sharpness: variance of the Laplacian over interior pixels (edge energy).
  let lapSum = 0, lapSq = 0, n = 0
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      const i = y * N + x
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - N] - gray[i + N]
      lapSum += lap; lapSq += lap * lap; n++
    }
  }
  const lapVar = n ? lapSq / n - (lapSum / n) ** 2 : 0
  const sharpness = clamp01(lapVar / 0.02) // ~0.02 var reads as crisp at this sample size

  // Greenness: share of pixels where green clearly leads red & blue and isn't dark
  // — a proxy for visible, healthy landscaping.
  let greenPx = 0
  for (let i = 0; i < gray.length; i++) {
    if (g[i] > r[i] * 1.06 && g[i] > b[i] * 1.06 && g[i] > 45 && gray[i] > 0.12) greenPx++
  }
  const greenness = clamp01(greenPx / gray.length / 0.55) // ~55% green frame = full score

  // Framing: reward detail spread across the frame; penalise a large flat/blown
  // region (e.g. a huge featureless sky). Fraction of cells with local contrast.
  let detailCells = 0, cells = 0
  const step = Math.max(2, Math.floor(N / 12))
  for (let y = 1; y < N - 1; y += step) {
    for (let x = 1; x < N - 1; x += step) {
      const i = y * N + x
      const local = Math.abs(gray[i] - gray[i - 1]) + Math.abs(gray[i] - gray[i + 1]) + Math.abs(gray[i] - gray[i - N]) + Math.abs(gray[i] - gray[i + N])
      if (local > 0.03 && gray[i] < 0.97) detailCells++
      cells++
    }
  }
  const framing = clamp01(cells ? detailCells / cells / 0.7 : 0.5)

  return { sharpness, brightness, exposure, greenness, framing }
}

export function assessImage(img: HTMLImageElement): ImageMetrics | null {
  const s = sample(img)
  return s ? metricsFrom(s) : null
}

export async function assessImageUrl(url: string): Promise<ImageMetrics | null> {
  try { return assessImage(await loadImage(url)) } catch { return null }
}

// A postable pair is carried mostly by the AFTER (the hero shot), with a smaller
// after-vs-before improvement term. Returns 0..100 + human reasons.
export function scorePairMetrics(before: ImageMetrics, after: ImageMetrics): PairImageScore {
  const reasons: string[] = []
  let score = 45

  const sharpPts = after.sharpness * 20
  if (after.sharpness >= 0.6) reasons.push('Sharp after photo')
  const expoPts = after.exposure * 16
  if (after.exposure >= 0.7) reasons.push('Well-lit')
  else if (after.brightness < 0.28) reasons.push('After looks dark')
  else if (after.brightness > 0.85) reasons.push('After looks over-exposed')
  const greenPts = after.greenness * 14
  if (after.greenness >= 0.5) reasons.push('Healthy lawn clearly visible')
  const framePts = after.framing * 8
  if (after.framing >= 0.6) reasons.push('Well-framed')

  // Visible improvement: after crisper / better-exposed / greener than before.
  const improvement = clamp01(
    (after.sharpness - before.sharpness) * 0.5 +
    (after.exposure - before.exposure) * 0.3 +
    (after.greenness - before.greenness) * 0.4 + 0.5,
  )
  const impPts = (improvement - 0.5) * 24 // -12..+12 around neutral
  if (improvement >= 0.62) reasons.push('Clear improvement over the before')

  score = Math.round(Math.max(0, Math.min(100, score + sharpPts + expoPts + greenPts + framePts + impPts)))
  return { score, improvement, reasons, before, after }
}

export async function scorePairUrls(beforeUrl: string, afterUrl: string): Promise<PairImageScore | null> {
  const [b, a] = await Promise.all([assessImageUrl(beforeUrl), assessImageUrl(afterUrl)])
  if (!a) return null // the after is essential; without it we can't score the pixels
  const before = b ?? a // if the before won't load, judge on the after alone
  return scorePairMetrics(before, a)
}

// Blend the metadata floor (buildPairs.score), this deterministic image score, and
// the optional AI Vision score into one 0..100. AI leads when present (it's the
// smarter judge); otherwise pixels lead the metadata proxy. All inputs 0..100.
export function blendPairScore(opts: { meta: number; image?: number | null; ai?: number | null }): number {
  const { meta } = opts
  const image = opts.image ?? null
  const ai = opts.ai ?? null
  if (ai != null && image != null) return Math.round(0.5 * ai + 0.32 * image + 0.18 * meta)
  if (ai != null) return Math.round(0.65 * ai + 0.35 * meta)
  if (image != null) return Math.round(0.6 * image + 0.4 * meta)
  return Math.round(meta)
}
