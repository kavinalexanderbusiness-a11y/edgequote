import { ReactNode } from 'react'
import { cn } from '@/lib/utils'

// ── StickyActionBar ───────────────────────────────────────────────────────────
// THE bottom save/action bar. The three builder/settings save bars each invented
// their own recipe (fixed vs sticky, bg-bg-secondary/95 vs bg-surface/95,
// border-t vs full card, three paddings). One surface here:
// sticky (or fixed via `fixed`), blurred bg-bg-secondary/95, border-t, py-2.5.
interface StickyActionBarProps {
  children: ReactNode
  /** Use position:fixed to the viewport bottom (mobile-only bars). Default: sticky. */
  fixed?: boolean
  className?: string
}

export function StickyActionBar({ children, fixed, className }: StickyActionBarProps) {
  return (
    <div
      className={cn(
        'bottom-0 z-30 bg-bg-secondary/95 backdrop-blur border-t border-border px-4 py-2.5',
        fixed ? 'fixed left-0 right-0' : 'sticky',
        className
      )}
    >
      {children}
    </div>
  )
}
