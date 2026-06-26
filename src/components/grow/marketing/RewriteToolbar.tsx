'use client'

import { Loader2, Wand2, Minimize2, Maximize2, Briefcase, HeartHandshake, Flame, Crown, MapPin, Laugh, Search, Eraser, SmilePlus, Megaphone, type LucideIcon } from 'lucide-react'
import { REWRITE_ACTIONS } from '@/lib/marketing/prompt'
import { cn } from '@/lib/utils'
import type { RewriteAction } from '@/lib/marketing/types'

// ── AI rewrite toolbar ──────────────────────────────────────────────────────────
// One-click transforms of the post in the editor. Each button is just a RewriteAction
// sent to /api/marketing/rewrite (same gateway, one-line modifier) — no per-action UI
// logic. Grouped so the long list stays scannable.

const ICONS: Record<RewriteAction, LucideIcon> = {
  shorter: Minimize2, longer: Maximize2, professional: Briefcase, friendly: HeartHandshake,
  exciting: Flame, premium: Crown, local: MapPin, humorous: Laugh, seo: Search,
  remove_emojis: Eraser, add_emojis: SmilePlus, stronger_cta: Megaphone,
}

const GROUPS: { label: string; actions: RewriteAction[] }[] = [
  { label: 'Length', actions: ['shorter', 'longer'] },
  { label: 'Tone', actions: ['professional', 'friendly', 'exciting', 'premium', 'humorous'] },
  { label: 'Reach', actions: ['local', 'seo', 'stronger_cta'] },
  { label: 'Emojis', actions: ['add_emojis', 'remove_emojis'] },
]

export function RewriteToolbar({ disabled, busy, onRewrite }: {
  disabled?: boolean
  busy?: RewriteAction | null
  onRewrite: (action: RewriteAction) => void
}) {
  return (
    <div className="rounded-card border border-border bg-surface/60 p-3 space-y-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint inline-flex items-center gap-1.5">
        <Wand2 className="w-3.5 h-3.5 text-accent" /> AI rewrite
      </p>
      {GROUPS.map(group => (
        <div key={group.label} className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] uppercase tracking-wide text-ink-faint/80 w-12 shrink-0">{group.label}</span>
          {group.actions.map(a => {
            const Icon = ICONS[a]
            const isBusy = busy === a
            return (
              <button
                key={a}
                type="button"
                onClick={() => onRewrite(a)}
                disabled={disabled || !!busy}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium border transition-colors whitespace-nowrap',
                  'bg-surface text-ink-muted border-border hover:text-ink hover:border-accent/50 disabled:opacity-40 disabled:cursor-not-allowed',
                  isBusy && 'border-accent text-accent',
                )}
              >
                {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Icon className="w-3 h-3" />}
                {REWRITE_ACTIONS[a].label}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
