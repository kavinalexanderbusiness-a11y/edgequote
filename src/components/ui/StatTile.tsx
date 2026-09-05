import { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tone, toneText, toneSoft } from '@/lib/tone'

// ── StatTile ──────────────────────────────────────────────────────────────────
// The ONE KPI tile. Replaces the ~15 hand-rolled `Stat`/`Tile`/`Metric`/`OppCard`
// variants that each drifted on weight, label size, padding and surface. Matches
// the SkeletonTiles placeholder (rounded-card border, p-3.5) so loaded tiles land
// exactly where their skeleton was.
//
// Flexible enough for every stats page:
// • `tone` colours the value + icon; `tonedSurface` tints the whole tile (status
//   tiles); `accent` is the hero-metric surface.
// • `value`, `label` and `sub` accept nodes, so deltas/trends/badges go in `sub`.
// • `onClick` makes the tile an interactive button (the old `OppCard` pattern) —
//   hover, pointer and a keyboard focus ring, for free.
interface StatTileProps {
  label: React.ReactNode
  value: React.ReactNode
  sub?: React.ReactNode
  icon?: LucideIcon
  tone?: Tone        // colours the value + icon (default: plain ink)
  accent?: boolean   // accent-tinted surface for the hero metric
  tonedSurface?: boolean // tint the whole tile with the tone (status tiles)
  onClick?: () => void   // interactive tile → renders a <button>
  className?: string
  /**
   * ⭐⭐ OPT-IN, DEFAULT OFF. `sub` truncates to one line with an ellipsis by
   * default — right for a short caption like "3 acted · 1 won", wrong for a
   * caveat the reader MUST read in full. A narrow-phone audit caught exactly
   * that: "19 without enough data" clipped to "19 without e…" at 375px,
   * because the tile holding it is one of four in a 2-column mobile grid and
   * the sub-line had almost no width. Set `subWrap` on a tile whose sub-text is
   * a disclosure, never a decoration — clipping the ONE sentence that limits
   * what a headline figure means is worse than a taller tile.
   * ⛔ Left false everywhere else on purpose: this is a shared component used
   * across the app, and changing the default would reflow every other tile's
   * card grid for callers that never asked for it.
   */
  subWrap?: boolean
}

export function StatTile({ label, value, sub, icon: Icon, tone, accent, tonedSurface, onClick, className, subWrap }: StatTileProps) {
  const surface = accent
    ? 'border-accent/30 bg-accent/[0.06]'
    : tonedSurface && tone
      ? toneSoft[tone]
      : 'border-border bg-surface'

  const body = (
    <>
      <div className="flex items-center gap-1.5">
        {Icon && <Icon className={cn('w-3.5 h-3.5 shrink-0', tone ? toneText[tone] : 'text-ink-faint')} />}
        <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint truncate">{label}</p>
      </div>
      {/* tabular-nums so KPI digits never shift width as values change */}
      <p className={cn('text-xl font-black tracking-tight tabular-nums mt-1.5', tone ? toneText[tone] : 'text-ink')}>{value}</p>
      {sub && <p className={cn('text-[11px] text-ink-muted mt-1', subWrap ? 'break-words' : 'truncate')}>{sub}</p>}
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'rounded-card border p-3.5 text-left w-full transition-colors hover:border-border-strong',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          surface,
          className
        )}
      >
        {body}
      </button>
    )
  }

  return <div className={cn('rounded-card border p-3.5', surface, className)}>{body}</div>
}
