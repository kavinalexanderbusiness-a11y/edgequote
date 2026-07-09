import {
  findCustomerMatch, addressMatches, normalizeAddressKey,
  type MatchInput, type CustomerMatch,
} from '@/lib/customers'
import { serviceKey } from '@/lib/labor'
import { haversineKm, type Coord } from '@/lib/geo'

// ── THE unified duplicate-detection engine ────────────────────────────────────────
// One place that answers "does this already exist?" for customers, properties, jobs
// and photos, so every entry point (forms, quote save, photo upload, intake) agrees.
// It COMPOSES the canonical matchers that already exist — the customer/address
// matcher lives in lib/customers.ts (find-or-create needs it there) and is
// re-exported here unchanged, never re-implemented. All matchers are pure: callers
// fetch the candidate rows, the engine only decides.
//
// Contract (owner directive): a match NEVER silently merges. Every surface asks one
// simple question — "Existing match found. Link to existing?" — with the reason.

// Customers — the canonical matcher, re-exported (phone/email/address confident,
// name-only flagged not-confident).
export { findCustomerMatch, addressMatches, normalizeAddressKey }
export type { MatchInput, CustomerMatch }

// ── Properties ────────────────────────────────────────────────────────────────────
export interface PropertyLite {
  id: string
  address: string | null
  lat?: number | null
  lng?: number | null
  customer_id?: string | null
}
export type PropertyMatchReason = 'address' | 'coordinates' | 'customer-address'
export interface PropertyMatch { property: PropertyLite; reason: PropertyMatchReason; confident: boolean }

// Two coordinates within ~35 m are the same lot (GPS noise is ~5–15 m).
const SAME_LOT_KM = 0.035

export function findPropertyMatch(
  properties: PropertyLite[],
  probe: { address?: string | null; lat?: number | null; lng?: number | null; customerId?: string | null },
): PropertyMatch | null {
  // Same customer + same address = the strongest signal (this is what the
  // find-or-create flow already links on).
  if (probe.customerId && probe.address) {
    const own = properties.find(p => p.customer_id === probe.customerId && addressMatches(p.address, probe.address))
    if (own) return { property: own, reason: 'customer-address', confident: true }
  }
  if (probe.address && normalizeAddressKey(probe.address).length >= 5) {
    const byAddr = properties.find(p => addressMatches(p.address, probe.address))
    if (byAddr) return { property: byAddr, reason: 'address', confident: true }
  }
  if (probe.lat != null && probe.lng != null) {
    const here: Coord = { lat: probe.lat, lng: probe.lng }
    let best: PropertyLite | null = null
    let bestKm = SAME_LOT_KM
    for (const p of properties) {
      if (p.lat == null || p.lng == null) continue
      const km = haversineKm(here, { lat: p.lat, lng: p.lng })
      if (km <= bestKm) { best = p; bestKm = km }
    }
    // Coordinates alone say "same lot", not "same record" — confident enough to ask,
    // not to auto-link (a new build can share a lot with a demolished listing).
    if (best) return { property: best, reason: 'coordinates', confident: false }
  }
  return null
}

// ── Jobs ──────────────────────────────────────────────────────────────────────────
export interface JobLiteForMatch {
  id: string
  property_id: string | null
  scheduled_date: string | null   // YYYY-MM-DD
  service_type: string | null
  recurrence_id?: string | null
  status?: string | null
  title?: string | null
  start_time?: string | null
}
export type JobMatchReason = 'recurrence-visit' | 'property-day-service'
export interface JobMatch { job: JobLiteForMatch; reason: JobMatchReason; confident: boolean }

// A duplicate job = the same recurring series already has a visit that day, or the
// same property already has the SAME service (shared serviceKey normalizer — the
// same identity the labor + pricing learning use) on the same day.
export function findJobMatch(
  jobs: JobLiteForMatch[],
  probe: { propertyId?: string | null; date?: string | null; serviceType?: string | null; recurrenceId?: string | null; excludeJobId?: string | null },
): JobMatch | null {
  if (!probe.date) return null
  const candidates = jobs.filter(j =>
    j.id !== probe.excludeJobId &&
    j.scheduled_date === probe.date &&
    (j.status || '').toLowerCase() !== 'cancelled')

  if (probe.recurrenceId) {
    const sameVisit = candidates.find(j => j.recurrence_id && j.recurrence_id === probe.recurrenceId)
    if (sameVisit) return { job: sameVisit, reason: 'recurrence-visit', confident: true }
  }
  if (probe.propertyId && probe.serviceType) {
    const key = serviceKey(probe.serviceType)
    const same = candidates.find(j => j.property_id === probe.propertyId && serviceKey(j.service_type) === key)
    if (same) return { job: same, reason: 'property-day-service', confident: true }
  }
  return null
}

// ── Photos ────────────────────────────────────────────────────────────────────────
// Exact duplicate = same file signature (session) or same content hash (durable,
// when the content_hash column exists). Near duplicate = visual hash within a small
// hamming distance, or same capture timestamp on the same property.

export function fileSignature(f: File): string {
  return `${f.name}|${f.size}|${f.lastModified}`
}

// 8×8 average hash (aHash) → 16 hex chars. Cheap (one tiny canvas), robust to
// resizing/recompression — exactly what "did I already upload this shot" needs.
// Returns null wherever canvas/decode is unavailable; callers degrade gracefully.
export async function visualHash(file: File): Promise<string | null> {
  if (!file.type.startsWith('image/') || typeof document === 'undefined') return null
  try {
    const bitmap = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    canvas.width = 8; canvas.height = 8
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) { bitmap.close?.(); return null }
    ctx.drawImage(bitmap, 0, 0, 8, 8)
    bitmap.close?.()
    const { data } = ctx.getImageData(0, 0, 8, 8)
    const lum: number[] = []
    for (let i = 0; i < 64; i++) {
      const o = i * 4
      lum.push(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2])
    }
    const avg = lum.reduce((a, b) => a + b, 0) / 64
    let hex = ''
    for (let n = 0; n < 16; n++) {
      let nibble = 0
      for (let b = 0; b < 4; b++) if (lum[n * 4 + b] >= avg) nibble |= 1 << (3 - b)
      hex += nibble.toString(16)
    }
    return hex
  } catch {
    return null
  }
}

export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return 64
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = (parseInt(a[i], 16) ^ parseInt(b[i], 16))
    while (x) { d += x & 1; x >>= 1 }
  }
  return d
}

const NEAR_HASH_MAX_HAMMING = 5   // ≤5/64 bits differ → same shot, re-encoded/cropped
const SAME_SHOT_WINDOW_MS = 90_000 // same property, captured within ±90 s

export interface ExistingPhotoLite { id: string; taken_at: string | null; content_hash?: string | null }
export type PhotoMatchReason = 'exact-hash' | 'near-hash' | 'timestamp'
export interface PhotoMatch { photo: ExistingPhotoLite; reason: PhotoMatchReason; confident: boolean }

export function findPhotoMatch(
  existing: ExistingPhotoLite[],
  probe: { contentHash?: string | null; takenAtMs?: number | null; exactTime?: boolean },
): PhotoMatch | null {
  if (probe.contentHash) {
    const exact = existing.find(p => p.content_hash && p.content_hash === probe.contentHash)
    if (exact) return { photo: exact, reason: 'exact-hash', confident: true }
    const near = existing.find(p => p.content_hash && hammingHex(p.content_hash, probe.contentHash!) <= NEAR_HASH_MAX_HAMMING)
    if (near) return { photo: near, reason: 'near-hash', confident: true }
  }
  // Timestamp match only counts when the probe time came from EXIF (exact) — file
  // mtimes collide too easily to accuse a photo of being a duplicate.
  if (probe.takenAtMs && probe.exactTime) {
    const hit = existing.find(p => {
      const t = p.taken_at ? Date.parse(p.taken_at) : NaN
      return Number.isFinite(t) && Math.abs(t - probe.takenAtMs!) <= SAME_SHOT_WINDOW_MS
    })
    if (hit) return { photo: hit, reason: 'timestamp', confident: false }
  }
  return null
}

export const PHOTO_MATCH_LABEL: Record<PhotoMatchReason, string> = {
  'exact-hash': 'identical to an uploaded photo',
  'near-hash': 'nearly identical to an uploaded photo',
  timestamp: 'taken at the same moment as an uploaded photo',
}
