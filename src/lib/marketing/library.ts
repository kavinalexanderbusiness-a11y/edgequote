import type { SupabaseClient } from '@supabase/supabase-js'
import type { ContentPiece, ContentStatus, MarketingCampaign, PostFilters } from './types'

// ── Content library / post management ─────────────────────────────────────────────
// Every read/write the "post manager" + calendar + campaign views need against
// content_pieces and marketing_campaigns. Works with ANY Supabase client (browser on
// the management pages, server in routes), so the query logic lives in one place and
// stays RLS-scoped to the owner. No AI here — pure data.

export const POSTS_PAGE = 24

// Paginated, filtered, searchable history. Returns one extra row internally to know
// if there's more (infinite scroll). Active (non-archived) unless filters.archived.
export async function listPieces(
  supabase: SupabaseClient,
  userId: string,
  filters: PostFilters,
  offset = 0,
): Promise<{ pieces: ContentPiece[]; hasMore: boolean }> {
  let q = supabase.from('content_pieces').select('*').eq('user_id', userId)

  if (filters.archived) q = q.not('archived_at', 'is', null)
  else q = q.is('archived_at', null)

  if (filters.status) q = q.eq('status', filters.status)
  if (filters.channel) q = q.eq('channel', filters.channel)
  if (filters.campaignId) q = q.eq('campaign_id', filters.campaignId)
  if (filters.season) q = q.eq('season', filters.season)
  if (filters.favorite) q = q.eq('favorite', true)
  const needle = filters.search?.trim()
  if (needle) q = q.or(`body.ilike.%${needle}%,title.ilike.%${needle}%`)

  q = q.order('created_at', { ascending: false }).range(offset, offset + POSTS_PAGE)
  const { data } = await q
  const rows = (data as ContentPiece[] | null) || []
  const hasMore = rows.length > POSTS_PAGE
  return { pieces: hasMore ? rows.slice(0, POSTS_PAGE) : rows, hasMore }
}

// Posts that fall in a calendar window: scheduled (or failed) by scheduled_for, OR
// published by published_at. Bounded by the visible range.
export async function listScheduledRange(
  supabase: SupabaseClient,
  userId: string,
  fromISO: string,
  toISO: string,
): Promise<ContentPiece[]> {
  const { data } = await supabase
    .from('content_pieces')
    .select('*')
    .eq('user_id', userId)
    .is('archived_at', null)
    .or(`and(scheduled_for.gte.${fromISO},scheduled_for.lte.${toISO}),and(published_at.gte.${fromISO},published_at.lte.${toISO})`)
    .order('scheduled_for', { ascending: true })
  return (data as ContentPiece[] | null) || []
}

// Unscheduled drafts — the calendar's "to schedule" tray.
export async function listUnscheduledDrafts(
  supabase: SupabaseClient,
  userId: string,
  limit = 60,
): Promise<ContentPiece[]> {
  const { data } = await supabase
    .from('content_pieces')
    .select('*')
    .eq('user_id', userId)
    .is('archived_at', null)
    .is('scheduled_for', null)
    .in('status', ['draft', 'approved'])
    .order('created_at', { ascending: false })
    .limit(limit)
  return (data as ContentPiece[] | null) || []
}

// A broad recent slice for reuse/similarity detection.
export async function listRecentPieces(
  supabase: SupabaseClient,
  userId: string,
  limit = 300,
): Promise<ContentPiece[]> {
  const { data } = await supabase
    .from('content_pieces')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)
  return (data as ContentPiece[] | null) || []
}

async function patch(supabase: SupabaseClient, id: string, p: Record<string, unknown>): Promise<ContentPiece | null> {
  const { data } = await supabase.from('content_pieces').update(p).eq('id', id).select('*').maybeSingle()
  return (data as ContentPiece | null) ?? null
}

// Schedule (or move) a post onto a day. Passing null clears the schedule → draft.
export async function setSchedule(supabase: SupabaseClient, id: string, scheduledForISO: string | null): Promise<ContentPiece | null> {
  return patch(supabase, id, scheduledForISO
    ? { scheduled_for: scheduledForISO, status: 'scheduled' }
    : { scheduled_for: null, status: 'draft' })
}

export async function setStatus(supabase: SupabaseClient, id: string, status: ContentStatus, extra?: Record<string, unknown>): Promise<ContentPiece | null> {
  return patch(supabase, id, { status, ...extra })
}

export async function markPublished(supabase: SupabaseClient, id: string): Promise<ContentPiece | null> {
  return patch(supabase, id, { status: 'published', published_at: new Date().toISOString() })
}

export async function toggleFavorite(supabase: SupabaseClient, id: string, favorite: boolean): Promise<ContentPiece | null> {
  return patch(supabase, id, { favorite })
}

export async function setArchived(supabase: SupabaseClient, id: string, archived: boolean): Promise<ContentPiece | null> {
  return patch(supabase, id, { archived_at: archived ? new Date().toISOString() : null })
}

// Duplicate a post into a fresh editable draft (no schedule, not published/favorite).
export async function duplicatePiece(supabase: SupabaseClient, userId: string, id: string): Promise<ContentPiece | null> {
  const { data: src } = await supabase.from('content_pieces').select('*').eq('id', id).maybeSingle()
  const s = src as ContentPiece | null
  if (!s) return null
  const { data } = await supabase.from('content_pieces').insert({
    user_id: userId,
    asset_id: s.asset_id,
    job_id: s.job_id,
    customer_id: s.customer_id,
    campaign_id: s.campaign_id,
    channel: s.channel,
    kind: s.kind,
    title: s.title,
    body: s.body,
    hashtags: s.hashtags,
    season: s.season,
    status: 'draft',
    model: s.model,
    prompt_version: s.prompt_version,
    variant_label: s.variant_label ? `${s.variant_label} (copy)` : 'copy',
    meta: { ...(s.meta || {}), duplicated_from: s.id },
  }).select('*').single()
  return (data as ContentPiece | null) ?? null
}

// ── Campaigns ──
export async function listCampaigns(supabase: SupabaseClient, userId: string, includeArchived = false): Promise<MarketingCampaign[]> {
  let q = supabase.from('marketing_campaigns').select('*').eq('user_id', userId)
  if (!includeArchived) q = q.is('archived_at', null)
  const { data } = await q.order('created_at', { ascending: false })
  return (data as MarketingCampaign[] | null) || []
}

export async function getCampaign(supabase: SupabaseClient, userId: string, id: string): Promise<MarketingCampaign | null> {
  const { data } = await supabase.from('marketing_campaigns').select('*').eq('user_id', userId).eq('id', id).maybeSingle()
  return (data as MarketingCampaign | null) ?? null
}

export async function archiveCampaign(supabase: SupabaseClient, id: string, archived: boolean): Promise<void> {
  await supabase.from('marketing_campaigns').update({
    archived_at: archived ? new Date().toISOString() : null,
    status: archived ? 'archived' : 'active',
  }).eq('id', id)
}
