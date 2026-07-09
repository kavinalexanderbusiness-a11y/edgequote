import type { CaptureStamp, CaptureMeta } from '@/lib/exif'
import { haversineKm } from '@/lib/geo'

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

// ── Multi-job clustering (same-day bulk drops) ────────────────────────────────────
// The SAME time-gap idea, generalized: within one visit, before→after are minutes
// apart; between two visits you drive somewhere — a much bigger gap (or a GPS jump).
// So: sort by capture time, break into VISIT clusters wherever the gap exceeds the
// between-jobs threshold or the location moves lots-apart, then run the existing
// before/after split INSIDE each cluster. One engine — detectBeforeAfter is reused
// verbatim per cluster, never re-implemented.

const BETWEEN_JOBS_GAP_MS = 45 * 60_000  // ≥45 min of silence = you moved on
const BETWEEN_JOBS_KM = 0.25             // consecutive shots >250 m apart = new site

export interface PhotoGroup {
  indices: number[]                 // original input indices, capture-time order
  detect: DetectResult              // before/after split INSIDE this cluster
  startMs: number
  endMs: number
  centroid: { lat: number; lng: number } | null   // mean GPS of located shots
  confidence: DetectConfidence      // cluster-boundary confidence
}
export interface GroupResult {
  groups: PhotoGroup[]
  confidence: DetectConfidence      // overall: lowest group boundary confidence
}

// metas must be parallel to the caller's file list (same indices).
export function clusterPhotoGroups(metas: CaptureMeta[]): GroupResult {
  if (!metas.length) return { groups: [], confidence: 'low' }
  const order = metas.map((m, index) => ({ ...m, index }))
    .sort((a, b) => (a.ms - b.ms) || (a.index - b.index))
  const haveTimes = order.some(o => o.ms > 0) && new Set(order.map(o => o.ms)).size > 1

  // Break into clusters at big time gaps / GPS jumps. Without usable times we can't
  // distinguish visits — everything stays one low-confidence cluster.
  const clusters: (typeof order)[] = [[order[0]]]
  if (haveTimes) {
    for (let i = 1; i < order.length; i++) {
      const prev = order[i - 1], cur = order[i]
      const gap = cur.ms - prev.ms
      const moved = prev.lat != null && prev.lng != null && cur.lat != null && cur.lng != null
        ? haversineKm({ lat: prev.lat, lng: prev.lng }, { lat: cur.lat, lng: cur.lng })
        : null
      const newVisit = gap >= BETWEEN_JOBS_GAP_MS || (moved != null && moved >= BETWEEN_JOBS_KM && gap >= 5 * 60_000)
      if (newVisit) clusters.push([cur])
      else clusters[clusters.length - 1].push(cur)
    }
  } else {
    for (let i = 1; i < order.length; i++) clusters[0].push(order[i])
  }

  const groups: PhotoGroup[] = clusters.map(c => {
    const located = c.filter(x => x.lat != null && x.lng != null)
    const centroid = located.length
      ? { lat: located.reduce((s, x) => s + (x.lat as number), 0) / located.length, lng: located.reduce((s, x) => s + (x.lng as number), 0) / located.length }
      : null
    // Reuse THE before/after detector on just this cluster's stamps.
    const detect = detectBeforeAfter(c.map(x => ({ ms: x.ms, exact: x.exact })))
    // Remap detect's local indices back to the ORIGINAL input indices.
    detect.items = detect.items.map((it, local) => ({ ...it, index: c[local].index }))
    const allExact = c.every(x => x.exact)
    const boundary: DetectConfidence = !haveTimes ? 'low' : allExact ? 'high' : 'medium'
    return {
      indices: c.map(x => x.index),
      detect,
      startMs: c[0].ms,
      endMs: c[c.length - 1].ms,
      centroid,
      confidence: boundary,
    }
  })

  const rank: Record<DetectConfidence, number> = { high: 2, medium: 1, low: 0 }
  const overall = groups.reduce<DetectConfidence>((worst, g) => (rank[g.confidence] < rank[worst] ? g.confidence : worst), 'high')
  return { groups, confidence: groups.length ? overall : 'low' }
}
