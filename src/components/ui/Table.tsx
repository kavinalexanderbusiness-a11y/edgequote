import { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

// ── Table cells ───────────────────────────────────────────────────────────────
// The app's three real tables (quotes list, profitability routes, measurement
// history) each invented their own header/cell treatment (text-xs vs [10px] vs
// [11px] headers, ink-muted vs ink-faint, py-3.5 vs py-2 cells, hover vs none).
// These two cells define it ONCE: header = the same uppercase micro-label the
// form system uses; cell = List's row padding. Use with a plain <table> —
// genuinely tabular data doesn't fit ui/List's single flex row.
export function Th({ className, children, ...props }: ThHTMLAttributes<HTMLTableCellElement> & { children?: ReactNode }) {
  return (
    <th className={cn('text-left text-xs font-semibold text-ink-muted uppercase tracking-wide px-4 py-3', className)} {...props}>
      {children}
    </th>
  )
}

export function Td({ className, children, ...props }: TdHTMLAttributes<HTMLTableCellElement> & { children?: ReactNode }) {
  return (
    <td className={cn('px-4 py-3 text-sm text-ink', className)} {...props}>
      {children}
    </td>
  )
}

// Canonical row hover for table bodies — matches ui/List's hover:bg-surface.
export const tableRowHover = 'transition-colors hover:bg-surface'
