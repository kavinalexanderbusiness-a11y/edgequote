import { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tone, toneSoft } from '@/lib/tone'
import {
  QuoteStatus, InvoiceDisplayStatus, JobStatus,
  STATUS_LABELS,
} from '@/types'

// ── Badge ─────────────────────────────────────────────────────────────────────
// ONE badge for the whole app, driven by the shared tone system. Replaces the
// per-feature colour maps (quote STATUS_COLORS, INVOICE_STATUS_COLORS,
// JOB_STATUS_COLORS, and the hand-spelled CRM / Marketing / AI-Vision chips) so
// every status pill — wherever it lives — has identical shape, weight and the
// same six semantic colours. Pass a `tone`; for the three status enums use the
// maps below so a status always renders the same colour everywhere.
interface BadgeProps {
  tone?: Tone
  icon?: LucideIcon
  children: React.ReactNode
  className?: string
}

export function Badge({ tone = 'neutral', icon: Icon, children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border uppercase tracking-wide',
        toneSoft[tone],
        className
      )}
    >
      {Icon && <Icon className="w-3 h-3 shrink-0" />}
      {children}
    </span>
  )
}

// ── Status → tone maps ────────────────────────────────────────────────────────
// The single source for "what colour is this status". Collapses the four bespoke
// colour maps onto the six semantic tones (purple/teal/sky/violet fold to the
// nearest tone — fewer arbitrary colours is the point). Render any status as
// `<Badge tone={quoteStatusTone[status]}>{STATUS_LABELS[status]}</Badge>`.
export const quoteStatusTone: Record<QuoteStatus, Tone> = {
  draft: 'neutral', sent: 'info', accepted: 'accent', scheduled: 'info',
  completed: 'success', paid: 'success', declined: 'danger',
}
export const invoiceStatusTone: Record<InvoiceDisplayStatus, Tone> = {
  draft: 'neutral', unpaid: 'warn', sent: 'info', viewed: 'info', partial: 'info',
  paid: 'success', overpaid: 'accent', overdue: 'danger', cancelled: 'neutral',
}
export const jobStatusTone: Record<JobStatus, Tone> = {
  scheduled: 'info', in_progress: 'warn', completed: 'success', cancelled: 'neutral',
}

// Quote status badge — now a thin wrapper over the shared Badge + tone map, so it
// no longer carries its own colour table. (API unchanged for existing callers.)
interface StatusBadgeProps {
  status: QuoteStatus
  className?: string
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  return <Badge tone={quoteStatusTone[status]} className={className}>{STATUS_LABELS[status]}</Badge>
}
