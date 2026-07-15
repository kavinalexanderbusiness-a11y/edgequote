import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

interface PageHeaderProps {
  title: string
  description?: string
  action?: React.ReactNode
  /** Parent surface this page belongs to — renders as an overline breadcrumb so
      hub leaves (Grow analytics, weather ops) always answer "where am I". */
  crumb?: { label: string; href: string }
}

export function PageHeader({ title, description, action, crumb }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-6">
      {/* flex-1 so the title CLAIMS the width the (shrink-0) action doesn't use —
          without it a long title collapses against the action. The title truncates
          (one line + ellipsis, full text on hover) so very long customer names /
          page titles never wrap awkwardly or push the action off-screen. */}
      <div className="flex-1 min-w-0">
        {crumb && (
          <Link href={crumb.href}
            className="inline-flex items-center gap-1 mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint hover:text-accent transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <ArrowLeft className="w-3 h-3" />
            {crumb.label}
          </Link>
        )}
        <h1 className="text-xl font-bold text-ink tracking-tight truncate" title={title}>{title}</h1>
        {description && (
          <p className="text-sm text-ink-muted mt-0.5">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}
