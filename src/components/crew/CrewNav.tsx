'use client'

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import {
  startCrewInboxFeed, subscribeCrewInbox, getCrewInboxSnapshot, getCrewInboxServerSnapshot, totalUnread,
} from '@/lib/crewMessages'
import { CalendarCheck, CalendarDays, MessagesSquare, User } from 'lucide-react'

// ── Crew Mode navigation ─────────────────────────────────────────────────────
// Four destinations, and that is the whole product for a worker:
//   Today    — what am I doing, where, and what is the one next action
//   Week     — what is coming, so tomorrow is not a surprise
//   Messages — what has been said that I have not seen, and which job it is about
//   Me       — who I am, who I work with, sign out
//
// ⭐ Messages earns a tab for ONE reason: Today shows today. A message about
// tomorrow's visit, or one that arrived after a visit was finished, is invisible
// without it — and an invisible message is worse than no messaging at all,
// because the office believes it was delivered. The badge is the whole point of
// the tab; without an unread count it would just be a second way to reach
// conversations already reachable from the stop card.
//
// Same ergonomics contract as the owner's BottomNav (which this deliberately
// does NOT reuse: that bar rides the module registry and offers quotes,
// messages and a quick-create sheet — every one of which is owner-only):
// ≥48px targets, labels always visible, aria-current on the active tab,
// pb-safe for the iOS home indicator.
const TABS = [
  { href: '/crew', label: 'Today', icon: CalendarCheck },
  { href: '/crew/schedule', label: 'Week', icon: CalendarDays },
  { href: '/crew/messages', label: 'Messages', icon: MessagesSquare, badge: true },
  { href: '/crew/profile', label: 'Me', icon: User },
]

export function CrewNav() {
  const pathname = usePathname()
  const supabase = useMemo(() => createClient(), [])
  // ⭐ The SAME ref-counted feed CrewToday reads. One fetch and one refresh loop
  // however many components want the number — the duplication NotificationBell
  // had to be rescued from, avoided by construction here.
  const items = useSyncExternalStore(subscribeCrewInbox, getCrewInboxSnapshot, getCrewInboxServerSnapshot)
  useEffect(() => startCrewInboxFeed(supabase), [supabase])
  const unread = totalUnread(items)

  return (
    <nav aria-label="Crew" className="fixed bottom-0 inset-x-0 z-40 bg-bg-secondary/95 backdrop-blur border-t border-border pb-safe">
      <div className="mx-auto flex max-w-lg items-stretch px-1 py-1">
        {TABS.map(({ href, label, icon: Icon, badge }) => {
          const active = href === '/crew' ? pathname === '/crew' : pathname.startsWith(href)
          const showBadge = badge && unread > 0
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              aria-label={showBadge ? `${label}, ${unread} unread` : undefined}
              className={cn(
                'flex-1 min-h-[48px] rounded-lg flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors',
                active ? 'text-accent-text' : 'text-ink-muted hover:text-ink',
              )}
            >
              <span className="relative">
                <Icon className={cn('w-5 h-5', active && 'text-accent-text')} aria-hidden />
                {showBadge && (
                  <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 rounded-full bg-accent text-black text-[10px] font-bold flex items-center justify-center">
                    {unread > 9 ? '9+' : unread}
                  </span>
                )}
              </span>
              {label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
