import { parseLocalDate } from '@/lib/utils'
import type { MarketingCandidate, Season } from './types'

// ── Deterministic asset scoring ─────────────────────────────────────────────────
// Ranks completed jobs for "how good a marketing post would this make" WITHOUT any
// AI — cheap, instant, explainable, and the same every time. Vision-based photo
// quality scoring is a later upgrade; today the signals are structural: do we have
// a before AND after, how recent, is there a review, do we know the neighborhood.
// The output also carries a plain-English rationale ("why post this") the Coach and
// Studio surface verbatim.

export interface ScoreJob {
  id: string
  service_type: string | null
  scheduled_date: string | null
  completed_at: string | null
}
export interface ScoreCustomer {
  id: string
  name: string | null
  reviewed_at: string | null
  photo_marketing_consent: boolean
}
export interface ScoreProperty {
  id: string
  neighborhood: string | null
  city: string | null
  lawn_sqft: number | null
}
export interface ScorePhoto {
  id: string
  kind: 'before' | 'after' | 'general'
  url: string
}

export function seasonOf(dateISO: string | null): Season | null {
  if (!dateISO) return null
  const m = parseLocalDate(dateISO).getMonth() // 0-11
  if (m <= 1 || m === 11) return 'winter'
  if (m <= 4) return 'spring'
  if (m <= 7) return 'summer'
  return 'fall'
}

function daysSince(dateISO: string | null): number | null {
  if (!dateISO) return null
  const ms = Date.now() - parseLocalDate(dateISO).getTime()
  return Math.floor(ms / 86_400_000)
}

// Newest-first photos are assumed (the catalogue orders by taken_at desc), so the
// first of each kind is the "strongest" we can pick without image analysis.
function pick(photos: ScorePhoto[], kind: 'before' | 'after'): ScorePhoto | null {
  return photos.find(p => p.kind === kind) || null
}

export function scoreCandidate(input: {
  job: ScoreJob
  customer: ScoreCustomer | null
  property: ScoreProperty | null
  photos: ScorePhoto[]
}): MarketingCandidate {
  const { job, customer, property, photos } = input
  const before = pick(photos, 'before')
  const after = pick(photos, 'after')
  const anyPhoto = photos[0] || null
  const hasBefore = !!before
  const hasAfter = !!after
  const hasReview = !!customer?.reviewed_at
  const neighborhood = property?.neighborhood || null
  const date = job.completed_at || job.scheduled_date
  const recency = daysSince(date)

  // ── Score ──
  let score = 30
  if (hasBefore && hasAfter) score += 28
  else if (hasAfter) score += 12
  else if (anyPhoto) score += 6
  if (hasReview) score += 12
  if (neighborhood) score += 8
  if (recency != null) {
    if (recency <= 14) score += 14
    else if (recency <= 45) score += 8
    else if (recency <= 120) score += 3
  }
  if (job.service_type) score += 4
  score = Math.max(0, Math.min(100, score))

  // ── Rationale (plain English, deterministic) ──
  const svc = job.service_type ? job.service_type.toLowerCase() : 'job'
  const where = neighborhood ? ` in ${neighborhood}` : ''
  let rationale: string
  if (hasBefore && hasAfter) {
    rationale = `This ${svc}${where} has a before & after — the kind of transformation that performs best${hasReview ? ', and the customer already left a review' : ''}.`
  } else if (hasAfter) {
    rationale = `A clean finished ${svc}${where}${hasReview ? ' from a reviewed customer' : ''} — solid proof-of-work for a quick post.`
  } else if (anyPhoto) {
    rationale = `A recent ${svc}${where} with a photo${hasReview ? ' and a happy customer' : ''} — worth a short post.`
  } else {
    rationale = `A recent ${svc}${where}. Add a photo to make it post-ready.`
  }

  return {
    jobId: job.id,
    customerId: customer?.id ?? null,
    propertyId: property?.id ?? null,
    customerName: customer?.name ?? null,
    serviceType: job.service_type,
    neighborhood,
    city: property?.city ?? null,
    lawnSqft: property?.lawn_sqft ?? null,
    date,
    season: seasonOf(date),
    score,
    hasBefore,
    hasAfter,
    hasReview,
    photoConsent: !!customer?.photo_marketing_consent,
    bestBeforePhotoId: before?.id ?? null,
    bestAfterPhotoId: after?.id ?? null,
    bestBeforeUrl: before?.url ?? null,
    bestAfterUrl: after?.url ?? null,
    rationale,
  }
}
