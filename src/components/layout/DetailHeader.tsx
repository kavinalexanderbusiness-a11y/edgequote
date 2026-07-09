'use client'

import { ArrowLeft } from 'lucide-react'
import { useRouter } from 'next/navigation'

// ── DetailHeader ──────────────────────────────────────────────────────────────
// PageHeader for DETAIL pages: a back affordance + the same title/description/
// action layout. Every detail page (quotes/[id], customers/[id], …) hand-rolled
// or awkwardly nested PageHeader inside a custom flex row to add a back button —
// which is exactly what collapsed the quote title. This composes the back button
// as a SIBLING of the (flex-1 min-w-0, truncating) title, so long names never
// collapse and the action stays put.
interface DetailHeaderProps {
  title: string
  description?: string
  action?: React.ReactNode
  backHref?: string        // explicit target; otherwise router.back()
  onBack?: () => void
}

export function DetailHeader({ title, description, action, backHref, onBack }: DetailHeaderProps) {
  const router = useRouter()
  const back = onBack ?? (() => (backHref ? router.push(backHref) : router.back()))
  return (
    <div className="flex items-start gap-3 mb-6">
      <button
        onClick={back}
        aria-label="Back"
        className="mt-1 shrink-0 text-ink-muted hover:text-ink transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <ArrowLeft className="w-4 h-4" />
      </button>
      <div className="flex-1 min-w-0 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-ink tracking-tight truncate" title={title}>{title}</h1>
          {description && <p className="text-sm text-ink-muted mt-0.5">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  )
}
