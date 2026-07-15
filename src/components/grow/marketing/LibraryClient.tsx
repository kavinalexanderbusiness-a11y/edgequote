'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { Card } from '@/components/ui/Card'
import { FilterPill } from '@/components/ui/FilterPill'
import { cn, formatDate } from '@/lib/utils'
import { thumbUrl } from '@/lib/photos'
import { toneSoft, type Tone } from '@/lib/tone'
import { Images, Search, Star, ArrowLeftRight, Sparkles, Image as ImageIcon } from 'lucide-react'
import type { MarketingCandidate, Season } from '@/lib/marketing/types'

const SEASONS: Season[] = ['spring', 'summer', 'fall', 'winter']

function scoreTone(score: number): Tone {
  if (score >= 70) return 'success'
  if (score >= 50) return 'accent'
  return 'neutral'
}

// Every completed job is reusable marketing content. The Library makes it
// searchable — by service, neighborhood, season, before/after, review — and a
// click drops the job straight into the Studio.
export function LibraryClient({ candidates }: { candidates: MarketingCandidate[] }) {
  const [q, setQ] = useState('')
  const [service, setService] = useState<string | null>(null)
  const [season, setSeason] = useState<Season | null>(null)
  const [beforeAfter, setBeforeAfter] = useState(false)
  const [reviewed, setReviewed] = useState(false)

  const services = useMemo(
    () => Array.from(new Set(candidates.map(c => c.serviceType).filter((s): s is string => !!s))).sort(),
    [candidates],
  )

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return candidates.filter(c => {
      if (service && c.serviceType !== service) return false
      if (season && c.season !== season) return false
      if (beforeAfter && !(c.hasBefore && c.hasAfter)) return false
      if (reviewed && !c.hasReview) return false
      if (needle) {
        const hay = [c.serviceType, c.neighborhood, c.city, c.customerName].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [candidates, q, service, season, beforeAfter, reviewed])

  if (!candidates.length) {
    return (
      <div>
        <PageHeader title="Content Library" description="Every completed job, ready to reuse as marketing." />
        <EmptyState
          icon={Images}
          title="Your library fills itself"
          description="Finished jobs with photos land here automatically — searchable by service, neighborhood, season and more."
        />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Content Library" description="Every completed job, ready to reuse as marketing." />

      {/* Search + facets */}
      <div className="space-y-2.5">
        <div className="relative">
          <Search className="w-4 h-4 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search service, neighborhood, customer…"
            className="w-full bg-bg-tertiary border border-border rounded-xl pl-9 pr-3 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/50"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <FilterPill active={beforeAfter} onClick={() => setBeforeAfter(v => !v)}>
            <ArrowLeftRight className="w-3 h-3" /> Before &amp; after
          </FilterPill>
          <FilterPill active={reviewed} onClick={() => setReviewed(v => !v)}>
            <Star className="w-3 h-3" /> Reviewed
          </FilterPill>
          {SEASONS.map(s => (
            <FilterPill key={s} active={season === s} onClick={() => setSeason(season === s ? null : s)}>
              <span className="capitalize">{s}</span>
            </FilterPill>
          ))}
        </div>
        {services.length > 1 && (
          <div className="flex gap-1.5 flex-wrap">
            {services.map(s => (
              <FilterPill key={s} active={service === s} onClick={() => setService(service === s ? null : s)}>
                {s}
              </FilterPill>
            ))}
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <InlineEmpty icon={Search}>No jobs match your filters.</InlineEmpty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map(c => {
            const thumb = c.bestAfterUrl || c.bestBeforeUrl
            return (
              // Whole card is the link (click anywhere), matching the Studio cards.
              <Link key={c.jobId} href={`/dashboard/grow/studio?job=${c.jobId}`} className="block group">
                <Card className="overflow-hidden flex flex-col h-full card-lift transition-colors group-hover:border-accent/40">
                  <div className="relative h-40 bg-bg-tertiary">
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumbUrl(thumb, 640, 400)} alt="" loading="lazy" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center"><ImageIcon className="w-6 h-6 text-ink-faint" /></div>
                    )}
                    <span title="Post potential score (0–100)" className={cn('absolute top-2 right-2 text-[10px] font-bold tabular-nums rounded-full px-1.5 py-0.5 border', toneSoft[scoreTone(c.score)])}>
                      {c.score}
                    </span>
                  </div>
                  <div className="p-3 flex-1 flex flex-col gap-1.5">
                    <p className="text-sm font-semibold text-ink truncate">{c.serviceType || 'Completed job'}</p>
                    <p className="text-xs text-ink-muted truncate">
                      {[c.neighborhood || c.city, c.date ? formatDate(c.date) : null].filter(Boolean).join(' · ') || '—'}
                    </p>
                    <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                      {c.hasBefore && c.hasAfter && <span className="inline-flex items-center gap-1 text-[10px] text-accent-text"><ArrowLeftRight className="w-3 h-3" /> Before &amp; after</span>}
                      {c.hasReview && <span className="inline-flex items-center gap-1 text-[10px] text-amber-400"><Star className="w-3 h-3 fill-amber-400" /> Review</span>}
                      {c.season && <span className="text-[10px] text-ink-faint capitalize">{c.season}</span>}
                    </div>
                    <span className="mt-auto inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent/10 border border-accent/20 text-accent-text text-xs font-semibold py-2 group-hover:bg-accent/15 transition-colors">
                      <Sparkles className="w-3.5 h-3.5" /> Use in Studio
                    </span>
                  </div>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
