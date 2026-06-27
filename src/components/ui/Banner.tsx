import { X, LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tone, toneSoft } from '@/lib/tone'

// ── Banner ────────────────────────────────────────────────────────────────────
// One inline notice covering every notice style in the app: info/saved/warning/
// error tints AND the high-emphasis dark "undo / just happened" toast. Replaces
// the per-page `rounded-xl px-4 py-2.5 border bg-…/10` blocks and the dark
// `bg-ink text-bg` undo toasts. Tone drives colour; `variant="solid"` is the
// emphasis toast (used for undo / transient confirmations). Dismissable shows a
// consistent lucide X (not a literal "✕" glyph).
interface BannerProps {
  tone?: Tone
  variant?: 'soft' | 'solid'
  icon?: LucideIcon
  children: React.ReactNode
  onDismiss?: () => void
  action?: React.ReactNode
  className?: string
}

export function Banner({ tone = 'accent', variant = 'soft', icon: Icon, children, onDismiss, action, className }: BannerProps) {
  const solid = variant === 'solid'
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-2.5 rounded-card border px-4 py-2.5 text-sm',
        solid ? 'bg-ink text-bg border-border-strong shadow-lg' : toneSoft[tone],
        className
      )}
    >
      {Icon && <Icon className="w-4 h-4 shrink-0" />}
      <div className="flex-1 min-w-0">{children}</div>
      {action}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 opacity-70 hover:opacity-100 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}
