import { X, LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tone, toneSoft } from '@/lib/tone'

// ── Banner ────────────────────────────────────────────────────────────────────
// One inline notice: toasts, "saved", undo, warnings, errors. Replaces the
// per-page `rounded-xl px-4 py-2.5 border bg-…/10` blocks. Tone drives colour;
// dismissable shows a consistent lucide X (not a literal "✕" glyph).
interface BannerProps {
  tone?: Tone
  icon?: LucideIcon
  children: React.ReactNode
  onDismiss?: () => void
  action?: React.ReactNode
  className?: string
}

export function Banner({ tone = 'accent', icon: Icon, children, onDismiss, action, className }: BannerProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-card border px-4 py-2.5 text-sm',
        toneSoft[tone],
        className
      )}
    >
      {Icon && <Icon className="w-4 h-4 shrink-0" />}
      <div className="flex-1 min-w-0">{children}</div>
      {action}
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100 transition-opacity">
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}
