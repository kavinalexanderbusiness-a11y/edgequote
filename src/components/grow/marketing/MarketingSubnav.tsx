'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Sparkles, CalendarDays, Megaphone, LayoutGrid, Lightbulb, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Marketing Studio sub-nav ──────────────────────────────────────────────────────
// The hub strip that turns the Studio into a social-media manager: Compose, Calendar,
// Campaigns, Posts, Ideas. Lives inside the marketing pages (not the Grow layout) so
// it only shows here. Same pill look as the rest of the app.

interface Item { label: string; href: string; icon: LucideIcon }
const ITEMS: Item[] = [
  { label: 'Compose', href: '/dashboard/grow/studio', icon: Sparkles },
  { label: 'Calendar', href: '/dashboard/grow/calendar', icon: CalendarDays },
  { label: 'Campaigns', href: '/dashboard/grow/campaigns', icon: Megaphone },
  { label: 'Posts', href: '/dashboard/grow/posts', icon: LayoutGrid },
  { label: 'Ideas', href: '/dashboard/grow/ideas', icon: Lightbulb },
]

export function MarketingSubnav() {
  const pathname = usePathname()
  return (
    <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
      {ITEMS.map(item => {
        const Icon = item.icon
        const active = pathname.startsWith(item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'shrink-0 inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-medium border transition-colors whitespace-nowrap',
              active ? 'bg-accent text-black border-accent' : 'bg-surface text-ink-muted border-border hover:text-ink hover:border-border-strong',
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {item.label}
          </Link>
        )
      })}
    </div>
  )
}
