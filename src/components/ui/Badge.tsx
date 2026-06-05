import { cn } from '@/lib/utils'
import { QuoteStatus, STATUS_LABELS, STATUS_COLORS } from '@/types'

interface StatusBadgeProps {
  status: QuoteStatus
  className?: string
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border uppercase tracking-wide',
        STATUS_COLORS[status],
        className
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  )
}
