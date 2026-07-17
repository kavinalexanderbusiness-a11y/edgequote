'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { AssistButton } from '@/components/ai/ui'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { channel as channelDef } from '@/lib/marketing/channels'
import { buildReuseSuggestions, type ReuseSuggestion } from '@/lib/marketing/reuse'
import { toast } from '@/lib/toast'
import { Lightbulb, ArrowRight, Star, CalendarClock, PartyPopper, CloudRain, Repeat2, Sparkles, Scissors, RefreshCw, Copy as CopyIcon, Check } from 'lucide-react'
import type { ContentPiece } from '@/lib/marketing/types'
import type { MarketingIdea, IdeaKind } from '@/lib/marketing/ideas'

// Icon per suggestion kind (kept in the UI so the engine stays pure data).
const IDEA_ICON: Record<IdeaKind, typeof Lightbulb> = {
  new_reviews: Star, post_job: Sparkles, inactive: CalendarClock, season_start: Repeat2,
  holiday: PartyPopper, slow_week: CalendarClock, weather: CloudRain, ready_backlog: Lightbulb,
}
const REUSE_ICON = { cross_post: Repeat2, shorten: Scissors, fresh_caption: RefreshCw, similar: CopyIcon }

export function IdeasClient({ ideas, pieces }: { ideas: MarketingIdea[]; pieces: ContentPiece[] }) {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const reuse = useMemo(() => buildReuseSuggestions(pieces), [pieces])
  const byId = useMemo(() => new Map(pieces.map(p => [p.id, p])), [pieces])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [done, setDone] = useState<Set<string>>(new Set())

  // Cross-post / shorten reuse a job's candidate through the existing generate route.
  async function actOnReuse(s: ReuseSuggestion) {
    const src = byId.get(s.sourcePieceId)
    if (!src) return
    if ((s.kind === 'cross_post' || s.kind === 'shorten') && s.targetChannel) {
      if (done.has(s.id) || busyId === s.id) return // don't create duplicates
      if (!src.job_id) { toast.error('This post isn’t linked to a job, so it can’t be reused automatically. Open it in Posts to duplicate it.'); return }
      setBusyId(s.id)
      try {
        const res = await fetch('/api/marketing/generate', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jobId: src.job_id, channel: s.targetChannel, options: s.kind === 'shorten' ? { length: 'short' } : undefined }),
        })
        const j = await res.json()
        if (j?.ok && j.piece) { setDone(prev => new Set(prev).add(s.id)); toast.success(`Created a ${channelDef(s.targetChannel).label} version — find it in Posts.`) }
        else toast.error(j?.error || 'Could not create that post.')
      } catch { toast.error('Could not reach the generator.') }
      finally { setBusyId(null) }
    } else {
      // fresh caption / similar → open the job in the composer to regenerate
      if (src.job_id) router.push(`/dashboard/grow/studio?job=${src.job_id}`)
      else router.push('/dashboard/grow/posts')
    }
  }

  return (
    <div className="space-y-5">
      {/* Suggestions */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-2 inline-flex items-center gap-1.5"><Lightbulb className="w-3.5 h-3.5 text-accent-text" /> Suggestions for you</p>
        {ideas.length === 0 ? (
          <EmptyState icon={Lightbulb} title="You’re all caught up" description="Finish a job, collect a review, or wait for the next season — fresh ideas will show up here." />
        ) : (
          <div className="grid sm:grid-cols-2 gap-2">
            {ideas.map(idea => {
              const Icon = IDEA_ICON[idea.kind] || Lightbulb
              return (
                <Card key={idea.id} className="p-3 flex flex-col gap-2">
                  <div className="flex items-start gap-2">
                    <span className="w-7 h-7 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0"><Icon className="w-3.5 h-3.5 text-accent-text" /></span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink">{idea.title}</p>
                      <p className="text-xs text-ink-muted leading-snug">{idea.detail}</p>
                    </div>
                  </div>
                  <Link href={idea.href} className="group self-start text-xs font-semibold text-accent-text inline-flex items-center gap-1 hover:underline">
                    {idea.actionLabel} <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* Content reuse */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-2 inline-flex items-center gap-1.5"><Repeat2 className="w-3.5 h-3.5 text-accent-text" /> Get more from what you’ve made</p>
        {reuse.length === 0 ? (
          <EmptyState icon={Repeat2} title="Nothing to reuse yet" description="Once you’ve published a few posts, you’ll get one-tap ways to repurpose them across platforms." />
        ) : (
          <div className="grid sm:grid-cols-2 gap-2">
            {reuse.map(s => {
              const Icon = REUSE_ICON[s.kind] || Repeat2
              const src = byId.get(s.sourcePieceId)
              return (
                <Card key={s.id} className="p-3 flex flex-col gap-2">
                  <div className="flex items-start gap-2">
                    <span className="w-7 h-7 rounded-lg bg-surface border border-border flex items-center justify-center shrink-0"><Icon className="w-3.5 h-3.5 text-ink-muted" /></span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink">{s.title}</p>
                      <p className="text-xs text-ink-muted leading-snug">{s.detail}</p>
                      {src && <p className="text-[10px] text-ink-faint mt-1 line-clamp-1">“{src.body.slice(0, 70)}…”</p>}
                    </div>
                  </div>
                  {s.kind === 'cross_post' || s.kind === 'shorten' ? (
                    done.has(s.id) ? (
                      <span className="self-start text-xs font-semibold text-emerald-400 inline-flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Created — in Posts</span>
                    ) : (
                      <AssistButton className="self-start" busy={busyId === s.id} onClick={() => actOnReuse(s)}
                        label={s.kind === 'cross_post' ? 'Write it' : 'Write a short version'} busyLabel="Writing…" />
                    )
                  ) : (
                    // Navigate-only reuse → a text link, matching the Suggestions above.
                    <button onClick={() => actOnReuse(s)} className="self-start text-xs font-semibold text-accent-text inline-flex items-center gap-1 hover:underline">
                      {s.kind === 'similar' ? 'Rewrite for variety' : 'Fresh caption'} <ArrowRight className="w-3 h-3" />
                    </button>
                  )}
                </Card>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
