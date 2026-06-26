import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { aiEnabled, generateStructured } from '@/lib/ai/studioGateway'
import { assembleCandidate, listCandidates, loadBrandVoice, upsertAsset, insertPiece, type PieceAnchor } from '@/lib/marketing/data'
import { buildPostInput, subjectFromCandidate, type PromptExtras, PROMPT_VERSION } from '@/lib/marketing/prompt'
import { campaignDef, campaignDirective, campaignSubject, isCampaignKind } from '@/lib/marketing/campaigns'
import { buildAvoidance } from '@/lib/marketing/memory'
import { generateScoredDraft, joinDirectives } from '@/lib/marketing/generation'
import type { ScoreContext } from '@/lib/marketing/quality'
import { isChannel } from '@/lib/marketing/channels'
import { listRecentPieces, setSchedule } from '@/lib/marketing/library'
import { normalizePostOptions, type ContentPiece, type GeneratedDraft, type CampaignGenerateResponse, type MarketingCampaign, type MarketingChannel } from '@/lib/marketing/types'

export const maxDuration = 90

// One campaign → one post per selected channel. The campaign's angle (directive) +
// subject (a real anchor job when one fits, else a themed subject) feed the SAME
// prompt framework as everything else. Optionally spreads the posts across the
// calendar. Each channel fails independently.
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, aiEnabled: aiEnabled(), pieces: [], errors: [] } satisfies CampaignGenerateResponse, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const kind = body.kind
  if (!isCampaignKind(kind)) {
    return NextResponse.json({ ok: false, aiEnabled: aiEnabled(), pieces: [], errors: [] } satisfies CampaignGenerateResponse, { status: 400 })
  }
  if (!aiEnabled()) {
    return NextResponse.json({ ok: false, aiEnabled: false, pieces: [], errors: [] } satisfies CampaignGenerateResponse)
  }

  const def = campaignDef(kind)
  const options = normalizePostOptions(body.options)
  const holiday: string | null = typeof body.holiday === 'string' ? body.holiday : null
  const reqChannels = Array.isArray(body.channels) ? (body.channels as unknown[]).filter(isChannel) as MarketingChannel[] : []
  const channels = reqChannels.length ? reqChannels : def.defaultChannels
  const scheduleFrom: string | null = typeof body.scheduleFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.scheduleFrom) ? body.scheduleFrom : null
  const everyDays = Math.max(1, Math.min(14, Number(body.scheduleEveryDays) || 2))

  const voice = await loadBrandVoice(supabase, user.id)

  // Pick an anchor job: the explicit one, else (for non-themed kinds) the best recent
  // candidate, preferring one whose season matches the campaign.
  let candidate = body.jobId ? await assembleCandidate(supabase, user.id, String(body.jobId)) : null
  if (!candidate && def.anchorMode !== 'themed') {
    const pool = await listCandidates(supabase, user.id)
    candidate = (def.season ? pool.find(c => c.season === def.season) : null) || pool[0] || null
  }

  const subject = candidate ? subjectFromCandidate(candidate) : campaignSubject(kind, voice, { holiday, season: def.season })
  const directive = campaignDirective(kind, voice, { holiday })
  const anchor: PieceAnchor = candidate ?? { jobId: null, customerId: null, date: null }
  const assetId = candidate ? await upsertAsset(supabase, user.id, candidate) : null
  const recent = await listRecentPieces(supabase, user.id, 8)

  // Create the campaign record up front so every post links back to it.
  const { data: campRow } = await supabase.from('marketing_campaigns').insert({
    user_id: user.id,
    name: (typeof body.name === 'string' && body.name.trim()) || def.defaultName,
    kind,
    status: 'active',
    description: def.description,
    season: def.season,
    channels,
    starts_on: scheduleFrom,
    meta: { holiday, anchorJobId: candidate?.jobId ?? null },
  }).select('*').single()
  const campaign = campRow as MarketingCampaign | null
  if (!campaign) {
    return NextResponse.json({ ok: false, aiEnabled: true, pieces: [], errors: [{ channel: channels[0], error: 'could not create campaign' }] } satisfies CampaignGenerateResponse, { status: 500 })
  }

  type Outcome = { piece: ContentPiece } | { channel: MarketingChannel; error: string }
  const results = await Promise.all(channels.map(async (ch, i): Promise<Outcome> => {
    // The campaign directive already drives the CTA (review/referral/etc.), so we leave
    // ctaIntent null and let the directive lead — but still apply style + anti-repetition.
    const extras: PromptExtras = { style: options.style, ctaIntent: null, avoidance: buildAvoidance(recent, ch) }
    const scoreCtx: ScoreContext = {
      channel: ch,
      neighborhood: candidate?.neighborhood ?? null,
      city: candidate?.city ?? voice.city,
      recentBodies: recent.map(r => r.body),
      emojisRequested: options.emojis,
    }
    const run = (extra: string | null) => generateStructured<GeneratedDraft>(
      buildPostInput(subject, ch, voice, options, joinDirectives(directive, extra), extras),
    )
    const out = await generateScoredDraft(run, scoreCtx)
    if (!out.ok) return { channel: ch, error: out.error }
    const { draft, score, regenerated, note } = out.result
    let piece = await insertPiece(supabase, user.id, anchor, ch, assetId, {
      title: draft.title ?? null,
      body: draft.body ?? '',
      hashtags: Array.isArray(draft.hashtags) ? draft.hashtags : [],
      model: out.result.model,
      promptVersion: PROMPT_VERSION,
      season: def.season ?? candidate?.season ?? null,
      campaignId: campaign.id,
      meta: { options, style: options.style, campaignKind: kind, quality: score, qualityNote: note, regenerated },
    })
    if (!piece) return { channel: ch, error: 'could not save draft' }
    if (scheduleFrom) {
      const scheduled = await setSchedule(supabase, piece.id, `${addDays(scheduleFrom, i * everyDays)}T09:00:00.000Z`)
      if (scheduled) piece = scheduled
    }
    return { piece }
  }))

  const pieces = results.flatMap(r => ('piece' in r ? [r.piece] : []))
  const errors = results.flatMap(r => ('error' in r ? [{ channel: r.channel, error: r.error }] : []))

  // Nothing generated → don't leave an empty campaign behind (keeps the campaign
  // count equal to the number of campaigns that actually produced posts). The client
  // shows a real error built from `errors`, not a misleading "campaign created".
  if (pieces.length === 0) {
    await supabase.from('marketing_campaigns').delete().eq('id', campaign.id)
    return NextResponse.json({ ok: false, aiEnabled: true, pieces: [], errors } satisfies CampaignGenerateResponse)
  }

  return NextResponse.json({ ok: true, aiEnabled: true, campaign, pieces, errors } satisfies CampaignGenerateResponse)
}
