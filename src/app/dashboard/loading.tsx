import { PageContainer } from '@/components/layout/PageContainer'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'

// The dashboard is one blocking server read, so without this boundary clicking
// "Dashboard" left the PREVIOUS page fully mounted — no spinner, no nav
// highlight move, nothing — until the payload landed. The click read as dropped.
//
// It also buys prefetch: for a dynamic route, <Link> only prefetches as far as
// the nearest loading boundary, so with none the router had nothing to warm.
//
// This mirrors the real shell (header → money band → strip → queue) rather than
// showing a spinner, so the skeleton lands where the content lands and nothing
// jumps when it arrives.
export default function DashboardLoading() {
  return (
    // aria-busy + aria-hidden children: this is a picture of the page, not the
    // page. Without it a screen reader announces a pile of meaningless empty
    // boxes; with it the region simply reports that it's loading.
    <PageContainer width="wide" aria-busy="true" aria-label="Loading your dashboard">
      <div aria-hidden className="contents">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-6">
        <div className="flex-1 min-w-0">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-72 mt-2" />
        </div>
        <Skeleton className="h-10 w-32 shrink-0 rounded-xl" />
      </div>

      {/* Money band — mirrors MoneyBand's real geometry (3-across at every width,
          p-3 on phones) so nothing shifts when the numbers land. */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {[0, 1, 2].map(i => (
          <Card key={i} className="p-3 sm:p-4">
            <div className="flex items-center justify-between gap-1 mb-1.5 sm:mb-2">
              <Skeleton className="h-2.5 w-12 sm:w-20" />
              <Skeleton className="h-7 w-7 rounded-lg hidden sm:block" />
            </div>
            <Skeleton className="h-6 sm:h-7 w-16 sm:w-24" />
            <Skeleton className="h-2.5 w-12 sm:w-16 mt-1.5" />
          </Card>
        ))}
      </div>

      {/* Weather strip. Reserved on purpose: the strip almost always renders
          something (the impact engine falls back to a default location, and a
          failed forecast still says so), so leaving no room here meant it
          INSERTED between money and priorities on arrival and shoved the queue
          down — a shift right where the eye already is. */}
      <Skeleton className="h-[42px] w-full rounded-card" />

      {/* Priorities queue */}
      <div className="rounded-card border border-accent/20 overflow-hidden">
        <div className="px-4 sm:px-5 py-3.5 border-b border-border flex items-center gap-2.5">
          <Skeleton className="h-7 w-7 rounded-lg" />
          <Skeleton className="h-4 w-36" />
        </div>
        <div className="divide-y divide-border">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="flex items-center gap-3 px-4 sm:px-5 py-3.5">
              <Skeleton className="h-5 w-5 rounded" />
              <Skeleton className="h-9 w-9 rounded-lg" />
              <div className="flex-1 min-w-0">
                <Skeleton className="h-3.5 w-48" />
                <Skeleton className="h-3 w-28 mt-1.5" />
              </div>
            </div>
          ))}
        </div>
      </div>
      </div>
    </PageContainer>
  )
}
