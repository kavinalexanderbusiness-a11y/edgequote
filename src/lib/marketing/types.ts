// ── Marketing Studio — shared types ─────────────────────────────────────────────
// One vocabulary shared by the scorer, the AI gateway, the API route and the UI.

export type MarketingChannel = 'facebook' | 'instagram' | 'threads' | 'gbp' | 'nextdoor' | 'linkedin'

export type Season = 'spring' | 'summer' | 'fall' | 'winter'

export type ContentStatus = 'draft' | 'approved' | 'published' | 'scheduled' | 'failed'

// ── Creative controls ────────────────────────────────────────────────────────────
// Per-generation knobs the owner sets in the Studio. Shared by every channel AND by
// "Generate all platforms", and fed into the ONE prompt framework as modifiers — so
// there's a single place that turns these into instructions (lib/marketing/prompt).
export type PostLength = 'short' | 'medium' | 'long'

export interface PostOptions {
  length: PostLength
  emojis: boolean
  hashtags: boolean   // only takes effect where the channel itself supports hashtags
  cta: boolean        // end with a call to action
  seasonal: boolean   // lean into the job's season
  local: boolean      // sound like a local neighbour (neighbourhood + city/climate)
}

export const DEFAULT_POST_OPTIONS: PostOptions = {
  length: 'medium',
  emojis: true,
  hashtags: true,
  cta: true,
  seasonal: true,
  local: true,
}

// Tolerant coercion of an untrusted request body into PostOptions (routes call this
// so a malformed payload can never break generation — it just falls back to defaults).
export function normalizePostOptions(raw: unknown): PostOptions {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const length: PostLength = o.length === 'short' || o.length === 'long' ? o.length : 'medium'
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  return {
    length,
    emojis: bool(o.emojis, DEFAULT_POST_OPTIONS.emojis),
    hashtags: bool(o.hashtags, DEFAULT_POST_OPTIONS.hashtags),
    cta: bool(o.cta, DEFAULT_POST_OPTIONS.cta),
    seasonal: bool(o.seasonal, DEFAULT_POST_OPTIONS.seasonal),
    local: bool(o.local, DEFAULT_POST_OPTIONS.local),
  }
}

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
  // ── manager columns (RUN-2026-06-25h) ──
  campaign_id: string | null
  season: Season | null
  favorite: boolean
  archived_at: string | null
  meta: Record<string, unknown>
}

// ── Campaigns ─────────────────────────────────────────────────────────────────────
// A saved theme that fans out into many posts. Mirrors public.marketing_campaigns.
export type CampaignKind =
  | 'spring' | 'summer' | 'fall' | 'winter'
  | 'holiday' | 'rain_delay' | 'referral' | 'review' | 'winback' | 'custom'

export type CampaignStatus = 'draft' | 'active' | 'completed' | 'archived'

export interface MarketingCampaign {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  name: string
  kind: CampaignKind
  status: CampaignStatus
  description: string | null
  season: Season | null
  channels: MarketingChannel[]
  starts_on: string | null
  ends_on: string | null
  meta: Record<string, unknown>
  archived_at: string | null
}

// ── AI rewrite tools ────────────────────────────────────────────────────────────────
// One-click transforms of an existing post. Each is just a one-line modifier fed into
// the SAME gateway (see REWRITE_ACTIONS in prompt.ts) — never a forked prompt.
export type RewriteAction =
  | 'shorter' | 'longer' | 'professional' | 'friendly' | 'exciting' | 'premium'
  | 'local' | 'humorous' | 'seo' | 'remove_emojis' | 'add_emojis' | 'stronger_cta'

// The editable text of a post, passed to the rewrite route (stateless transform).
export interface PostText {
  title?: string | null
  body: string
  hashtags: string[]
}

// What the model returns for one channel (forced via a strict tool schema).
export interface GeneratedDraft {
  title?: string
  body: string
  hashtags: string[]
}

// POST /api/marketing/generate  (and /generate/stream)
export interface GenerateRequest {
  jobId: string
  channel: MarketingChannel
  options?: PostOptions
}
export interface GenerateResponse {
  ok: boolean
  aiEnabled: boolean
  piece?: ContentPiece
  error?: string
}

// POST /api/marketing/generate/all — one click, every platform.
export interface GenerateAllRequest {
  jobId: string
  options?: PostOptions
}
export interface GenerateAllResponse {
  ok: boolean
  aiEnabled: boolean
  pieces: ContentPiece[]
  errors: { channel: MarketingChannel; error: string }[]
}

// POST /api/marketing/rewrite — one-click transform of existing text.
export interface RewriteRequest {
  channel: MarketingChannel
  action: RewriteAction
  text: PostText
}
export interface RewriteResponse {
  ok: boolean
  aiEnabled: boolean
  text?: PostText
  error?: string
}

// POST /api/marketing/campaign/generate — one campaign → many posts.
export interface CampaignGenerateRequest {
  kind: CampaignKind
  name?: string
  channels?: MarketingChannel[]
  options?: PostOptions
  jobId?: string | null        // optional anchor job for a seasonal/before-after post
  holiday?: string | null      // for holiday campaigns
  scheduleFrom?: string | null // ISO date — spread the posts starting here (optional)
  scheduleEveryDays?: number   // spacing when scheduling (default 2)
}
export interface CampaignGenerateResponse {
  ok: boolean
  aiEnabled: boolean
  campaign?: MarketingCampaign
  pieces: ContentPiece[]
  errors: { channel: MarketingChannel; error: string }[]
}

// POST /api/marketing/queue — generate (and schedule) a batch of varied posts.
export interface QueueRequest {
  count: number                // how many posts to generate (capped server-side)
  channels?: MarketingChannel[]
  startDate?: string | null    // ISO date to begin scheduling from
  everyDays?: number           // spacing between scheduled posts (default 2)
  options?: PostOptions
}
export interface QueueResponse {
  ok: boolean
  aiEnabled: boolean
  pieces: ContentPiece[]
  errors: string[]
  skipped?: string | null      // honest note when fewer than requested were possible
}

// Library / post-management filters.
export interface PostFilters {
  search?: string
  channel?: MarketingChannel | null
  campaignId?: string | null
  season?: Season | null
  status?: ContentStatus | null
  favorite?: boolean
  archived?: boolean           // when true, show archived only; default shows active only
}
