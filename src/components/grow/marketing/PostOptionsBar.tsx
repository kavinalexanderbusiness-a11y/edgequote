'use client'

import { FilterPill } from '@/components/ui/FilterPill'
import { cn } from '@/lib/utils'
import { Smile, Hash, Megaphone, Leaf, MapPin } from 'lucide-react'
import type { PostLength, PostOptions } from '@/lib/marketing/types'

// ── Post options ──────────────────────────────────────────────────────────────────
// The owner's creative controls — length + the on/off style modifiers. Lifted into
// the Studio so a single setting drives BOTH a per-channel generate and "Generate all
// platforms"; the chosen options ride along in every generate request.

const LENGTHS: { key: PostLength; label: string }[] = [
  { key: 'short', label: 'Short' },
  { key: 'medium', label: 'Medium' },
  { key: 'long', label: 'Long' },
]

export function PostOptionsBar({ options, onChange, className }: {
  options: PostOptions
  onChange: (next: PostOptions) => void
  className?: string
}) {
  const set = (patch: Partial<PostOptions>) => onChange({ ...options, ...patch })
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mr-0.5">Length</span>
        {LENGTHS.map(l => (
          <FilterPill key={l.key} active={options.length === l.key} onClick={() => set({ length: l.key })}>
            {l.label}
          </FilterPill>
        ))}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mr-0.5">Style</span>
        <FilterPill active={options.emojis} onClick={() => set({ emojis: !options.emojis })}>
          <Smile className="w-3 h-3" /> Emojis
        </FilterPill>
        <FilterPill active={options.hashtags} onClick={() => set({ hashtags: !options.hashtags })}>
          <Hash className="w-3 h-3" /> Hashtags
        </FilterPill>
        <FilterPill active={options.cta} onClick={() => set({ cta: !options.cta })}>
          <Megaphone className="w-3 h-3" /> CTA
        </FilterPill>
        <FilterPill active={options.seasonal} onClick={() => set({ seasonal: !options.seasonal })}>
          <Leaf className="w-3 h-3" /> Seasonal
        </FilterPill>
        <FilterPill active={options.local} onClick={() => set({ local: !options.local })}>
          <MapPin className="w-3 h-3" /> Local
        </FilterPill>
      </div>
    </div>
  )
}
