'use client'

import { Card } from '@/components/ui/Card'
import { cn, formatDate } from '@/lib/utils'
import { thumbUrl } from '@/lib/photos'
import { Image as ImageIcon, Star, ArrowLeftRight } from 'lucide-react'
import { toneSoft, type Tone } from '@/lib/tone'
import type { MarketingCandidate } from '@/lib/marketing/types'

// One postable job in the Studio / Library list. Shows the strongest photo, the
// deterministic score, and the before/after + review signals at a glance.

function scoreTone(score: number): Tone {
  if (score >= 70) return 'success'
  if (score >= 50) return 'accent'
  return 'neutral'
}

export function AssetCard({ candidate, selected, onClick }: {
  candidate: MarketingCandidate
  selected?: boolean
  onClick?: () => void
}) {
  const thumb = candidate.bestAfterUrl || candidate.bestBeforeUrl
  return (
    <button type="button" onClick={onClick} className="w-full text-left">
      <Card className={cn(
        'p-3 flex gap-3 items-center transition-colors',
        selected ? 'border-accent ring-1 ring-accent/30' : 'hover:border-accent/40',
      )}>
        <div className="w-14 h-14 rounded-lg overflow-hidden bg-bg-tertiary border border-border shrink-0 flex items-center justify-center">
          {thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumbUrl(thumb, 160, 160)} alt="" loading="lazy" className="w-full h-full object-cover" />
          ) : (
            <ImageIcon className="w-5 h-5 text-ink-faint" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-ink truncate">
              {candidate.serviceType || 'Completed job'}
            </p>
            <span title="Post potential score (0–100)" className={cn('shrink-0 text-[10px] font-bold tabular-nums rounded-full px-1.5 py-0.5 border', toneSoft[scoreTone(candidate.score)])}>
              {candidate.score}
            </span>
          </div>
          <p className="text-xs text-ink-muted truncate">
            {candidate.neighborhood || candidate.city || 'Unknown area'}
            {candidate.date ? ` · ${formatDate(candidate.date)}` : ''}
          </p>
          <div className="flex items-center gap-1.5 mt-1">
            {candidate.hasBefore && candidate.hasAfter && (
              <span className="inline-flex items-center gap-1 text-[10px] text-accent-text">
                <ArrowLeftRight className="w-3 h-3" /> Before &amp; after
              </span>
            )}
            {candidate.hasReview && (
              <span className="inline-flex items-center gap-1 text-[10px] text-amber-400">
                <Star className="w-3 h-3 fill-amber-400" /> Reviewed
              </span>
            )}
          </div>
        </div>
      </Card>
    </button>
  )
}
