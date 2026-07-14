import { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── SectionHeading ────────────────────────────────────────────────────────────
// One in-page / in-card section title. Replaces the 6+ hand-rolled markups
// (`text-sm font-bold` + icon-w4, `text-[10px] uppercase` + icon-w3.5, colored
// <h2>, etc.). Icon size and weight are defined once.
interface SectionHeadingProps {
  icon?: LucideIcon
  title: React.ReactNode
  sub?: React.ReactNode
  action?: React.ReactNode
  /** Uppercase micro "eyebrow" variant — ONE style for small section labels
      (text-xs font-semibold uppercase tracking-wide) instead of hand-rolls. */
  eyebrow?: boolean
  className?: string
}

export function SectionHeading({ icon: Icon, title, sub, action, eyebrow, className }: SectionHeadingProps) {
  return (
    <div className={cn('flex items-center gap-2', eyebrow ? 'mb-2' : 'mb-3', className)}>
      {Icon && <Icon className={cn('text-ink-muted shrink-0', eyebrow ? 'w-3.5 h-3.5' : 'w-4 h-4')} />}
      <div className="min-w-0">
        <h2 className={cn('truncate', eyebrow ? 'text-xs font-semibold uppercase tracking-wide text-ink-muted' : 'text-sm font-semibold text-ink')}>{title}</h2>
        {sub && <p className="text-xs text-ink-muted truncate">{sub}</p>}
      </div>
      {action && <div className="ml-auto shrink-0">{action}</div>}
    </div>
  )
}
