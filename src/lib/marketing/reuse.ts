import { channel as channelDef } from './channels'
import type { ContentPiece, MarketingChannel } from './types'

// ── Content reuse ─────────────────────────────────────────────────────────────────
// Spots posts worth getting more mileage out of and proposes the next move — all
// deterministic, all reusing the existing generate/rewrite paths to actually do the
// work. Three angles: (1) cross-post a job that's live on one platform but missing
// another; (2) make a shorter version for a punchier platform; (3) refresh an older
// post with a new caption; plus near-duplicate detection so the feed doesn't get stale.

export type ReuseKind = 'cross_post' | 'shorten' | 'fresh_caption' | 'similar'

export interface ReuseSuggestion {
  id: string
  kind: ReuseKind
  sourcePieceId: string
  jobId: string | null
  title: string
  detail: string
  targetChannel?: MarketingChannel  // for cross_post / shorten
}

// Channels worth making sure a strong job lands on.
const CROSS_TARGETS: MarketingChannel[] = ['gbp', 'instagram', 'facebook']
// Punchy short-form platforms to spin a long post into.
const SHORT_TARGETS: MarketingChannel[] = ['instagram', 'threads']

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/#[^\s#]+/g, ' ')                 // drop hashtags
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')          // drop punctuation + emoji
    .replace(/\s+/g, ' ')
    .trim()
}

function wordSet(text: string): Set<string> {
  return new Set(normalize(text).split(' ').filter(w => w.length > 2))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const w of a) if (b.has(w)) inter++
  return inter / (a.size + b.size - inter)
}

export function buildReuseSuggestions(pieces: ContentPiece[]): ReuseSuggestion[] {
  const out: ReuseSuggestion[] = []
  const active = pieces.filter(p => !p.archived_at)

  // (1) Cross-post: a job that's posted on one channel but missing strong others.
  const byJob = new Map<string, ContentPiece[]>()
  for (const p of active) {
    if (!p.job_id) continue
    const list = byJob.get(p.job_id) || []
    list.push(p)
    byJob.set(p.job_id, list)
  }
  for (const [jobId, group] of byJob) {
    const present = new Set(group.map(g => g.channel))
    if (present.size === 0) continue
    // anchor on the strongest existing post (prefer one with a real body)
    const anchor = group.find(g => g.body.trim().length > 40) || group[0]
    const missing = CROSS_TARGETS.find(t => !present.has(t))
    if (missing && present.size < 6) {
      out.push({
        id: `cross:${jobId}:${missing}`,
        kind: 'cross_post',
        sourcePieceId: anchor.id,
        jobId,
        title: `Turn this ${channelDef(anchor.channel).label} post into ${channelDef(missing).label}`,
        detail: 'This job already has a post — reach a different audience with one more, in seconds.',
        targetChannel: missing,
      })
    }
  }

  // (2) Shorten: a long post that would pop as a short Instagram/Threads version.
  for (const p of active) {
    const def = channelDef(p.channel)
    if (p.body.length > def.maxChars * 1.25 && !SHORT_TARGETS.includes(p.channel)) {
      const target = SHORT_TARGETS[0]
      out.push({
        id: `short:${p.id}`,
        kind: 'shorten',
        sourcePieceId: p.id,
        jobId: p.job_id,
        title: `Create a shorter ${channelDef(target).label} version`,
        detail: 'This post runs long. A tighter cut works better on short-form feeds.',
        targetChannel: target,
      })
    }
  }

  // (3) Fresh caption: a published post that could run again with a new angle.
  const now = Date.now()
  for (const p of active) {
    if (p.status !== 'published' || !p.published_at) continue
    const ageDays = Math.round((now - new Date(p.published_at).getTime()) / 86_400_000)
    if (ageDays >= 21) {
      out.push({
        id: `fresh:${p.id}`,
        kind: 'fresh_caption',
        sourcePieceId: p.id,
        jobId: p.job_id,
        title: 'Reuse this with a fresh caption',
        detail: `Posted ${ageDays} days ago. Regenerate a new take on the same job.`,
      })
    }
  }

  // (4) Near-duplicate detection (so suggestions don't all read the same).
  const sets = active.map(p => ({ p, w: wordSet(p.body) }))
  const flagged = new Set<string>()
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      if (sets[i].p.channel !== sets[j].p.channel) continue
      if (jaccard(sets[i].w, sets[j].w) >= 0.7) {
        const newer = new Date(sets[i].p.created_at) >= new Date(sets[j].p.created_at) ? sets[i].p : sets[j].p
        if (flagged.has(newer.id)) continue
        flagged.add(newer.id)
        out.push({
          id: `similar:${newer.id}`,
          kind: 'similar',
          sourcePieceId: newer.id,
          jobId: newer.job_id,
          title: 'This looks very similar to another post',
          detail: `Two ${channelDef(newer.channel).label} posts read alike. Rewrite one for variety.`,
          targetChannel: newer.channel,
        })
      }
    }
  }

  // Rank: cross-post first (highest value), then shorten, fresh, similar.
  const rank: Record<ReuseKind, number> = { cross_post: 0, shorten: 1, fresh_caption: 2, similar: 3 }
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]).slice(0, 12)
}
