import { MapPin } from 'lucide-react'
import { cn } from '@/lib/utils'

// The property address for a scheduled visit, shown beneath the customer name.
// A customer can own several properties, so the name alone ("Dana Reyes") never
// says WHICH property today's visit is at — the address is what disambiguates it.
// One place so every visit list (day board, dispatch card) renders it identically.
//
// Renders nothing when there's no address on file, and truncates to a single line
// so it never reflows a dense day board or a phone-width card — the row keeps its
// height and the address ellipsises on narrow screens.
export function VisitAddress({ address, className }: { address?: string | null; className?: string }) {
  const a = address?.trim()
  if (!a) return null
  return (
    <span className={cn('flex items-center gap-1 min-w-0 text-[11px] text-ink-faint', className)} title={a}>
      <MapPin className="w-3 h-3 shrink-0 opacity-70" aria-hidden="true" />
      <span className="truncate">{a}</span>
    </span>
  )
}
