'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Inbox, History, CalendarClock, LayoutTemplate, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Communications Center rail ──────────────────────────────────────────────────
// The ONE spine above every messaging surface (same pattern as GrowNav). Inbox is
// the existing conversations hub — untouched; History / Scheduled / Templates are
// read-and-manage views over the same engines (notification_log, scheduled_messages,
// business_settings.message_templates). No tab owns a second send pipeline.

interface RailItem { label: string; href: string; icon: LucideIcon }

const ITEMS: RailItem[] = [
  { label: 'Inbox', href: '/dashboard/messages', icon: Inbox },
  { label: 'History', href: '/dashboard/messages/history', icon: History },
  { label: 'Scheduled', href: '/dashboard/messages/scheduled', icon: CalendarClock },
  { label: 'Templates', href: '/dashboard/messages/templates', icon: LayoutTemplate },
]

export function CommsNav() {
  const pathname = usePathname()
  // Light per-navigation refresh (no extra realtime channel — the Sidebar already
  // holds one): unread on Inbox, pending count on Scheduled, so the rail answers
  // "anything waiting?" from any tab. Muted conversations don't count, matching
  // the sidebar badge.
  const [unread, setUnread] = useState(0)
  const [pending, setPending] = useState(0)
  useEffect(() => {
    let active = true
    const supabase = createClient()
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid || !active) return
      const [u, p] = await Promise.all([
        supabase.from('conversations').select('unread').eq('user_id', uid).gt('unread', 0).eq('muted', false),
        supabase.from('scheduled_messages').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('status', 'pending'),
      ])
      if (!active) return
      setUnread(((u.data as { unread: number }[] | null) || []).reduce((s, c) => s + (c.unread || 0), 0))
      setPending(p.count || 0)
    })()
    return () => { active = false }
  }, [pathname])

  return (
    <nav aria-label="Communications sections" className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1 [mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)] sm:[mask-image:none]">
      {ITEMS.map(item => {
        const Icon = item.icon
        const active = item.href === '/dashboard/messages'
          ? pathname === '/dashboard/messages'
          : pathname.startsWith(item.href)
        const badge = item.label === 'Inbox' ? unread : item.label === 'Scheduled' ? pending : 0
        return (
          <Link
            key={item.label}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'shrink-0 inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-medium border transition-colors whitespace-nowrap',
              active ? 'bg-accent text-black border-accent font-semibold pill-glow' : 'bg-surface text-ink-muted border-border hover:text-ink hover:border-border-strong',
            )}
          >
            <Icon className="w-3.5 h-3.5" aria-hidden="true" />
            {item.label}
            {badge > 0 && (
              <span className={cn('min-w-[16px] h-4 px-1 rounded-full text-[9px] font-bold tabular-nums flex items-center justify-center',
                active ? 'bg-black/20 text-black' : item.label === 'Inbox' ? 'bg-accent text-black' : 'bg-surface-raised text-ink-muted border border-border')}>
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}
