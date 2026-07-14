import { PageHeader } from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'

// Library route loading state — matches the grid so the prior screen doesn't just
// freeze while the query resolves.
export default function LibraryLoading() {
  return (
    <div className="space-y-5">
      <PageHeader title="Content Library" description="Every completed job, ready to reuse as marketing." />
      <Skeleton className="h-11 w-full rounded-xl" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="overflow-hidden flex flex-col">
            <Skeleton className="h-40 rounded-none" />
            <div className="p-3 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-8 w-full rounded-xl mt-1" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
