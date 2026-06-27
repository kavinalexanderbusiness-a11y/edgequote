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
}

export function StatTile({ label, value, sub, icon: Icon, tone, accent, tonedSurface, onClick, className }: StatTileProps) {
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
      <p className={cn('text-xl font-black tracking-tight mt-1.5', tone ? toneText[tone] : 'text-ink')}>{value}</p>
      {sub && <p className="text-[11px] text-ink-muted mt-1 truncate">{sub}</p>}
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
