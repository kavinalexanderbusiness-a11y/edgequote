'use client'

import { Loader2, Wand2, RefreshCw, Minimize2, Maximize2, Briefcase, HeartHandshake, Flame, Crown, MapPin, Laugh, Search, Eraser, SmilePlus, Megaphone, ChevronDown, type LucideIcon } from 'lucide-react'
import { REWRITE_ACTIONS } from '@/lib/marketing/prompt'
import { cn } from '@/lib/utils'
import type { RewriteAction } from '@/lib/marketing/types'

// ── AI edit toolbar ─────────────────────────────────────────────────────────────
// One-click edits of the post in the editor — no full regeneration needed. "Rewrite"
// gives a fresh take; the rest are precise tweaks. Each is a RewriteAction sent to
// /api/marketing/rewrite (same gateway, one-line modifier) and the result replaces the
// text in place so the owner keeps editing. Primary edits are surfaced; the rest sit
// under "More" so the bar stays clean.

const ICONS: Record<RewriteAction, LucideIcon> = {
  rewrite: RefreshCw, shorter: Minimize2, longer: Maximize2, professional: Briefcase, friendly: HeartHandshake,
  exciting: Flame, premium: Crown, local: MapPin, humorous: Laugh, seo: Search,
  remove_emojis: Eraser, add_emojis: SmilePlus, stronger_cta: Megaphone,
}

const PRIMARY: RewriteAction[] = ['shorter', 'longer', 'professional', 'exciting', 'stronger_cta', 'local']
const MORE: RewriteAction[] = ['premium', 'friendly', 'humorous', 'seo', 'add_emojis', 'remove_emojis']

function Pill({ action, busy, disabled, onRewrite }: { action: RewriteAction; busy: RewriteAction | null; disabled?: boolean; onRewrite: (a: RewriteAction) => void }) {
  const Icon = ICONS[action]
  const isBusy = busy === action
  return (
    <button
      type="button"
      onClick={() => onRewrite(action)}
      disabled={disabled || !!busy}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium border transition-colors whitespace-nowrap',
        'bg-surface text-ink-muted border-border hover:text-ink hover:border-accent/50 disabled:opacity-40 disabled:cursor-not-allowed',
        isBusy && 'border-accent text-accent',
      )}
    >
      {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Icon className="w-3 h-3" />}
      {REWRITE_ACTIONS[action].label}
    </button>
  )
}

export function RewriteToolbar({ disabled, busy, onRewrite }: {
  disabled?: boolean
  busy?: RewriteAction | null
  onRewrite: (action: RewriteAction) => void
}) {
  const b = busy ?? null
  return (
    <div className="rounded-card border border-border bg-surface/60 p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint inline-flex items-center gap-1.5">
          <Wand2 className="w-3.5 h-3.5 text-accent" /> AI edits
        </p>
        <button
          type="button"
          onClick={() => onRewrite('rewrite')}
          disabled={disabled || !!b}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border transition-colors whitespace-nowrap',
            'bg-surface text-ink-muted border-border hover:text-ink hover:border-accent/50 disabled:opacity-40 disabled:cursor-not-allowed',
            b === 'rewrite' && 'border-accent text-accent',
          )}
        >
          {b === 'rewrite' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Rewrite
        </button>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {PRIMARY.map(a => <Pill key={a} action={a} busy={b} disabled={disabled} onRewrite={onRewrite} />)}
      </div>
      <details className="group">
        <summary className="text-[11px] text-ink-faint cursor-pointer select-none hover:text-ink-muted list-none inline-flex items-center gap-1">More edits <ChevronDown className="w-3 h-3 transition-transform group-open:rotate-180" /></summary>
        <div className="flex items-center gap-1.5 flex-wrap mt-2">
          {MORE.map(a => <Pill key={a} action={a} busy={b} disabled={disabled} onRewrite={onRewrite} />)}
        </div>
      </details>
    </div>
  )
}
