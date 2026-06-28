'use client'

import { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SkeletonRows } from './Skeleton'
import { EmptyState, InlineEmpty } from './EmptyState'

// ── List ──────────────────────────────────────────────────────────────────────
// ONE list/table shell so every list in the app — customers, quotes, invoices,
// messages, neighbours, reactivation, CRM — shares the same spacing, row height,
// hover, click + keyboard behaviour, action placement, selection, loading and
// empty states. The feature only supplies `renderRow` for the row CONTENT; all
// the chrome is identical everywhere.
//
// Convention: keep interactive elements (buttons, menus, links) in `rowActions`,
// NOT inside `renderRow` — the row's click target wraps only the (non-interactive)
// content, so there's never a nested-interactive accessibility violation.
interface ListEmpty {
  icon: LucideIcon
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
}

interface ListProps<T> {
  items: T[]
  getKey: (item: T) => string
  renderRow: (item: T) => React.ReactNode
  onRowClick?: (item: T) => void
  rowActions?: (item: T) => React.ReactNode
  isActive?: (item: T) => boolean        // persistent highlight (master-detail / current)
  isSelected?: (item: T) => boolean      // checkbox state (with onToggleSelect)
  onToggleSelect?: (item: T) => void     // present → renders a leading checkbox
  loading?: boolean
  skeletonCount?: number
  empty?: ListEmpty
  emptyVariant?: 'full' | 'inline'
  ariaLabel?: string
  className?: string
}

export function List<T>({
  items, getKey, renderRow, onRowClick, rowActions, isActive, isSelected, onToggleSelect,
  loading, skeletonCount = 5, empty, emptyVariant = 'full', ariaLabel, className,
}: ListProps<T>) {
  if (loading) return <SkeletonRows count={skeletonCount} className={className} />

  if (!items.length && empty) {
    return emptyVariant === 'inline' ? (
      <div className={cn('rounded-card border border-border bg-bg-secondary', className)}>
        <InlineEmpty icon={empty.icon}>{empty.title}</InlineEmpty>
      </div>
    ) : (
      <EmptyState icon={empty.icon} title={empty.title} description={empty.description ?? ''} action={empty.action} className={className} />
    )
  }

  return (
    <ul role="list" aria-label={ariaLabel}
      className={cn('rounded-card border border-border bg-bg-secondary divide-y divide-border overflow-hidden', className)}>
      {items.map(item => {
        const active = isActive?.(item)
        return (
          <li key={getKey(item)}
            className={cn('flex items-center gap-3 px-4 py-3 transition-colors', active && 'bg-surface', onRowClick && 'hover:bg-surface')}>
            {onToggleSelect && (
              <input
                type="checkbox"
                checked={!!isSelected?.(item)}
                onChange={() => onToggleSelect(item)}
                aria-label="Select row"
                className="shrink-0 w-4 h-4 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
              />
            )}
            {onRowClick ? (
              <button
                type="button"
                onClick={() => onRowClick(item)}
                aria-current={active || undefined}
                className="flex-1 min-w-0 text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {renderRow(item)}
              </button>
            ) : (
              <div className="flex-1 min-w-0">{renderRow(item)}</div>
            )}
            {rowActions && <div className="shrink-0 flex items-center gap-1.5">{rowActions(item)}</div>}
          </li>
        )
      })}
    </ul>
  )
}
