import { cn } from '@/lib/utils'

// ── FilterPill ────────────────────────────────────────────────────────────────
// One segmented-control / filter pill. Replaces the copy-pasted
// `rounded-full px-3 py-1.5 border …` buttons that drifted across invoices,
// customers, quotes, messages, revenue-intelligence, saturation, settings.
interface FilterPillProps {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  className?: string
}

export function FilterPill({ active, onClick, children, className }: FilterPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border transition-colors whitespace-nowrap',
        active
          ? 'bg-accent text-black border-accent'
          : 'bg-surface text-ink-muted border-border hover:text-ink hover:border-border-strong',
        className
      )}
    >
      {children}
    </button>
  )
}
