import { cn } from '@/lib/utils'

// ── FilterPill ────────────────────────────────────────────────────────────────
// One segmented-control / filter pill. Replaces the copy-pasted
// `rounded-full px-3 py-1.5 border …` buttons that drifted across invoices,
// customers, quotes, messages, revenue-intelligence, saturation, settings.
// Fully accessible: a real <button> (native Enter/Space), `aria-pressed` so it
// announces its selected state to screen readers, an optional `ariaLabel` for
// icon-only pills, and a visible keyboard focus ring.
interface FilterPillProps {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  ariaLabel?: string
  title?: string
  disabled?: boolean
  className?: string
}

export function FilterPill({ active, onClick, children, ariaLabel, title, disabled, className }: FilterPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      className={cn(
        // 44px on a phone, unchanged on a desktop — the same trade lib/ui/Button
        // makes, for the same reason and by the same mechanism. These pills were
        // ~30px tall at every phone width, which is under this product's own
        // stated minimum for a control a gloved thumb has to hit.
        //
        // ⚠️ Responsive PADDING rather than the `.tap-target` utility: that
        // utility is gated on `pointer: coarse`, so it grows nothing in a
        // narrow desktop window — which is exactly where a viewport check
        // measures. text-xs has a 16px line box, so py-3.5 → 16 + 28 = 44.
        'inline-flex items-center gap-1.5 rounded-full px-3 py-3.5 sm:py-1.5 text-xs font-medium border transition-all whitespace-nowrap active:scale-[0.97]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100',
        active
          ? 'bg-accent text-black border-accent pill-glow'
          : 'bg-surface text-ink-muted border-border hover:text-ink hover:border-border-strong',
        className
      )}
    >
      {children}
    </button>
  )
}
