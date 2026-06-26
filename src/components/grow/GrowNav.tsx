'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Sprout, Sparkles, Images, Megaphone, Star, Gift, BarChart3, Bot, Inbox, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Grow section rail ───────────────────────────────────────────────────────────
// The 9-item Marketing spine, promoted from the brief. Built surfaces link; the
// rest show as muted "Soon" so the owner sees the full roadmap without dead links.
// Horizontal + scrollable on mobile, matching the app's Tabs/FilterPill look.

interface RailItem { label: string; href?: string; icon: LucideIcon; soon?: boolean }

const ITEMS: RailItem[] = [
  { label: 'Overview', href: '/dashboard/grow', icon: Sprout },
  { label: 'Studio', href: '/dashboard/grow/studio', icon: Sparkles },
  { label: 'Library', href: '/dashboard/grow/library', icon: Images },
  { label: 'Campaigns', icon: Megaphone, soon: true },
  { label: 'Reviews', icon: Star, soon: true },
  { label: 'Referrals', icon: Gift, soon: true },
  { label: 'Analytics', icon: BarChart3, soon: true },
  { label: 'Coach', icon: Bot, soon: true },
  { label: 'Pipeline', icon: Inbox, soon: true },
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
