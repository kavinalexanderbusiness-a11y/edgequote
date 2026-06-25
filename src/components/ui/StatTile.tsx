import { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tone, toneText } from '@/lib/tone'

// ── StatTile ──────────────────────────────────────────────────────────────────
// The ONE KPI tile. Replaces the ~8 hand-rolled `Stat`/`Tile`/`Metric`/`OppCard`
// variants that each drifted on weight, label size, padding and surface. Matches
// the SkeletonTiles placeholder (rounded-card border, p-3.5) so loaded tiles land
// exactly where their skeleton was.
interface StatTileProps {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  icon?: LucideIcon
  tone?: Tone        // colours the value + icon (default: plain ink)
  accent?: boolean   // accent-tinted surface for the hero metric
  className?: string
}

export function StatTile({ label, value, sub, icon: Icon, tone, accent, className }: StatTileProps) {
  return (
    <div
      className={cn(
        'rounded-card border p-3.5',
        accent ? 'border-accent/30 bg-accent/[0.06]' : 'border-border bg-surface',
        className
      )}
    >
      <div className="flex items-center gap-1.5">
        {Icon && <Icon className={cn('w-3.5 h-3.5 shrink-0', tone ? toneText[tone] : 'text-ink-faint')} />}
        <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint truncate">{label}</p>
      </div>
      <p className={cn('text-xl font-black tracking-tight mt-1.5', tone ? toneText[tone] : 'text-ink')}>{value}</p>
      {sub && <p className="text-[11px] text-ink-muted mt-1 truncate">{sub}</p>}
    </div>
  )
}
