import type { CaptureStamp } from '@/lib/exif'

// ── Before/After auto-detection ──────────────────────────────────────────────────
// Decides which dropped photos are "before" and which are "after" from capture time
// (EXIF, else file lastModified), falling back to drop order. The work happens
// BETWEEN the before and after shots, so the biggest time gap in the sorted sequence
// is the natural split: everything before the gap is "before", everything after is
// "after". Returns a confidence so the UI can ASK instead of guessing when unsure.

export type DetectConfidence = 'high' | 'medium' | 'low'
export interface DetectItem { index: number; kind: 'before' | 'after'; ms: number; exact: boolean }
export interface DetectResult {
  items: DetectItem[]                         // one per input, in ORIGINAL order
  confidence: DetectConfidence
  method: 'capture-time' | 'order' | 'single'
  gapMs: number | null                        // the inferred work gap, when known
}

const MIN_WORK_GAP_MS = 60_000  // a real before→after gap is at least ~1 minute

// stamps must be parallel to the caller's file list (same indices).
export function detectBeforeAfter(stamps: CaptureStamp[]): DetectResult {
  const n = stamps.length
  if (n === 0) return { items: [], confidence: 'low', method: 'order', gapMs: null }

  // A lone photo can't form a pair — default it to "after" (usually the result shot),
  // low confidence so the UI lets the owner flip it.
  if (n === 1) return { items: [{ index: 0, kind: 'after', ms: stamps[0].ms, exact: stamps[0].exact }], confidence: 'low', method: 'single', gapMs: null }

  const order = stamps.map((s, index) => ({ index, ms: s.ms, exact: s.exact }))
  const sorted = [...order].sort((a, b) => (a.ms - b.ms) || (a.index - b.index))
  const allExact = stamps.every(s => s.exact)
  const haveTimes = sorted.some(s => s.ms > 0) && new Set(sorted.map(s => s.ms)).size > 1

  let splitAfterPos: number   // last sorted position that belongs to "before"
  let gapMs: number | null = null
  let dominance = 0
  let method: DetectResult['method']

  if (haveTimes) {
    // Largest consecutive gap = the work break.
    let maxGap = -1, secondGap = 0, at = 0
    for (let i = 1; i < sorted.length; i++) {
      const g = sorted[i].ms - sorted[i - 1].ms
      if (g > maxGap) { secondGap = maxGap; maxGap = g; at = i - 1 }
      else if (g > secondGap) secondGap = g
    }
    splitAfterPos = at
    gapMs = maxGap
    dominance = secondGap > 0 ? maxGap / secondGap : (maxGap > 0 ? 99 : 0)
    method = 'capture-time'
  } else {
    // No usable times → split by drop order (first half before, rest after).
    splitAfterPos = Math.floor((sorted.length - 1) / 2)
    method = 'order'
  }

  const items: DetectItem[] = order.map(o => ({ index: o.index, kind: 'before', ms: o.ms, exact: o.exact }))
  sorted.forEach((s, pos) => { items[s.index].kind = pos <= splitAfterPos ? 'before' : 'after' })

  // Confidence: a big, dominant gap on EXIF times is trustworthy; order-only is not.
  let confidence: DetectConfidence
  if (method === 'capture-time' && allExact && (gapMs ?? 0) >= MIN_WORK_GAP_MS && dominance >= 3) confidence = 'high'
  else if (method === 'capture-time' && (gapMs ?? 0) >= MIN_WORK_GAP_MS && dominance >= 2) confidence = 'medium'
  else if (method === 'capture-time' && (gapMs ?? 0) > 0) confidence = 'medium'
  else confidence = 'low'

  // A clean 2-photo drop with EXIF is the common, trustworthy case.
  if (n === 2 && method === 'capture-time' && allExact && (gapMs ?? 0) >= MIN_WORK_GAP_MS) confidence = 'high'

  return { items, confidence, method, gapMs }
}
