import { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

// ── Page layout system ────────────────────────────────────────────────────────
// ONE container primitive so every dashboard page shares the same content width,
// section rhythm and responsive behaviour — so the app reads as a single product.
// The dashboard shell (dashboard/layout.tsx) owns the outer gutters (p-4 lg:p-8);
// this owns the content column. Width tiers, and when each applies:
//   narrow  — focused single-column: forms, settings, a single record's detail/reading
//   default — most content: lists, tables, standard pages
//   wide    — data-dense dashboards / analytics with many tiles
//   full    — map / canvas / studio tools that need the whole width
// Content is centered (mx-auto) so it reads as an intentional column instead of
// hugging the left edge on wide screens — the premium SaaS feel. Section spacing
// (space-y-6) is baked in so vertical rhythm is identical everywhere; pass a
// `space-y-*` in className to override for a genuinely different page.
const WIDTH = {
  narrow: 'max-w-3xl',
  default: 'max-w-5xl',
  wide: 'max-w-6xl',
  full: 'max-w-none',
} as const

export type PageWidth = keyof typeof WIDTH

export function PageContainer({
  width = 'default',
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { width?: PageWidth }) {
  return (
    <div className={cn(WIDTH[width], 'mx-auto space-y-6', className)} {...props}>
      {children}
    </div>
  )
}
