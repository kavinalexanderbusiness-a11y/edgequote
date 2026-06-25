import { LucideIcon, TrendingUp, TrendingDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tone, toneText } from '@/lib/tone'

// ── StatTile ──────────────────────────────────────────────────────────────────
// The ONE KPI tile. Replaces the ~8 hand-rolled `Stat`/`Tile`/`Metric`/`OppCard`
// variants that each drifted on weight, label size, padding and surface. Matches
// the SkeletonTiles placeholder (rounded-card border bg-surface, p-3.5) so loaded
// tiles land exactly where their skeleton was.
interface StatTileProps {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  icon?: LucideIcon
  tone?: Tone           // colours the value + icon (default: plain ink)
  accent?: boolean      // accent-tinted surface for the hero metric
  delta?: number | null // signed % change → coloured ▲/▼ line (overrides sub)
  deltaLabel?: string
  className?: string
}

export function StatTile({ label, value, sub, icon: Icon, tone, accent, delta, deltaLabel, className }: StatTileProps) {
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
      {delta != null ? (
        <p className={cn('text-[11px] font-semibold mt-1 flex items-center gap-1', delta >= 0 ? 'text-emerald-400' : 'text-red-400')}>
          {delta >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
          {delta > 0 ? '+' : ''}{delta}% {deltaLabel && <span className="text-ink-faint font-normal">{deltaLabel}</span>}
        </p>
      ) : sub ? (
        <p className="text-[11px] text-ink-muted mt-1 truncate">{sub}</p>
      ) : null}
    </div>
  )
}
