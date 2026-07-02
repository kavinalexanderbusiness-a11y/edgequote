'use client'

import { FilterPill } from '@/components/ui/FilterPill'
import { cn } from '@/lib/utils'
import { Smile } from 'lucide-react'
import { WRITING_STYLES } from '@/lib/marketing/styles'
import { WRITING_STYLES_LIST, type PostLength, type PostOptions, type WritingStyle } from '@/lib/marketing/types'

// ── Post options ──────────────────────────────────────────────────────────────────
// Three controls that actually change the result: the writing VOICE, the LENGTH, and
// emoji on/off. Everything else a marketing manager would decide — local references,
// the seasonal angle, the call to action, platform-appropriate hashtags — the engine
// now handles automatically and intelligently, so those toggles were removed (fewer
// decisions, the same or better output). Lifted into the Studio so one setting drives
// a per-channel generate, "Generate all platforms", and campaigns alike.

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
    <div className={cn('space-y-2.5', className)}>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-1.5">Voice</p>
        <div className="flex items-center gap-1.5 flex-wrap">
          {WRITING_STYLES_LIST.map(s => (
            <FilterPill key={s} active={options.style === s} onClick={() => set({ style: s as WritingStyle })}>
              <span title={WRITING_STYLES[s].blurb}>{WRITING_STYLES[s].label}</span>
            </FilterPill>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Length</span>
        {LENGTHS.map(l => (
          <FilterPill key={l.key} active={options.length === l.key} onClick={() => set({ length: l.key })}>
            {l.label}
          </FilterPill>
        ))}
        <span className="w-px h-4 bg-border mx-1" />
        <FilterPill active={options.emojis} onClick={() => set({ emojis: !options.emojis })}>
          <Smile className="w-3 h-3" /> Emojis
        </FilterPill>
      </div>
    </div>
  )
}
