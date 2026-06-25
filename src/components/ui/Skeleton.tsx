import { cn } from '@/lib/utils'

// ── Skeleton loaders ─────────────────────────────────────────────────────────────
// Shared shimmer primitives so loading states feel premium and consistent instead
// of a bare spinner. One look everywhere.
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-bg-tertiary/70', className)} />
}

// A grid of stat-tile placeholders (matches the Tile/Stat cards used across the
// intelligence dashboards).
export function SkeletonTiles({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('grid grid-cols-2 lg:grid-cols-4 gap-3', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-card border border-border bg-surface p-3.5">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="h-6 w-16 mt-2" />
          <Skeleton className="h-2 w-24 mt-2" />
        </div>
      ))}
    </div>
  )
}

// A stack of list-row placeholders (matches ranked lists / feeds).
export function SkeletonRows({ count = 5, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('rounded-card border border-border bg-surface divide-y divide-border overflow-hidden', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="px-4 py-3 flex items-center gap-3">
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

// Whole-page loading shell: a shimmer title + optional map/tiles + list rows.
// ONE loading look for every page (`if (loading) return <PageSkeleton .../>`), so
// the app never flashes a bare "Loading…" line. Mirrors the PageHeader + content
// rhythm so the real content lands where the skeleton was.
export function PageSkeleton({
  tiles = 0,
  rows = 4,
  map = false,
  className,
}: { tiles?: number; rows?: number; map?: boolean; className?: string }) {
  return (
    <div className={cn('max-w-5xl space-y-6', className)}>
      <div className="space-y-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-3 w-72" />
      </div>
      {map && <Skeleton className="h-72 w-full rounded-card" />}
      {tiles > 0 && <SkeletonTiles count={tiles} />}
      {rows > 0 && <SkeletonRows count={rows} />}
    </div>
  )
}
