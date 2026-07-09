interface PageHeaderProps {
  title: string
  description?: string
  action?: React.ReactNode
}

export function PageHeader({ title, description, action }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-6">
      {/* flex-1 so the title CLAIMS the width the (shrink-0) action doesn't use —
          without it a long title collapses against the action. The title truncates
          (one line + ellipsis, full text on hover) so very long customer names /
          page titles never wrap awkwardly or push the action off-screen. */}
      <div className="flex-1 min-w-0">
        <h1 className="text-xl font-bold text-ink tracking-tight truncate" title={title}>{title}</h1>
        {description && (
          <p className="text-sm text-ink-muted mt-0.5">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}