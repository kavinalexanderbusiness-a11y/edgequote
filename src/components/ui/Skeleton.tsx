import { cn } from '@/lib/utils'

// ── Skeleton loaders ─────────────────────────────────────────────────────────────
// Shared shimmer primitives so loading states feel premium and consistent instead
// of a bare spinner. One look everywhere. The single Skeleton is a bare shimmer
// bar (used inline in laid-out cards); the composites below stand in for a whole
// section while it loads, so they carry a screen-reader "Loading" announcement.
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-bg-tertiary/70', className)} />
}

// A grid of stat-tile placeholders (matches the Tile/Stat cards used across the
// intelligence dashboards).
export function SkeletonTiles({ count = 4, className, label = 'Loading…' }: { count?: number; className?: string; label?: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={cn('grid grid-cols-2 lg:grid-cols-4 gap-3', className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} aria-hidden="true" className="rounded-card border border-border bg-bg-secondary p-3.5">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="h-6 w-16 mt-2" />
          <Skeleton className="h-2 w-24 mt-2" />
        </div>
      ))}
    </div>
  )
}

// A stack of list-row placeholders (matches ranked lists / feeds).
export function SkeletonRows({ count = 5, className, label = 'Loading…' }: { count?: number; className?: string; label?: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={cn('rounded-card border border-border bg-bg-secondary divide-y divide-border overflow-hidden', className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} aria-hidden="true" className="px-4 py-3 flex items-center gap-3">
          <Skeleton className="w-9 h-9 rounded-xl shrink-0" />
          <div className="flex-1 min-w-0">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-2 w-3/4 mt-1.5" />
          </div>
          <Skeleton className="h-4 w-12 shrink-0" />
        </div>
      ))}
    </div>
  )
}
