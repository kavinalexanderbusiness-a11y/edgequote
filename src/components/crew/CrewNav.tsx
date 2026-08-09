'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { CalendarCheck, CalendarDays, User } from 'lucide-react'

// ── Crew Mode navigation ─────────────────────────────────────────────────────
// Three destinations, and that is the whole product for a worker:
//   Today    — what am I doing, where, and what is the one next action
//   Week     — what is coming, so tomorrow is not a surprise
//   Me       — who I am, who I work with, sign out
//
// Same ergonomics contract as the owner's BottomNav (which this deliberately
// does NOT reuse: that bar rides the module registry and offers quotes,
// messages and a quick-create sheet — every one of which is owner-only):
// ≥48px targets, labels always visible, aria-current on the active tab,
// pb-safe for the iOS home indicator.
const TABS = [
  { href: '/crew', label: 'Today', icon: CalendarCheck },
  { href: '/crew/schedule', label: 'Week', icon: CalendarDays },
  { href: '/crew/profile', label: 'Me', icon: User },
]

export function CrewNav() {
  const pathname = usePathname()
  return (
    <nav aria-label="Crew" className="fixed bottom-0 inset-x-0 z-40 bg-bg-secondary/95 backdrop-blur border-t border-border pb-safe">
      <div className="mx-auto flex max-w-lg items-stretch px-1 py-1">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = href === '/crew' ? pathname === '/crew' : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex-1 min-h-[48px] rounded-lg flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors',
                active ? 'text-accent-text' : 'text-ink-muted hover:text-ink',
              )}
            >
              <Icon className={cn('w-5 h-5', active && 'text-accent-text')} aria-hidden />
              {label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
