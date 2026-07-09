import type { SupabaseClient } from '@supabase/supabase-js'
import { aiEnabled, generateStructured } from '@/lib/ai/studioGateway'
import { loadBrandVoice, upsertAsset, insertPiece } from '@/lib/marketing/data'
import { assembleIntelligence, intelligenceSubject } from '@/lib/marketing/intelligence'
import { buildPostInput, PROMPT_VERSION } from '@/lib/marketing/prompt'
import { buildGenerationContext, generateScoredDraft, joinDirectives } from '@/lib/marketing/generation'
import { listRecentPieces } from '@/lib/marketing/library'
import { channel as channelDef, topSuggestedChannels } from '@/lib/marketing/channels'
import { DEFAULT_POST_OPTIONS, type GeneratedDraft } from '@/lib/marketing/types'

// ── Automatic marketing draft (reuses the ONE generation engine — never publishes) ──
// When a COMPLETED job has valid before+after photos, prepare a marketing DRAFT: the
// strongest pair (from the shared candidate), captions + hashtags for the suggested
// platforms (the same job→channel draft path the Studio uses), and a "draft ready"
// notification. Idempotent (skips a job that already has content_pieces), disabled-
// safe (no ANTHROPIC key → still saves the pair asset + notifies, generates nothing),
// and works with EITHER a user-session client (route) OR a service-role client (cron).
// This adds NO new prompt/gateway/insert and NEVER touches the publish path.

export type AutoDraftResult =
  | { status: 'created'; channels: string[]; count: number }
  | { status: 'shell'; channels: string[] }          // pair saved + notified; AI off, no captions
  | { status: 'skipped'; reason: 'not-completed' | 'not-found' | 'no-pair' | 'exists' }

export async function prepareAutoDraft(
  supabase: SupabaseClient,
  userId: string,
  jobId: string,
  opts?: { force?: boolean },
): Promise<AutoDraftResult> {
  // Gate: the job must be completed and owned by this user.
  const { data: jobRow } = await supabase.from('jobs').select('status').eq('id', jobId).eq('user_id', userId).maybeSingle()
  if (!jobRow || (jobRow as { status: string }).status !== 'completed') return { status: 'skipped', reason: 'not-completed' }

  // Idempotency: never re-draft a job that already has content pieces (unless forced).
  if (!opts?.force) {
    const { data: existing } = await supabase.from('content_pieces').select('id').eq('user_id', userId).eq('job_id', jobId).limit(1)
    if (existing && existing.length) return { status: 'skipped', reason: 'exists' }
  }

  const intel = await assembleIntelligence(supabase, userId, jobId)
  if (!intel) return { status: 'skipped', reason: 'not-found' }
  const candidate = intel.candidate
  // Valid before+after is the strongest, most honest signal (same rule as buildPairs).
  if (!candidate.hasBefore || !candidate.hasAfter) return { status: 'skipped', reason: 'no-pair' }

  const suggested = topSuggestedChannels({
    hasBefore: candidate.hasBefore, hasAfter: candidate.hasAfter, hasReview: candidate.hasReview,
    neighborhood: candidate.neighborhood, serviceType: candidate.serviceType,
  }, 3)

  // Always persist the chosen pair as the asset anchor (idempotent on user_id,job_id).
  const assetId = await upsertAsset(supabase, userId, candidate)

  let count = 0
  if (aiEnabled()) {
    const [voice, recent] = await Promise.all([loadBrandVoice(supabase, userId), listRecentPieces(supabase, userId, 8)])
    const subject = intelligenceSubject(intel, voice)
    for (let i = 0; i < suggested.length; i++) {
      const def = channelDef(suggested[i])
      const { extras, ctaIntent, scoreCtx } = buildGenerationContext({
        channel: def.key, options: DEFAULT_POST_OPTIONS, recent,
        neighborhood: candidate.neighborhood, city: candidate.city,
        hasReview: candidate.hasReview, recurring: intel.recurring, seasonStart: intel.seasonStart,
        ctaOffset: i,
      })
      const run = (extra: string | null) => generateStructured<GeneratedDraft>(
        buildPostInput(subject, def.key, voice, DEFAULT_POST_OPTIONS, joinDirectives(null, extra), extras),
      )
      const out = await generateScoredDraft(run, scoreCtx)
      if (!out.ok) continue
      const { draft, score, regenerated, note } = out.result
      const piece = await insertPiece(supabase, userId, candidate, def.key, assetId, {
        title: draft.title ?? null,
        body: draft.body ?? '',
        hashtags: Array.isArray(draft.hashtags) ? draft.hashtags : [],
        model: out.result.model,
        promptVersion: PROMPT_VERSION,
        meta: { options: DEFAULT_POST_OPTIONS, style: DEFAULT_POST_OPTIONS.style, ctaIntent, quality: score, qualityNote: note, regenerated, auto: true },
      })
      if (piece) count++
    }
  }

  await notifyDraftReady(supabase, userId, jobId, candidate.customerId, candidate.customerName, count)
  return count > 0 ? { status: 'created', channels: suggested, count } : { status: 'shell', channels: suggested }
}

// Insert a "draft ready" notification, matching existing rows + dedupe-first so
// re-runs don't spam the bell. Deep-links into the Studio for that job.
async function notifyDraftReady(
  supabase: SupabaseClient, userId: string, jobId: string, customerId: string | null, customerName: string | null, count: number,
): Promise<void> {
  try {
    const { data: dup } = await supabase.from('notifications').select('id')
      .eq('user_id', userId).eq('type', 'marketing_draft_ready').eq('entity_id', jobId).limit(1)
    if (dup && dup.length) return
    const who = customerName?.trim() || 'a recent job'
    const body = count > 0
      ? `${count} post${count !== 1 ? 's' : ''} drafted for ${who} — tap to review & post.`
      : `Before/after photos ready for ${who} — tap to write posts.`
    await supabase.from('notifications').insert({
      user_id: userId, type: 'marketing_draft_ready', title: 'Marketing posts ready', body,
      customer_id: customerId, entity_type: 'job', entity_id: jobId,
      href: `/dashboard/grow/studio?job=${jobId}`,
    })
  } catch { /* notifications are best-effort; never block draft creation */ }
}
