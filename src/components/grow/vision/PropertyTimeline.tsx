'use client'

import { useState } from 'react'
import { TrendingUp, TrendingDown, ChevronDown, Camera, Activity } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toneSoft } from '@/lib/tone'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { detectChanges } from '@/lib/vision/change'
import { FEATURE_LABELS } from '@/lib/vision/labels'
import type { ConfidenceBand, PropertyIntelligence } from '@/lib/vision/types'

// ── AI Vision — property timeline ─────────────────────────────────────────────
// Every analysis over time, newest first. Each entry shows the read + how it
// changed from the PREVIOUS one (improvements green, deterioration red), and
// expands to its summary, detections and the photos that fed it. Read-only.

const BAND_TONE: Record<ConfidenceBand, 'success' | 'warn' | 'danger'> = { high: 'success', medium: 'warn', low: 'danger' }

export function PropertyTimeline({ entries, photoUrlById }: { entries: PropertyIntelligence[]; photoUrlById: Record<string, string> }) {
  const [open, setOpen] = useState<string | null>(entries[0]?.id ?? null)

  if (!entries.length) return <InlineEmpty icon={Activity}>No analyses yet — run AI Vision to start the timeline.</InlineEmpty>

  return (
    <div className="space-y-2">
      {entries.map((e, i) => {
        const prev = entries[i + 1] || null // older
        const change = detectChanges(e.analysis, prev?.analysis ?? null, prev?.created_at ?? null)
        const ups = change.signals.filter(s => s.direction === 'better' || s.direction === 'down').length
        const downs = change.signals.filter(s => s.direction === 'worse' || s.direction === 'up').length
        const band = e.confidence_band || 'low'
        const isOpen = open === e.id
        const present = (e.analysis?.detections || []).filter(d => d.present)
        const photoRefs = (e.inputs || []).filter(x => x.kind === 'ground_photo' && x.ref).map(x => x.ref as string)
        const health = e.analysis?.condition?.lawn_health

        return (
          <div key={e.id} className="rounded-card border border-border bg-surface overflow-hidden">
            <button onClick={() => setOpen(isOpen ? null : e.id)} className="w-full flex items-center gap-3 px-3.5 py-3 text-left hover:bg-surface-raised transition-colors">
              {/* timeline dot */}
              <div className="flex flex-col items-center shrink-0">
                <div className={cn('w-2.5 h-2.5 rounded-full', i === 0 ? 'bg-accent' : 'bg-ink-faint/40')} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">
                  {(e.observed_at || e.created_at || '').slice(0, 10)}
                  <span className="text-[11px] text-ink-faint font-normal ml-2">{e.source} · {e.image_count} img</span>
                </p>
                <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                  <span className={cn('text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full border', toneSoft[BAND_TONE[band]])}>{Math.round(e.confidence ?? 0)} {band}</span>
                  {health && <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-surface text-ink-muted border-border">turf {health}</span>}
                  {ups > 0 && <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border bg-emerald-500/15 text-emerald-400 border-emerald-500/25"><TrendingUp className="w-2.5 h-2.5" />{ups}</span>}
                  {downs > 0 && <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border bg-red-500/10 text-red-400 border-red-500/20"><TrendingDown className="w-2.5 h-2.5" />{downs}</span>}
                  {change.is_first && <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-blue-500/10 text-blue-400 border-blue-500/20">baseline</span>}
                </div>
              </div>
              <ChevronDown className={cn('w-4 h-4 text-ink-faint shrink-0 transition-transform', isOpen && 'rotate-180')} />
            </button>

            {isOpen && (
              <div className="px-3.5 pb-3.5 pt-1 border-t border-border space-y-3">
                {!change.is_first && change.narrative && (
                  <p className="text-xs text-ink-muted"><span className="font-semibold text-ink">Since previous:</span> {change.narrative}</p>
                )}
                {e.analysis?.summary && <p className="text-xs text-ink-muted">{e.analysis.summary}</p>}
                {present.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {present.map(d => (
                      <span key={d.key} className="text-[10px] px-1.5 py-0.5 rounded-full border bg-surface-raised text-ink-muted border-border-strong">{FEATURE_LABELS[d.key]}</span>
                    ))}
                  </div>
                )}
                {photoRefs.length > 0 && (
                  <div className="flex gap-2 overflow-x-auto no-scrollbar">
                    {photoRefs.map(ref => photoUrlById[ref] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={ref} src={photoUrlById[ref]} alt="" className="w-16 h-16 rounded-lg object-cover border border-border shrink-0" />
                    ) : (
                      <div key={ref} className="w-16 h-16 rounded-lg border border-border bg-surface-raised flex items-center justify-center shrink-0"><Camera className="w-4 h-4 text-ink-faint" /></div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
