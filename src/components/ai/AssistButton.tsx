'use client'

import { Sparkles, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── The AI-assist trigger ─────────────────────────────────────────────────────
// One small, consistent button for every "write it for me / clean it up" spot:
// Sparkles icon, quiet ghost styling, spinner while streaming. Callers own the
// hook state (useAiAssist) so several buttons can share one run/error state.
// Render it ONLY when useAiAssist().enabled is true — surfaces disappear
// entirely on installs with no AI key (the app's disabled-by-default contract).
export function AssistButton({ label, onClick, busy, disabled, title, className }: {
  label: string
  onClick: () => void
  busy?: boolean
  disabled?: boolean
  title?: string
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 text-xs font-medium rounded-lg px-2.5 py-1.5 border border-accent/25 text-accent-text',
        'hover:bg-accent/10 hover:border-accent/40 transition-colors disabled:opacity-50 disabled:pointer-events-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        className,
      )}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
      {label}
    </button>
  )
}
