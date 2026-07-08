'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Sprout, Sparkles, Images, Megaphone, CalendarDays, LayoutGrid, Lightbulb, ArrowLeftRight, Bot, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Grow section rail ───────────────────────────────────────────────────────────
// The ONE Marketing spine above every Grow surface. Every entry is a built page —
// this replaced the old two-rail setup (this rail + a separate Studio sub-nav that
// duplicated Studio/Campaigns and showed five dead "Soon" pills). Horizontal +
// scrollable on mobile, matching the app's Tabs/FilterPill look.

interface RailItem { label: string; href?: string; icon: LucideIcon; soon?: boolean }

const ITEMS: RailItem[] = [
  { label: 'Overview', href: '/dashboard/grow', icon: Sprout },
  { label: 'Studio', href: '/dashboard/grow/studio', icon: Sparkles },
  { label: 'Calendar', href: '/dashboard/grow/calendar', icon: CalendarDays },
  { label: 'Posts', href: '/dashboard/grow/posts', icon: LayoutGrid },
  { label: 'Library', href: '/dashboard/grow/library', icon: Images },
  { label: 'Before & after', href: '/dashboard/grow/before-after', icon: ArrowLeftRight },
  { label: 'Campaigns', href: '/dashboard/grow/campaigns', icon: Megaphone },
  { label: 'Ideas', href: '/dashboard/grow/ideas', icon: Lightbulb },
  { label: 'Automations', href: '/dashboard/grow/crm', icon: Bot },
]

export function GrowNav() {
  const pathname = usePathname()
  return (
    <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
      {ITEMS.map(item => {
        const Icon = item.icon
        const active = item.href && (item.href === '/dashboard/grow'
          ? pathname === '/dashboard/grow'
          : pathname.startsWith(item.href))
        const base = 'shrink-0 inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-medium border transition-colors whitespace-nowrap'
        if (item.soon) {
          return (
            <span key={item.label} className={cn(base, 'bg-surface/50 text-ink-faint border-border cursor-default')} aria-disabled>
              <Icon className="w-3.5 h-3.5" />
              {item.label}
              <span className="text-[9px] uppercase tracking-wide text-ink-faint/70 bg-ink-faint/10 rounded px-1 py-0.5">Soon</span>
            </span>
          )
        }
        return (
          <Link
            key={item.label}
            href={item.href!}
            className={cn(base, active ? 'bg-accent text-black border-accent' : 'bg-surface text-ink-muted border-border hover:text-ink hover:border-border-strong')}
          >
            <Icon className="w-3.5 h-3.5" />
            {item.label}
          </Link>
        )
      })}
    </div>
  )
}