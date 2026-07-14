import { ButtonHTMLAttributes, forwardRef } from 'react'
import { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── IconButton ────────────────────────────────────────────────────────────────
// THE square icon-only button. Replaces the byte-identical `h-8 w-8 rounded-lg
// border …` refresh/close clones (WinLossPanel, SuggestionsCenter,
// CustomerHealthPanel, NotificationBell at h-9…) with one hit size and a
// mandatory accessible name. 36px default — comfortably tappable; `size="sm"`
// (32px) for dense toolbars.
interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  icon: LucideIcon
  label: string            // accessible name (also the tooltip)
  size?: 'sm' | 'md'
  tone?: 'default' | 'danger'
  /** Spin the icon (refresh-in-flight). */
  spin?: boolean
}

const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon: Icon, label, size = 'md', tone = 'default', spin, className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'shrink-0 rounded-lg border flex items-center justify-center transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50',
        size === 'sm' ? 'h-8 w-8' : 'h-9 w-9',
        tone === 'danger'
          ? 'border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20'
          : 'border-border text-ink-muted hover:text-ink hover:border-border-strong',
        className
      )}
      {...props}
    >
      <Icon className={cn('w-4 h-4', spin && 'animate-spin')} />
    </button>
  )
)

IconButton.displayName = 'IconButton'
export { IconButton }
