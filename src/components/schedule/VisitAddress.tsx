import { MapPin } from 'lucide-react'
import { cn } from '@/lib/utils'

// The property address for a scheduled visit, shown beneath the customer name.
// A customer can own several properties, so the name alone ("Dana Reyes") never
// says WHICH property today's visit is at — the address is what disambiguates it.
// One place so every visit list (day board, dispatch card) renders it identically.
//
// Dense lists keep a single line. Reading surfaces opt into full wrapping so
// a unit number or access description never depends on a hover tooltip.
export function VisitAddress({ address, className, readable = false }: {
  address?: string | null
  className?: string
  readable?: boolean
}) {
  const a = address?.trim()
  if (!a) return null
  return (
    <span className={cn('flex gap-1 min-w-0', readable
      ? 'items-start text-sm leading-relaxed text-ink-muted'
      : 'items-center text-[11px] text-ink-faint', className)} title={a}>
      <MapPin className={cn('shrink-0', readable ? 'w-4 h-4 mt-0.5' : 'w-3 h-3 opacity-70')} aria-hidden="true" />
      <span className={readable ? 'min-w-0 [overflow-wrap:anywhere]' : 'truncate'}>{a}</span>
    </span>
  )
}
