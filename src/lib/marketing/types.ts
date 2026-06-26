// ── Marketing Studio — shared types ─────────────────────────────────────────────
// One vocabulary shared by the scorer, the AI gateway, the API route and the UI.

export type MarketingChannel = 'facebook' | 'instagram' | 'gbp' | 'nextdoor' | 'linkedin'

export type Season = 'spring' | 'summer' | 'fall' | 'winter'

export type ContentStatus = 'draft' | 'approved' | 'published' | 'scheduled'

// A postable job, scored live from jobs + job_photos + property + customer.
// Computed by lib/marketing/score.ts — NOT persisted until the owner acts.
export interface MarketingCandidate {
  jobId: string
  customerId: string | null
  propertyId: string | null
  customerName: string | null
  serviceType: string | null
  neighborhood: string | null
  city: string | null
  lawnSqft: number | null
  date: string | null            // completed_at or scheduled_date (ISO / yyyy-mm-dd)
  season: Season | null
  score: number                  // deterministic 0-100
  hasBefore: boolean
  hasAfter: boolean
  hasReview: boolean             // customer left a review (social proof)
  photoConsent: boolean          // may a customer photo be used publicly?
  bestBeforePhotoId: string | null
  bestAfterPhotoId: string | null
  bestBeforeUrl: string | null
  bestAfterUrl: string | null
  rationale: string              // "why this is worth posting" (deterministic)
}

// A generated draft row (mirrors public.content_pieces).
export interface ContentPiece {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  asset_id: string | null
  job_id: string | null
  customer_id: string | null
  channel: MarketingChannel
  kind: 'organic' | 'ad' | 'print'
  title: string | null
  body: string
  hashtags: string[]
  variant_label: string | null
  status: ContentStatus
  model: string | null
  prompt_version: string | null
  scheduled_for: string | null
  published_at: string | null
  external_ref: string | null
  meta: Record<string, unknown>
}

// What the model returns for one channel (forced via a strict tool schema).
export interface GeneratedDraft {
  title?: string
  body: string
  hashtags: string[]
}

// POST /api/marketing/generate
export interface GenerateRequest {
  jobId: string
  channel: MarketingChannel
}
export interface GenerateResponse {
  ok: boolean
  aiEnabled: boolean
  piece?: ContentPiece
  error?: string
}
